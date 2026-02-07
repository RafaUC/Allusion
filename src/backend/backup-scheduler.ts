import { promises as fs } from 'fs';
import fse from 'fs-extra';
import path from 'path';
import Backend from './backend';
import { AUTO_BACKUP_TIMEOUT, DB_TO_IMPORT_NAME, NUM_AUTO_BACKUPS } from './config';
import { DataBackup } from 'src/api/data-backup';
import SQLite from 'better-sqlite3';
import { debounce } from 'common/timeout';
import { getToday, getWeekStart } from 'common/core';

export default class BackupScheduler implements DataBackup {
  #db!: SQLite.Database;
  #backupDirectory: string = '';
  #batabaseDirectory: string = '';
  #lastBackupIndex: number = 0;
  #lastBackupDate: Date = new Date(0);

  async init(
    databasePath: string,
    batabaseDirectory: string,
    backupDirectory: string,
  ): Promise<string | undefined> {
    this.#batabaseDirectory = batabaseDirectory;
    this.#backupDirectory = backupDirectory;

    await fse.ensureDir(backupDirectory);
    await fse.ensureDir(batabaseDirectory);

    const tempJsonToImport = await BackupScheduler.checkAndRestoreDB(
      databasePath,
      batabaseDirectory,
      backupDirectory,
    );
    await fse.ensureFile(databasePath);

    this.#db = new SQLite(databasePath, { readonly: true });

    return tempJsonToImport;
  }

  private static async getLastJsonBackupPath(backupDirectory: string): Promise<string | undefined> {
    const files = await fse.readdir(backupDirectory);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    if (!jsonFiles.length) {
      return undefined;
    }
    const stats = await Promise.all(
      jsonFiles.map(async (f) => ({
        path: path.join(backupDirectory, f),
        mtime: (await fse.stat(path.join(backupDirectory, f))).mtime,
      })),
    );
    return stats.reduce((a, b) => (a.mtime > b.mtime ? a : b)).path;
  }

  // Check if the DB to import exists,
  // if it does and its a json we delete the old DB and return the json path to import.
  // if it is a sqlite file we replace the old DB with the new file without opening it.
  private static async checkAndRestoreDB(
    databasePath: string,
    batabaseDirectory: string,
    backupDirectory: string,
  ): Promise<string | undefined> {
    const importJsonPath = path.join(batabaseDirectory, `${DB_TO_IMPORT_NAME}.json`);
    const importDbPath = path.join(batabaseDirectory, `${DB_TO_IMPORT_NAME}.sqlite`);
    try {
      if ((await fse.pathExists(importJsonPath)) || (await fse.pathExists(importDbPath))) {
        console.info('BackupScheduler: Remove previous DB', databasePath);
        await fse.remove(databasePath);
        await fse.remove(`${databasePath}-shm`);
        await fse.remove(`${databasePath}-wal`);
      }
      if (await fse.pathExists(importJsonPath)) {
        return importJsonPath;
      }
      if (await fse.pathExists(importDbPath)) {
        await fse.move(importDbPath, databasePath, { overwrite: true });
        return undefined;
      }
    } catch (error) {
      console.error(error);
    }
    return this.getLastJsonBackupPath(backupDirectory);
  }

  schedule(): void {
    if (new Date().getTime() > this.#lastBackupDate.getTime() + AUTO_BACKUP_TIMEOUT) {
      this.#createPeriodicBackup();
    }
  }

  /** Creates a copy of a backup file, when the target file creation date is less than the provided date */
  static async #copyFileIfCreatedBeforeDate(
    srcPath: string,
    targetPath: string,
    dateToCheck: Date,
  ): Promise<boolean> {
    let createBackup = false;
    try {
      // If file creation date is less than provided date, create a back-up
      const stats = await fse.stat(targetPath);
      createBackup = stats.ctime < dateToCheck;
    } catch (e) {
      // File not found
      createBackup = true;
    }
    if (createBackup) {
      try {
        await fse.copyFile(srcPath, targetPath);
        console.log('Created backup', targetPath);
        return true;
      } catch (e) {
        console.error('Could not create backup', targetPath, e);
      }
    }
    return false;
  }

  // Wait 10 seconds after a change for any other changes before creating a backup.
  #createPeriodicBackup = debounce(async (): Promise<void> => {
    const filePath = path.join(
      this.#backupDirectory,
      `auto-backup-${this.#lastBackupIndex}.sqlite`,
    );

    this.#lastBackupDate = new Date();
    this.#lastBackupIndex = (this.#lastBackupIndex + 1) % NUM_AUTO_BACKUPS;

    try {
      await this.backupToFile(filePath);

      console.log('Created automatic backup', filePath);

      // Check for daily backup
      await BackupScheduler.#copyFileIfCreatedBeforeDate(
        filePath,
        path.join(this.#backupDirectory, 'daily.sqlite'),
        getToday(),
      );

      // Check for weekly backup
      await BackupScheduler.#copyFileIfCreatedBeforeDate(
        filePath,
        path.join(this.#backupDirectory, 'weekly.sqlite'),
        getWeekStart(),
      );
    } catch (e) {
      console.error('Could not create periodic backup', filePath, e);
    }
  }, 10000);

  async backupToFile(path: string): Promise<void> {
    console.info('SQLite: Exporting database backup...', path);
    await this.#db.backup(path);
  }

  async restoreFromFile(sourcePath: string): Promise<void> {
    console.info('SQLite: Importing database backup...', sourcePath);

    if (!(await fse.pathExists(sourcePath))) {
      throw new Error(`Backup file not found: ${sourcePath}`);
    }
    const ext = path.extname(sourcePath);
    const destPath = path.join(this.#batabaseDirectory, `${DB_TO_IMPORT_NAME}${ext}`);
    // Replace file to import if exists.
    await fse.remove(destPath);
    await fse.copyFile(sourcePath, destPath);
    console.info(`SQLite: Backup file copied to ${destPath}`);
  }

  async restoreEmpty(): Promise<void> {
    const emptyDBPath = path.join(this.#batabaseDirectory, `${DB_TO_IMPORT_NAME}.sqlite`);
    await fse.remove(emptyDBPath);
    await fse.ensureFile(emptyDBPath);
    const db = new Backend();
    // Init the DB to apply the migrations but passing an empty string to not import data brom backup folder.
    await db.init(
      emptyDBPath,
      '',
      () => {},
      async () => {},
      'migrate',
    );
  }

  async peekFile(sourcePath: string): Promise<[numTags: number, numFiles: number]> {
    console.info('SQLite: Peeking database backup...', sourcePath);
    const ext = path.extname(sourcePath);
    if (ext === '.json') {
      const content = await fs.readFile(sourcePath, 'utf8');
      const json = JSON.parse(content);
      if (json.formatName !== 'dexie') {
        throw new Error('Invalid backup format (expected dexie .json)');
      }
      const tables = Object.fromEntries(
        json.data.data.map((table: any) => [table.tableName, table.rows]),
      );
      return [tables.tags.length, tables.files.length];
    }
    if (ext === '.sqlite') {
      let db = null;
      db = new Backend();
      await db.init(
        sourcePath,
        '',
        () => {},
        async () => {},
        'readonly',
      );
      const tags = (await db.fetchTags()).length;
      const files = (await db.countFiles({ files: true }))[0] ?? 0;
      db = null;
      if (global.gc) {
        // Remove the backend instance to get rid of any WAL file.
        console.log('Forcing Garbage Collection');
        global.gc();
      }
      return [tags, files];
    }
    throw new Error('Invalid backup format (expected dexie .json or .sqlite)');
  }
}
