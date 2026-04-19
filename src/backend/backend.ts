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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  RawBuilder,
} from 'kysely';
import { kyselyLogger, migrateToLatest, PAD_STRING_LENGTH } from './config';
import { DataStorage } from 'src/api/data-storage';
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
  PaginationDirection,
  Cursor,
  IndexableType,
} from 'src/api/data-storage-search';
import { ExtraProperties, ExtraPropertyDTO } from 'src/api/extraProperty';
import { FileDTO, FileStats } from 'src/api/file';
import { FileSearchDTO, SearchGroupDTO } from 'src/api/file-search';
import { generateId, ID } from 'src/api/id';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ROOT_TAG_ID, TagDTO } from 'src/api/tag';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { isFileExtensionVideo } from 'common/fs';
import { IS_DEV } from 'common/process';
import { UpdateObject } from 'kysely/dist/cjs/parser/update-set-parser';
import { SemanticSearchOptions, SemanticSearchStatus } from 'src/api/semantic-search';
import {
  float32BlobToVector,
  SemanticEmbedder,
  sourceHashForFile,
  vectorToFloat32Blob,
} from './semantic';
import { isRenderable3DModelPath } from 'src/rendering/ModelPreviewRenderer';

// Use to debug perfomance.
const USE_TIMING_PROXY = IS_DEV;
const USE_QUERY_LOGGER = false ? IS_DEV : false;
const SQLITE_VECTOR_TABLE = 'file_embeddings';
const SQLITE_VECTOR_COLUMN = 'embedding_blob';
const SEMANTIC_VIDEO_FRAME_COUNT = 4;
const SEMANTIC_VIDEO_FRAME_SAMPLE_RATIOS = [0.1, 0.35, 0.6, 0.85] as const;

export default class Backend implements DataStorage {
  readonly MAX_VARS!: number;
  #db!: Kysely<AllusionDB_SQL>;
  #sqlite!: SQLite.Database;
  #dbPath!: string;
  #notifyChange!: () => void;
  #restoreEmpty!: () => Promise<void>;
  /** State variable that indicates if we need to recompute preAggregateJSON */
  #isQueryDirty: boolean = true;
  // Seed used to have deterministic order when order by random
  #seed: number = generateSeed();
  #sqliteVectorAvailable = false;
  #sqliteVectorInitializedDimension: number | undefined;
  #sqliteVectorQuantizeDirty = true;
  #semanticEmbeddingDimension: number | undefined;
  readonly #semanticEmbedder = new SemanticEmbedder();
  readonly #semanticIndexQueue = new Set<ID>();
  #semanticIndexProcessing = false;
  #semanticIndexTotal = 0;
  #semanticIndexCompleted = 0;
  #semanticIndexFailed = 0;
  #bundledFfmpegPath: string | null | undefined;

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
    database.function('pad_string', { deterministic: true }, PadString);
    database.function('stable_hash', { deterministic: true }, stableHash);

    const dialect = new SqliteDialect({ database });
    const db = new Kysely<AllusionDB_SQL>({
      dialect: dialect,
      plugins: [new ParseJSONResultsPlugin(), new CamelCasePlugin()],
      log: USE_QUERY_LOGGER ? kyselyLogger : undefined, // Used only for debugging.
    });

    // Instead of initializing this through the constructor, set the class properties here,
    // this allows us to use the class as a worker having async await calls at init.
    this.#db = db;
    this.#sqlite = database;
    this.#dbPath = dbPath;
    this.#notifyChange = notifyChange;
    this.#restoreEmpty = restoreEmpty;
    (this as any).MAX_VARS = await getSqliteMaxVariables(db);

    // Run migrations if required
    if (mode === 'default' || mode === 'migrate') {
      await migrateToLatest(db, { jsonToImport });
    }

