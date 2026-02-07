import { Kysely, Migrator, Migration, MigrationProvider, Logger, LogEvent } from 'kysely';
import { AllusionDB_SQL } from './schemaTypes';

export const DB_NAME = 'Allusion';

export const DB_TO_IMPORT_NAME = 'DB_TO_IMPORT';

export const NUM_AUTO_BACKUPS = 6;

export const AUTO_BACKUP_TIMEOUT = 1000 * 60 * 10; // 10 minutes

export const USE_BACKEND_AS_WORKER = true; // easier to debug when false

export const PAD_STRING_LENGTH = 10;

//Register the migrations here.
class InlineMigrationProvider implements MigrationProvider {
  #context: Record<string, any>;

  constructor(context: Record<string, any> = {}) {
    this.#context = context;
  }
  async getMigrations(): Promise<Record<string, Migration>> {
    const context = this.#context;
    return {
      '000_initial': await import('./migrations/000_initial'),
      '001_migrateJSON': (await import('./migrations/001_migrateJSON')).default(context),
    };
  }
}

export async function migrateToLatest(
  db: Kysely<AllusionDB_SQL>,
  context: { jsonToImport: string | undefined },
): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new InlineMigrationProvider(context),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('failed to migrate');
    console.error(error);
  }
}

export const kyselyLogger: Logger = (event: LogEvent): void => {
  if (event.level === 'query') {
    console.log('SQL:', event.query.sql);
    console.log('Parameters:', event.query.parameters);
    console.log('Duration:', event.queryDurationMillis, 'ms');
  }

  if (event.level === 'error') {
    console.error('SQL Error:', event.error);
    console.error('Failed Query:', event.query.sql);
    console.error('Parameters:', event.query.parameters);
  }
};
