import Dexie, { Collection, IndexableType, Table, WhereClause } from 'dexie';

import { retainArray, shuffleArray } from '../../common/core';
import { DataStorage } from '../api/data-storage';
import {
  ArrayConditionDTO,
  BaseIndexSignature,
  ConditionDTO,
  DateConditionDTO,
  IndexSignatureConditionDTO,
  NumberConditionDTO,
  OrderBy,
  OrderDirection,
  StringConditionDTO,
  isExtraPropertyOperatorType,
  isNumberOperator,
  isStringOperator,
} from '../api/data-storage-search';
import { FileDTO } from '../api/file';
import { FileSearchDTO } from '../api/file-search';
import { ID } from '../api/id';
import { LocationDTO } from '../api/location';
import { ROOT_TAG_ID, TagDTO } from '../api/tag';
import { ExtraPropertyDTO, ExtraPropertyType } from '../api/extraProperty';

const USE_TIMING_PROXY = false;

/**
 * The backend of the application serves as an API, even though it runs on the same machine.
 * This helps code organization by enforcing a clear separation between backend/frontend logic.
 * Whenever we want to change things in the backend, this should have no consequences in the frontend.
 * The backend has access to the database, which is exposed to the frontend through a set of endpoints.
 */
export default class Backend implements DataStorage {
  #files: Table<FileDTO, ID>;
  #tags: Table<TagDTO, ID>;
  #locations: Table<LocationDTO, ID>;
  #searches: Table<FileSearchDTO, ID>;
  #extraProperties: Table<ExtraPropertyDTO, ID>;
  #db: Dexie;
  #notifyChange: () => void;

  constructor(db: Dexie, notifyChange: () => void) {
    console.info(`IndexedDB: Initializing database "${db.name}"...`);
    // Initialize database tables
    this.#files = db.table('files');
    this.#tags = db.table('tags');
    this.#locations = db.table('locations');
    this.#searches = db.table('searches');
    this.#extraProperties = db.table('extraProperties');
    this.#db = db;
    this.#notifyChange = notifyChange;
  }

