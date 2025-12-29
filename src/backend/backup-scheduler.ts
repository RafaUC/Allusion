import { promises as fs } from 'fs';
import { Insertable, InsertObject, Kysely, sql } from 'kysely';
import { generateId, ID } from 'src/api/id';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AllusionDB_SQL,
  ExtraProperties,
  EpValues,
  Files,
  FileTags,
  LocationNodes,
  Locations,
  LocationTags,
  SavedSearches,
  serializeBoolean,
  serializeDate,
  SubLocations,
  SearchCriteria,
  TagImplications,
  TagAliases,
  SubTags,
  Tags,
  SearchGroups,
} from './schemaTypes';
import fse from 'fs-extra';
import path from 'path';
import { ExtraPropertyType } from 'src/api/extraProperty';
import Backend, { computeBatchSize, getSqliteMaxVariables } from './backend';
import { AUTO_BACKUP_TIMEOUT, DB_TO_IMPORT_NAME, NUM_AUTO_BACKUPS } from './config';
import { DataBackup } from 'src/api/data-backup';
import SQLite from 'better-sqlite3';
import { debounce } from 'common/timeout';
import { getToday, getWeekStart } from 'common/core';

export default class BackupScheduler implements DataBackup {
  #db: SQLite.Database;
  #backupDirectory: string = '';
  #batabaseDirectory: string = '';
  #lastBackupIndex: number = 0;
  #lastBackupDate: Date = new Date(0);

  constructor(databasePath: string, batabaseDirectory: string, backupDirectory: string) {
    this.#db = new SQLite(databasePath, { readonly: true });
    this.#batabaseDirectory = batabaseDirectory;
    this.#backupDirectory = backupDirectory;
  }

