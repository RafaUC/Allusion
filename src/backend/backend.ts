import {
  AllusionDB_SQL,
  deserializeBoolean,
  deserializeDate,
  EpValues,
  Files,
  LocationNodes,
  Locations,
  LocationTags,
  serializeBoolean,
  serializeDate,
  SubLocations,
  TagAliases,
  TagImplications,
  ExtraProperties as DbExtraProperties,
  SavedSearches,
  SearchCriteria,
  FileTags,
  SubTags,
  SearchGroups,
} from './schemaTypes';
import SQLite from 'better-sqlite3';
import {
  Kysely,
  SqliteDialect,
  ParseJSONResultsPlugin,
  CamelCasePlugin,
  sql,
  SelectQueryBuilder,
  SqlBool,
  ExpressionBuilder,
  OrderByDirection,
  AnyColumn,
  Insertable,
  Expression,
} from 'kysely';
import { kyselyLogger, migrateToLatest, PAD_STRING_LENGTH } from './config';
import { DataStorage } from 'src/api/data-storage';
import { IndexableType } from '../api/data-storage';
import {
  OrderBy,
  OrderDirection,
  ConditionDTO,
  StringOperatorType,
  NumberOperatorType,
  ArrayOperatorType,
  ExtraPropertyOperatorType,
  isNumberOperator,
  isStringOperator,
  PropertyKeys,
  StringProperties,
  SearchConjunction,
  ConditionGroupDTO,
} from 'src/api/data-storage-search';
import { ExtraProperties, ExtraPropertyDTO } from 'src/api/extraProperty';
import { FileDTO } from 'src/api/file';
import { FileSearchDTO, SearchGroupDTO } from 'src/api/file-search';
import { generateId, ID } from 'src/api/id';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ROOT_TAG_ID, TagDTO } from 'src/api/tag';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { IS_DEV } from 'common/process';
import { UpdateObject } from 'kysely/dist/cjs/parser/update-set-parser';

// Use to debug perfomance.
const USE_TIMING_PROXY = IS_DEV;
const USE_QUERY_LOGGER = false ? IS_DEV : false;

export default class Backend implements DataStorage {
  readonly MAX_VARS!: number;
  #db!: Kysely<AllusionDB_SQL>;
  #dbPath!: string;
  #notifyChange!: () => void;
  #restoreEmpty!: () => Promise<void>;
  /** State variable that indicates if we need to recompute preAggregateJSON */
  #isQueryDirty: boolean = true;

  constructor() {
    // Must call init() before using to init the properties.
    return USE_TIMING_PROXY ? createTimingProxy(this) : this;
  }

  async init(
    dbPath: string,
    jsonToImport: string | undefined,
    notifyChange: () => void,
    restoreEmpty: () => Promise<void>,
    mode: 'default' | 'migrate' | 'readonly' = 'default',
  ): Promise<void> {
    console.info(`SQLite3: Initializing database "${dbPath}"...`);
    // For some reason, if initializing the better-sqlite3 db with readonly true, later when disposing the instance,
    // it does not remove the WAL files, which is bothersome to leave in the backup directory.
    //const isReadOnly = mode === 'readonly';
    const database = new SQLite(dbPath, { timeout: 50000 }); //, readonly: isReadOnly });

    // HACK Use a padded string to do natural sorting
    database.function('pad_string', { deterministic: true }, (str) => {
      return str.replace(/\d+/g, (num: string) => num.padStart(PAD_STRING_LENGTH, '0'));
    });

    const dialect = new SqliteDialect({ database });
    const db = new Kysely<AllusionDB_SQL>({
      dialect: dialect,
      plugins: [new ParseJSONResultsPlugin(), new CamelCasePlugin()],
      log: USE_QUERY_LOGGER ? kyselyLogger : undefined, // Used only for debugging.
    });

    // Instead of initializing this through the constructor, set the class properties here,
    // this allows us to use the class as a worker having async await calls at init.
    this.#db = db;
    this.#dbPath = dbPath;
    this.#notifyChange = notifyChange;
    this.#restoreEmpty = restoreEmpty;
    (this as any).MAX_VARS = await getSqliteMaxVariables(db);

    // Run migrations if required
    if (mode === 'default' || mode === 'migrate') {
      await migrateToLatest(db, { jsonToImport });
    }

    if (mode === 'migrate' || mode === 'readonly') {
      return;
    }
    // Configure PRAGMA settings (these can create WAL/SHM files)
    // Enable WAL mode to not wait for writes and optimize database
    await sql`PRAGMA journal_mode = WAL;`.execute(db);
    await sql`PRAGMA case_sensitive_like = ON;`.execute(db);
    await sql`PRAGMA synchronous = NORMAL;`.execute(db);
    await sql`PRAGMA temp_store = MEMORY;`.execute(db);
    await sql`PRAGMA automatic_index = ON;`.execute(db);
    await sql`PRAGMA cache_size = -64000;`.execute(db);
    await sql`PRAGMA OPTIMIZE;`.execute(db);

    // Create Root Tag if not exists.
    const rootTag = await db
      .selectFrom('tags')
      .selectAll()
      .where('id', '=', ROOT_TAG_ID)
      .executeTakeFirst();
    if (!rootTag) {
      await db
        .insertInto('tags')
        .values({
          id: ROOT_TAG_ID,
          name: 'Root',
          dateAdded: serializeDate(new Date()),
          color: '',
          isHidden: serializeBoolean(false),
          isVisibleInherited: serializeBoolean(false),
          description: '',
          isHeader: serializeBoolean(false),
        })
        .execute();
    }
    await this.preAggregateJSON();
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
    this.#isQueryDirty = false;
  }

