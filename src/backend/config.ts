import { Kysely, Migrator, Migration, MigrationProvider } from 'kysely';
import { AllusionDB_SQL } from './schemaTypes';

export const DB_NAME = 'Allusion';

export const NUM_AUTO_BACKUPS = 6;

export const AUTO_BACKUP_TIMEOUT = 1000 * 60 * 10; // 10 minutes

export const USE_BACKEND_AS_WORKER = false;

export const PAD_STRING_LENGTH = 10;

//Register the migrations here.
class InlineMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '000_initial': await import('./migrations/000_initial'),
      '001_migrateJSON': await import('./migrations/001_migrateJSON'),
    };
  }
}

export async function migrateToLatest(db: Kysely<AllusionDB_SQL>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new InlineMigrationProvider(),
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
