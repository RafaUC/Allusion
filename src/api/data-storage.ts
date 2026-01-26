import {
  ConditionGroupDTO,
  Cursor,
  IndexableType,
  OrderBy,
  OrderDirection,
  PaginationDirection,
} from './data-storage-search';
import { FileDTO, FileStats } from './file';
import { FileSearchDTO } from './file-search';
import { ID } from './id';
import { LocationDTO } from './location';
import { TagDTO } from './tag';
import { ExtraPropertyDTO } from './extraProperty';
import { BatchFetcher } from 'common/promise';

/**
 * The user generated persisted data edited or viewed by one or multiple actors (users, multiple devices etc.).
 *
 * The document contains data about
 * * files (index map),
 * * tags (tree),
 * * locations (list) and
 * * searches (list).
 */
export interface DataStorage {
  fetchTags(): Promise<TagDTO[]>;
  fetchFiles(
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    limit?: number,
    pagination?: PaginationDirection,
    cursor?: Cursor,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]>;
  fetchFilesByID(ids: ID[]): Promise<FileDTO[]>;
  fetchFilesByKey(key: keyof FileDTO, value: IndexableType): Promise<FileDTO[]>;
  fetchLocations(): Promise<LocationDTO[]>;
  fetchSearches(): Promise<FileSearchDTO[]>;
  fetchExtraProperties(): Promise<ExtraPropertyDTO[]>;
  searchFiles(
    criteria: ConditionGroupDTO<FileDTO> | undefined,
    order: OrderBy<FileDTO>,
    fileOrder: OrderDirection,
    useNaturalOrdering: boolean,
    limit?: number,
    pagination?: PaginationDirection,
    cursor?: Cursor,
    extraPropertyID?: ID,
  ): Promise<FileDTO[]>;
  createTag(tag: TagDTO): Promise<void>;
  createFilesFromPath(path: string, files: FileDTO[]): Promise<void>;
  createLocation(location: LocationDTO): Promise<void>;
  createSearch(search: FileSearchDTO): Promise<void>;
  createExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void>;
  saveTag(tag: TagDTO): Promise<void>;
  saveFiles(files: FileDTO[]): Promise<void>;
  saveLocation(location: LocationDTO): Promise<void>;
  saveSearch(search: FileSearchDTO): Promise<void>;
  saveExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void>;
  removeTags(tags: ID[]): Promise<void>;
  mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void>;
  removeFiles(files: ID[]): Promise<void>;
  removeLocation(location: ID): Promise<void>;
  removeSearch(search: ID): Promise<void>;
  removeExtraProperties(extraProperty: ID[]): Promise<void>;
  countFiles(
    options?: { files: boolean; untagged: boolean },
    criteria?: ConditionGroupDTO<FileDTO>,
  ): Promise<[fileCount: number | undefined, untaggedFileCount: number | undefined]>;
  compareFiles(
    locationId: ID,
    diskFiles: FileStats[],
  ): Promise<{ createdStats: FileStats[]; missingFiles: FileDTO[] }>;
  findMissingDBMatches(
    missingFiles: FileDTO[],
  ): Promise<Array<[missingFileId: ID, dbMatch: FileDTO]>>;
  clear(): Promise<void>;
  setSeed(seed?: number): Promise<void>;
}

export function makeFileBatchFetcher(
  backend: DataStorage,
  n: number,
  filter?: ConditionGroupDTO<FileDTO>,
): BatchFetcher<FileDTO, Cursor> {
  return async (cursor?: Cursor) => {
    // eslint-disable-next-line prettier/prettier
    const items = await backend.searchFiles(filter, 'id', OrderDirection.Desc, false, n, 'after', cursor);
    const cursorItem = items.at(-1);
    return {
      items,
      nextOpts: cursorItem ? { id: cursorItem.id, orderValue: cursorItem.id } : undefined,
    };
  };
}
