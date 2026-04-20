import SQLite from 'better-sqlite3';
import {
  Kysely,
  SqliteDialect,
  ParseJSONResultsPlugin,
  CamelCasePlugin,
  sql,
} from 'kysely';
import { kyselyLogger, PAD_STRING_LENGTH } from './config';
import { AllusionDB_SQL } from './schemaTypes';
import { IS_DEV } from 'common/process';

// Defined here (NOT imported from backend.ts) to avoid circular import
const USE_QUERY_LOGGER = false ? IS_DEV : false;

export interface DBInitResult {
  db: Kysely<AllusionDB_SQL>;
  sqlite: SQLite.Database;
}

export async function initDB(dbPath: string): Promise<DBInitResult> {
  console.info(`SQLite3: Initializing database "${dbPath}"...`);
  const database = new SQLite(dbPath, { timeout: 50000 });

  // HACK Use a padded string to do natural sorting
  database.function('pad_string', { deterministic: true }, PadString);
  database.function('stable_hash', { deterministic: true }, stableHash);

  const dialect = new SqliteDialect({ database });
  const db = new Kysely<AllusionDB_SQL>({
    dialect: dialect,
    plugins: [new ParseJSONResultsPlugin(), new CamelCasePlugin()],
    log: USE_QUERY_LOGGER ? kyselyLogger : undefined, // Used only for debugging.
  });

  // Configure PRAGMA settings (these can create WAL/SHM files)
  // Enable WAL mode to not wait for writes and optimize database
  await sql`PRAGMA journal_mode = WAL;`.execute(db);
  await sql`PRAGMA case_sensitive_like = ON;`.execute(db);
  await sql`PRAGMA synchronous = NORMAL;`.execute(db);
  await sql`PRAGMA temp_store = MEMORY;`.execute(db);
  await sql`PRAGMA automatic_index = ON;`.execute(db);
  await sql`PRAGMA cache_size = -64000;`.execute(db);
  await sql`PRAGMA OPTIMIZE;`.execute(db);

  return { db, sqlite: database };
}

export async function getSqliteMaxVariables(db: Kysely<AllusionDB_SQL>): Promise<number> {
  const rows = (await sql`PRAGMA compile_options`.execute(db)).rows;
  const opt: any = rows.find((r: any) => r.compileOptions?.includes('MAX_VARIABLE_NUMBER'));
  if (!opt) {
    console.warn('MAX_VARIABLE_NUMBER not found, using 22766');
    return 22766;
  }
  const maxVars = parseInt(opt.compileOptions.split('=')[1], 10);
  return isNaN(maxVars) ? 22766 : maxVars;
}

export function computeBatchSize(maxVars: number, sampleObject?: Record<string, any>): number {
  if (!sampleObject) {
    return 501;
  }
  const numCols = Object.keys(sampleObject).length;
  return Math.floor(maxVars / numCols);
}

export function PadString(str: string): string {
  return str.replace(/\d+/g, (num: string) => num.padStart(PAD_STRING_LENGTH, '0'));
}

export function stableHash(id: string, seed: number): number {
  let h = seed | 0;

  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }

  return h >>> 0;
}

export function generateSeed(): number {
  return Date.now() >>> 0;
}
