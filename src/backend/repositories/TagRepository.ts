import { Insertable, Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import {
  AllusionDB_SQL,
  deserializeBoolean,
  deserializeDate,
  serializeBoolean,
  serializeDate,
  SubTags,
  TagAliases,
  TagImplications,
} from '../schemaTypes';
import { TagDTO, ROOT_TAG_ID } from 'src/api/tag';
import { ID } from 'src/api/id';
import { upsertTable } from '../backend';

export class TagRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #maxVars: number;
  readonly #notifyChange: () => void;
  /** True when file_tag_aggregates_temp needs recomputation before a file query */
  isQueryDirty = true;

  constructor(db: Kysely<AllusionDB_SQL>, maxVars: number, notifyChange: () => void) {
    this.#db = db;
    this.#maxVars = maxVars;
    this.#notifyChange = notifyChange;
  }

  async fetchTags(): Promise<TagDTO[]> {
    console.info('SQLite: Fetching tags...');
    const tags = (
      await this.#db
        .selectFrom('tags')
        .selectAll('tags')
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('subTags')
              .select('subTags.subTagId')
              .whereRef('subTags.tagId', '=', 'tags.id')
              .orderBy('subTags.idx'),
          ).as('subTags'),
          jsonArrayFrom(
            eb
              .selectFrom('tagImplications')
              .select('tagImplications.impliedTagId')
              .whereRef('tagImplications.tagId', '=', 'tags.id'),
          ).as('impliedTags'),
          jsonArrayFrom(
            eb
              .selectFrom('tagAliases')
              .select('tagAliases.alias')
              .whereRef('tagAliases.tagId', '=', 'tags.id'),
          ).as('aliases'),
        ])
        .execute()
    )
      // convert data into TagDTO format
      .map((dbTag) => ({
        id: dbTag.id,
        name: dbTag.name,
        dateAdded: deserializeDate(dbTag.dateAdded),
        color: dbTag.color,
        subTags: dbTag.subTags.map((st) => st.subTagId),
        impliedTags: dbTag.impliedTags.map((it) => it.impliedTagId),
        isHidden: deserializeBoolean(dbTag.isHidden),
        isVisibleInherited: deserializeBoolean(dbTag.isVisibleInherited),
        isHeader: deserializeBoolean(dbTag.isHeader),
        aliases: dbTag.aliases.map((a) => a.alias),
        description: dbTag.description,
        fileCount: dbTag.fileCount,
        isFileCountDirty: deserializeBoolean(dbTag.isFileCountDirty),
      }));
    return tags;
  }

  // Original implementation by Pianissi
  // Because creating the jsons takes a lot of time, let's preaggregate them everytime we save our files.
  async preAggregateJSON(): Promise<void> {
    console.info('SQLite: Updating temp aggregates...');
    await sql`
      DROP TABLE IF EXISTS file_tag_aggregates_temp;
    `.execute(this.#db);
    await sql`
      DROP TABLE IF EXISTS file_ep_aggregates_temp;
    `.execute(this.#db);

    await sql`
      CREATE TEMPORARY TABLE IF NOT EXISTS file_tag_aggregates_temp AS
      SELECT
        file_id,
        json_group_array(tag_id) AS tags
      FROM file_tags
      GROUP BY file_id;
    `.execute(this.#db);
    await sql`
      CREATE TEMPORARY TABLE IF NOT EXISTS file_ep_aggregates_temp AS
      SELECT
        file_id,
        json_group_array(json_object(
          'file_id', file_id,
          'ep_id', ep_id,
          'text_value', text_value,
          'number_value', number_value,
          'timestamp_value', timestamp_value))
        as extra_properties
      FROM ep_values
      GROUP BY file_id;
    `.execute(this.#db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_file_tag_aggregates_temp_file ON file_tag_aggregates_temp(file_id);
    `.execute(this.#db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_file_ep_aggregates_temp_file ON file_ep_aggregates_temp(file_id);
    `.execute(this.#db);
    this.isQueryDirty = false;
  }

  async createTag(tag: TagDTO): Promise<void> {
    console.info('SQLite: Creating tag...', tag);
    return this.upsertTag(tag);
  }

  async saveTag(tag: TagDTO): Promise<void> {
    console.info('SQLite: Saving tag...', tag);
    return this.upsertTag(tag);
  }

  async upsertTag(tag: TagDTO): Promise<void> {
    const { tagIds, tags, subTags, tagImplications, tagAliases } = normalizeTags([tag]);
    if (tags.length === 0) {
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('subTags').where('tagId', 'in', tagIds).execute();
      await trx.deleteFrom('tagImplications').where('tagId', 'in', tagIds).execute();
      await trx.deleteFrom('tagAliases').where('tagId', 'in', tagIds).execute();
      await upsertTable(this.#maxVars, trx, 'tags', tags, ['id'], ['dateAdded']);
      if (subTags.length > 0) {
        await upsertTable(this.#maxVars, trx, 'subTags', subTags, ['tagId', 'subTagId']);
      }
      if (tagImplications.length > 0) {
        await upsertTable(this.#maxVars, trx, 'tagImplications', tagImplications, ['tagId', 'impliedTagId']); // eslint-disable-line prettier/prettier
      }
      if (tagAliases.length > 0) {
        await upsertTable(this.#maxVars, trx, 'tagAliases', tagAliases, ['tagId', 'alias']);
      }
    });
    this.#notifyChange();
  }

  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    console.info('SQLite: Merging tags...', tagToBeRemoved, tagToMergeWith);

    await this.#db.transaction().execute(async (trx) => {
      // Merge in FileTags
      // first delete the records that would make a duplicate
      await trx
        .deleteFrom('fileTags')
        .where('tagId', '=', tagToBeRemoved)
        .where('fileId', 'in', (eb) =>
          eb.selectFrom('fileTags').select('fileId').where('tagId', '=', tagToMergeWith),
        )
        .execute();
      // Update the thag ids
      await trx
        .updateTable('fileTags')
        .set({ tagId: tagToMergeWith })
        .where('tagId', '=', tagToBeRemoved)
        .execute();
      // Merge in locationTags
      await trx
        .deleteFrom('locationTags')
        .where('tagId', '=', tagToBeRemoved)
        .where('nodeId', 'in', (eb) =>
          eb.selectFrom('locationTags').select('nodeId').where('tagId', '=', tagToMergeWith),
        )
        .execute();
      await trx
        .updateTable('locationTags')
        .set({ tagId: tagToMergeWith })
        .where('tagId', '=', tagToBeRemoved)
        .execute();

      // delete the tag
      await trx.deleteFrom('tags').where('id', '=', tagToBeRemoved).execute();
    });
    this.#notifyChange();
  }

  async removeTags(tags: ID[]): Promise<void> {
    console.info('SQLite: Removing tags...', tags);
    // Cascade delte in other tables deleting from tags table.
    await this.#db.deleteFrom('tags').where('id', 'in', tags).execute();
    this.#notifyChange();
  }
}

function normalizeTags(tags: TagDTO[]) {
  const tagIds: ID[] = [];
  const subTags: Insertable<SubTags>[] = [];
  const tagImplications: Insertable<TagImplications>[] = [];
  const tagAliases: Insertable<TagAliases>[] = [];

  for (const tag of tags) {
    tagIds.push(tag.id);
    for (const [index, subTagId] of (Array.isArray(tag.subTags) ? tag.subTags : []).entries()) {
      subTags.push({ tagId: tag.id, subTagId: subTagId, idx: index });
    }
    for (const impliedTagId of Array.isArray(tag.impliedTags) ? tag.impliedTags : []) {
      tagImplications.push({ tagId: tag.id, impliedTagId: impliedTagId });
    }
    const aliases = new Set<string>(Array.isArray(tag.aliases) ? tag.aliases : []);
    for (const alias of aliases) {
      tagAliases.push({ tagId: tag.id, alias: alias });
    }
  }

  const normalizedTags = tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    isHidden: serializeBoolean(tag.isHidden),
    isVisibleInherited: serializeBoolean(tag.isVisibleInherited),
    isHeader: serializeBoolean(tag.isHeader),
    description: tag.description,
    dateAdded: serializeDate(tag.dateAdded),
    fileCount: tag.fileCount,
    isFileCountDirty: serializeBoolean(tag.isFileCountDirty),
  }));

  return { tagIds, tags: normalizedTags, subTags, tagImplications, tagAliases };
}