  async queryFiles(
    criteria: ConditionGroupDTO<FileDTO> = { conjunction: 'and', children: [] },
    sortOptions: SortOptions,
    keyInListOptions?: KeyInListOptions,
  ): Promise<FileDTO[]> {
    if (this.#isQueryDirty) {
      await this.preAggregateJSON();
    }
    const dbWithTemp = this.#db.withTables<{
      fileTagAggregatesTemp: {
        fileId: ID;
        tags: ID[];
      };
      fileEpAggregatesTemp: {
        fileId: ID;
        extraProperties: EpValues[];
      };
    }>();
    // Apply the filter criterias expressions to the files QueryBuilder and execute the query.
    let query;
    query = dbWithTemp
      .selectFrom('files')
      .leftJoin('fileTagAggregatesTemp as ft', 'ft.fileId', 'files.id')
      .leftJoin('fileEpAggregatesTemp as fe', 'fe.fileId', 'files.id')
      .selectAll('files')
      .select(['ft.tags', 'fe.extraProperties']);
    query = applyFileFilters(query, criteria as unknown as ConditionGroupDTO<Files>);
    query = await applySortOrder(this.#db, query, sortOptions);
    if (keyInListOptions) {
      query = query.where(keyInListOptions.key, 'in', keyInListOptions.values);
    }

    const files = (await query.execute()).map((dbFile): FileDTO => {
      // convert data into FileDTO format
      const extraPropertyIDs: ID[] = [];
      const extraProperties: ExtraProperties = {};
      for (const ep of dbFile.extraProperties ?? []) {
        extraPropertyIDs.push(ep.epId);
        const val = ep.textValue ?? ep.numberValue; // ?? ep.timestampValue;
        if (val) {
          extraProperties[ep.epId] = val;
        }
      }
      return {
        id: dbFile.id,
        ino: dbFile.ino,
        locationId: dbFile.locationId,
        relativePath: dbFile.relativePath,
        absolutePath: dbFile.absolutePath,
        tagSorting: dbFile.tagSorting,
        dateAdded: deserializeDate(dbFile.dateAdded),
        dateModified: deserializeDate(dbFile.dateModified),
        dateModifiedOS: deserializeDate(dbFile.dateModifiedOS),
        dateLastIndexed: deserializeDate(dbFile.dateLastIndexed),
        dateCreated: deserializeDate(dbFile.dateCreated),
        name: dbFile.name,
        extension: dbFile.extension,
        size: dbFile.size,
        width: dbFile.width,
        height: dbFile.height,
        tags: dbFile.tags ?? [],
        extraProperties: extraProperties,
      };
    });
    return files;
  }

  async fetchFiles(
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]> {
    console.info('SQLite: Fetching all files...');
    return this.queryFiles(undefined, {
      order,
      direction: fileOrder,
      useNaturalOrdering,
      extraPropertyID,
    });
  }

  async searchFiles(
    criteria: ConditionGroupDTO<FileDTO>,
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]> {
    console.info('SQLite: Searching files...', criteria);
    return this.queryFiles(criteria, {
      order,
      direction: fileOrder,
      useNaturalOrdering,
      extraPropertyID,
    });
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by ID...', ids);
    return this.queryFiles(undefined, { order: 'dateAdded' }, { key: 'id', values: ids });
  }

