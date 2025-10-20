import {
  AllusionDB_SQL,
  deserializeBoolean,
  deserializeDate,
  EpValues,
  Files,
  serializeBoolean,
  serializeDate,
} from './schemaTypes';
import { expose } from 'comlink';
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
} from 'kysely';
import { migrateToLatest, PAD_STRING_LENGTH } from './config';
import { DataStorage } from 'src/api/data-storage';
import { IndexableType } from 'dexie';
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
} from 'src/api/data-storage-search';
import { ExtraProperties, ExtraPropertyDTO } from 'src/api/extraProperty';
import { FileDTO } from 'src/api/file';
import { FileSearchDTO } from 'src/api/file-search';
import { ID } from 'src/api/id';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ROOT_TAG_ID, TagDTO } from 'src/api/tag';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { jsonArrayFrom, jsonObjectFrom, jsonBuildObject } from 'kysely/helpers/sqlite';
import { IS_DEV } from 'common/process';

// Use to debug perfomance.
const USE_TIMING_PROXY = IS_DEV;

export default class Backend implements DataStorage {
  readonly MAX_VARS!: number;
  #db!: Kysely<AllusionDB_SQL>;
  #notifyChange!: () => void;
  /** State variable that indicates if we need to recompute preAggregateJSON */
  #isQueryDirty: boolean = true;

  constructor() {
    // Must call init() before using to init the properties.
    return USE_TIMING_PROXY ? createTimingProxy(this) : this;
  }

