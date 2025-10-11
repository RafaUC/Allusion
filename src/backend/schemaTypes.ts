/**
 * In this file we define the types that Kysely will use to provide typing and build SQL queries.
 * These types are a type-level equivalent representation of the actual SQLite database schema.
 *
 * Each exported interface represents a table in the SQLite database. Some schemas differ from
 * Allusion's DTO API in favor of better normalization, avoiding nulls, and ensuring query-building compatibility.
 * The serialization to and from the DTO API is handled by the data-storage implementation (backend) class.
 *
 * Note: These are only TypeScript types. Updating them will not update the database automatically.
 * To apply changes to the actual schema you must manually write Kysely migrations,
 * ensuring that the database schema is kept in sync with this definitions.
 */

import { ColumnType } from 'kysely';
import { ID } from '../api/id';
import { CriteriaValueType, OperatorType } from 'src/api/search-criteria';
import { FILE_TAGS_SORTING_TYPE, FileDTO } from 'src/api/file';

export type BooleanAsNumber = number;
export const serializeBoolean = (value: boolean): number => (value ? 1 : 0);
export const deserializeBoolean = (value: number): boolean => value === 1;
export type DateAsNumber = number;
export const serializeDate = (value: Date): number => value.getTime();
export const deserializeDate = (value: number): Date => new Date(value);

export type AllusionDB_SQL = {
  tags: Tags;
  tagImplications: TagImplications;
  tagAliases: TagAliases;
  locationNodes: LocationNodes;
  locations: Locations;
  subLocations: SubLocations;
  locationTags: LocationTags;
  files: Files;
  fileTags: FileTags;
  extraProperties: ExtraProperties;
  epValuesText: EpValuesText;
  epValuesNumber: EpValuesNumber;
  epValuesTimestamp: EpValuesTimestamp;
  savedSearches: SavedSearches;
  searchCriteria: SearchCriteria;
};

///// TAGS /////

export type Tags = {
  id: ColumnType<ID, ID, never>; //pk
  parentId: ID; //fk
  idx: number;
  name: string;
  dateAdded: ColumnType<DateAsNumber, DateAsNumber, never>;
  color: string;
  isHidden: BooleanAsNumber;
  isVisibleInherited: BooleanAsNumber;
  isHeader: BooleanAsNumber;
  description: string;
};

export type TagImplications = {
  tagId: ID; //pk fk
  impliedTagId: ID; //pk fk
};

export type TagAliases = {
  tagId: ID; //pk
  alias: string; //pk
};

/// LOCATIONS ///

export type LocationNodes = {
  id: ColumnType<ID, ID, never>; //pk
  parentId: ID; //fk
  path: string;
};

export type Locations = {
  nodeId: ID; //pk fk
  dateAdded: ColumnType<DateAsNumber, DateAsNumber, never>;
  idx: number;
  isWatchingFiles: BooleanAsNumber;
};

export type SubLocations = {
  nodeId: ID; //pk fk
  isExcluded: BooleanAsNumber;
};

export type LocationTags = {
  nodeId: ID; //pk fk
  tagId: ID; //pk fk
};

/// FILES ///

export type Files = {
  id: ColumnType<ID, ID, never>; //pk
  ino: string;
  locationId: ID; //fk - to Location, not node table
  relativePath: string;
  absolutePath: string;
  tagSorting: FILE_TAGS_SORTING_TYPE;
  dateAdded: ColumnType<DateAsNumber, DateAsNumber, never>;
  dateModified: DateAsNumber;
  dateModifiedOS: DateAsNumber;
  dateLastIndexed: DateAsNumber;
  name: string;
  extension: string;
  size: number;
  width: number;
  height: number;
  dateCreated: DateAsNumber;
};

export type FileTags = {
  fileId: ID; //pk fk
  tagId: ID; //pk fk
};

/// EXTRA PROPERTIES ///

export type ExtraProperties = {
  id: ColumnType<ID, ID, never>; //pk
  type: string;
  name: string;
  dateAdded: ColumnType<DateAsNumber, DateAsNumber, never>;
};

type EpValues<T> = {
  fileId: ID; //pk fk
  epId: ID; //pk fk
  value: T;
};

export type EpValuesText = EpValues<string>;
export type EpValuesNumber = EpValues<number>;
export type EpValuesTimestamp = EpValues<DateAsNumber>;

/// SAVED SEARCHES ///

export type SavedSearches = {
  id: ColumnType<ID, ID, never>; //pk
  name: string;
  idx: number;
};

export type SearchCriteria = {
  id: ColumnType<ID, ID, never>; //pk
  savedSearchId: ID; //fk
  idx: number;
  matchGroup: 'any' | 'all';
  key: keyof FileDTO;
  valueType: CriteriaValueType;
  operator: OperatorType;
  // Since we only need to filter by saved_search_id and not by individual value types,
  // all values are stored as stringified JSON regardless of type.
  // This simplifies the schema (single column) and querying. The type check is managed
  // inside the app logic in the searchStore and thir related api types.
  jsonValue: string;
};