  async fetchFilesByKey(key: keyof FileDTO, value: IndexableType): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by key...');
    if (!['tags', 'extraProperties', 'extraPropertyIDs'].includes(key) && Array.isArray(value)) {
      return this.queryFiles(
        undefined,
        { order: 'dateAdded' },
        { key: key as keyof Files, values: value },
      );
    }
    console.error('fetchFilesByKey error: Key or values not supported.');
    return [];
  }

  async fetchLocations(): Promise<LocationDTO[]> {
    console.info('SQLite: Fetching locations...');
    /** Map to quicly find a node and his parent <nodeId, nodeInsatnce, parentId>  */
    const locationNodesMap = new Map<ID, [{ subLocations: SubLocationDTO[] }, ID | null]>();
    const locations: LocationDTO[] = (
      await this.#db
        .selectFrom('locations')
        .innerJoin('locationNodes as node', 'node.id', 'locations.nodeId')
        .selectAll()
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('locationTags')
              .select('locationTags.tagId')
              .whereRef('locationTags.nodeId', '=', 'locations.nodeId'),
          ).as('tags'),
        ])
        .execute()
    ).map((dbLoc) => {
      // convert data into LocationDTO format
      const lc: LocationDTO = {
        id: dbLoc.id,
        path: dbLoc.path,
        dateAdded: deserializeDate(dbLoc.dateAdded),
        subLocations: [],
        tags: dbLoc.tags.map((t) => t.tagId),
        index: dbLoc.idx,
        isWatchingFiles: deserializeBoolean(dbLoc.isWatchingFiles),
      };
      locationNodesMap.set(dbLoc.id, [lc, dbLoc.parentId]);
      return lc;
    });
    const subLocations: SubLocationDTO[] = (
      await this.#db
        .selectFrom('subLocations')
        .innerJoin('locationNodes as node', 'node.id', 'subLocations.nodeId')
        .selectAll()
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('locationTags')
              .select('locationTags.tagId')
              .whereRef('locationTags.nodeId', '=', 'subLocations.nodeId'),
          ).as('tags'),
        ])
        .execute()
    ).map((dbLoc) => {
      // convert data into SubLocationDTO format
      const slc: SubLocationDTO = {
        id: dbLoc.id,
        name: dbLoc.path,
        subLocations: [],
        tags: dbLoc.tags.map((t) => t.tagId),
        isExcluded: deserializeBoolean(dbLoc.isExcluded),
      };
      locationNodesMap.set(dbLoc.id, [slc, dbLoc.parentId]);
      return slc;
    });
    // Insert sublocations into their parents
    for (const subLocation of subLocations) {
      const parent = locationNodesMap.get(locationNodesMap.get(subLocation.id)?.[1] ?? '')?.[0];
      if (parent) {
        parent.subLocations.push(subLocation);
      }
    }
    return locations;
  }

  async fetchSearches(): Promise<FileSearchDTO[]> {
    console.info('SQLite: Fetching saved searches...');
    const groupsMap = new Map<ID, SearchGroupDTO & { parentGroupId: ID | null }>();
    // 1. Fetch searches
    const savedSearches = await this.#db.selectFrom('savedSearches').selectAll().execute();
    if (!savedSearches.length) {
      return [];
    }
    const savedSearchIds = savedSearches.map((s) => s.id);

    // 2. Fetch groups
    const dbGroups = await this.#db
      .selectFrom('searchGroups')
      .select(['id', 'name', 'savedSearchId', 'parentGroupId', 'idx', 'conjunction'])
      .where('savedSearchId', 'in', savedSearchIds)
      .orderBy('savedSearchId')
      .orderBy('parentGroupId')
      .orderBy('idx')
      .execute();

    for (const grp of dbGroups) {
      groupsMap.set(grp.id, {
        id: grp.id,
        name: grp.name,
        conjunction: grp.conjunction,
        children: [],
        parentGroupId: grp.parentGroupId,
      });
    }

    // 3. Fetch criteria
    const dbCriteria = await this.#db
      .selectFrom('searchCriteria')
      .select(['id', 'groupId', 'idx', 'key', 'valueType', 'operator', 'jsonValue'])
      .where('groupId', 'in', Array.from(groupsMap.keys()))
      .orderBy('groupId')
      .orderBy('idx')
      .execute();

    // 4. Attach criteria to their groups
    for (const crit of dbCriteria) {
      const parent = groupsMap.get(crit.groupId);
      if (!parent) {
        continue;
      }

      parent.children.push({
        id: crit.id,
        key: crit.key,
        operator: crit.operator,
        valueType: crit.valueType,
        value:
          // the ParseJSONResultsPlugin already parses the arrays but not strings
          crit.valueType === 'string' ? JSON.parse(crit.jsonValue as string) : crit.jsonValue,
      });
    }

    // Attach child groups to their parents
    const rootGroupsBySearch = new Map<ID, SearchGroupDTO>();

    for (const [groupId, group] of groupsMap) {
      if (group.parentGroupId) {
        const parent = groupsMap.get(group.parentGroupId);
        if (parent) {
          parent.children.push(group);
        }
      } else {
        // Root group
        const dbGroup = dbGroups.find((g) => g.id === groupId);
        if (dbGroup) {
          rootGroupsBySearch.set(dbGroup.savedSearchId, group);
        }
      }
    }

    // 6. Build final DTOs
    const searches: FileSearchDTO[] = savedSearches.map((search) => ({
      id: search.id,
      name: search.name,
      index: search.idx,
      rootGroup: rootGroupsBySearch.get(search.id) ?? {
        id: 'root-' + search.id,
        name: 'root-' + search.name,
        conjunction: 'and',
        children: [],
      },
    }));

    return searches;
  }

  async fetchExtraProperties(): Promise<ExtraPropertyDTO[]> {
    console.info('SQLite: Fetching extra properties...');
    const eProperties = (
      await this.#db.selectFrom('extraProperties').selectAll().orderBy('name').execute()
    ).map(
      (dbEp): ExtraPropertyDTO => ({
        id: dbEp.id,
        type: dbEp.type,
        name: dbEp.name,
        dateAdded: deserializeDate(dbEp.dateAdded),
      }),
    );
    return eProperties;
  }

  async createTag(tag: TagDTO): Promise<void> {
    console.info('SQLite: Creating tag...', tag);
    return this.upsertTag(tag);
  }

  // Creates many files at once, and checks for duplicates in the path they are in
  async createFilesFromPath(path: string, filesDTO: FileDTO[]): Promise<void> {
    console.info('SQLite: Creating files...', path, filesDTO.length);

    if (filesDTO.length === 0) {
      return;
    }
    const { files } = normalizeFiles(filesDTO);
    const FILES_BATCH_SIZE = computeBatchSize(this.MAX_VARS, files[0]);
    await this.#db.transaction().execute(async (trx) => {
      for (let i = 0; i < files.length; i += FILES_BATCH_SIZE) {
        const batch = files.slice(i, i + FILES_BATCH_SIZE);
        try {
          await trx
            .insertInto('files')
            .values(batch)
            .onConflict((oc) => oc.doNothing())
            .execute();
        } catch (error) {
          console.error(`Failed to insert files batch at index ${i}:`, error);
        }
      }
    });
    this.#isQueryDirty = true;
    this.#notifyChange();
    console.info('SQLite: Files created successfully');
  }

  async createLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Creating location...', location);
    return this.upsertLocation(location);
  }

  async createSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Creating search...', search);
    return this.upsertSearch(search);
  }

  async createExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('SQLite: Creating extra property...', extraProperty);
    return this.upsertExtraProperty(extraProperty);
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
      await upsertTable(trx, 'tags', tags, ['id'], ['dateAdded']);
      if (subTags.length > 0) {
        await upsertTable(trx, 'subTags', subTags, ['tagId', 'subTagId']);
      }
      if (tagImplications.length > 0) {
        await upsertTable(trx, 'tagImplications', tagImplications, ['tagId', 'impliedTagId']);
      }
      if (tagAliases.length > 0) {
        await upsertTable(trx, 'tagAliases', tagAliases, ['tagId', 'alias']);
      }
    });
    this.#notifyChange();
  }

  async saveFiles(filesDTO: FileDTO[]): Promise<void> {
    console.info('SQLite: Saving files...', filesDTO);
    if (filesDTO.length === 0) {
      return;
    }

    const { fileIds, files, fileTags, epVal } = normalizeFiles(filesDTO);

    // Compute batch sizes. To use the maximum number of vars SQLite can handle per query.
    const DELETE_BATCH_SIZE = this.MAX_VARS;
    const FILES_BATCH_SIZE = computeBatchSize(this.MAX_VARS, files[0]);
    const FILE_TAGS_BATCH_SIZE = computeBatchSize(this.MAX_VARS, fileTags[0]);
    const EP_VALUES_BATCH_SIZE = computeBatchSize(this.MAX_VARS, epVal[0]);

    await this.#db.transaction().execute(async (trx) => {
      // Create unique temp table names.
      const tempSuffix = generateId();
      const tempFiles = `files_temp_${tempSuffix}`;
      const tempFileTags = `file_tags_temp_${tempSuffix}`;
      const tempEpValues = `ep_values_temp_${tempSuffix}`;

      try {
        // Create temp tables form a copy of the actual tables.
        await sql`CREATE TEMP TABLE ${sql.id(tempFiles)} AS SELECT * FROM files WHERE 0`.execute(
          trx,
        );
        await sql`CREATE TEMP TABLE ${sql.id(
          tempFileTags,
        )} AS SELECT * FROM file_tags WHERE 0`.execute(trx);
        await sql`CREATE TEMP TABLE ${sql.id(
          tempEpValues,
        )} AS SELECT * FROM ep_values WHERE 0`.execute(trx);
        // Insert files into temp files table
        for (let i = 0; i < files.length; i += FILES_BATCH_SIZE) {
          const batch = files.slice(i, i + FILES_BATCH_SIZE);
          await trx
            .insertInto(tempFiles as any)
            .values(batch)
            .execute();
        }
        // Delete previous fileTags and epValues, it is quicker to delete all from related files and insert them in bulk.
        if (fileIds.length > 0) {
          for (let i = 0; i < fileIds.length; i += DELETE_BATCH_SIZE) {
            const batchIds = fileIds.slice(i, i + DELETE_BATCH_SIZE);
            await trx.deleteFrom('fileTags').where('fileId', 'in', batchIds).execute();
            await trx.deleteFrom('epValues').where('fileId', 'in', batchIds).execute();
          }
        }
        // Insert fileTags into temp table
        if (fileTags.length > 0) {
          for (let i = 0; i < fileTags.length; i += FILE_TAGS_BATCH_SIZE) {
            const batch = fileTags.slice(i, i + FILE_TAGS_BATCH_SIZE);
            await trx
              .insertInto(tempFileTags as any)
              .values(batch)
              .execute();
          }
        }
        // Insert epValues into temp table
        if (epVal.length > 0) {
          for (let i = 0; i < epVal.length; i += EP_VALUES_BATCH_SIZE) {
            const batch = epVal.slice(i, i + EP_VALUES_BATCH_SIZE);
            await trx
              .insertInto(tempEpValues as any)
              .values(batch)
              .execute();
          }
        }
        // Transfer from temp tables
        // Upsert FILES
        upsertTable(
          trx,
          'files',
          sql`SELECT * FROM ${sql.id(tempFiles)} WHERE true`,
          ['id'],
          ['dateAdded'],
          files[0],
        );
        // Insert FileTags
        if (fileTags.length > 0) {
          await sql`
          INSERT INTO file_tags 
          SELECT * FROM ${sql.id(tempFileTags)}
        `.execute(trx);
        }
        // Insert EpValues
        if (epVal.length > 0) {
          await sql`
          INSERT INTO ep_values 
          SELECT * FROM ${sql.id(tempEpValues)}
        `.execute(trx);
        }
        this.#isQueryDirty = true;
        console.info('SQLite: Files saved successfully');
      } finally {
        // Clean temp table.
        await sql`DROP TABLE IF EXISTS ${sql.id(tempFiles)}`.execute(trx);
        await sql`DROP TABLE IF EXISTS ${sql.id(tempFileTags)}`.execute(trx);
        await sql`DROP TABLE IF EXISTS ${sql.id(tempEpValues)}`.execute(trx);
      }
    });
    this.#notifyChange();
  }

  async saveLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Saving location...', location);
    return this.upsertLocation(location);
  }

  async upsertLocation(location: LocationDTO): Promise<void> {
    const { nodeIds, locationNodes, locations, subLocations, locationTags } = normalizeLocations([
      location,
    ]);
    if (locationNodes.length === 0) {
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('locationTags').where('nodeId', 'in', nodeIds).execute();
      await trx.deleteFrom('locationNodes').where('parentId', 'in', nodeIds).execute();
      await upsertTable(trx, 'locationNodes', locationNodes, ['id']);
      if (locations.length > 0) {
        await upsertTable(trx, 'locations', locations, ['nodeId'], ['dateAdded']);
      }
      if (subLocations.length > 0) {
        await upsertTable(trx, 'subLocations', subLocations, ['nodeId']);
      }
      if (locationTags.length > 0) {
        await upsertTable(trx, 'locationTags', locationTags, ['nodeId', 'tagId']);
      }
    });
    this.#notifyChange();
  }

  async saveSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Saving search...', search);
    return this.upsertSearch(search);
  }

  async upsertSearch(search: FileSearchDTO): Promise<void> {
    const { savedSearchesIds, savedSearches, searchGroups, searchCriteria } =
      normalizeSavedSearches([search]);
    if (savedSearches.length === 0) {
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('searchGroups').where('savedSearchId', 'in', savedSearchesIds).execute();
      await upsertTable(trx, 'savedSearches', savedSearches, ['id']);
      if (searchGroups.length > 0) {
        await upsertTable(trx, 'searchGroups', searchGroups, ['id']);
      }
      if (searchCriteria.length > 0) {
        await upsertTable(trx, 'searchCriteria', searchCriteria, ['id']);
      }
    });
    this.#notifyChange();
  }

  async saveExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('SQLite: Saving extra property...', extraProperty);
    return this.upsertExtraProperty(extraProperty);
  }

  async upsertExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    const extraProperties: Insertable<DbExtraProperties>[] = [extraProperty].map((ep) => ({
      id: ep.id,
      type: ep.type,
      name: ep.name,
      dateAdded: serializeDate(ep.dateAdded),
    }));
    await this.#db.transaction().execute(async (trx) => {
      await upsertTable(trx, 'extraProperties', extraProperties, ['id'], ['dateAdded']);
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

  async removeFiles(files: ID[]): Promise<void> {
    console.info('SQLite: Removing files...', files);
    // Cascade delte in other tables deleting from files table.
    await this.#db.deleteFrom('files').where('id', 'in', files).execute();
    this.#notifyChange();
  }

  async removeLocation(location: ID): Promise<void> {
    console.info('SQLite: Removing location...', location);
    // Cascade delte in other tables deleting from locationNodes table.
    await this.#db.deleteFrom('locationNodes').where('id', '=', location).execute();
    // Run VACUUM to free disk space after large deletions.
    await sql`VACUUM;`.execute(this.#db);
    this.#notifyChange();
  }

  async removeSearch(search: ID): Promise<void> {
    console.info('SQLite: Removing search...', search);
    // Cascade delte in other tables deleting from savedSearches table.
    await this.#db.deleteFrom('savedSearches').where('id', '=', search).execute();
    this.#notifyChange();
  }

  async removeExtraProperties(extraPropertyIDs: ID[]): Promise<void> {
    console.info('SQLite: Removing extra properties...', extraPropertyIDs);
    // Cascade delte in other tables deleting from extraProperties table.
    await this.#db.deleteFrom('extraProperties').where('id', 'in', extraPropertyIDs).execute();
    this.#notifyChange();
  }

  async countFiles(): Promise<[fileCount: number, untaggedFileCount: number]> {
    console.info('SQLite: Counting files...');
    const totalResult = await this.#db
      .selectFrom('files')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .executeTakeFirst();
    const fileCount = totalResult?.count ?? 0;

    const untaggedResult = await this.#db
      .selectFrom('files as f')
      .leftJoin('fileTags as ft', 'ft.fileId', 'f.id')
      .where('ft.fileId', 'is', null)
      .select(({ fn }) => fn.count<number>('f.id').as('count'))
      .executeTakeFirst();
    const untaggedFileCount = untaggedResult?.count ?? 0;
    return [fileCount, untaggedFileCount];
  }

  async clear(): Promise<void> {
    console.info('SQLite: Clearing database...');
    /*
    const tables = await this.#db
      .selectFrom('sqlite_master' as any)
      .select('name')
      .where('type', '=', 'table')
      .where('name', 'not like', 'sqlite_%')
      .execute();

    for (const { name } of tables) {
      if (name === 'kysely_migration' || name === 'kysely_migration_lock') {
        continue;
      }
      await this.#db.deleteFrom(name as any).execute();
    } */

    // Empy the tables with a large database takes too long, instead create an emprty DB,
    // reinit and restore it at startup relying in the backup-scheduler checkAndRestoreDB behaviour.
    await this.#restoreEmpty();
  }
}