  static async init(db: Dexie, notifyChange: () => void): Promise<Backend> {
    const backend = new Backend(db, notifyChange);
    // Create a root tag if it does not exist
    const tags = backend.#tags;
    await db.transaction('rw', tags, async () => {
      const tagCount = await tags.count();
      if (tagCount === 0) {
        await tags.put({
          id: ROOT_TAG_ID,
          name: 'Root',
          dateAdded: new Date(),
          subTags: [],
          impliedTags: [],
          color: '',
          isHidden: false,
          isVisibleInherited: false,
        });
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return USE_TIMING_PROXY ? createTimingProxy(backend) : backend;
  }

  async fetchTags(): Promise<TagDTO[]> {
    console.info('IndexedDB: Fetching tags...');
    return this.#tags.toArray();
  }

  async fetchFiles(
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]> {
    console.info('IndexedDB: Fetching files...');
    if (order === 'random') {
      return shuffleArray(await this.#files.toArray());
    }
    if (order === 'extraProperty') {
      order = 'dateAdded';
      if (extraPropertyID) {
        const extraProperty = await this.#extraProperties.get(extraPropertyID);
        if (extraProperty) {
          return await orderByExtraProperty(this.#files.orderBy(order), fileOrder, extraProperty);
        } else {
          console.error(`IndexedDB: Custom field with ID "${extraPropertyID}" not found.`);
        }
      }
    }

    const collection = this.#files.orderBy(order);
    const items = await collection.toArray();

    if (fileOrder === OrderDirection.Desc) {
      return items.reverse();
    } else {
      return items;
    }
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    console.info('IndexedDB: Fetching files by ID...');
    const files = await this.#files.bulkGet(ids);
    retainArray(files, (file) => file !== undefined);
    return files as FileDTO[];
  }

  async fetchFilesByKey(key: keyof FileDTO, value: IndexableType): Promise<FileDTO[]> {
    console.info('IndexedDB: Fetching files by key/value...', { key, value });
    return this.#files.where(key).equals(value).toArray();
  }

  async fetchLocations(): Promise<LocationDTO[]> {
    console.info('IndexedDB: Fetching locations...');
    return this.#locations.orderBy('dateAdded').toArray();
  }

  async fetchSearches(): Promise<FileSearchDTO[]> {
    console.info('IndexedDB: Fetching searches...');
    return this.#searches.toArray();
  }

  async fetchExtraProperties(): Promise<ExtraPropertyDTO[]> {
    console.info('IndexedDB: Fetching extra properties...');
    return this.#extraProperties.orderBy('name').toArray();
  }

  async searchFiles(
    criteria: ConditionDTO<FileDTO> | [ConditionDTO<FileDTO>, ...ConditionDTO<FileDTO>[]],
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    extraPropertyID?: ID,
    matchAny?: boolean,
  ): Promise<FileDTO[]> {
    console.info('IndexedDB: Searching files...', { criteria, matchAny });
    const criterias = Array.isArray(criteria) ? criteria : ([criteria] as [ConditionDTO<FileDTO>]);
    const collection = await filter(this.#files, criterias, matchAny ? 'or' : 'and');

    if (order === 'random') {
      return shuffleArray(await collection.toArray());
    }
    if (order === 'extraProperty') {
      order = 'dateAdded';
      if (extraPropertyID) {
        const extraProperty = await this.#extraProperties.get(extraPropertyID);
        if (extraProperty) {
          return await orderByExtraProperty(collection, fileOrder, extraProperty);
        } else {
          console.error(`IndexedDB: Custom field with ID "${extraPropertyID}" not found.`);
        }
      }
    }
    // table.reverse() can be an order of magnitude slower than a javascript .reverse() call
    // (tested at ~5000 items, 500ms instead of 100ms)
    // easy to verify here https://jsfiddle.net/dfahlander/xf2zrL4p
    const items = await collection.sortBy(order);

    if (fileOrder === OrderDirection.Desc) {
      return items.reverse();
    } else {
      return items;
    }
  }

  async createTag(tag: TagDTO): Promise<void> {
    console.info('IndexedDB: Creating tag...', tag);
    await this.#tags.add(tag);
    this.#notifyChange();
  }

  async createLocation(location: LocationDTO): Promise<void> {
    console.info('IndexedDB: Creating location...', location);
    await this.#locations.add(location);
    this.#notifyChange();
  }

  async createSearch(search: FileSearchDTO): Promise<void> {
    console.info('IndexedDB: Creating search...', search);
    await this.#searches.add(search);
    this.#notifyChange();
  }

  async createExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('IndexedDB: Creating extra property...', extraProperty);
    await this.#extraProperties.add(extraProperty);
    this.#notifyChange();
  }

  async saveTag(tag: TagDTO): Promise<void> {
    console.info('IndexedDB: Saving tag...', tag);
    await this.#tags.put(tag);
    this.#notifyChange();
  }

  async saveFiles(files: FileDTO[]): Promise<void> {
    console.info('IndexedDB: Saving files...', files);
    await this.#files.bulkPut(files);
    this.#notifyChange();
  }

  async saveLocation(location: LocationDTO): Promise<void> {
    console.info('IndexedDB: Saving location...', location);
    await this.#locations.put(location);
    this.#notifyChange();
  }

  async saveSearch(search: FileSearchDTO): Promise<void> {
    console.info('IndexedDB: Saving search...', search);
    await this.#searches.put(search);
    this.#notifyChange();
  }

  async saveExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('IndexedDB: Saving extra property...', extraProperty);
    await this.#extraProperties.put(extraProperty);
    this.#notifyChange();
  }

  async removeTags(tags: ID[]): Promise<void> {
    console.info('IndexedDB: Removing tags...', tags);
    await this.#db.transaction('rw', this.#files, this.#tags, () => {
      const deletedTags = new Set(tags);
      retainArray(tags, (tag) => deletedTags.has(tag));
      // We have to make sure files tagged with these tags should be untagged
      this.#files
        // Get all files with these tags
        .where('tags')
        .anyOf(tags)
        .distinct()
        // Remove tags from files
        .modify((file) => retainArray(file.tags, (tag) => !deletedTags.has(tag)));
      // Remove tag from db
      this.#tags.bulkDelete(tags);
    });
    this.#notifyChange();
  }

  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    console.info('IndexedDB: Merging tags...', tagToBeRemoved, tagToMergeWith);
    await this.#db.transaction('rw', this.#files, this.#tags, () => {
      // Replace tag on all files with the tag to be removed
      this.#files
        .where('tags')
        .anyOf(tagToBeRemoved)
        .modify((file) => {
          const tagToBeRemovedIndex = file.tags.findIndex((tag) => tag === tagToBeRemoved);

          if (tagToBeRemovedIndex !== -1) {
            file.tags[tagToBeRemovedIndex] = tagToMergeWith;
            // Might contain duplicates if the tag to be merged with was already on the file, so remove duplicates.
            retainArray(
              file.tags.slice(tagToBeRemovedIndex + 1),
              (tag) => tag !== tagToMergeWith || tag !== tagToBeRemoved,
            );
          }
        });
      // Remove tag from DB
      this.#tags.delete(tagToBeRemoved);
    });
    this.#notifyChange();
  }

  async removeFiles(files: ID[]): Promise<void> {
    console.info('IndexedDB: Removing files...', files);
    await this.#files.bulkDelete(files);
    this.#notifyChange();
  }

  async removeLocation(location: ID): Promise<void> {
    console.info('IndexedDB: Removing location...', location);
    await this.#db.transaction('rw', this.#files, this.#locations, () => {
      this.#files.where('locationId').equals(location).delete();
      this.#locations.delete(location);
    });
    this.#notifyChange();
  }

  async removeSearch(search: ID): Promise<void> {
    console.info('IndexedDB: Removing search...', search);
    await this.#searches.delete(search);
    this.#notifyChange();
  }

  async removeExtraProperties(extraPropertyIDs: ID[]): Promise<void> {
    console.info('IndexedDB: Removing extra properties...', extraPropertyIDs);
    await this.#db.transaction('rw', this.#files, this.#extraProperties, async () => {
      await this.#files
        .where('extraPropertyIDs')
        .anyOf(extraPropertyIDs)
        .distinct()
        .modify((file) => {
          for (const id of extraPropertyIDs) {
            delete file.extraProperties[id];
          }
          retainArray(file.extraPropertyIDs, (id) => !extraPropertyIDs.includes(id));
        });

      await this.#extraProperties.bulkDelete(extraPropertyIDs);
    });

    this.#notifyChange();
  }

  async countFiles(): Promise<[fileCount: number, untaggedFileCount: number]> {
    console.info('IndexedDB: Getting number stats of files...');
    return this.#db.transaction('r', this.#files, async () => {
      // Aparently converting the whole table into array and check tags in a for loop is a lot faster than using a where tags filter followed by unique().
      const files = await this.#files.toArray();
      let unTaggedFileCount = 0;
      for (let i = 0; i < files.length; i++) {
        if (files[i].tags.length === 0) {
          unTaggedFileCount++;
        }
      }
      return [files.length, unTaggedFileCount];
    });
  }

  // Creates many files at once, and checks for duplicates in the path they are in
  async createFilesFromPath(path: string, files: FileDTO[]): Promise<void> {
    console.info('IndexedDB: Creating files...', path, files);
    await this.#db.transaction('rw', this.#files, async () => {
      // previously we did filter getting all the paths that start with the base path using where('absolutePath').startsWith(path).keys()
      // but converting to an array and extracting the paths is significantly faster than .keys()
      // Also, for small batches of new files, checking each path individually is faster.
      console.debug('Filtering files...');
      if (files.length > 500) {
        // When creating a large number of files (likely adding a big location),
        // it's faster to fetch all existing paths starting with the given base path.
        const existingFilePaths = new Set(
          (await this.#files.where('absolutePath').startsWith(path).toArray()).map(
            (f) => f.absolutePath,
          ),
        );
        retainArray(files, (file) => !existingFilePaths.has(file.absolutePath));
      } else {
        // For small batches, check each file path individually.
        const checks = await Promise.all(
          files.map(async (file) => {
            const count = await this.#files.where('absolutePath').equals(file.absolutePath).count();
            return count === 0;
          }),
        );
        retainArray(files, (_, i) => checks[i]);
      }
      console.debug('Creating files...');
      this.#files.bulkAdd(files);
    });
    console.debug('Done!');
    this.#notifyChange();
  }

  async clear(): Promise<void> {
    console.info('IndexedDB: Clearing database...');
    Dexie.delete(this.#db.name);
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

async function orderByExtraProperty(
  collection: Dexie.Collection<FileDTO, string>,
  fileOrder: OrderDirection,
  extraProperty: ExtraPropertyDTO,
): Promise<FileDTO[]> {
  switch (extraProperty.type) {
    case ExtraPropertyType.number:
      return orderByCustomNumberField(collection, extraProperty.id, fileOrder);
    case ExtraPropertyType.text:
      return orderByCustomTextField(collection, extraProperty.id, fileOrder);
    default:
      throw new Error(`Unsupported custom field type: ${extraProperty.type}`);
  }
}

function castOrDefault<T>(value: unknown, fallback: T, expectedType: string): T {
  return typeof value === expectedType ? (value as T) : fallback;
}

async function orderByCustomNumberField(
  collection: Dexie.Collection<FileDTO, string>,
  extraPropertyID: ID,
  fileOrder: OrderDirection,
): Promise<FileDTO[]> {
  const files = await collection.toArray();
  const fallback = fileOrder === OrderDirection.Desc ? -Infinity : Infinity;
  files.sort((a, b) => {
    const valueA: number = castOrDefault(a.extraProperties[extraPropertyID], fallback, 'number');
    const valueB: number = castOrDefault(b.extraProperties[extraPropertyID], fallback, 'number');
    return fileOrder === OrderDirection.Desc ? valueB - valueA : valueA - valueB;
  });
  return files;
}

async function orderByCustomTextField(
  collection: Dexie.Collection<FileDTO, string>,
  extraPropertyID: ID,
  fileOrder: OrderDirection,
): Promise<FileDTO[]> {
  const files = await collection.toArray();
  const fallback = fileOrder === OrderDirection.Desc ? '\u0000' : '\uffff';
  files.sort((a, b) => {
    const valueA: string = castOrDefault(
      a.extraProperties[extraPropertyID],
      fallback,
      'string',
    ).toLowerCase();
    const valueB: string = castOrDefault(
      b.extraProperties[extraPropertyID],
      fallback,
      'string',
    ).toLowerCase();

    return fileOrder === OrderDirection.Desc
      ? valueB.localeCompare(valueA)
      : valueA.localeCompare(valueB);
  });
  return files;
}

type SearchConjunction = 'and' | 'or';

async function filter<T>(
  collection: Dexie.Table<T, ID>,
  criterias: [ConditionDTO<T>, ...ConditionDTO<T>[]],
  conjunction: SearchConjunction,
): Promise<Dexie.Collection<T, string>> {
  // Searching with multiple 'wheres': https://stackoverflow.com/questions/35679590/dexiejs-indexeddb-chain-multiple-where-clauses
  // Unfortunately doesn't work out of the box.
  // It's one of the things they are working on, looks much better: https://github.com/dfahlander/Dexie.js/issues/427
  // We'll have to mostly rely on naive filter function (lambdas)

  if (criterias.length > 1 && conjunction === 'or') {
    // OR: We can only chain ORs if all filters can be "where" functions - else we do an ugly .some() check on every document

    let allWheres = true;
    let table: Dexie.Collection<T, string> | undefined = undefined;
    for (const crit of criterias) {
      const where: WhereClause<T, string> = !table
        ? collection.where(crit.key)
        : table.or(crit.key);
      const tableOrFilter = filterWhere(where, crit);

      if (typeof tableOrFilter === 'function') {
        allWheres = false;
        break;
      } else {
        table = tableOrFilter;
      }
    }

    if (allWheres && table) {
      return table;
    } else {
      const critLambdas = criterias.map(filterLambda);
      return collection.filter((t) => critLambdas.some((lambda) => lambda(t)));
    }
  }

  // AND: We can get some efficiency for ANDS by separating the first crit from the rest...
  // Dexie can use a fast "where" search for the initial search
  // For consecutive "and" conjunctions, a lambda function must be used
  // Since not all operators we need are supported by "where" filters, _filterWhere can also return a lambda.
  const [firstCrit, ...otherCrits] = criterias;

  const where = collection.where(firstCrit.key);
  const whereOrFilter = filterWhere(where, firstCrit);
  let table =
    typeof whereOrFilter !== 'function' ? whereOrFilter : collection.filter(whereOrFilter);

  // Then just chain a loop of and() calls. A .every() feels more efficient than chaining table.and() calls
  if (otherCrits.length) {
    const critLambdas = otherCrits.map(filterLambda);
    table = table.and((item) => critLambdas.every((lambda) => lambda(item)));
  }
  // for (const crit of otherCrits) {
  //   table = table.and(this._filterLambda(crit));
  // }
  return table;
}

///////////////////////////////
////// FILTERING METHODS //////
///////////////////////////////
// There are 'where' and 'lambda filter functions:
// - where: For filtering by a single criteria and for 'or' conjunctions, Dexie exposes indexeddb-accelerated functions.
//          Since some of our search operations are not supported by Dexie, some _where functions return a lambda.
// - lambda: For 'and' conjunctions, a naive filter function (lambda) must be used.

function filterWhere<T>(
  where: WhereClause<T, string>,
  crit: ConditionDTO<T>,
): Collection<T, string> | ((val: T) => boolean) {
  switch (crit.valueType) {
    case 'array':
      return filterArrayWhere(where, crit);
    case 'string':
      return filterStringWhere(where, crit);
    case 'number':
      return filterNumberWhere(where, crit);
    case 'date':
      return filterDateWhere(where, crit);
    case 'indexSignature':
      return filterIndexSignatureLambda(crit);
  }
}

function filterLambda<T>(crit: ConditionDTO<T>): (val: T) => boolean {
  switch (crit.valueType) {
    case 'array':
      return filterArrayLambda(crit);
    case 'string':
      return filterStringLambda(crit);
    case 'number':
      return filterNumberLambda(crit);
    case 'date':
      return filterDateLambda(crit);
    case 'indexSignature':
      return filterIndexSignatureLambda(crit);
  }
}

function filterArrayWhere<T>(
  where: WhereClause<T, string>,
  crit: ArrayConditionDTO<T, any>,
): Collection<T, string> | ((val: T) => boolean) {
  // Querying array props: https://dexie.org/docs/MultiEntry-Index
  // Check whether to search for empty arrays (e.g. no tags)
  if (crit.value.length === 0) {
    return crit.operator === 'contains'
      ? (val: T): boolean => (val as any)[crit.key].length === 0
      : (val: T): boolean => (val as any)[crit.key].length !== 0;
  } else {
    // contains/notContains 1 or more elements
    if (crit.operator === 'contains') {
      return where.anyOf(crit.value).distinct();
    } else {
      // not contains: there as a noneOf() function we used to use, but it matches every item individually, e.g.
      // an item with tags "Apple, Pear" is matched twice: once as Apple, once as Pear; A "notContains Apple" still matches for Pear
      return (val: T): boolean =>
        (val as any)[crit.key].every((val: string) => !crit.value.includes(val));
    }
  }
}

function filterArrayLambda<T>(crit: ArrayConditionDTO<T, any>): (val: T) => boolean {
  if (crit.operator === 'contains') {
    // Check whether to search for empty arrays (e.g. no tags)
    return crit.value.length === 0
      ? (val: T): boolean => (val as any)[crit.key].length === 0
      : (val: T): boolean => crit.value.some((item) => (val as any)[crit.key].indexOf(item) !== -1);
  } else {
    // not contains
    return crit.value.length === 0
      ? (val: T): boolean => (val as any)[crit.key].length !== 0
      : (val: T): boolean =>
          crit.value.every((item) => (val as any)[crit.key].indexOf(item) === -1);
  }
}

function filterStringWhere<T>(
  where: WhereClause<T, string>,
  crit: StringConditionDTO<T>,
): Collection<T, string> | ((t: any) => boolean) {
  const dbStringOperators = [
    'equalsIgnoreCase',
    'equals',
    'notEqual',
    'startsWithIgnoreCase',
    'startsWith',
  ] as const;

  if ((dbStringOperators as readonly string[]).includes(crit.operator)) {
    const funcName = crit.operator as unknown as (typeof dbStringOperators)[number];
    return where[funcName](crit.value);
  }
  // Use normal string filter as fallback for functions not supported by the DB
  return filterStringLambda(crit);
}

function filterStringLambda<T>(crit: StringConditionDTO<T>): (t: any) => boolean {
  const { key, value } = crit;
  const valLow = value.toLowerCase();

  switch (crit.operator) {
    case 'equals':
      return (t: any) => (t[key] as string) === crit.value;
    case 'equalsIgnoreCase':
      return (t: any) => (t[key] as string).toLowerCase() === valLow;
    case 'notEqual':
      return (t: any) => (t[key] as string).toLowerCase() !== valLow;
    case 'contains':
      return (t: any) => (t[key] as string).toLowerCase().includes(valLow);
    case 'notContains':
      return (t: any) => !(t[key] as string).toLowerCase().includes(valLow);
    case 'startsWith':
      return (t: any) => (t[key] as string).startsWith(crit.value);
    case 'startsWithIgnoreCase':
      return (t: any) => (t[key] as string).toLowerCase().startsWith(valLow);
    case 'notStartsWith':
      return (t: any) => !(t[key] as string).toLowerCase().startsWith(valLow);
    default:
      console.log('String operator not allowed:', crit.operator);
      return () => false;
  }
}

function filterNumberWhere<T>(
  where: WhereClause<T, string>,
  crit: NumberConditionDTO<T>,
): Collection<T, string> {
  switch (crit.operator) {
    case 'equals':
      return where.equals(crit.value);
    case 'notEqual':
      return where.notEqual(crit.value);
    case 'smallerThan':
      return where.below(crit.value);
    case 'smallerThanOrEquals':
      return where.belowOrEqual(crit.value);
    case 'greaterThan':
      return where.above(crit.value);
    case 'greaterThanOrEquals':
      return where.aboveOrEqual(crit.value);
    default:
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
  }
}

function filterNumberLambda<T>(crit: NumberConditionDTO<T>): (t: any) => boolean {
  const { key, value } = crit;

  switch (crit.operator) {
    case 'equals':
      return (t: any) => t[key] === value;
    case 'notEqual':
      return (t: any) => t[key] !== value;
    case 'smallerThan':
      return (t: any) => t[key] < value;
    case 'smallerThanOrEquals':
      return (t: any) => t[key] <= value;
    case 'greaterThan':
      return (t: any) => t[key] > value;
    case 'greaterThanOrEquals':
      return (t: any) => t[key] >= value;
    default:
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
  }
}

function filterIndexSignatureLambda<T>(
  crit: IndexSignatureConditionDTO<T, any>,
): (t: any) => boolean {
  const {
    value: [keyIS, valueIS],
  } = crit;

  if (isExtraPropertyOperatorType(crit.operator)) {
    switch (crit.operator) {
      case 'existsInFile':
        return (t: any) => t[crit.key][keyIS] !== undefined;
      case 'notExistsInFile':
        return (t: any) => t[crit.key][keyIS] === undefined;
      default:
        const _exhaustiveCheck: never = crit.operator;
        return _exhaustiveCheck;
    }
  }
  switch (typeof valueIS) {
    case 'number':
      if (isNumberOperator(crit.operator)) {
        const numberCrit: NumberConditionDTO<BaseIndexSignature> = {
          key: keyIS,
          operator: crit.operator,
          value: valueIS,
          valueType: 'number',
        };
        const lamda = filterNumberLambda<BaseIndexSignature>(numberCrit);
        return (t: any) => {
          const obj = t[crit.key];
          return typeof obj[keyIS] === 'number' ? lamda(obj) : false;
        };
      }
      return () => false;
    case 'string':
      if (isStringOperator(crit.operator)) {
        const stringCrit: StringConditionDTO<BaseIndexSignature> = {
          key: keyIS,
          operator: crit.operator,
          value: valueIS,
          valueType: 'string',
        };
        const lamda = filterStringLambda<BaseIndexSignature>(stringCrit);
        return (t: any) => {
          const obj = t[crit.key];
          return typeof obj[keyIS] === 'string' ? lamda(obj) : false;
        };
      }
      return () => false;
    default:
      return () => false;
  }
}

function filterDateWhere<T>(
  where: WhereClause<T, string>,
  crit: DateConditionDTO<T>,
): Collection<T, string> {
  const dateStart = new Date(crit.value);
  dateStart.setHours(0, 0, 0);
  const dateEnd = new Date(crit.value);
  dateEnd.setHours(23, 59, 59);

  switch (crit.operator) {
    // equal to this day, so between 0:00 and 23:59
    case 'equals':
      return where.between(dateStart, dateEnd);
    case 'smallerThan':
      return where.below(dateStart);
    case 'smallerThanOrEquals':
      return where.below(dateEnd);
    case 'greaterThan':
      return where.above(dateEnd);
    case 'greaterThanOrEquals':
      return where.above(dateStart);
    // not equal to this day, so before 0:00 or after 23:59
    case 'notEqual':
      return where.below(dateStart).or(crit.key).above(dateEnd);
    default:
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
  }
}

function filterDateLambda<T>(crit: DateConditionDTO<T>): (t: any) => boolean {
  const { key } = crit;
  const start = new Date(crit.value);
  start.setHours(0, 0, 0);
  const end = new Date(crit.value);
  end.setHours(23, 59, 59);

  switch (crit.operator) {
    case 'equals':
      return (t: any) => t[key] >= start || t[key] <= end;
    case 'notEqual':
      return (t: any) => t[key] < start || t[key] > end;
    case 'smallerThan':
      return (t: any) => t[key] < start;
    case 'smallerThanOrEquals':
      return (t: any) => t[key] <= end;
    case 'greaterThan':
      return (t: any) => t[key] > end;
    case 'greaterThanOrEquals':
      return (t: any) => t[key] >= start;
    default:
      const _exhaustiveCheck: never = crit.operator;
      return _exhaustiveCheck;
  }
}
