import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  try {
    await sql`ALTER TABLE file_embeddings ADD COLUMN embedding_blob blob`.execute(db);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    // Older databases may already have this column.
    if (!message.includes('duplicate column name')) {
      throw error;
    }
  }
}

export async function down(): Promise<void> {
  // SQLite does not support dropping a single column without table rebuild.
}