// Creates a proxy that wraps the Backend instance to log the execution time of its methods.
function createTimingProxy(obj: Backend): Backend {
  console.log('Creating timing proxy for Backend');
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original === 'function') {
        return (...args: any[]) => {
          const startTime = performance.now();
          const result = original.apply(target, args);
          // Ensure both synchronous and asynchronous results are handled uniformly
          return Promise.resolve(result).then((res) => {
            const endTime = performance.now();
            console.log(`[Timing] ${String(prop)} took ${(endTime - startTime).toFixed(2)}ms`);
            return res;
          });
        };
      }
      return original;
    },
  });
}

export async function getSqliteMaxVariables(db: Kysely<AllusionDB_SQL>): Promise<number> {
  const rows = (await sql`PRAGMA compile_options`.execute(db)).rows;
  const opt: any = rows.find((r: any) => r.compileOptions?.includes('MAX_VARIABLE_NUMBER'));
  if (!opt) {
    console.warn('MAX_VARIABLE_NUMBER not found, using 22766');
    return 22766;
  }
  const maxVars = parseInt(opt.compileOptions.split('=')[1], 10);
  return isNaN(maxVars) ? 22766 : maxVars;
}

export function computeBatchSize(maxVars: number, sampleObject?: Record<string, any>): number {
  if (!sampleObject) {
    return 501;
  }
  const numCols = Object.keys(sampleObject).length;
  return Math.floor(maxVars / numCols);
}

