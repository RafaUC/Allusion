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
    .addColumn('parent_id', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('color', 'text')
    .addColumn('is_hidden', 'boolean', (col) => col.notNull().defaultTo(0))
    .addColumn('is_visible_inherited', 'boolean', (col) => col.notNull().defaultTo(1))
    .addColumn('is_header', 'boolean', (col) => col.notNull().defaultTo(0))
    .addColumn('description', 'text')
    .addForeignKeyConstraint('fk_tag_parent', ['parent_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
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
    .addColumn('absolute_path', 'text', (col) => col.notNull())
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
    .addUniqueConstraint('uq_location_node_parent_path', ['location_id', 'relative_path'])
    .addUniqueConstraint('uq_absolute_path', ['relative_path'])
    .execute();
  // await db.schema.createIndex('idx_files_name').on('files').column('name').execute();
  // await db.schema.createIndex('idx_files_extension').on('files').column('extension').execute();
  // await db.schema.createIndex('idx_files_size').on('files').column('size').execute();
  // await db.schema.createIndex('idx_files_width').on('files').column('width').execute();
  // await db.schema.createIndex('idx_files_height').on('files').column('height').execute();
  // await db.schema.createIndex('idx_files_date_added').on('files').column('date_added').execute();
  // await db.schema.createIndex('idx_files_date_modified').on('files').column('date_modified').execute();
  // await db.schema.createIndex('idx_files_date_created').on('files').column('date_created').execute();
  // await db.schema.createIndex('idx_files_relative_path').on('files').column('relative_path').unique().execute();
  // await db.schema.createIndex('idx_files_location').on('files').column('location_id').execute();

  await db.schema
    .createTable('file_tags')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('tag_id', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_file_tags', ['file_id', 'tag_id'])
    .addForeignKeyConstraint('fk_file_tags_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_file_tags_tag', ['tag_id'], 'tags', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  //await db.schema.createIndex('idx_file_tags_tag').on('file_tags').column('tag_id').execute();
  //await db.schema.createIndex('idx_file_tags_file').on('file_tags').column('file_id').execute();

  //// EXTRA PROPERTIES ////
  await db.schema
    .createTable('extra_properties')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('date_added', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable('ep_values_text')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('ep_id', 'text', (col) => col.notNull())
    .addColumn('value', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_ep_values_text', ['file_id', 'ep_id'])
    .addForeignKeyConstraint('fk_ep_values_text_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_ep_values_text_ep', ['ep_id'], 'extra_properties', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_ep_values_text_file').on('ep_values_text').column('file_id').execute();
  await db.schema.createIndex('idx_ep_values_text_value').on('ep_values_text').column('value').execute();
  await db.schema.createIndex('idx_ep_values_text_ep').on('ep_values_text').column('ep_id').execute();


  await db.schema
    .createTable('ep_values_number')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('ep_id', 'text', (col) => col.notNull())
    .addColumn('value', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_ep_values_number', ['file_id', 'ep_id'])
    .addForeignKeyConstraint('fk_ep_values_number_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_ep_values_number_ep', ['ep_id'], 'extra_properties', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_ep_values_number_file').on('ep_values_number').column('file_id').execute();
  await db.schema.createIndex('idx_ep_values_number_value').on('ep_values_number').column('value').execute();
  await db.schema.createIndex('idx_ep_values_number_ep').on('ep_values_number').column('ep_id').execute();

  await db.schema
    .createTable('ep_values_timestamp')
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('ep_id', 'text', (col) => col.notNull())
    .addColumn('value', 'timestamp', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_ep_values_timestamp', ['file_id', 'ep_id'])
    .addForeignKeyConstraint('fk_ep_values_timestamp_file', ['file_id'], 'files', ['id'], (cb) => cb.onDelete('cascade'))
    .addForeignKeyConstraint('fk_ep_values_timestamp_ep', ['ep_id'], 'extra_properties', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_ep_values_timestamp_file').on('ep_values_timestamp').column('file_id').execute();
  await db.schema.createIndex('idx_ep_values_timestamp_value').on('ep_values_timestamp').column('value').execute();
  await db.schema.createIndex('idx_ep_values_timestamp_ep').on('ep_values_timestamp').column('ep_id').execute();

  //// SAVED SEARCHES ////
  await db.schema
    .createTable('saved_searches')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('search_criteria')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('saved_search_id', 'text', (col) => col.notNull())
    .addColumn('idx', 'integer', (col) => col.notNull())
    .addColumn('match_group', 'text', (col) => col.notNull()) // 'any' | 'all'
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('value_type', 'text', (col) => col.notNull())
    .addColumn('operator', 'text', (col) => col.notNull())
    .addColumn('json_value', 'text', (col) => col.notNull())
    .addForeignKeyConstraint('fk_search_criteria_saved_search', ['saved_search_id'], 'saved_searches', ['id'], (cb) => cb.onDelete('cascade'))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_ep_values_text_file').execute();
  await db.schema.dropIndex('idx_ep_values_text_value').execute();
  await db.schema.dropIndex('idx_ep_values_text_ep').execute();

  await db.schema.dropIndex('idx_ep_values_number_file').execute();
  await db.schema.dropIndex('idx_ep_values_number_value').execute();
  await db.schema.dropIndex('idx_ep_values_number_ep').execute();

  await db.schema.dropIndex('idx_ep_values_timestamp_file').execute();
  await db.schema.dropIndex('idx_ep_values_timestamp_value').execute();
  await db.schema.dropIndex('idx_ep_values_timestamp_ep').execute();

  await db.schema.dropIndex('idx_file_tags_file').execute();
  await db.schema.dropIndex('idx_file_tags_tag').execute();

  await db.schema.dropIndex('idx_files_location').execute();
  await db.schema.dropIndex('idx_files_relative_path').execute();
  await db.schema.dropIndex('idx_files_date_created').execute();
  await db.schema.dropIndex('idx_files_date_modified').execute();
  await db.schema.dropIndex('idx_files_date_added').execute();
  await db.schema.dropIndex('idx_files_height').execute();
  await db.schema.dropIndex('idx_files_width').execute();
  await db.schema.dropIndex('idx_files_size').execute();
  await db.schema.dropIndex('idx_files_extension').execute();
  await db.schema.dropIndex('idx_files_name').execute();

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
