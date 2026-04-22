import SQLite from 'better-sqlite3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Kysely, sql } from 'kysely';
import { AllusionDB_SQL } from '../schemaTypes';
import { FileDTO } from 'src/api/file';
import { ID } from 'src/api/id';
import { SemanticSearchOptions, SemanticSearchStatus } from 'src/api/semantic-search';
import {
  float32BlobToVector,
  SemanticEmbedder,
  sourceHashForFile,
  vectorToFloat32Blob,
  computeSampleTimestamps,
  meanPoolEmbeddings,
} from '../semantic';
import { isFileExtensionVideo } from 'common/fs';
import { isRenderable3DModelPath } from 'src/rendering/ModelPreviewRenderer';
import { OrderDirection } from 'src/api/data-storage-search';
import { ConditionGroupDTO } from 'src/api/data-storage-search';
import { PaginationOptions } from '../query-builder';

const SQLITE_VECTOR_TABLE = 'file_embeddings';
const SQLITE_VECTOR_COLUMN = 'embedding_blob';
const SEMANTIC_VIDEO_FRAME_COUNT = 4;
const SEMANTIC_VIDEO_FRAME_SAMPLE_RATIOS = [0.1, 0.35, 0.6, 0.85] as const;

export class SemanticRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #sqlite: SQLite.Database;
  readonly #semanticEmbedder = new SemanticEmbedder();
  readonly #semanticIndexQueue = new Set<ID>();
  #sqliteVectorAvailable = false;
  #sqliteVectorInitializedDimension: number | undefined;
  #sqliteVectorQuantizeDirty = true;
  #semanticEmbeddingDimension: number | undefined;
  #bundledFfmpegPath: string | null | undefined;
  #semanticIndexProcessing = false;
  #semanticIndexTotal = 0;
  #semanticIndexCompleted = 0;
  #semanticIndexFailed = 0;

  readonly #fetchFilesByID: (ids: ID[]) => Promise<FileDTO[]>;
  readonly #queryFiles: (
    criteria: ConditionGroupDTO<FileDTO> | undefined,
    pagOptions: PaginationOptions,
  ) => Promise<FileDTO[]>;

  constructor(
    db: Kysely<AllusionDB_SQL>,
    sqlite: SQLite.Database,
    fetchFilesByID: (ids: ID[]) => Promise<FileDTO[]>,
    queryFiles: (
      criteria: ConditionGroupDTO<FileDTO> | undefined,
      pagOptions: PaginationOptions,
    ) => Promise<FileDTO[]>,
  ) {
    this.#db = db;
    this.#sqlite = sqlite;
    this.#fetchFilesByID = fetchFilesByID;
    this.#queryFiles = queryFiles;
    this.#sqliteVectorAvailable = this.tryLoadSqliteVectorExtension(sqlite);
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
      path.resolve(process.resourcesPath || '', 'resources', 'sqlite-vector'),
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
      path.resolve(process.resourcesPath || '', 'resources', 'ffmpeg'),
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
    const files = await this.#fetchFilesByID([fileId]);
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

  async semanticSearchByImages(fileIds: ID[], options?: SemanticSearchOptions): Promise<FileDTO[]> {
    if (fileIds.length === 0) {
      return [];
    }
    if (fileIds.length === 1) {
      return this.semanticSearchByImage(fileIds[0], options);
    }

    const files = await this.#fetchFilesByID(fileIds);
    if (files.length === 0) {
      return [];
    }

    const expectedDimension = await this.getSemanticEmbeddingDimension();
    const embeddings: number[][] = [];

    for (const file of files) {
      try {
        const emb = await this.ensureEmbeddingForFile(file, false, undefined, expectedDimension);
        embeddings.push(emb);
      } catch {
        // Skip files that cannot be embedded
      }
    }

    if (embeddings.length === 0) {
      return [];
    }

    const centroid = meanPoolEmbeddings(embeddings);
    const queryFileIdSet = new Set(fileIds);
    const results = await this.semanticSearchByEmbedding(centroid, undefined, options);
    return results.filter((f) => !queryFileIdSet.has(f.id));
  }

  async warmupSemanticModel(): Promise<void> {
    await this.#semanticEmbedder.warmup();
  }

  async reindexSemanticEmbeddings(fileIds?: ID[]): Promise<number> {
    let files: FileDTO[];
    if (fileIds && fileIds.length > 0) {
      files = await this.#fetchFilesByID(fileIds);
    } else {
      files = await this.#queryFiles(undefined, {
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
    const file = (await this.#fetchFilesByID([fileId])).at(0);
    if (!file) {
      return;
    }

    const sourceHash = sourceHashForFile(file);
    const modelId = this.#semanticEmbedder.modelId;

    const existing = await this.#db
      .selectFrom('fileEmbeddings')
      .select(['sourceHash', 'modelId'])
      .where('fileId', '=', fileId)
      .executeTakeFirst();
    if (existing?.sourceHash === sourceHash && existing.modelId === modelId) {
      return;
    }

    const embedding = await this.#semanticEmbedder.embedImage(thumbnailPath);
    const embeddingBlob = vectorToFloat32Blob(embedding);
    const embeddingJson = JSON.stringify(embedding);

    await this.#db
      .insertInto('fileEmbeddings')
      .values({ fileId, modelId, embeddingJson, embeddingBlob, sourceHash, updatedAt: Date.now() })
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
    const candidates = await this.#queryFiles(options?.criteria, {
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
        if (!(error instanceof Error && error.message.startsWith('3D format not supported'))) {
          console.warn('Semantic search skipped unreadable file', file.absolutePath, error);
        }
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
      const embeddingSourcePath = file.absolutePath;
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

  enqueueSemanticEmbeddings(fileIds: ID[]): void {
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
          const file = (await this.#fetchFilesByID([fileId])).at(0);
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
