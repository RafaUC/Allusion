import {
  AllusionDB_SQL,
  deserializeBoolean,
  deserializeDate,
  LocationNodes,
  Locations,
  LocationTags,
  serializeBoolean,
  serializeDate,
  SubLocations,
  ExtraProperties as DbExtraProperties,
  SavedSearches,
  SearchCriteria,
  SearchGroups,
} from './schemaTypes';
import SQLite from 'better-sqlite3';

import { Kysely, sql, SelectQueryBuilder, AnyColumn, Insertable, Expression } from 'kysely';
import { migrateToLatest } from './config';
import { initDB, generateSeed, getSqliteMaxVariables, computeBatchSize } from './db';
import { DataStorage } from 'src/api/data-storage';
import {
  OrderBy,
  OrderDirection,
  ConditionGroupDTO,
  PaginationDirection,
  Cursor,
  IndexableType,
} from 'src/api/data-storage-search';
import { ExtraPropertyDTO } from 'src/api/extraProperty';
import { FileDTO, FileStats } from 'src/api/file';
import { FileSearchDTO, SearchGroupDTO } from 'src/api/file-search';
import { ID } from 'src/api/id';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ROOT_TAG_ID, TagDTO } from 'src/api/tag';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { IS_DEV } from 'common/process';
import { UpdateObject } from 'kysely/dist/cjs/parser/update-set-parser';
import { SemanticSearchOptions, SemanticSearchStatus } from 'src/api/semantic-search';
import { PaginationOptions } from './query-builder';
import { SemanticRepository } from './repositories/SemanticRepository';
import { TagRepository } from './repositories/TagRepository';
import { LocationRepository } from './repositories/LocationRepository';
import { SearchRepository } from './repositories/SearchRepository';
import { ExtraPropertyRepository } from './repositories/ExtraPropertyRepository';
import { FileRepository } from './repositories/FileRepository';

// Use to debug perfomance.
const USE_TIMING_PROXY = IS_DEV;

export default class Backend implements DataStorage {
  readonly MAX_VARS!: number;
  #db!: Kysely<AllusionDB_SQL>;
  #sqlite!: SQLite.Database;
  #dbPath!: string;
  #notifyChange!: () => void;
  #restoreEmpty!: () => Promise<void>;
  #semantic!: SemanticRepository;
  #tags!: TagRepository;
  #locations!: LocationRepository;
  #searches!: SearchRepository;
  #extraProperties!: ExtraPropertyRepository;
  #files!: FileRepository;

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
    // Instead of initializing this through the constructor, set the class properties here,
    // this allows us to use the class as a worker having async await calls at init.
    const { db, sqlite } = await initDB(dbPath);
    this.#db = db;
    this.#sqlite = sqlite;
    this.#dbPath = dbPath;
    this.#notifyChange = notifyChange;
    this.#restoreEmpty = restoreEmpty;
    (this as any).MAX_VARS = await getSqliteMaxVariables(db);

    // Run migrations if required
    if (mode === 'default' || mode === 'migrate') {
      await migrateToLatest(db, { jsonToImport });
    }

