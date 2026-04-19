import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('file_embeddings')
    .ifNotExists()
    .addColumn('file_id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('model_id', 'text', (col) => col.notNull())
    .addColumn('embedding_json', 'text', (col) => col.notNull())
    .addColumn('source_hash', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addForeignKeyConstraint('fk_file_embeddings_file', ['file_id'], 'files', ['id'], (cb) =>
      cb.onDelete('cascade'),
    )
    .execute();

  await db.schema
    .createIndex('idx_file_embeddings_model')
    .ifNotExists()
    .on('file_embeddings')
    .column('model_id')
    .execute();

  await db.schema
    .createIndex('idx_file_embeddings_updated_at')
    .ifNotExists()
    .on('file_embeddings')
    .column('updated_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_file_embeddings_model').ifExists().execute();
  await db.schema.dropIndex('idx_file_embeddings_updated_at').ifExists().execute();
  await db.schema.dropTable('file_embeddings').ifExists().execute();
}
