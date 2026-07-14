/* eslint-disable prettier/prettier */
import { Kysely } from 'kysely';

/*
Migration to create the Tag Palettes tables.
SQL table and column names are in snake_case, which will later be converted
to camelCase by the Kysely camel case plugin.
*/
export async function up(db: Kysely<any>): Promise<void> {
  //// TAG PALETTES ////
  await db.schema
    .createTable('tag_palettes')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('tag_palette_items')
    .addColumn('palette_id', 'text', (col) => col.notNull())
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_tag_palette_items', ['palette_id', 'tag_id', 'idx'])
    .addForeignKeyConstraint('fk_tag_palette_items_palette', ['palette_id'], 'tag_palettes', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_tag_palette_items_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  // Indexes
  await db.schema.createIndex('idx_tag_palette_items_palette').on('tag_palette_items').column('palette_id').execute();
  await db.schema.createIndex('idx_tag_palette_items_tag').on('tag_palette_items').column('tag_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_tag_palette_items_tag').execute();
  await db.schema.dropIndex('idx_tag_palette_items_palette').execute();
  await db.schema.dropTable('tag_palette_items').execute();
  await db.schema.dropTable('tag_palettes').execute();
}