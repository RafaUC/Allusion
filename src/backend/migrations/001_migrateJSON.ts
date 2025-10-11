import { Kysely } from 'kysely';
import path from 'path';
import { readdir, stat } from 'fs/promises';
import { RendererMessenger } from 'src/ipc/renderer';
import { restoreFromOldJsonFormat } from '../backup-scheduler';

export async function getLastJsonBackupPath(): Promise<string> {
  const dir = await RendererMessenger.getDefaultBackupDirectory();
  const files = await readdir(dir);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (!jsonFiles.length) {
    throw new Error(`No .json files found in ${dir}`);
  }
  const stats = await Promise.all(
    jsonFiles.map(async (f) => ({
      path: path.join(dir, f),
      mtime: (await stat(path.join(dir, f))).mtime,
    })),
  );
  return stats.reduce((a, b) => (a.mtime > b.mtime ? a : b)).path;
}


export async function up(db: Kysely<any>): Promise<void> {
  restoreFromOldJsonFormat(db, await getLastJsonBackupPath());
}

export async function down(_: Kysely<any>): Promise<void> {
  // No rollback for imports, maybe delete all the data
  void _;
}
