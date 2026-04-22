import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('savedSearches')
    .addColumn('semanticQueryJson', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('savedSearches')
    .dropColumn('semanticQueryJson')
    .execute();
}
