import {
  AllusionDB_SQL,
  deserializeDate,
  EpValues,
  Files,
  serializeDate,
  FileTags,
} from '../schemaTypes';
import {
  Kysely,
  sql,
  SelectQueryBuilder,
  SqlBool,
  Insertable,
} from 'kysely';
import { computeBatchSize } from '../db';
import {
  OrderBy,
  OrderDirection,
  ConditionGroupDTO,
  PaginationDirection,
  Cursor,
  IndexableType,
} from 'src/api/data-storage-search';
import { ExtraProperties } from 'src/api/extraProperty';
import { FileDTO, FileStats } from 'src/api/file';
import { generateId, ID } from 'src/api/id';
import { applyFileFilters, applyPagination, PaginationOptions } from '../query-builder';
import { TagRepository } from './TagRepository';
import { SemanticRepository } from './SemanticRepository';
import { upsertTable } from '../backend';

export class FileRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #tagRepo: TagRepository;
  readonly #semanticRepo: SemanticRepository;
  readonly #maxVars: number;
  readonly #notifyChange: () => void;
  #seed: number;

  constructor(
    db: Kysely<AllusionDB_SQL>,
    tagRepo: TagRepository,
    semanticRepo: SemanticRepository,
    maxVars: number,
    notifyChange: () => void,
    seed: number,
  ) {
    this.#db = db;
    this.#tagRepo = tagRepo;
    this.#semanticRepo = semanticRepo;
    this.#maxVars = maxVars;
    this.#notifyChange = notifyChange;
    this.#seed = seed;
  }

  async setSeed(seed?: number): Promise<void> {
    const { generateSeed } = await import('../db');
    this.#seed = seed ?? generateSeed();
  }

  async queryFiles<Q extends SelectQueryBuilder<any, any, any>>(
    criteria: ConditionGroupDTO<FileDTO> = { conjunction: 'and', children: [] },
    pagOptions: PaginationOptions,
    modifyQuery?: (qb: Q) => Q,
  ): Promise<FileDTO[]> {
    pagOptions.seed = this.#seed;
    if (this.#tagRepo.isQueryDirty) {
      await this.#tagRepo.preAggregateJSON();
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
    let query;
    query = dbWithTemp
      .selectFrom('files')
      .leftJoin('fileTagAggregatesTemp as ft', 'ft.fileId', 'files.id')
      .leftJoin('fileEpAggregatesTemp as fe', 'fe.fileId', 'files.id')
      .selectAll('files')
      .select(['ft.tags', 'fe.extraProperties']);
    query = applyFileFilters(query, criteria);
    query = await applyPagination(this.#db, query, pagOptions);
    if (modifyQuery) {
      query = modifyQuery(query as any);
    }

    const files = (await query.execute()).map(mapToDTO);
    const shouldReverse = pagOptions.pagination === 'before' && pagOptions.cursor !== undefined;
    return shouldReverse ? files.reverse() : files;
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
    console.info('SQLite: Fetching all files...', cursor);
    return this.queryFiles(undefined, {
      order,
      direction: fileOrder,
      useNaturalOrdering,
      limit,
      pagination,
      cursor,
      extraPropertyID,
    });
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
    console.info('SQLite: Searching files...', cursor, criteria);
    return this.queryFiles(criteria, {
      order,
      direction: fileOrder,
      useNaturalOrdering,
      limit,
      pagination,
      cursor,
      extraPropertyID,
    });
  }

  async fetchFilesByID(ids: ID[]): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by ID...', ids);
    return this.queryFiles(undefined, { order: 'dateAdded' }, (query) =>
      query.where('id', 'in', ids),
    );
  }

  async fetchFilesByKey(key: keyof FileDTO, values: IndexableType): Promise<FileDTO[]> {
    console.info('SQLite: Fetching files by key...');
    if (!['tags', 'extraProperties', 'extraPropertyIDs'].includes(key)) {
      if (!Array.isArray(values)) {
        values = [values as string | number | Date];
      }
      return this.queryFiles(undefined, { order: 'dateAdded' }, (query) =>
        query.where(key, 'in', values),
      );
    }
    console.error('fetchFilesByKey error: Key or values not supported.');
    return [];
  }

  // Creates many files at once, and checks for duplicates in the path they are in
  async createFilesFromPath(path: string, filesDTO: FileDTO[]): Promise<void> {
    console.info('SQLite: Creating files...', path, filesDTO.length);

    if (filesDTO.length === 0) {
      return;
    }
    const { files } = normalizeFiles(filesDTO);
    const FILES_BATCH_SIZE = computeBatchSize(this.#maxVars, files[0]);
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

    this.#semanticRepo.enqueueSemanticEmbeddings(filesDTO.map((file) => file.id));

    this.#tagRepo.isQueryDirty = true;
    this.#notifyChange();
    console.info('SQLite: Files created successfully');
  }

  async saveFiles(filesDTO: FileDTO[]): Promise<void> {
    console.info('SQLite: Saving files...', filesDTO);
    if (filesDTO.length === 0) {
      return;
    }

    const { fileIds, files, fileTags, epVal } = normalizeFiles(filesDTO);

    // Compute batch sizes. To use the maximum number of vars SQLite can handle per query.
    const DELETE_BATCH_SIZE = this.#maxVars;
    const FILES_BATCH_SIZE = computeBatchSize(this.#maxVars, files[0]);
    const FILE_TAGS_BATCH_SIZE = computeBatchSize(this.#maxVars, fileTags[0]);
    const EP_VALUES_BATCH_SIZE = computeBatchSize(this.#maxVars, epVal[0]);

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
          this.#maxVars,
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
        this.#tagRepo.isQueryDirty = true;
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

  async removeFiles(files: ID[]): Promise<void> {
    console.info('SQLite: Removing files...', files);
    // Cascade delete in other tables deleting from files table.
    await this.#db.deleteFrom('files').where('id', 'in', files).execute();
    this.#notifyChange();
  }

  async addTagsToFiles(tagIds: ID[], criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    console.info('SQLite: Add tags to filtered files...', criteria, tagIds);
    let fileSubquery = this.#db.selectFrom('files').select('files.id as fileId');
    fileSubquery = applyFileFilters(fileSubquery, criteria);

    await this.#db
      .insertInto('fileTags')
      .columns(['fileId', 'tagId'])
      .expression(() => {
        const tagValues = tagIds.map((id) => `SELECT '${id}' as tag_id`).join(' UNION ALL ');

        return this.#db
          .selectFrom(fileSubquery.as('matchedFiles'))
          .crossJoin(sql`(${sql.raw(tagValues)})`.as('tagValues'))
          .select(['matchedFiles.fileId', sql<number>`tag_values.tag_id`.as('tagId')])
          .where(sql<SqlBool>`true`);
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    this.#tagRepo.isQueryDirty = true;
  }

  async removeTagsFromFiles(tagIds: ID[], criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    console.info('SQLite: Remove tags from filtered files...', criteria, tagIds);

    let fileSubquery = this.#db.selectFrom('files').select('files.id');
    fileSubquery = applyFileFilters(fileSubquery, criteria);

    await this.#db
      .deleteFrom('fileTags')
      .where('fileId', 'in', fileSubquery)
      .where('tagId', 'in', tagIds)
      .execute();

    this.#tagRepo.isQueryDirty = true;
  }

  async clearTagsFromFiles(criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    let fileSubquery = this.#db.selectFrom('files').select('files.id');
    fileSubquery = applyFileFilters(fileSubquery, criteria);

    await this.#db.deleteFrom('fileTags').where('fileId', 'in', fileSubquery).execute();

    this.#tagRepo.isQueryDirty = true;
  }

  async countFiles(
    options?: { files?: boolean; untagged?: boolean },
    criteria?: ConditionGroupDTO<FileDTO>,
  ): Promise<[fileCount: number | undefined, untaggedFileCount: number | undefined]> {
    console.info('SQLite: Counting files...', options, criteria);
    const result: [number | undefined, number | undefined] = [undefined, undefined];
    if (options?.files) {
      let totalQuery = this.#db
        .selectFrom('files')
        .select(({ fn }) => fn.count<number>('files.id').as('count'));
      totalQuery = criteria ? applyFileFilters(totalQuery, criteria) : totalQuery;
      const totalResult = await totalQuery.executeTakeFirst();
      result[0] = totalResult?.count ?? 0;
    }

    if (options?.untagged) {
      let untaggedQuery = this.#db
        .selectFrom('files')
        .leftJoin('fileTags as ft', 'ft.fileId', 'files.id')
        .where('ft.fileId', 'is', null)
        .select(({ fn }) => fn.count<number>('files.id').as('count'));
      untaggedQuery = criteria ? applyFileFilters(untaggedQuery, criteria) : untaggedQuery;
      const untaggedResult = await untaggedQuery.executeTakeFirst();
      result[1] = untaggedResult?.count ?? 0;
    }
    return result;
  }

  /** Compare the given disk files with the database files for the given location. */
  async compareFiles(
    locationId: ID,
    diskFiles: FileStats[],
  ): Promise<{ createdStats: FileStats[]; missingFiles: FileDTO[] }> {
    const dbWithTemp = this.#db.withTables<{
      tempDiskFiles: Omit<FileStats, 'dateModified' | 'dateCreated'> & {
        dateModified: number;
        dateCreated: number;
      };
    }>();
    // first insert all missing files into a temp table for easier and db optimized querying
    // use unique table name for concurrency
    const tempSuffix = generateId();
    const tempDiskFilesName = `temp_disk_files_${tempSuffix}`;
    const tempDiskFiles = sql
      .table(tempDiskFilesName)
      .as('tempDiskFiles') as unknown as 'tempDiskFiles';

    await sql`
      CREATE TEMP TABLE ${sql.id(tempDiskFilesName)} (
        absolute_path   TEXT PRIMARY KEY,
        ino            TEXT NOT NULL,
        size           INTEGER NOT NULL,
        date_modified   INTEGER NOT NULL,
        date_created    INTEGER NOT NULL
      ) WITHOUT ROWID;
    `.execute(this.#db);

    const DISK_FILES_BATCH_SIZE = computeBatchSize(this.#maxVars, diskFiles[0]);
    await dbWithTemp.transaction().execute(async (trx) => {
      for (let i = 0; i < diskFiles.length; i += DISK_FILES_BATCH_SIZE) {
        const batch = [];
        const end = Math.min(i + DISK_FILES_BATCH_SIZE, diskFiles.length);
        for (let j = i; j < end; j++) {
          const f = diskFiles[j];
          batch.push({
            absolutePath: f.absolutePath,
            ino: f.ino,
            size: f.size,
            dateModified: serializeDate(f.dateModified),
            dateCreated: serializeDate(f.dateCreated),
          });
        }
        await trx
          .insertInto(tempDiskFilesName as 'tempDiskFiles')
          .values(batch)
          .execute();
      }
    });

    // find created files, (the ones present in disk but not in db)
    const createdStats: FileStats[] = (
      await dbWithTemp
        .selectFrom(tempDiskFiles)
        .leftJoin('files', (join) =>
          join
            .onRef('files.absolutePath', '=', 'tempDiskFiles.absolutePath')
            .on('files.locationId', '=', locationId),
        )
        .where('files.id', 'is', null)
        .selectAll('tempDiskFiles')
        .execute()
    ).map((df) => ({
      absolutePath: df.absolutePath,
      ino: df.ino,
      size: df.size,
      dateModified: deserializeDate(df.dateModified),
      dateCreated: deserializeDate(df.dateCreated),
    }));

    // find missing files, (the ones present in db but not in disk)
    const missingFiles = await this.queryFiles(
      undefined,
      { order: 'id' },
      (query: SelectQueryBuilder<AllusionDB_SQL & { tempDiskFiles: FileStats }, 'files', any>) => {
        return query
          .leftJoin(tempDiskFiles, (join) =>
            join.onRef('tempDiskFiles.absolutePath', '=', 'files.absolutePath'),
          )
          .where('files.locationId', '=', locationId)
          .where('tempDiskFiles.absolutePath', 'is', null);
      },
    );
    // clean temp table
    await sql`DROP TABLE IF EXISTS ${sql.id(tempDiskFilesName)}`.execute(this.#db);

    return { createdStats, missingFiles };
  }

  /** Find possible matches in the database for the given missing files based on their metadata. */
  async findMissingDBMatches(
    missingFiles: FileDTO[],
  ): Promise<Array<[missingFileId: ID, dbMatch: FileDTO]>> {
    if (missingFiles.length === 0) {
      return [];
    }

    const dbWithTemp = this.#db.withTables<{
      tempMissingFiles: {
        id: string;
        name: string;
        ino: string;
        width: number | null;
        height: number | null;
        dateCreated: number;
      };
      fileTagAggregatesTemp: {
        fileId: ID;
        tags: ID[];
      };
      fileEpAggregatesTemp: {
        fileId: ID;
        extraProperties: EpValues[];
      };
    }>();

    // first insert all missing files into a temp table for easier and db optimized querying
    // use unique table name for concurrency
    const tempMissingName = `temp_missing_files_${generateId()}`;
    const tempMissingFiles = sql
      .table(tempMissingName)
      .as('tempMissingFiles') as unknown as 'tempMissingFiles';

    await sql`
      CREATE TEMP TABLE ${sql.id(tempMissingName)} (
        id TEXT PRIMARY KEY,
        name TEXT,
        ino TEXT,
        width INTEGER,
        height INTEGER,
        date_created INTEGER
      ) WITHOUT ROWID;
    `.execute(this.#db);

    const BATCH_SIZE = computeBatchSize(this.#maxVars, missingFiles[0]);
    await dbWithTemp.transaction().execute(async (trx) => {
      for (let i = 0; i < missingFiles.length; i += BATCH_SIZE) {
        const batch = [];
        const end = Math.min(i + BATCH_SIZE, missingFiles.length);
        for (let j = i; j < end; j++) {
          const f = missingFiles[j];
          batch.push({
            id: f.id,
            name: f.name,
            ino: f.ino,
            width: f.width,
            height: f.height,
            dateCreated: serializeDate(f.dateCreated),
          });
        }
        await trx
          .insertInto(tempMissingName as 'tempMissingFiles')
          .values(batch)
          .execute();
      }
    });

    // Compare metadata of two files to determine whether the files are (likely to be) identical
    const matches = await dbWithTemp
      .selectFrom(tempMissingFiles)
      .innerJoin('files', (join) =>
        join
          .onRef('files.id', '!=', 'tempMissingFiles.id')
          .on((eb) =>
            eb.or([
              eb('files.ino', '=', eb.ref('tempMissingFiles.ino')),
              eb.and([
                eb('files.width', '=', eb.ref('tempMissingFiles.width')),
                eb('files.height', '=', eb.ref('tempMissingFiles.height')),
                eb('files.dateCreated', '=', eb.ref('tempMissingFiles.dateCreated')),
              ]),
            ]),
          ),
      )
      .leftJoin('fileTagAggregatesTemp as ft', 'ft.fileId', 'files.id')
      .leftJoin('fileEpAggregatesTemp as fe', 'fe.fileId', 'files.id')
      .selectAll('files')
      .select(['ft.tags', 'fe.extraProperties', 'tempMissingFiles.id as missingSourceId'])
      // prioritize matches by name first, then by id to have a stable order
      .orderBy('tempMissingFiles.id')
      .orderBy(sql`CASE WHEN files.name = ${sql.ref('tempMissingFiles.name')} THEN 0 ELSE 1 END`)
      .execute();

    // clean temp table
    await sql`DROP TABLE IF EXISTS ${sql.id(tempMissingName)}`.execute(this.#db);

    // multiple matches can be found for the same missing file, keep the best one (first by name)
    const uniqueMatches = new Map<ID, FileDTO>();
    for (const row of matches) {
      if (!uniqueMatches.has(row.missingSourceId as ID)) {
        const { missingSourceId, ...fileData } = row;
        uniqueMatches.set(missingSourceId as ID, mapToDTO(fileData));
      }
    }

    // return entries for compatibility with worker mode.
    return Array.from(uniqueMatches.entries()).map(([missingId, matchedFile]) => [
      missingId,
      matchedFile,
    ]);
  }

  async clear(restoreEmpty: () => Promise<void>): Promise<void> {
    console.info('SQLite: Clearing database...');
    await restoreEmpty();
  }
}

function mapToDTO(dbFile: FileDTO | { [x: string]: any }): FileDTO {
  // convert data into FileDTO format
  const extraPropertyIDs: ID[] = [];
  const extraProperties: ExtraProperties = {};
  for (const ep of dbFile.extraProperties ?? []) {
    extraPropertyIDs.push(ep.epId);
    const val = ep.textValue ?? ep.numberValue; // ?? ep.timestampValue;
    if (val !== null) {
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