  static async init(
    databasePath: string,
    batabaseDirectory: string,
    backupDirectory: string,
  ): Promise<{ backupScheduler: BackupScheduler; tempJsonToImport: string | undefined }> {
    await fse.ensureDir(backupDirectory);
    await fse.ensureDir(batabaseDirectory);
    const tempJsonToImport = await this.checkAndRestoreDB(
      databasePath,
      batabaseDirectory,
      backupDirectory,
    );
    await delay(5000);
    await fse.ensureFile(databasePath);
    const backupScheduler = new BackupScheduler(databasePath, batabaseDirectory, backupDirectory);
    return { backupScheduler, tempJsonToImport };
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
      const files = (await db.countFiles())[0];
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

const fallbackIds = {
  locationNode: 'fallback_location_node',
  extraProperty: 'fallback_ep',
};

export async function restoreFromOldJsonFormat(
  db: Kysely<AllusionDB_SQL>,
  backupFilePath: string | undefined,
): Promise<void> {
  if (backupFilePath === undefined) {
    return;
  }
  const content = await fs.readFile(backupFilePath, 'utf8');
  const json = JSON.parse(content);
  console.info('====================================================');
  console.info('-> Importing Dexie backup from', backupFilePath);
  if (json.formatName !== 'dexie') {
    throw new Error('Invalid backup format (expected dexie)');
  }

  const tables = Object.fromEntries(
    json.data.data.map((table: any) => [table.tableName, table.rows]),
  );

  const MAX_VARS = await getSqliteMaxVariables(db);
  console.info(`MAX_VARS: ${MAX_VARS}`);

  const saveEntries = async <TableName extends keyof AllusionDB_SQL>(
    entityName: TableName,
    entries: InsertObject<AllusionDB_SQL, TableName>[],
  ) => {
    let errors = 0;
    const batchSize = computeBatchSize(MAX_VARS, entries.find(Boolean));
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 100;
    console.info(
      `Importing ${entries.length} ${entityName} from old format. (Batch size: ${batchSize})`,
    );
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);

        let attempt = 0;
        while (true) {
          try {
            await trx
              .insertInto(entityName)
              .values(batch)
              .onConflict((oc) => oc.doNothing())
              .execute();
            // If success, break the while
            break;
          } catch (err: any) {
            if (err.code === 'SQLITE_BUSY' && attempt < MAX_RETRIES) {
              const wait = BASE_DELAY_MS * Math.pow(2, attempt);
              console.warn(
                `SQLITE_BUSY on ${entityName} (batch ${
                  i / batchSize + 1
                }). Retrying in ${wait} ms... (attempt ${attempt + 1}/${MAX_RETRIES})`,
              );
              attempt++;
              await delay(wait);
              continue; // retry
            }

            console.warn(`❌ Error while inserting ${entityName}`, err);
            errors += batchSize;
            break; // stop retry loop for this batch
          }
        }
      }
    });
    console.info(`Finished importing ${entityName}: ${errors} errors.`);
  };

  // Disable foreign key constraints
  await sql`PRAGMA foreign_keys = OFF;`.execute(db);

  // Create fallback references for missing foreign keys
  // Ensure fallback base records exist

  await db
    .insertInto('locationNodes')
    .values({
      id: fallbackIds.locationNode,
      parentId: fallbackIds.locationNode,
      path: 'fallback',
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('locations')
    .values({
      nodeId: fallbackIds.locationNode,
      idx: 0,
      isWatchingFiles: serializeBoolean(false),
      dateAdded: serializeDate(new Date()),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('extraProperties')
    .values({
      id: fallbackIds.extraProperty,
      name: 'Fallback Property',
      type: ExtraPropertyType.text,
      dateAdded: serializeDate(new Date()),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  /// IMPORTING DATA ///

  // Import tags
  const { tags, subTags, tagImplications, tagAliases } = normalizeTags(tables.tags ?? []);

  await saveEntries('tags', tags);
  await saveEntries('subTags', subTags);
  await saveEntries('tagImplications', tagImplications);
  await saveEntries('tagAliases', tagAliases);

  // Import locations
  const { locationNodes, locations, subLocations } = normalizeLocations(tables.locations ?? []);

  await saveEntries('locationNodes', locationNodes);
  await saveEntries('locations', locations);
  await saveEntries('subLocations', subLocations);

  // Import extra properties definitions
  const extraProperties: Insertable<ExtraProperties>[] = (
    tables.extraProperties ? (tables.extraProperties as Array<any>) : []
  ).map((ep) => ({
    id: ep.id ?? generateId(),
    type: ep.type ?? ExtraPropertyType.text,
    name: ep.name ?? '(unnamed)',
    dateAdded: serializeDate(ep.dateAdded ? new Date(ep.dateAdded) : new Date()),
  }));

  await saveEntries('extraProperties', extraProperties);

  // Import files
  const { files, fileTags, epVal } = normalizeFiles(tables.files ?? [], extraProperties);

  await saveEntries('files', files);
  await saveEntries('fileTags', fileTags);
  await saveEntries('epValues', epVal);

  // Import seved searches
  const { savedSearches, searchGroups, searchCriteria } = normalizeSavedSearches(
    tables.searches ?? [],
  );
  await saveEntries('savedSearches', savedSearches);
  await saveEntries('searchGroups', searchGroups);
  await saveEntries('searchCriteria', searchCriteria);

  //  Re-enable foreign keys
  await sql`PRAGMA foreign_keys = ON;`.execute(db);

  //  Validate foreign keys
  const fkCheck = await sql`PRAGMA foreign_key_check;`.execute(db);
  if (fkCheck.rows.length > 0) {
    console.warn('Foreign key issues found:', fkCheck.rows);
    // optional cleanup: remove invalid references
    await sql`DELETE FROM files WHERE location_id NOT IN (SELECT node_id FROM locations);`.execute(
      db,
    );
    await sql`DELETE FROM file_tags WHERE tag_id NOT IN (SELECT id FROM tags);`.execute(db);
  } else {
    console.info('Complete succes! no foreign key issues found:', fkCheck.rows);
  }

  console.info('Dexie backup import completed successfully.');
  console.info('====================================================');
}

function normalizeTags(tags: any[]) {
  const subTags: Insertable<SubTags>[] = [];
  const tagImplications: Insertable<TagImplications>[] = [];
  const tagAliases: Insertable<TagAliases>[] = [];

  for (const tag of tags) {
    for (const [index, subTagId] of (Array.isArray(tag.subTags) ? tag.subTags : []).entries()) {
      subTags.push({ tagId: tag.id, subTagId: subTagId, idx: index });
    }

    for (const impliedTagId of Array.isArray(tag.impliedTags) ? tag.impliedTags : []) {
      tagImplications.push({ tagId: tag.id, impliedTagId: impliedTagId });
    }

    // Convert to Set to get rid of duplicates.
    const aliases = new Set<string>(Array.isArray(tag.aliases) ? tag.aliases : []);
    for (const alias of aliases) {
      tagAliases.push({ tagId: tag.id, alias: alias });
    }
  }

  const normalizedTags: Insertable<Tags>[] = tags.map((tag) => ({
    id: tag.id ?? generateId(),
    name: tag.name ?? '(untitled)',
    color: tag.color ?? '',
    isHidden: serializeBoolean(!!tag.isHidden),
    isVisibleInherited: serializeBoolean(!!tag.isVisibleInherited),
    isHeader: serializeBoolean(!!tag.isHeader),
    description: tag.description ?? '',
    dateAdded: serializeDate(tag.dateAdded ? new Date(tag.dateAdded) : new Date()),
  }));

  return { tags: normalizedTags, subTags, tagImplications, tagAliases };
}

function normalizeLocations(sourcelocations: any[]) {
  const locationNodes: Insertable<LocationNodes>[] = [];
  const locations: Insertable<Locations>[] = [];
  const subLocations: Insertable<SubLocations>[] = [];
  const locationTags: Insertable<LocationTags>[] = [];

  function normalizeLocationNodeRecursive(
    node: any, //LocationDTO | SubLocationDTO,
    parentId: ID,
    isRoot: boolean,
  ) {
    const nodeId = node.id ?? generateId();
    const parentIdvalue = isRoot ? null : parentId;
    const pathValue = isRoot ? node.path ?? '' : node.name ?? '';
    // Insert into locationNodes
    locationNodes.push({
      id: nodeId,
      parentId: parentIdvalue,
      path: pathValue,
    });
    if (isRoot) {
      locations.push({
        nodeId: nodeId,
        idx: node.index ?? 0,
        isWatchingFiles: serializeBoolean(!!node.isWatchingFiles),
        dateAdded: serializeDate(node.dateAdded ? new Date(node.dateAdded) : new Date()),
      });
    } else {
      // Insert into sub_location
      subLocations.push({
        nodeId: nodeId,
        isExcluded: serializeBoolean(!!node.isExcluded),
      });
    }
    // Insert tags
    for (const tagId of Array.isArray(node.tags) ? node.tags : []) {
      locationTags.push({
        nodeId: nodeId,
        tagId: tagId,
      });
    }
    // Recurse for sublocations
    for (const sub of Array.isArray(node.subLocations) ? node.subLocations : []) {
      normalizeLocationNodeRecursive(sub, nodeId, false);
    }
  }

  for (const loc of sourcelocations) {
    normalizeLocationNodeRecursive(loc, loc.id ?? generateId(), true);
  }
  return { locationNodes, locations, subLocations };
}

function normalizeFiles(sourceFiles: any[], extraProperties: Insertable<ExtraProperties>[]) {
  const files: Insertable<Files>[] = [];
  const fileTags: Insertable<FileTags>[] = [];
  const epVal: Insertable<EpValues>[] = [];

  for (const file of sourceFiles) {
    const fileId = file.id ?? generateId();
    files.push({
      id: fileId,
      ino: file.ino ?? '',
      locationId: file.locationId ?? fallbackIds.locationNode,
      relativePath: file.relativePath ?? '',
      absolutePath: file.absolutePath ?? '',
      tagSorting: file.tagsSorting ?? 'none',
      name: file.name ?? '(unnamed)',
      extension: file.extension ?? '',
      size: file.size ?? 10,
      width: file.width ?? 10,
      height: file.height ?? 10,
      dateAdded: serializeDate(file.dateAdded ? new Date(file.dateAdded) : new Date()),
      dateModified: serializeDate(file.dateModified ? new Date(file.dateModified) : new Date()),
      dateModifiedOS: serializeDate(
        file.OrigDateModified
          ? new Date(file.OrigDateModified)
          : file.dateModifiedOS
          ? new Date(file.dateModifiedOS)
          : new Date(),
      ),
      dateLastIndexed: serializeDate(
        file.dateLastIndexed ? new Date(file.dateLastIndexed) : new Date(),
      ),
      dateCreated: serializeDate(file.dateCreated ? new Date(file.dateCreated) : new Date()),
    });

    // file_tags (tags relations)
    for (const tagId of Array.isArray(file.tags) ? file.tags : []) {
      fileTags.push({
        fileId: fileId,
        tagId: tagId,
      });
    }

    // ep_values  (extra properties relations)
    if (file.extraPropertyIDs) {
      for (const epId of Array.isArray(file.extraPropertyIDs) ? file.extraPropertyIDs : []) {
        const epRow = extraProperties.find((ep: any) => ep.id === epId);

        const value = file.extraProperties?.[epId];
        if (value !== undefined && value !== null) {
          const epType = epRow?.type ?? typeof value;
          if (epType === 'number') {
            epVal.push({
              fileId,
              epId,
              numberValue: value,
            });
          } else {
            epVal.push({
              fileId,
              epId,
              textValue: value,
            });
          }
        }
      }
    }
  }
  return { files, fileTags, epVal };
}

function normalizeSavedSearches(sourceSearches: any[]) {
  const savedSearches: Insertable<SavedSearches>[] = [];
  const searchGroups: Insertable<SearchGroups>[] = [];
  const searchCriteria: Insertable<SearchCriteria>[] = [];

  for (const search of sourceSearches) {
    const searchId = search.id ?? generateId();
    // Extract saved search
    savedSearches.push({
      id: searchId,
      name: search.name ?? '(unnamed search)',
      idx: search.index ?? 0,
    });
    // Root group
    const rootGroupId = generateId();
    searchGroups.push({
      id: rootGroupId,
      name: '',
      savedSearchId: searchId,
      parentGroupId: null,
      idx: 0,
      conjunction: search.matchAny ? 'or' : 'and',
    });
    //Extract Criterias
    const criteriaArray = Array.isArray(search.criteria) ? search.criteria : [];
    for (const [idx, crit] of criteriaArray.entries()) {
      const criteriaId = generateId();
      searchCriteria.push({
        id: criteriaId,
        groupId: rootGroupId,
        idx: idx,
        key: crit.key ?? 'name',
        valueType: crit.valueType ?? 'string',
        operator: crit.operator ?? 'equals',
        jsonValue: JSON.stringify(crit.value ?? 'error'),
      });
    }
  }

  return {
    savedSearches,
    searchGroups,
    searchCriteria,
  };
}