    this.#tags = new TagRepository(this.#db, this.MAX_VARS, this.#notifyChange);
    this.#semantic = new SemanticRepository(
      db,
      sqlite,
      (ids) => this.fetchFilesByID(ids),
      (criteria, pagOptions) => this.#files.queryFiles(criteria, pagOptions),
    );
    this.#locations = new LocationRepository(this.#db, this.MAX_VARS, this.#notifyChange);
    this.#searches = new SearchRepository(this.#db, this.MAX_VARS, this.#notifyChange);
    this.#extraProperties = new ExtraPropertyRepository(
      this.#db,
      this.MAX_VARS,
      this.#notifyChange,
    );
    this.#files = new FileRepository(
      this.#db,
      this.#tags,
      this.#semantic,
      this.MAX_VARS,
      this.#notifyChange,
      generateSeed(),
    );

    if (mode === 'migrate' || mode === 'readonly') {
      return;
    }
    // PRAGMAs only for default mode — avoid creating WAL/SHM files in readonly/migrate modes
    await sql`PRAGMA journal_mode = WAL;`.execute(this.#db);
    await sql`PRAGMA case_sensitive_like = ON;`.execute(this.#db);
    await sql`PRAGMA synchronous = NORMAL;`.execute(this.#db);
    await sql`PRAGMA temp_store = MEMORY;`.execute(this.#db);
    await sql`PRAGMA automatic_index = ON;`.execute(this.#db);
    await sql`PRAGMA cache_size = -64000;`.execute(this.#db);
    await sql`PRAGMA OPTIMIZE;`.execute(this.#db);
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
          fileCount: 0,
          isFileCountDirty: serializeBoolean(true),
        })
        .execute();
    }
    await this.preAggregateJSON();
  }

  async setSeed(seed?: number): Promise<void> {
    return this.#files.setSeed(seed);
  }

  async fetchTags(): Promise<TagDTO[]> {
    return this.#tags.fetchTags();
  }

  async preAggregateJSON(): Promise<void> {
    return this.#tags.preAggregateJSON();
  }

  async queryFiles<Q extends SelectQueryBuilder<any, any, any>>(
    criteria: ConditionGroupDTO<FileDTO>,
    pagOptions: PaginationOptions,
    modifyQuery?: (qb: Q) => Q,
  ): Promise<FileDTO[]> {
    return this.#files.queryFiles(criteria, pagOptions, modifyQuery);
  }

  async fetchFiles(
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    limit?: number,
    pagination?: PaginationDirection,
    cursor?: Cursor,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]> {
    return this.#files.fetchFiles(
      order,
      fileOrder,
      useNaturalOrdering,
      limit,
      pagination,
      cursor,
      extraPropertyID,
    );
  }

  async searchFiles(
    criteria: ConditionGroupDTO<FileDTO> | undefined,
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    limit?: number,
    pagination?: PaginationDirection,
    cursor?: Cursor,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]> {
    return this.#files.searchFiles(
      criteria,
      order,
      fileOrder,
      useNaturalOrdering,
      limit,
      pagination,
      cursor,
      extraPropertyID,
    );
  }

  async semanticSearchByText(query: string, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    return this.#semantic.semanticSearchByText(query, options);
  }

  async semanticSearchByImage(fileId: ID, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    return this.#semantic.semanticSearchByImage(fileId, options);
  }

  async semanticSearchByImages(fileIds: ID[], options?: SemanticSearchOptions): Promise<FileDTO[]> {
    return this.#semantic.semanticSearchByImages(fileIds, options);
  }

  async warmupSemanticModel(): Promise<void> {
    return this.#semantic.warmupSemanticModel();
  }

  async reindexSemanticEmbeddings(fileIds?: ID[]): Promise<number> {
    return this.#semantic.reindexSemanticEmbeddings(fileIds);
  }

  async embedFileFromThumbnail(fileId: ID, thumbnailPath: string): Promise<void> {
    return this.#semantic.embedFileFromThumbnail(fileId, thumbnailPath);
  }

  async fetchSemanticStatus(): Promise<SemanticSearchStatus> {
    return this.#semantic.fetchSemanticStatus();
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    return this.#files.fetchFilesByID(ids);
  }

  async fetchFilesByKey(key: keyof FileDTO, values: IndexableType): Promise<FileDTO[]> {
    return this.#files.fetchFilesByKey(key, values);
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
    return this.#tags.createTag(tag);
  }

  async createFilesFromPath(path: string, filesDTO: FileDTO[]): Promise<void> {
    return this.#files.createFilesFromPath(path, filesDTO);
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
    return this.#tags.saveTag(tag);
  }

  async upsertTag(tag: TagDTO): Promise<void> {
    return this.#tags.upsertTag(tag);
  }

  async saveFiles(filesDTO: FileDTO[]): Promise<void> {
    return this.#files.saveFiles(filesDTO);
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
      await upsertTable(this.MAX_VARS, trx, 'locationNodes', locationNodes, ['id']);
      if (locations.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'locations', locations, ['nodeId'], ['dateAdded']);
      }
      if (subLocations.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'subLocations', subLocations, ['nodeId']);
      }
      if (locationTags.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'locationTags', locationTags, ['nodeId', 'tagId']);
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
      await upsertTable(this.MAX_VARS, trx, 'savedSearches', savedSearches, ['id']);
      if (searchGroups.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'searchGroups', searchGroups, ['id']);
      }
      if (searchCriteria.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'searchCriteria', searchCriteria, ['id']);
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
      await upsertTable(this.MAX_VARS, trx, 'extraProperties', extraProperties, ['id'], ['dateAdded']); // eslint-disable-line prettier/prettier
    });
    this.#notifyChange();
  }

  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    return this.#tags.mergeTags(tagToBeRemoved, tagToMergeWith);
  }

  async removeTags(tags: ID[]): Promise<void> {
    return this.#tags.removeTags(tags);
  }

  async removeFiles(files: ID[]): Promise<void> {
    return this.#files.removeFiles(files);
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

  async addTagsToFiles(tagIds: ID[], criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    return this.#files.addTagsToFiles(tagIds, criteria);
  }

  async removeTagsFromFiles(tagIds: ID[], criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    return this.#files.removeTagsFromFiles(tagIds, criteria);
  }

  async clearTagsFromFiles(criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    return this.#files.clearTagsFromFiles(criteria);
  }

  async countFiles(
    options?: { files?: boolean; untagged?: boolean },
    criteria?: ConditionGroupDTO<FileDTO>,
  ): Promise<[fileCount: number | undefined, untaggedFileCount: number | undefined]> {
    return this.#files.countFiles(options, criteria);
  }

  async compareFiles(
    locationId: ID,
    diskFiles: FileStats[],
  ): Promise<{ createdStats: FileStats[]; missingFiles: FileDTO[] }> {
    return this.#files.compareFiles(locationId, diskFiles);
  }

  async findMissingDBMatches(
    missingFiles: FileDTO[],
  ): Promise<Array<[missingFileId: ID, dbMatch: FileDTO]>> {
    return this.#files.findMissingDBMatches(missingFiles);
  }

  async clear(): Promise<void> {
    return this.#files.clear(this.#restoreEmpty);
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

///////////////////
///// HELPERS /////
///////////////////

export async function upsertTable<
  Table extends keyof AllusionDB_SQL,
  Columns extends ReadonlyArray<AnyColumn<AllusionDB_SQL, Table>>,
>(
  maxVars: number,
  db: Kysely<AllusionDB_SQL>,
  table: Table,
  values: Insertable<AllusionDB_SQL[Table]>[] | Expression<any>,
  conflictColumns: Columns,
  excludeFromUpdate?: (keyof Insertable<AllusionDB_SQL[Table]>)[],
  sampleObject?: Insertable<AllusionDB_SQL[Table]>,
): Promise<void> {
  const isExpression = !Array.isArray(values);
  if (!isExpression && values.length === 0) {
    return;
  }

  // Infer Columns
  const referenceRow = (isExpression ? sampleObject : sampleObject || values[0]) as Record<
    string,
    unknown
  >;
  if (isExpression && !sampleObject) {
    throw new Error(
      `sampleObject is required when using SQL expressions for table ${String(table)}`,
    );
  }
  const columnsToUpdate = Object.keys(referenceRow).filter(
    (key) =>
      !conflictColumns.includes(key as any) &&
      (!excludeFromUpdate || !excludeFromUpdate.includes(key as any)),
  );
  const updateSet = columnsToUpdate.reduce((acc, column) => {
    acc[column] = (eb: any) => eb.ref(`excluded.${column}`);
    return acc;
  }, {} as Record<string, any>) as UpdateObject<AllusionDB_SQL, Table, Table>;

  let query;
  if (isExpression) {
    query = db.insertInto(table).expression(values as any);
  } else {
    query = db.insertInto(table);
  }

  if (columnsToUpdate.length === 0) {
    query = query.onConflict((oc) => oc.columns(conflictColumns as any).doNothing());
  } else {
    query = query.onConflict((oc) =>
      oc.columns(conflictColumns as any).doUpdateSet(updateSet as any),
    );
  }

  if (isExpression) {
    await query.execute();
    return;
  }

  // batching logic for arrays
  const batchSize = computeBatchSize(maxVars, referenceRow);

  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    await query.values(batch as any).execute();
  }
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