    this.#sqliteVectorAvailable = this.tryLoadSqliteVectorExtension(database);

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
          fileCount: 0,
          isFileCountDirty: serializeBoolean(true),
        })
        .execute();
    }
    await this.preAggregateJSON();
  }

  private tryLoadSqliteVectorExtension(database: SQLite.Database): boolean {
    const extensionPath = this.resolveSqliteVectorExtensionPath();
    if (!extensionPath) {
      return false;
    }

    try {
      database.loadExtension(extensionPath);
      const row = database.prepare('SELECT vector_version() AS version').get() as
        | { version?: string }
        | undefined;
      console.info(
        `SQLite: sqlite-vector extension loaded from "${extensionPath}" (${
          row?.version ?? 'unknown version'
        }).`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`SQLite: sqlite-vector extension failed to load (${message}).`);
      return false;
    }
  }

  private resolveSqliteVectorExtensionPath(): string | undefined {
    const configured = process.env.ALLUSION_SQLITE_VECTOR_PATH?.trim();
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    let ext = '.so';
    if (process.platform === 'win32') {
      ext = '.dll';
    } else if (process.platform === 'darwin') {
      ext = '.dylib';
    }
    const candidateNames = [`vector${ext}`, 'vector'];
    const roots = [
      path.resolve(process.cwd(), 'resources', 'sqlite-vector'),
      path.resolve(process.resourcesPath || '', 'sqlite-vector'),
    ];

    for (const root of roots) {
      for (const name of candidateNames) {
        const candidate = path.resolve(root, name);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private resolveBundledFfmpegPath(): string | undefined {
    const configured = process.env.ALLUSION_FFMPEG_PATH?.trim();
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const roots = [
      path.resolve(process.cwd(), 'resources', 'ffmpeg'),
      path.resolve(process.resourcesPath || '', 'ffmpeg'),
    ];

    for (const root of roots) {
      const candidate = path.resolve(root, executableName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private getBundledFfmpegPath(): string | undefined {
    if (this.#bundledFfmpegPath === undefined) {
      this.#bundledFfmpegPath = this.resolveBundledFfmpegPath() ?? null;
    }
    return this.#bundledFfmpegPath ?? undefined;
  }

  private async ensureSqliteVectorInitialized(dimension: number): Promise<void> {
    if (!this.#sqliteVectorAvailable) {
      throw new Error(
        'sqlite-vector extension is not available. Ensure resources/sqlite-vector contains the native vector binary.',
      );
    }

    if (dimension <= 0) {
      throw new Error('sqlite-vector initialization failed: invalid vector dimension.');
    }

    if (this.#sqliteVectorInitializedDimension === dimension) {
      return;
    }

    try {
      const options = `dimension=${dimension},type=FLOAT32,distance=COSINE`;
      await sql`SELECT vector_init(${SQLITE_VECTOR_TABLE}, ${SQLITE_VECTOR_COLUMN}, ${options})`.execute(
        this.#db,
      );
      this.#sqliteVectorInitializedDimension = dimension;
      this.#sqliteVectorQuantizeDirty = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`sqlite-vector initialization failed: ${message}`);
    }
  }

  private async ensureSqliteVectorQuantized(): Promise<void> {
    if (!this.#sqliteVectorQuantizeDirty) {
      return;
    }

    try {
      await sql`SELECT vector_quantize(${SQLITE_VECTOR_TABLE}, ${SQLITE_VECTOR_COLUMN})`.execute(
        this.#db,
      );
      await sql`SELECT vector_quantize_preload(${SQLITE_VECTOR_TABLE}, ${SQLITE_VECTOR_COLUMN})`.execute(
        this.#db,
      );
      this.#sqliteVectorQuantizeDirty = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`sqlite-vector quantization failed: ${message}`);
    }
  }

  async setSeed(seed?: number): Promise<void> {
    this.#seed = seed ?? generateSeed();
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
    this.#isQueryDirty = false;
  }

  async queryFiles<Q extends SelectQueryBuilder<any, any, any>>(
    criteria: ConditionGroupDTO<FileDTO> = { conjunction: 'and', children: [] },
    pagOptions: PaginationOptions,
    modifyQuery?: (qb: Q) => Q,
  ): Promise<FileDTO[]> {
    pagOptions.seed = this.#seed;
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

  async semanticSearchByText(query: string, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const queryEmbedding = await this.#semanticEmbedder.embedText(cleaned);
    this.#semanticEmbeddingDimension = queryEmbedding.length;
    return this.semanticSearchByEmbedding(queryEmbedding, undefined, options);
  }

  async semanticSearchByImage(fileId: ID, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    const files = await this.fetchFilesByID([fileId]);
    const queryFile = files.at(0);
    if (!queryFile) {
      return [];
    }

    const expectedDimension = await this.getSemanticEmbeddingDimension();
    const queryEmbedding = await this.ensureEmbeddingForFile(
      queryFile,
      false,
      undefined,
      expectedDimension,
    );
    return this.semanticSearchByEmbedding(queryEmbedding, fileId, options);
  }

  async warmupSemanticModel(): Promise<void> {
    await this.#semanticEmbedder.warmup();
  }

  async reindexSemanticEmbeddings(fileIds?: ID[]): Promise<number> {
    let files: FileDTO[];
    if (fileIds && fileIds.length > 0) {
      files = await this.fetchFilesByID(fileIds);
    } else {
      files = await this.queryFiles(undefined, {
        order: 'dateModifiedOS',
        direction: OrderDirection.Desc,
        useNaturalOrdering: false,
      });
    }

    const expectedDimension = await this.getSemanticEmbeddingDimension();

    let indexed = 0;
    for (const file of files) {
      try {
        await this.ensureEmbeddingForFile(file, true, undefined, expectedDimension);
        indexed++;
      } catch (error) {
        console.warn('Semantic reindex skipped unreadable file', file.absolutePath, error);
      }
    }
    return indexed;
  }

  async embedFileFromThumbnail(fileId: ID, thumbnailPath: string): Promise<void> {
    const file = (await this.fetchFilesByID([fileId])).at(0);
    if (!file) return;

    const sourceHash = sourceHashForFile(file);
    const modelId = this.#semanticEmbedder.modelId;
    const embedding = await this.#semanticEmbedder.embedImage(thumbnailPath);
    const embeddingBlob = vectorToFloat32Blob(embedding);
    const embeddingJson = JSON.stringify(embedding);

    await this.#db
      .insertInto('fileEmbeddings')
      .values({ fileId, modelId, embeddingJson, embeddingBlob, sourceHash, updatedAt: Date.now() })
      .onConflict((oc) =>
        oc.column('fileId').doUpdateSet({ modelId, embeddingJson, embeddingBlob, sourceHash, updatedAt: Date.now() }),
      )
      .execute();

    this.#sqliteVectorQuantizeDirty = true;
  }

  async fetchSemanticStatus(): Promise<SemanticSearchStatus> {
    const status = this.#semanticEmbedder.getStatus();
    const pending = this.#semanticIndexQueue.size;
    const total = Math.max(0, this.#semanticIndexTotal);
    const completed = Math.min(this.#semanticIndexCompleted, total);
    const progress = total <= 0 ? 1 : Math.min(1, completed / total);

    return {
      ...status,
      indexing: {
        isRunning: this.#semanticIndexProcessing,
        total,
        completed,
        failed: this.#semanticIndexFailed,
        pending,
        progress,
      },
    };
  }

  private async getSemanticEmbeddingDimension(): Promise<number> {
    if (this.#semanticEmbeddingDimension && this.#semanticEmbeddingDimension > 0) {
      return this.#semanticEmbeddingDimension;
    }

    const probe = await this.#semanticEmbedder.embedText('dimension probe');
    if (probe.length <= 0) {
      throw new Error('Semantic embedding dimension probe returned an empty vector.');
    }

    this.#semanticEmbeddingDimension = probe.length;
    return this.#semanticEmbeddingDimension;
  }

  private async semanticSearchByEmbedding(
    queryEmbedding: number[],
    queryFileId?: ID,
    options?: SemanticSearchOptions,
  ): Promise<FileDTO[]> {
    const topK = Math.max(1, options?.topK ?? 128);
    const minScore = options?.minScore ?? -1;

    // IMPORTANT: do not pre-limit by recency for semantic search.
    // A recency window biases the candidate pool and causes incorrect matches.
    const candidates = await this.queryFiles(options?.criteria, {
      order: 'dateModifiedOS',
      direction: OrderDirection.Desc,
      useNaturalOrdering: false,
      pagination: 'after',
    });

    if (candidates.length === 0) {
      return [];
    }

    const uniqueCandidates: FileDTO[] = [];
    const seenCandidateIds = new Set<ID>();
    for (const candidate of candidates) {
      if (!seenCandidateIds.has(candidate.id)) {
        seenCandidateIds.add(candidate.id);
        uniqueCandidates.push(candidate);
      }
    }

    const existingEmbeddings = await this.#db
      .selectFrom('fileEmbeddings')
      .select(['fileId', 'embeddingBlob', 'embeddingJson', 'sourceHash', 'modelId'])
      .where(
        'fileId',
        'in',
        uniqueCandidates.map((file) => file.id),
      )
      .execute();
    const existingByFileId = new Map<ID, (typeof existingEmbeddings)[number]>();
    for (const row of existingEmbeddings) {
      existingByFileId.set(row.fileId, row);
    }

    for (const file of uniqueCandidates) {
      if (!options?.includeQueryFile && queryFileId && file.id === queryFileId) {
        continue;
      }

      try {
        await this.ensureEmbeddingForFile(
          file,
          false,
          existingByFileId.get(file.id),
          queryEmbedding.length,
        );
      } catch (error) {
        console.warn('Semantic search skipped unreadable file', file.absolutePath, error);
      }
    }

    return this.semanticSearchByEmbeddingSqliteVector(
      queryEmbedding,
      uniqueCandidates,
      queryFileId,
      topK,
      minScore,
      options?.includeQueryFile,
    );
  }

  private async semanticSearchByEmbeddingSqliteVector(
    queryEmbedding: number[],
    candidates: FileDTO[],
    queryFileId: ID | undefined,
    topK: number,
    minScore: number,
    includeQueryFile: boolean | undefined,
  ): Promise<FileDTO[]> {
    await this.ensureSqliteVectorInitialized(queryEmbedding.length);
    await this.ensureSqliteVectorQuantized();

    const candidateById = new Map<ID, FileDTO>();
    for (const file of candidates) {
      candidateById.set(file.id, file);
    }
    const candidateIds = Array.from(candidateById.keys());
    if (candidateIds.length === 0) {
      return [];
    }

    const placeholders = candidateIds.map(() => '?').join(', ');
    const shouldExcludeQueryFile = !includeQueryFile && queryFileId !== undefined;

    const query = `
      SELECT fe.file_id as fileId, v.distance as distance
      FROM vector_quantize_scan('${SQLITE_VECTOR_TABLE}', '${SQLITE_VECTOR_COLUMN}', ?) AS v
      JOIN file_embeddings fe ON fe.rowid = v.rowid
      WHERE fe.model_id = ?
        AND fe.embedding_blob IS NOT NULL
        AND fe.file_id IN (${placeholders})
        ${shouldExcludeQueryFile ? 'AND fe.file_id <> ?' : ''}
      ORDER BY v.distance ASC
      LIMIT ?
    `;

    const params: Array<string | Uint8Array | number> = [
      vectorToFloat32Blob(queryEmbedding),
      this.#semanticEmbedder.modelId,
      ...candidateIds,
    ];
    if (shouldExcludeQueryFile && queryFileId !== undefined) {
      params.push(queryFileId);
    }
    params.push(Math.min(candidateIds.length, Math.max(topK * 4, topK)));

    type ResultRow = { fileId: ID; distance: number };
    const rows = this.#sqlite.prepare(query).all(...params) as ResultRow[];

    const filtered = rows
      .map((row) => {
        const score = 1 - row.distance;
        return { file: candidateById.get(row.fileId), score };
      })
      .filter((entry): entry is { file: FileDTO; score: number } => entry.file !== undefined)
      .filter((entry) => minScore <= -1 || entry.score >= minScore);

    return filtered.slice(0, topK).map((entry) => entry.file);
  }

  private async ensureEmbeddingForFile(
    file: FileDTO,
    forceReindex = false,
    existingEmbedding?: {
      embeddingBlob: Uint8Array | null;
      embeddingJson: string;
      sourceHash: string;
      modelId: string;
    },
    expectedDimension?: number,
  ): Promise<number[]> {
    const sourceHash = sourceHashForFile(file);
    const modelId = this.#semanticEmbedder.modelId;

    const existing =
      existingEmbedding ??
      (await this.#db
        .selectFrom('fileEmbeddings')
        .select(['embeddingBlob', 'embeddingJson', 'sourceHash', 'modelId'])
        .where('fileId', '=', file.id)
        .executeTakeFirst());

    if (!forceReindex && existing?.sourceHash === sourceHash && existing.modelId === modelId) {
      if (existing.embeddingBlob) {
        const vector = float32BlobToVector(existing.embeddingBlob);
        if (vector.length > 0 && (!expectedDimension || vector.length === expectedDimension)) {
          return vector;
        }
      }

      try {
        const vector = JSON.parse(existing.embeddingJson) as number[];
        if (
          Array.isArray(vector) &&
          vector.length > 0 &&
          (!expectedDimension || vector.length === expectedDimension)
        ) {
          return vector;
        }
      } catch {
        // Ignore malformed legacy JSON and regenerate below.
      }
    }

    let embedding: number[];
    if (isFileExtensionVideo(file.extension)) {
      embedding = await this.embedVideoSemanticEmbedding(file, expectedDimension);
    } else {
      let embeddingSourcePath = file.absolutePath;
      let cleanupPreviewPath: string | undefined;
      if (isRenderable3DModelPath(file.absolutePath)) {
        // Three.js and Spark both need `window` (WebGL), which isn't available in the
        // backend worker context. 3D models cannot be semantically embedded here.
        throw new Error(`3D format not supported for semantic embedding: ${file.absolutePath}`);
      }

      try {
        embedding = await this.#semanticEmbedder.embedImage(embeddingSourcePath);
      } finally {
        if (cleanupPreviewPath) {
          fs.promises.rm(cleanupPreviewPath, { force: true }).catch(() => undefined);
        }
      }
    }

    if (expectedDimension && embedding.length !== expectedDimension) {
      throw new Error(
        `Semantic image embedding dimension mismatch for ${file.absolutePath}: expected ${expectedDimension}, got ${embedding.length}.`,
      );
    }

    const embeddingBlob = vectorToFloat32Blob(embedding);
    const embeddingJson = JSON.stringify(embedding);

    await this.#db
      .insertInto('fileEmbeddings')
      .values({
        fileId: file.id,
        modelId,
        embeddingJson,
        embeddingBlob,
        sourceHash,
        updatedAt: Date.now(),
      })
      .onConflict((oc) =>
        oc.column('fileId').doUpdateSet({
          modelId,
          embeddingJson,
          embeddingBlob,
          sourceHash,
          updatedAt: Date.now(),
        }),
      )
      .execute();

    this.#sqliteVectorQuantizeDirty = true;

    return embedding;
  }

  private async embedVideoSemanticEmbedding(
    file: FileDTO,
    expectedDimension?: number,
  ): Promise<number[]> {
    const ffmpegPath = this.getBundledFfmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        `Semantic video embedding requires a bundled ffmpeg binary, but none was found for ${file.absolutePath}.`,
      );
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'allusion-semantic-video-'));
    try {
      const framePaths = await extractVideoFrames(
        ffmpegPath,
        file.absolutePath,
        tempDir,
        SEMANTIC_VIDEO_FRAME_SAMPLE_RATIOS,
      );
      if (framePaths.length === 0) {
        throw new Error(`Could not extract semantic frames from ${file.absolutePath}.`);
      }

      const frameEmbeddings: number[][] = [];
      for (const framePath of framePaths.slice(0, SEMANTIC_VIDEO_FRAME_COUNT)) {
        const embedding = await this.#semanticEmbedder.embedImage(framePath);
        if (expectedDimension && embedding.length !== expectedDimension) {
          throw new Error(
            `Semantic video embedding dimension mismatch for ${file.absolutePath}: expected ${expectedDimension}, got ${embedding.length}.`,
          );
        }
        frameEmbeddings.push(embedding);
      }

      if (frameEmbeddings.length === 0) {
        throw new Error(
          `Semantic video embedding produced no frame vectors for ${file.absolutePath}.`,
        );
      }

      return meanPoolEmbeddings(frameEmbeddings);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
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

    this.enqueueSemanticEmbeddings(filesDTO.map((file) => file.id));

    this.#isQueryDirty = true;
    this.#notifyChange();
    console.info('SQLite: Files created successfully');
  }

  private enqueueSemanticEmbeddings(fileIds: ID[]): void {
    if (fileIds.length === 0) {
      return;
    }

    if (!this.#semanticIndexProcessing && this.#semanticIndexQueue.size === 0) {
      this.#semanticIndexTotal = 0;
      this.#semanticIndexCompleted = 0;
      this.#semanticIndexFailed = 0;
    }

    let added = 0;
    for (const fileId of fileIds) {
      if (this.#semanticIndexQueue.has(fileId)) {
        continue;
      }
      this.#semanticIndexQueue.add(fileId);
      added++;
    }

    if (added <= 0) {
      return;
    }

    this.#semanticIndexTotal += added;

    if (!this.#semanticIndexProcessing) {
      void this.processSemanticEmbeddingQueue();
    }
  }

  private takeNextSemanticQueueFileId(): ID | undefined {
    const iterator = this.#semanticIndexQueue.values().next();
    if (iterator.done) {
      return undefined;
    }

    const fileId = iterator.value;
    this.#semanticIndexQueue.delete(fileId);
    return fileId;
  }

  private async processSemanticEmbeddingQueue(): Promise<void> {
    if (this.#semanticIndexProcessing) {
      return;
    }

    this.#semanticIndexProcessing = true;

    try {
      const expectedDimension = await this.getSemanticEmbeddingDimension();

      while (true) {
        const fileId = this.takeNextSemanticQueueFileId();
        if (!fileId) {
          break;
        }

        try {
          const file = (await this.fetchFilesByID([fileId])).at(0);
          if (file) {
            await this.ensureEmbeddingForFile(file, false, undefined, expectedDimension);
          }
        } catch (error) {
          this.#semanticIndexFailed++;
          if (!(error instanceof Error && error.message.startsWith('3D format not supported'))) {
            console.warn('Background semantic indexing skipped file', fileId, error);
          }
        } finally {
          this.#semanticIndexCompleted++;
        }
      }
    } catch (error) {
      console.warn('Background semantic indexing queue failed', error);
    } finally {
      this.#semanticIndexProcessing = false;
      if (this.#semanticIndexQueue.size > 0) {
        void this.processSemanticEmbeddingQueue();
      }
    }
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
      await upsertTable(this.MAX_VARS, trx, 'tags', tags, ['id'], ['dateAdded']);
      if (subTags.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'subTags', subTags, ['tagId', 'subTagId']);
      }
      if (tagImplications.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'tagImplications', tagImplications, ['tagId', 'impliedTagId']); // eslint-disable-line prettier/prettier
      }
      if (tagAliases.length > 0) {
        await upsertTable(this.MAX_VARS, trx, 'tagAliases', tagAliases, ['tagId', 'alias']);
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
          this.MAX_VARS,
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

  async addTagsToFiles(tagIds: ID[], criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    console.info('SQLite: Add tags to filtered files...', criteria, tagIds);
    // Subquery tipado correctamente
    let fileSubquery = this.#db.selectFrom('files').select('files.id as fileId');
    fileSubquery = applyFileFilters(fileSubquery, criteria);

    // Crear valores de tags como CTE o subquery
    await this.#db
      .insertInto('fileTags')
      .columns(['fileId', 'tagId'])
      .expression(() => {
        // Usar raw SQL para el cross join con los valores
        const tagValues = tagIds.map((id) => `SELECT '${id}' as tag_id`).join(' UNION ALL ');

        return this.#db
          .selectFrom(fileSubquery.as('matchedFiles'))
          .crossJoin(sql`(${sql.raw(tagValues)})`.as('tagValues'))
          .select(['matchedFiles.fileId', sql<number>`tag_values.tag_id`.as('tagId')])
          .where(sql<SqlBool>`true`);
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    this.#isQueryDirty = true;
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

    this.#isQueryDirty = true;
  }

  async clearTagsFromFiles(criteria?: ConditionGroupDTO<FileDTO>): Promise<void> {
    let fileSubquery = this.#db.selectFrom('files').select('files.id');
    fileSubquery = applyFileFilters(fileSubquery, criteria);

    await this.#db.deleteFrom('fileTags').where('fileId', 'in', fileSubquery).execute();

    this.#isQueryDirty = true;
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

    const DISK_FILES_BATCH_SIZE = computeBatchSize(this.MAX_VARS, diskFiles[0]);
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

    const BATCH_SIZE = computeBatchSize(this.MAX_VARS, missingFiles[0]);
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
    // same logic as areFilesIdenticalBesidesName but in DB for optimization to trasverse all files.
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

function isValidCursor(cursor: any): cursor is Cursor {
  if (typeof cursor === 'object' && 'orderValue' in cursor && 'id' in cursor) {
    if (typeof cursor.id === 'string' && cursor.orderValue !== undefined) {
      return true;
    }
  }
  return false;
}

function PadString(str: string): string {
  return str.replace(/\d+/g, (num: string) => num.padStart(PAD_STRING_LENGTH, '0'));
}

function stableHash(id: string, seed: number): number {
  let h = seed | 0;

  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }

  return h >>> 0;
}

function generateSeed() {
  return Date.now() >>> 0;
}

async function extractVideoFrames(
  ffmpegPath: string,
  videoPath: string,
  outputDir: string,
  ratios: readonly number[],
): Promise<string[]> {
  const duration = await probeVideoDurationSeconds(ffmpegPath, videoPath);
  const timestamps = computeSampleTimestamps(duration, ratios);
  const framePaths: string[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const framePath = path.resolve(outputDir, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      timestamps[i].toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      framePath,
    ];

    await runProcess(ffmpegPath, args);
    const exists = await fsp
      .stat(framePath)
      .then((info) => info.isFile())
      .catch(() => false);
    if (exists) {
      framePaths.push(framePath);
    }
  }

  return framePaths;
}

async function probeVideoDurationSeconds(ffmpegPath: string, videoPath: string): Promise<number> {
  const args = ['-hide_banner', '-i', videoPath];
  const result = await runProcess(ffmpegPath, args, [0, 1]);
  const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(result.stderr);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function computeSampleTimestamps(durationSeconds: number, ratios: readonly number[]): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0, 1, 2, 3].slice(0, ratios.length);
  }

  const maxTimestamp = Math.max(0, durationSeconds - 0.05);
  return ratios.map((ratio) => {
    const normalizedRatio = Math.min(1, Math.max(0, ratio));
    return Math.min(maxTimestamp, durationSeconds * normalizedRatio);
  });
}

function meanPoolEmbeddings(embeddings: number[][]): number[] {
  const first = embeddings[0];
  const sum = first.slice();

  for (let i = 1; i < embeddings.length; i++) {
    const current = embeddings[i];
    if (current.length !== sum.length) {
      throw new Error('Cannot aggregate semantic video frame embeddings with mismatched sizes.');
    }
    for (let dim = 0; dim < sum.length; dim++) {
      sum[dim] += current[dim];
    }
  }

  for (let dim = 0; dim < sum.length; dim++) {
    sum[dim] /= embeddings.length;
  }

  let norm = 0;
  for (const value of sum) {
    norm += value * value;
  }
  if (norm <= 0) {
    return sum;
  }

  const scale = 1 / Math.sqrt(norm);
  return sum.map((value) => value * scale);
}

async function runProcess(
  executable: string,
  args: string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : -1;
      if (allowedExitCodes.includes(exitCode)) {
        resolve({ stdout, stderr });
        return;
      }

      const stderrTrimmed = stderr.trim();
      reject(
        new Error(
          `Process failed (${executable} ${args.join(' ')}), exit=${exitCode}${
            stderrTrimmed ? `: ${stderrTrimmed}` : ''
          }`,
        ),
      );
    });
  });
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

type PaginationOptions = {
  order: OrderBy<FileDTO>;
  direction?: OrderDirection;
  useNaturalOrdering?: boolean;
  limit?: number;
  pagination?: PaginationDirection;
  cursor?: Cursor;
  extraPropertyID?: string;
  seed?: number;
};

// Original implementation by Pianissi
async function applyPagination<O>(
  db: Kysely<AllusionDB_SQL>,
  q: SelectQueryBuilder<AllusionDB_SQL, 'files', O>,
  pagOptions: PaginationOptions,
): Promise<SelectQueryBuilder<AllusionDB_SQL, 'files', O>> {
  const { direction, useNaturalOrdering, extraPropertyID } = pagOptions;
  const { pagination, cursor, limit } = pagOptions;
  const { order } = pagOptions;

  let sqlDirection: OrderByDirection = direction === OrderDirection.Asc ? 'asc' : 'desc';
  let orderColumn: string | RawBuilder<unknown> =
    order === 'extraProperty' ? 'sortValue' : `files.${order}`;
  let type: 'text' | 'number' =
    order !== 'extraProperty' && order !== 'random' && isFileDTOPropString(order)
      ? 'text'
      : 'number';
  // Compute pagination consts
  const isAfter = pagination === 'after';
  const isAsc = sqlDirection === 'asc';
  const operator = isAfter === isAsc ? '>' : '<';
  const isValidPagination = isValidCursor(cursor) && pagination;
  // alter sqlDirection only if a valid pagination applies
  if (isValidPagination) {
    // if pagination === 'before' invert direction to fetch adjacent elements, then after executing the query apply a reverse to the result data.
    sqlDirection = !isAfter ? (isAsc ? 'desc' : 'asc') : sqlDirection;
  }

  /// add extraproperty optional value ///
  // because of how the joined table is returned as, we need to aggregate a sort value in the joined table which can be used as a key
  if (order === 'extraProperty') {
    const extraProp = await db
      .selectFrom('extraProperties' as any)
      .select('type')
      .where('id' as any, '=', extraPropertyID)
      .executeTakeFirst();

    if (!extraPropertyID || !extraProp) {
      q = q.select(sql<null>`NULL`.as('sortValue'));
    } else {
      // maping value type to column
      // TODO: add timestamp mapping when implementing that extra property
      const valueColumn = extraProp.type === 'text' ? 'textValue' : 'numberValue';
      type = extraProp.type === 'text' ? 'text' : 'number';
      // Left join the corresponding extraProperty value and select it as sortValue
      q = q
        .leftJoin('epValues', (join) =>
          join.onRef('epValues.fileId', '=', 'files.id').on('epValues.epId', '=', extraPropertyID),
        )
        .select(`epValues.${valueColumn} as sortValue` as any) as any;
    }
  }

  // convert columns to handle nulls in pagination this also applies the natural ordering formating
  const { safeColumn, safeOrderValue } = getOrderColumnExpression(
    orderColumn,
    type,
    cursor?.orderValue,
    direction, // use original direction since sqlDirection can be altered for pagination
    useNaturalOrdering,
    order === 'extraProperty',
  );
  orderColumn = safeColumn;

  // PAGINATION LOGIC
  if (isValidPagination) {
    const { id } = cursor;

    if (order === 'random') {
      // In random we use a pseudo random but stable hash value based on the cursor, this allow us to use pagination while order by random
      const seed = pagOptions.seed ?? 0;
      const cursorHash = stableHash(id, seed);
      q = q.where((eb) =>
        eb.or([
          eb(sql`stable_hash(files.id, ${seed})`, operator, cursorHash),
          eb.and([
            eb(sql`stable_hash(files.id, ${seed})`, '=', cursorHash),
            eb('files.id', operator, id),
          ]),
        ]),
      );
    } else {
      // Standard pagination: (orderColumn, id) > (orderValue, id)
      q = q.where((eb) =>
        eb.or([
          eb(orderColumn as any, operator, safeOrderValue),
          eb.and([eb(orderColumn as any, '=', safeOrderValue), eb('files.id', operator, id)]),
        ]),
      );
    }
  }
  //PAGINATION LOGIC END

  // Apply Ordering
  if (order === 'random') {
    const seed = pagOptions.seed ?? 0;
    q = q.orderBy(sql`stable_hash(files.id, ${seed})`, sqlDirection);
  } else {
    // Default
    q = q.orderBy(orderColumn as any, sqlDirection);
  }

  // Allways append order by some unique value, required for pagination
  q = q.orderBy('files.id', sqlDirection);

  // Apply limit
  if (limit) {
    q = q.limit(limit);
  }

  return q;
}

/**
 * Normalizes a column and its cursor value for consistent sorting.
 * Handles natural ordering via padding and provides fallback values
 * for null/undefined to ensure stable pagination.
 */
export function getOrderColumnExpression(
  columnName: string,
  type: 'text' | 'number',
  orderValue: unknown,
  direction?: OrderDirection,
  useNaturalOrdering?: boolean,
  useNullFallback?: boolean,
): { safeColumn: RawBuilder<unknown>; safeOrderValue: unknown } {
  const isAsc = direction === OrderDirection.Asc;
  const isText = type === 'text';

  // Set a fallback value per data type, Date is managed as number
  let fallbackValue;
  if (isText) {
    fallbackValue = isAsc ? '\uffff\uffff\uffff' : '';
  } else {
    fallbackValue = isAsc ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
  }

  let safeOrderValue =
    useNullFallback && (orderValue === null || orderValue === undefined)
      ? fallbackValue
      : orderValue;
  let colExpression = sql.ref(columnName);
  // Add PAD_STRING if needed
  if (isText && useNaturalOrdering) {
    safeOrderValue = PadString(String(safeOrderValue));
    colExpression = sql`PAD_STRING(${colExpression})`;
  }
  const safeColumn = useNullFallback
    ? sql`COALESCE(${colExpression}, ${fallbackValue})`
    : colExpression;

  return { safeColumn, safeOrderValue };
}

///////////////////////////
///////// FILTERS /////////
///////////////////////////

type MustIncludeFiles<T> = 'files' extends T ? T : never;

export type ConditionWithConjunction<T> = ConditionDTO<T> & {
  conjunction?: SearchConjunction;
};

function applyFileFilters<DB extends AllusionDB_SQL, TB extends MustIncludeFiles<keyof DB>, O>(
  q: SelectQueryBuilder<DB, TB, O>,
  criteria?: ConditionGroupDTO<FileDTO>,
): SelectQueryBuilder<DB, TB, O> {
  if (!criteria || criteria.children.length === 0) {
    return q;
  }
  return q.where((eb) =>
    expressionFromNode(
      eb as ExpressionBuilder<AllusionDB_SQL, 'files'>,
      criteria as unknown as ConditionGroupDTO<Files>,
    ),
  );
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
          subquery = subquery.where(sql`LOWER(${sql.ref('epValues.textValue')})`, '=', innerValue.toLowerCase());
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
          subquery = subquery.where(sql`LOWER(${sql.ref('epValues.textValue')})`, 'like', `${innerValue.toLowerCase()}%`);
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
  maxVars: number,
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
    return query.execute();
  }

  // batching logic for arrays
  const batchSize = computeBatchSize(maxVars, referenceRow);
  const results = [];

  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    const batchQuery = query.values(batch as any);
    results.push(await batchQuery.execute());
  }

  return results;
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
    fileCount: tag.fileCount,
    isFileCountDirty: serializeBoolean(tag.isFileCountDirty),
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
