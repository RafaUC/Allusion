import { Kysely } from 'kysely';

export async function up(db: Kysely<any>) {
  // tags
  await db.schema
    .createTable('tags')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('date_added', 'integer', (col) => col.notNull())
    .addColumn('color', 'text', (col) => col.notNull())
    .addColumn('is_hidden', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_visible_inherited', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_header', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('description', 'text')
    .execute();

  // N:N subTags
  await db.schema
    .createTable('tag_subtags')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('subtag_id', 'text', (col) => col.notNull())
    .addForeignKeyConstraint('fk_tag_subtags_tag', ['tag_id'], 'tags', ['id'])
    .addForeignKeyConstraint('fk_tag_subtags_subtag', ['subtag_id'], 'tags', ['id'])
    .execute();

  // N:N impliedTags
  await db.schema
    .createTable('tag_implied')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('implied_tag_id', 'text', (col) => col.notNull())
    .addForeignKeyConstraint('fk_tag_implied_tag', ['tag_id'], 'tags', ['id'])
    .addForeignKeyConstraint('fk_tag_implied_implied', ['implied_tag_id'], 'tags', ['id'])
    .execute();

  // Aliases
  await db.schema
    .createTable('tag_aliases')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('alias', 'text', (col) => col.notNull())
    .addForeignKeyConstraint('fk_tag_aliases_tag', ['tag_id'], 'tags', ['id'])
    .execute();
}

export async function down(db: Kysely<any>) {}
