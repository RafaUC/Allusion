import { Kysely } from 'kysely';
import { restoreFromOldJsonFormat } from '../backup-scheduler';

export default (context: { jsonToImport?: string }) => ({
  async up(db: Kysely<any>): Promise<void> {
    const jsonToImport = context.jsonToImport;
    await restoreFromOldJsonFormat(db, jsonToImport);
  },
  async down(_: Kysely<any>): Promise<void> {
    // No rollback for imports, maybe delete all the data
    void _;
  },
});