///////////////////
///// SORTING /////
///////////////////

const exampleFileDTO: FileDTO = {
  id: '',
  ino: '',
  name: '',
  relativePath: '',
  absolutePath: '',
  locationId: '',
  extension: 'jpg',
  tagSorting: 'hierarchy',
  size: 0,
  width: 0,
  height: 0,
  dateAdded: new Date(),
  dateCreated: new Date(),
  dateLastIndexed: new Date(),
  dateModified: new Date(),
  dateModifiedOS: new Date(),
  extraProperties: {},
  tags: [],
};

function isFileDTOPropString(prop: PropertyKeys<FileDTO>): prop is StringProperties<FileDTO> {
  return typeof exampleFileDTO[prop] === 'string';
}

type SortOptions = {
  order: OrderBy<FileDTO>;
  direction?: OrderDirection;
  useNaturalOrdering?: boolean;
  extraPropertyID?: string;
};

// Original implementation by Pianissi
async function applySortOrder<O>(
  db: Kysely<AllusionDB_SQL>,
  q: SelectQueryBuilder<AllusionDB_SQL, 'files', O>,
  sortOptions: SortOptions,
): Promise<SelectQueryBuilder<AllusionDB_SQL, 'files', O>> {
  const { direction, useNaturalOrdering, extraPropertyID } = sortOptions;
  let { order } = sortOptions;

  const sqlDirection: OrderByDirection = direction === OrderDirection.Asc ? 'asc' : 'desc';
  // because of how the joined table is returned as, we need to aggregate a sort value in the joined table which can be used as a key
  if (order === 'extraProperty') {
    q = q.orderBy('sortValue' as any, sqlDirection);
    order = 'dateAdded';
  }

  if (order === 'random') {
    q = q.orderBy(sql`RANDOM()`);
  } else if (useNaturalOrdering && isFileDTOPropString(order)) {
    q = q.orderBy(sql`PAD_STRING(files.${sql.ref(order)})`, sqlDirection);
  } else {
    // Default
    q = q.orderBy(`files.${order}` as any, sqlDirection);
  }

  ///
  /// extraproperty optional value ///

  if (!extraPropertyID) {
    return q.select(sql<null>`NULL`.as('sortValue'));
  }
  const extraProp = await db
    .selectFrom('extraProperties' as any)
    .select('type')
    .where('id' as any, '=', extraPropertyID)
    .executeTakeFirst();
  if (!extraProp) {
    return q.select(sql<null>`NULL`.as('sortValue'));
  }
  // maping value type to column
  // TODO: add timestamp mapping when implementing
  const valueColumn = extraProp.type === 'text' ? 'textValue' : 'numberValue';
  // Left join the corresponding extraProperty value and select it as sortValue
  return q
    .leftJoin('epValues', (join) =>
      join.onRef('epValues.fileId', '=', 'files.id').on('epValues.epId', '=', extraPropertyID),
    )
    .select(`epValues.${valueColumn} as sortValue` as any) as any;
}