  async init(dbPath: string, notifyChange: () => void): Promise<void> {
    console.info(`SQLite3: Initializing database "${dbPath}"...`);
    const database = new SQLite(dbPath, { timeout: 50000 });
    // HACK
    // Use a padded string to do natural sorting
    database.function('pad_string', { deterministic: true }, (str) => {
      return str.replace(/\d+/g, (num: string) => num.padStart(PAD_STRING_LENGTH, '0'));
    });
    const dialect = new SqliteDialect({
      database: database,
    });
    const db = new Kysely<AllusionDB_SQL>({
      dialect: dialect,
      plugins: [new ParseJSONResultsPlugin(), new CamelCasePlugin()],
      log: IS_DEV ? ['query', 'error'] : undefined, // Used only for debugging.
    });
    // Instead of initializing this through the constructor, set the class properties here,
    // this allows us to use the class as a worker having async await calls at init.
    this.#db = db;
    this.#notifyChange = notifyChange;
    (this as any).MAX_VARS = await getSqliteMaxVariables(db);

    // check if any migration is needed before configure pragma
    await migrateToLatest(db);

    // We enable case sensitive like for search queries
    await sql`PRAGMA case_sensitive_like = ON;`.execute(db);
    // Do not wait for writes
    await sql`PRAGMA journal_mode = WAL;`.execute(db);
    await sql`PRAGMA synchronous = NORMAL;`.execute(db);
    await sql`PRAGMA temp_store = MEMORY;`.execute(db);
    await sql`PRAGMA automatic_index = ON;`.execute(db);
    await sql`PRAGMA cache_size = -64000;`.execute(db);
    await sql`PRAGMA VACUUM;`.execute(db);
    await sql`PRAGMA OPTIMIZE;`.execute(db);

    // Create Root Tag if not exists.
    if (
      !(await db.selectFrom('tags').selectAll().where('id', '=', ROOT_TAG_ID).executeTakeFirst())
    ) {
      await db
        .insertInto('tags')
        .values({
          id: ROOT_TAG_ID,
          parentId: null,
          idx: 0,
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
              .selectFrom('tags as subTags')
              .select('subTags.id')
              .whereRef('subTags.parentId', '=', 'tags.id')
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
        subTags: dbTag.subTags.map((st) => st.id),
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
    this.#isQueryDirty = false;
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
      FROM ep_values;
    `.execute(this.#db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_file_tag_aggregates_temp_file ON file_tag_aggregates_temp(file_id);
    `.execute(this.#db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_file_ep_aggregates_temp_file ON file_ep_aggregates_temp(file_id);
    `.execute(this.#db);
  }

  async queryFiles(
    criteria: ConditionDTO<FileDTO> | ConditionDTO<FileDTO>[] = [],
    sortOptions: SortOptions,
    keyInListOptions?: KeyInListOptions,
  ): Promise<FileDTO[]> {
    const criterias = (Array.isArray(criteria) ? criteria : [criteria]) as ConditionDTO<Files>[];

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
    query = applyFileFilters(query, criterias);
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
        tagsSorting: dbFile.tagSorting,
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
        extraPropertyIDs: extraPropertyIDs,
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
    criteria: ConditionDTO<FileDTO> | [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    extraPropertyID?: ID,
    matchAny?: boolean,
  ): Promise<FileDTO[]> {
    console.info('SQLite: Searching files...');
    return this.queryFiles(criteria, {
      order,
      direction: fileOrder,
      useNaturalOrdering,
      extraPropertyID,
    });
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by ID...');
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
    const searches = (
      await this.#db
        .selectFrom('savedSearches')
        .selectAll('savedSearches')
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('searchCriteria as criteria')
              .select([
                'id',
                'savedSearchId',
                'idx',
                'matchGroup',
                'key',
                'valueType',
                'operator',
                'jsonValue',
              ])
              .whereRef('criteria.savedSearchId', '=', 'savedSearches.id'),
          ).as('criteria'),
        ])
        .execute()
    ).map(
      // convert data into FileSearchDTO format
      (dbSearch): FileSearchDTO => ({
        id: dbSearch.id,
        name: dbSearch.name,
        criteria: dbSearch.criteria.map((dbCrit) => ({
          key: dbCrit.key,
          operator: dbCrit.operator,
          valueType: dbCrit.valueType,
          value:
            // the ParseJSONResultsPlugin already parses the arrays but not strings
            dbCrit.valueType === 'string'
              ? JSON.parse(dbCrit.jsonValue as string)
              : dbCrit.jsonValue,
        })),
        index: dbSearch.idx,
      }),
    );
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
    console.warn('Method not implemented.');
  }
  async createFilesFromPath(path: string, files: FileDTO[]): Promise<void> {
    console.warn('Method not implemented.');
  }
  async createLocation(location: LocationDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async createSearch(search: FileSearchDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async createExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async saveTag(tag: TagDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async saveFiles(files: FileDTO[]): Promise<void> {
    console.warn('Method not implemented.');
  }
  async saveLocation(location: LocationDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async saveSearch(search: FileSearchDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async saveExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.warn('Method not implemented.');
  }
  async removeTags(tags: ID[]): Promise<void> {
    console.warn('Method not implemented.');
  }
  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    console.warn('Method not implemented.');
  }
  async removeFiles(files: ID[]): Promise<void> {
    console.warn('Method not implemented.');
  }
  async removeLocation(location: ID): Promise<void> {
    console.warn('Method not implemented.');
  }
  async removeSearch(search: ID): Promise<void> {
    console.warn('Method not implemented.');
  }
  async removeExtraProperties(extraProperty: ID[]): Promise<void> {
    console.warn('Method not implemented.');
  }
  async countFiles(): Promise<[fileCount: number, untaggedFileCount: number]> {
    console.warn('Method not implemented.');
    return [0, 0];
  }
  async clear(): Promise<void> {
    console.warn('Method not implemented.');
  }
}

// https://lorefnon.tech/2019/03/24/using-comlink-with-typescript-and-worker-loader/
expose(Backend, self);

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
  tagsSorting: 'hierarchy',
  size: 0,
  width: 0,
  height: 0,
  dateAdded: new Date(),
  dateCreated: new Date(),
  dateLastIndexed: new Date(),
  dateModified: new Date(),
  dateModifiedOS: new Date(),
  extraProperties: {},
  extraPropertyIDs: [],
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

type SearchConjunction = 'and' | 'or';

export type ConditionWithConjunction<T> = ConditionDTO<T> & {
  conjunction?: SearchConjunction;
};

function applyFileFilters<O>(
  q: SelectQueryBuilder<AllusionDB_SQL, 'files', O>,
  criterias: ConditionWithConjunction<Files>[],
): SelectQueryBuilder<AllusionDB_SQL, 'files', O> {
  if (criterias.length === 0) {
    return q;
  }

  // group criterias by consecutive conjuntions
  const groups: Array<{
    conjunction: SearchConjunction;
    criterias: ConditionDTO<Files>[];
  }> = [];

  let currentGroup = {
    conjunction: criterias[0].conjunction ?? 'and',
    criterias: [criterias[0]],
  };

  for (let i = 1; i < criterias.length; i++) {
    const crit = criterias[i];
    const conj = crit.conjunction ?? 'and';

    // if same group
    if (conj === currentGroup.conjunction) {
      currentGroup.criterias.push(crit);
      // else create new group
    } else {
      groups.push(currentGroup);
      currentGroup = {
        conjunction: conj,
        criterias: [crit],
      };
    }
  }
  groups.push(currentGroup);

  // create conjuction grouped expressions and concatenate them
  for (const group of groups) {
    const groupExpression = (eb: ExpressionBuilder<AllusionDB_SQL, 'files'>) => {
      const expressions = group.criterias.map((crit) => expressionFromCriteria(eb, crit));

      return group.conjunction === 'or' ? eb.or(expressions) : eb.and(expressions);
    };

    q = q.where(groupExpression);
  }

  return q;
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
