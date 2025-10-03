import { AllusionDB_SQL } from './schemaTypes';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect, CamelCasePlugin } from 'kysely';
import { migrateToLatest } from './config';

export default class Backend {
  #db: Kysely<AllusionDB_SQL>;
  #notifyChange: () => void;

  constructor(db: Kysely<AllusionDB_SQL>, notifyChange: () => void) {
    this.#db = db;

    this.#notifyChange = notifyChange;
  }

  static async init(dbPath: string, notifyChange: () => void): Promise<Backend> {
    console.info(`SQLite3: Initializing database "${dbPath}"...`);
    const dialect = new SqliteDialect({
      database: new SQLite(dbPath),
    });
    const db = new Kysely<AllusionDB_SQL>({
      dialect: dialect,
      plugins: [new CamelCasePlugin()],
    });
    migrateToLatest(db);
    const backend = new Backend(db, notifyChange);
    return backend;
  }
}