///////////////////////////
///////// FILTERS /////////
///////////////////////////

type KeyInListOptions = { key: AnyColumn<AllusionDB_SQL, 'files'>; values: any[] };

export type ConditionWithConjunction<T> = ConditionDTO<T> & {
  conjunction?: SearchConjunction;
};

function applyFileFilters<O>(
  q: SelectQueryBuilder<AllusionDB_SQL, 'files', O>,
  criteria?: ConditionGroupDTO<Files>,
): SelectQueryBuilder<AllusionDB_SQL, 'files', O> {
  if (!criteria || criteria.children.length === 0) {
    return q;
  }
  return q.where((eb) => expressionFromNode(eb, criteria));
}

function expressionFromNode(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  node: ConditionGroupDTO<Files> | ConditionDTO<Files>,
): ReturnType<typeof eb.or> | ReturnType<typeof expressionFromCriteria> {
  // if it's a condition
  if (!('children' in node)) {
    return expressionFromCriteria(eb, node);
  }
  // if it's a group recursively apply criterias
  const expressions = node.children.map((child) => expressionFromNode(eb, child)).filter(Boolean);
  // if no expressions return true for this criteria node
  if (expressions.length === 0) {
    return sql<SqlBool>`TRUE`;
  }
  return node.conjunction === 'or' ? eb.or(expressions) : eb.and(expressions);
}

const expressionFromCriteria = (
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  crit: ConditionDTO<Files>,
) => {
  switch (crit.valueType) {
    case 'string':
      return applyStringCondition(eb, crit.key, crit.operator, crit.value);
    case 'number':
      return applyNumberCondition(eb, crit.key, crit.operator, crit.value);
    case 'date':
      return applyDateCondition(eb, crit.key, crit.operator, crit.value);
    case 'array':
      return applyTagArrayCondition(eb, crit.key, crit.operator, crit.value);
    case 'indexSignature':
      return applyExtraPropertyCondition(eb, crit.key, crit.operator, crit.value);
  }
};

function applyStringCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: StringOperatorType,
  value: string,
) {
  switch (operator) {
    case 'equals':
      return eb(`files.${key}`, '=', value);
    case 'equalsIgnoreCase':
      return eb(sql`lower(${sql.ref(`files.${key}`)})`, '=', value.toLowerCase());
    case 'notEqual':
      return eb(`files.${key}`, '!=', value);
    case 'contains':
      return eb(`files.${key}`, 'like', `%${value}%`);
    case 'notContains':
      // use NOT LIKE
      return eb(`files.${key}`, 'not like', `%${value}%`);
    case 'startsWith':
      return eb(`files.${key}`, 'like', `${value}%`);
    case 'startsWithIgnoreCase':
      return eb(sql`lower(${sql.ref(`files.${key}`)})`, 'like', `${value.toLowerCase()}%`);
    case 'notStartsWith':
      return eb(`files.${key}`, 'not like', `${value}%`);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

function applyNumberCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: NumberOperatorType,
  value: number,
) {
  switch (operator) {
    case 'equals':
      return eb(`files.${key}`, '=', value);
    case 'notEqual':
      return eb(`files.${key}`, '!=', value);
    case 'smallerThan':
      return eb(`files.${key}`, '<', value);
    case 'smallerThanOrEquals':
      return eb(`files.${key}`, '<=', value);
    case 'greaterThan':
      return eb(`files.${key}`, '>', value);
    case 'greaterThanOrEquals':
      return eb(`files.${key}`, '>=', value);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

function applyDateCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: NumberOperatorType,
  value: Date,
) {
  // In DB dates are DateAsNumber, convert Date to number.
  const startOfDay = new Date(value);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(value);
  endOfDay.setHours(23, 59, 59, 999);
  const s = serializeDate(startOfDay);
  const e = serializeDate(endOfDay);

  switch (operator) {
    case 'equals':
      // equal to this day, so between 0:00 and 23:59
      return eb(`files.${key}`, '>=', s).and(`files.${key}`, '<=', e);
    case 'notEqual':
      // not equal to this day, so before 0:00 or after 23:59
      return eb.or([eb(`files.${key}`, '<', s), eb(`files.${key}`, '>', e)]);
    case 'smallerThan':
      return eb(`files.${key}`, '<', s);
    case 'smallerThanOrEquals':
      return eb(`files.${key}`, '<=', e);
    case 'greaterThan':
      return eb(`files.${key}`, '>', e);
    case 'greaterThanOrEquals':
      return eb(`files.${key}`, '>=', s);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

/**
 * Note / TODO:
 * Array and IndexSignature condition appliers would work the same way as the next two examples.
 * They could be used for any array or index signature property, but since those properties
 * only exist in the DTO objects (not in the raw fetched data from the database) and are instead
 * represented through relation tables, a mapping between the DTO property key and the corresponding
 * subquery table must be defined.
 *
 * Currently, since only the "tags" and "extraProperties" properties use these conditions,
 * the mapping is hard-coded to those specific database tables in each case.
 */

function applyTagArrayCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof FileDTO,
  operator: ArrayOperatorType,
  values: any[],
) {
  // If the key is not tags return a neutral condition (always true) to avoid breaking
  // the WHERE clause when no filter is applied
  if (key !== 'tags') {
    return sql<SqlBool>`TRUE`;
  }
  if (values.length === 0) {
    const anyTagFiles = eb.selectFrom('fileTags').select('fileId').distinct();
    if (operator === 'contains') {
      // files with 0 tags -> NOT EXISTS fileTags for this file
      return eb.not(eb('files.id', 'in', anyTagFiles));
    } else {
      // notContains empty -> files which have at least one tag
      return eb('files.id', 'in', anyTagFiles);
    }
  } else {
    const matchingFiles = eb
      .selectFrom('fileTags')
      .select('fileId')
      .where('tagId', 'in', values)
      .distinct();
    if (operator === 'contains') {
      return eb('files.id', 'in', matchingFiles);
    } else {
      // notContains: ensure NOT EXISTS any tag in the list for that file
      return eb.not(eb('files.id', 'in', matchingFiles));
    }
  }
}

function applyExtraPropertyCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof FileDTO,
  operator: NumberOperatorType | StringOperatorType | ExtraPropertyOperatorType,
  valueTuple: [string, any],
) {
  // If the key is not extraProperties return a neutral condition (always true)
  // to avoid breaking the WHERE clause when no filter is applied
  if (key !== 'extraProperties') {
    return sql<SqlBool>`TRUE`;
  }
  const [epID, innerValue] = valueTuple;
  let subquery = eb
    .selectFrom('extraProperties')
    .innerJoin('epValues', 'extraProperties.id', 'epValues.epId')
    .select('epValues.fileId')
    .distinct()
    .where('extraProperties.id', '=', epID);
  //.whereRef('epValues.fileId', '=', sql.ref('files.id'));

  if (operator === 'existsInFile') {
    return eb('files.id', 'in', subquery);
  }

  if (operator === 'notExistsInFile') {
    return eb.not(eb('files.id', 'in', subquery));
  }

  // For typed comparisons add an echtra filter to the subquery
  if (typeof innerValue === 'number' && isNumberOperator(operator)) {
    // prettier-ignore
    // use epValues.numberValue
    switch (operator) {
        case 'equals':
          subquery = subquery.where('epValues.numberValue', '=', innerValue);
          break;
        case 'notEqual':
          subquery = subquery.where('epValues.numberValue', '!=', innerValue);
          break;
        case 'greaterThan':
          subquery = subquery.where('epValues.numberValue', '>', innerValue);
          break;
        case 'greaterThanOrEquals':
          subquery = subquery.where('epValues.numberValue', '>=', innerValue);
          break;
        case 'smallerThan':
          subquery = subquery.where('epValues.numberValue', '<', innerValue);
          break;
        case 'smallerThanOrEquals':
          subquery = subquery.where('epValues.numberValue', '<=', innerValue);
          break;
        default:
          const _exhaustiveCheck: never = operator;
          return _exhaustiveCheck;
      }
  } else if (typeof innerValue === 'string' && isStringOperator(operator)) {
    // prettier-ignore
    // use epValues.textValue
    switch (operator) {
        case 'equals':
          subquery = subquery.where('epValues.textValue', '=', innerValue);
          break;
        case 'equalsIgnoreCase':
          subquery = subquery.where(sql`LOWER(epValues.textValue)`, '=', innerValue.toLowerCase());
          break;
        case 'notEqual':
          subquery = subquery.where('epValues.textValue', '=', innerValue);
          break;
        case 'contains':
          subquery = subquery.where('epValues.textValue', 'like', `%${innerValue}%`);
          break;
        case 'notContains':
          subquery = subquery.where('epValues.textValue', 'not like', `%${innerValue}%`);
          break;
        case 'startsWith':
          subquery = subquery.where('epValues.textValue', 'like', `${innerValue}%`);
          break;
        case 'notStartsWith':
          subquery = subquery.where('epValues.textValue', 'not like', `${innerValue}%`);
          break;
        case 'startsWithIgnoreCase':
          subquery = subquery.where(sql`LOWER(epValues.textValue)`, 'like', `${innerValue.toLowerCase()}%`);
          break;
        default:
          const _exhaustiveCheck: never = operator;
          return _exhaustiveCheck;
      }
  } else {
    throw new Error('Unsupported indexSignature value type');
  }
  // Return the expression
  return eb('files.id', 'in', subquery);
}

///////////////////
///// HELPERS /////
///////////////////

async function upsertTable<
  Table extends keyof AllusionDB_SQL,
  Columns extends ReadonlyArray<AnyColumn<AllusionDB_SQL, Table>>,
>(
  db: Kysely<AllusionDB_SQL>,
  table: Table,
  values: Insertable<AllusionDB_SQL[Table]>[] | Expression<any>,
  conflictColumns: Columns,
  excludeFromUpdate?: (keyof Insertable<AllusionDB_SQL[Table]>)[],
  sampleObject?: Insertable<AllusionDB_SQL[Table]>,
) {
  const isExpression = !Array.isArray(values);
  if (!isExpression && values.length === 0) {
    return;
  }

  // Infer Columns
  let columnsToUpdate: string[];
  if (isExpression) {
    if (!sampleObject) {
      throw new Error(
        `sampleObject is required when using SQL expressions for table ${String(table)}`,
      );
    }
    columnsToUpdate = Object.keys(sampleObject).filter(
      (key) =>
        !conflictColumns.includes(key as any) &&
        (!excludeFromUpdate || !excludeFromUpdate.includes(key as any)),
    );
  } else {
    const firstRow = (sampleObject || values[0]) as Record<string, unknown>;
    columnsToUpdate = Object.keys(firstRow).filter(
      (key) =>
        !conflictColumns.includes(key as any) &&
        (!excludeFromUpdate || !excludeFromUpdate.includes(key as any)),
    );
  }
  const updateSet = columnsToUpdate.reduce((acc, column) => {
    acc[column] = (eb: any) => eb.ref(`excluded.${column}`);
    return acc;
  }, {} as Record<string, any>) as UpdateObject<AllusionDB_SQL, Table, Table>;

  let query;
  if (isExpression) {
    query = db.insertInto(table as keyof AllusionDB_SQL & string).expression(values as any);
  } else {
    query = db.insertInto(table as keyof AllusionDB_SQL & string).values(values as any);
  }

  if (columnsToUpdate.length === 0) {
    query = query.onConflict((oc) => oc.columns(conflictColumns as any).doNothing());
  } else {
    query = query.onConflict((oc) =>
      oc.columns(conflictColumns as any).doUpdateSet(updateSet as any),
    );
  }

  return query.execute();
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
    // Convert to Set to get rid of duplicates.
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
  }));

  return { tagIds, tags: normalizedTags, subTags, tagImplications, tagAliases };
}

