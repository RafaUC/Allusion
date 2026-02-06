/* eslint-disable prettier/prettier */
import { Kysely, sql } from 'kysely';

/*
Migration to create the SQLite database. Note that SQL table and column names
are in snake_case, which will later be converted to camelCase
by the Kysely camel case plugin.
*/

export async function up(db: Kysely<any>): Promise<void> {
  //// TAGS ////
  await db.schema
    .createTable('tags')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('color', 'text')
    .addColumn('is_hidden', 'boolean', (col) => col.notNull().defaultTo(0))
    .addColumn('is_visible_inherited', 'boolean', (col) => col.notNull().defaultTo(1))
    .addColumn('is_header', 'boolean', (col) => col.notNull().defaultTo(0))
    .addColumn('description', 'text')
    .addColumn('file_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_file_count_dirty', 'boolean', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable('sub_tags')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('sub_tag_id', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_tag_implications', ['tag_id', 'sub_tag_id'])
    .addForeignKeyConstraint('fk_tag_implications_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_tag_implications_implied', ['sub_tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .addUniqueConstraint('uq_sub_tags_sub_tag', ['sub_tag_id'])
    .execute();

  await db.schema
    .createTable('tag_implications')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('implied_tag_id', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_tag_implications', ['tag_id', 'implied_tag_id'])
    .addForeignKeyConstraint('fk_tag_implications_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_tag_implications_implied', ['implied_tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  await db.schema
    .createTable('tag_aliases')
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addColumn('alias', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_tag_aliases', ['tag_id', 'alias'])
    .addForeignKeyConstraint('fk_tag_aliases_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  //// LOCATIONS ////
  await db.schema
    .createTable('location_nodes')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('parent_id', 'text')
    .addColumn('path', 'text', (col) => col.notNull())
    .addForeignKeyConstraint('fk_location_node_parent', ['parent_id'], 'location_nodes', ['id'], (cb) => cb.onDelete('cascade'))
    .addUniqueConstraint('uq_location_node_parent_path', ['parent_id', 'path'])
    .execute();

  await db.schema
    .createTable('locations')
    .addColumn('node_id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('idx', 'integer', (col) => col.notNull())
    .addColumn('is_watching_files', 'boolean', (col) => col.notNull().defaultTo(0))
    .addForeignKeyConstraint('fk_location_node', ['node_id'], 'location_nodes', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  await db.schema
    .createTable('sub_locations')
    .addColumn('node_id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('is_excluded', 'boolean', (col) => col.notNull().defaultTo(0))
    .addForeignKeyConstraint('fk_sub_location_node', ['node_id'], 'location_nodes', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  await db.schema
    .createTable('location_tags')
    .addColumn('node_id', 'text', (col) => col.notNull())
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_location_tags', ['node_id', 'tag_id'])
    .addForeignKeyConstraint('fk_location_tags_node', ['node_id'], 'location_nodes', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_location_tags_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();

  //// FILES ////
  await db.schema
    .createTable('files')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('ino', 'text', (col) => col.notNull())
    .addColumn('location_id', 'text', (col) => col.notNull())
    .addColumn('relative_path', 'text', (col) => col.notNull())
    .addColumn('absolute_path', 'text', (col) => col.notNull().unique())
    .addColumn('tag_sorting', 'text', (col) => col.notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('date_modified', 'timestamp')
    .addColumn('date_modified_os', 'timestamp')
    .addColumn('date_last_indexed', 'timestamp')
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('extension', 'text')
    .addColumn('size', 'integer')
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('date_created', 'timestamp')
    .addForeignKeyConstraint('fk_files_location', ['location_id'], 'locations', ['node_id'], (cb) => cb.onDelete('cascade'))
    .execute();

  await db.schema
    .createTable('file_tags')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_file_tags', ['file_id', 'tag_id'])
    .addForeignKeyConstraint('fk_file_tags_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_file_tags_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_file_tags_tag').on('file_tags').column('tag_id').execute();
  await db.schema.createIndex('idx_file_tags_file').on('file_tags').column('file_id').execute();

  //// EXTRA PROPERTIES ////
  await db.schema
    .createTable('extra_properties')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable('ep_values')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('ep_id', 'text', (col) => col.notNull())
    .addColumn('text_value', 'text')
    .addColumn('number_value', 'integer')
    .addColumn('timestamp_value', 'timestamp')
    .addPrimaryKeyConstraint('pk_ep_values_text', ['file_id', 'ep_id'])
    .addForeignKeyConstraint('fk_ep_values_text_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_ep_values_text_ep', ['ep_id'], 'extra_properties', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_ep_values_text_value').ifNotExists().on('ep_values').column('text_value').execute();
  await db.schema.createIndex('idx_ep_values_number_value').ifNotExists().on('ep_values').column('number_value').execute();
  await db.schema.createIndex('idx_ep_values_timestamp_value').ifNotExists().on('ep_values').column('timestamp_value').execute();

  //// SAVED SEARCHES ////
await db.schema
  .createTable('saved_searches')
  .addColumn('id', 'text', (col) => col.primaryKey().notNull())
  .addColumn('name', 'text', (col) => col.notNull())
  .addColumn('idx', 'integer', (col) => col.notNull())
  .execute();

await db.schema
  .createTable('search_groups')
  .addColumn('id', 'text', (col) => col.primaryKey().notNull())
  .addColumn('name', 'text', (col) => col.notNull())
  .addColumn('saved_search_id', 'text', (col) => col.notNull())
  .addColumn('parent_group_id', 'text')
  .addColumn('idx', 'integer', (col) => col.notNull())
  .addColumn('conjunction', 'text', (col) => col.notNull())
  .addForeignKeyConstraint('fk_search_groups_saved_search',  ['saved_search_id'], 'saved_searches',  ['id'],  (cb) => cb.onDelete('cascade'))
  .addForeignKeyConstraint('fk_search_groups_parent', ['parent_group_id'], 'search_groups',  ['id'], (cb) => cb.onDelete('cascade'))
  .execute();
await db.schema.createIndex('idx_search_groups_saved_search').on('search_groups').column('saved_search_id').execute();
await db.schema.createIndex('idx_search_groups_parent').on('search_groups').column('parent_group_id').execute();

await db.schema
  .createTable('search_criteria')
  .addColumn('id', 'text', (col) => col.primaryKey().notNull())
  .addColumn('group_id', 'text', (col) => col.notNull())
  .addColumn('idx', 'integer', (col) => col.notNull())
  .addColumn('key', 'text', (col) => col.notNull())
  .addColumn('value_type', 'text', (col) => col.notNull())
  .addColumn('operator', 'text', (col) => col.notNull())
  .addColumn('json_value', 'text', (col) => col.notNull())
  .addForeignKeyConstraint('fk_search_criteria_group', ['group_id'], 'search_groups', ['id'], (cb) => cb.onDelete('cascade'))
  .execute();
await db.schema.createIndex('idx_search_criteria_group').on('search_criteria').column('group_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_ep_values_text_value').execute();
  await db.schema.dropIndex('idx_ep_values_number_value').execute();
  await db.schema.dropIndex('idx_ep_values_timestamp_value').execute();
  await db.schema.dropIndex('idx_file_tags_file').execute();
  await db.schema.dropIndex('idx_file_tags_tag').execute();
  await db.schema.dropTable('search_criteria').execute();
  await db.schema.dropTable('saved_searches').execute();
  await db.schema.dropTable('ep_values_timestamp').execute();
  await db.schema.dropTable('ep_values_number').execute();
  await db.schema.dropTable('ep_values_text').execute();
  await db.schema.dropTable('extra_properties').execute();
  await db.schema.dropTable('file_tags').execute();
  await db.schema.dropTable('files').execute();
  await db.schema.dropTable('location_tags').execute();
  await db.schema.dropTable('sub_locations').execute();
  await db.schema.dropTable('locations').execute();
  await db.schema.dropTable('location_nodes').execute();
  await db.schema.dropTable('tag_aliases').execute();
  await db.schema.dropTable('tag_implications').execute();
  await db.schema.dropTable('tags').execute();
}