function normalizeLocations(sourcelocations: LocationDTO[]) {
  const locationNodes: Insertable<LocationNodes>[] = [];
  const locations: Insertable<Locations>[] = [];
  const subLocations: Insertable<SubLocations>[] = [];
  const locationTags: Insertable<LocationTags>[] = [];
  const nodeIds: ID[] = [];

  function normalizeLocationNodeRecursive(
    node: LocationDTO | SubLocationDTO,
    parentId: ID | null,
    isRoot: boolean,
  ) {
    const parentIdvalue = isRoot ? null : parentId;
    const pathValue = 'path' in node ? node.path : node.name;
    nodeIds.push(node.id);
    locationNodes.push({
      id: node.id,
      parentId: parentIdvalue,
      path: pathValue,
    });
    if (isRoot) {
      const location = node as LocationDTO;
      locations.push({
        nodeId: node.id,
        idx: location.index,
        isWatchingFiles: serializeBoolean(!!location.isWatchingFiles),
        dateAdded: serializeDate(new Date(location.dateAdded)),
      });
    } else {
      const subLocation = node as SubLocationDTO;
      subLocations.push({
        nodeId: node.id,
        isExcluded: serializeBoolean(subLocation.isExcluded),
      });
    }
    // Insert tags
    for (const tagId of Array.isArray(node.tags) ? node.tags : []) {
      locationTags.push({
        nodeId: node.id,
        tagId: tagId,
      });
    }
    // Recurse for sublocations
    for (const sub of Array.isArray(node.subLocations) ? node.subLocations : []) {
      normalizeLocationNodeRecursive(sub, node.id, false);
    }
  }

  for (const loc of sourcelocations) {
    normalizeLocationNodeRecursive(loc, null, true);
  }
  return { nodeIds, locationNodes, locations, subLocations, locationTags };
}

function normalizeSavedSearches(sourceSearches: FileSearchDTO[]) {
  const savedSearchesIds: ID[] = [];
  const savedSearches: Insertable<SavedSearches>[] = [];
  const searchGroups: Insertable<SearchGroups>[] = [];
  const searchCriteria: Insertable<SearchCriteria>[] = [];

  function normalizeGroupRecursive(
    group: SearchGroupDTO,
    savedSearchId: ID,
    parentGroupId: ID | null,
  ) {
    // Insert group
    searchGroups.push({
      id: group.id,
      name: group.name,
      savedSearchId: savedSearchId,
      parentGroupId: parentGroupId,
      idx: 0, // currently this is static, (insertion order)
      conjunction: group.conjunction,
    });
    let idx = 0;
    for (const child of group.children) {
      // if group recurse
      if ('children' in child) {
        normalizeGroupRecursive(child, savedSearchId, group.id);
      }
      // id criteria
      else {
        searchCriteria.push({
          id: child.id,
          groupId: group.id,
          idx: idx++,
          key: child.key,
          valueType: child.valueType,
          operator: child.operator,
          jsonValue: JSON.stringify(child.value),
        });
      }
    }
  }
  for (const search of sourceSearches) {
    savedSearchesIds.push(search.id);
    savedSearches.push({
      id: search.id,
      name: search.name,
      idx: search.index,
    });
    normalizeGroupRecursive(search.rootGroup, search.id, null);
  }
  return {
    savedSearchesIds,
    savedSearches,
    searchGroups,
    searchCriteria,
  };
}

function normalizeFiles(sourceFiles: FileDTO[]) {
  const fileIds: ID[] = [];
  const files: Insertable<Files>[] = [];
  const fileTags: Insertable<FileTags>[] = [];
  const epVal: Insertable<EpValues>[] = [];

  for (const file of sourceFiles) {
    const fileId = file.id;
    fileIds.push(fileId);
    files.push({
      id: fileId,
      ino: file.ino,
      locationId: file.locationId,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      tagSorting: file.tagSorting,
      name: file.name,
      extension: file.extension,
      size: file.size,
      width: file.width,
      height: file.height,
      dateAdded: serializeDate(file.dateAdded),
      dateModified: serializeDate(file.dateModified),
      dateModifiedOS: serializeDate(file.dateModifiedOS),
      dateLastIndexed: serializeDate(file.dateLastIndexed),
      dateCreated: serializeDate(file.dateCreated),
    });
    // file_tags (tags relations)
    for (const tagId of Array.isArray(file.tags) ? file.tags : []) {
      fileTags.push({
        fileId: fileId,
        tagId: tagId,
      });
    }
    // ep_values  (extra properties relations)
    for (const [epId, value] of Object.entries(file.extraProperties)) {
      // TODO: Maybe should fetch the ExtraProperties types to assign the type based on
      // the extra property definition, but since the DTO types do not overlap for now, this
      // is good enough.
      if (typeof value === 'number') {
        epVal.push({
          fileId,
          epId,
          numberValue: value,
        });
      } else {
        epVal.push({
          fileId,
          epId,
          textValue: value,
        });
      }
    }
  }
  return { fileIds, files, fileTags, epVal };
}
