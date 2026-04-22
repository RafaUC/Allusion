import fs from 'node:fs';
import path from 'node:path';
import { FileDTO } from 'src/api/file';
import { SemanticSearchStatus, SemanticStatusState } from 'src/api/semantic-search';

const DEFAULT_SEMANTIC_MODEL_ID = 'Xenova/siglip-base-patch16-224';
const SEMANTIC_CACHE_DIR_NAME = 'semantic-model-cache';

export class SemanticEmbedder {
  readonly #modelId: string;
  #textTokenizer: any;
  #textModel: any;
  #imagePipeline: any;
  #initPromise: Promise<void> | undefined;
  #status: SemanticStatusState = 'idle';
  #initError: Error | undefined;

  constructor(modelId = DEFAULT_SEMANTIC_MODEL_ID) {
    this.#modelId = modelId;
  }

  get modelId(): string {
    return this.#modelId;
  }

  getStatus(): SemanticSearchStatus {
    return {
      modelId: this.#modelId,
      state: this.#status,
      error: this.#initError?.message,
      indexing: {
        isRunning: false,
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        progress: 1,
      },
    };
  }

  async warmup(): Promise<void> {
    await this.ensureInitialized();
  }

  async embedText(text: string): Promise<number[]> {
    await this.ensureInitialized();
    const inputs = await this.#textTokenizer(text, {
      padding: 'max_length',
      truncation: true,
      max_length: 64,
    });
    const output = await this.#textModel(inputs);
    const parsed = parseTextEmbeddingOutput(output, inputs?.attention_mask);
    if (parsed.length === 0) {
      throw new Error('SemanticEmbedder: Text embedding returned an empty vector.');
    }
    return normalizeVector(parsed);
  }

  async embedImage(absolutePath: string): Promise<number[]> {
    await this.ensureInitialized();
    // For transformers.js image-feature-extraction, `pool: true` returns `pooler_output`.
    // `pooling` / `normalize` are not recognized options for this pipeline.
    const output = await this.#imagePipeline(absolutePath, { pool: true });
    const parsed = parseImageEmbeddingOutput(output);
    if (parsed.length === 0) {
      throw new Error(
        `SemanticEmbedder: Image embedding returned an empty vector for ${absolutePath}.`,
      );
    }
    return normalizeVector(parsed);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.#status === 'ready') {
      return;
    }

    if (this.#initPromise !== undefined) {
      await this.#initPromise;
      return;
    }

    this.#status = 'loading';
    this.#initError = undefined;

    this.#initPromise = this.initializeModel();
    try {
      await this.#initPromise;
    } finally {
      this.#initPromise = undefined;
    }
  }

  private async initializeModel(): Promise<void> {
    const isPackaged = isPackagedRuntime();
    const cacheDir = resolveSemanticCacheDir(isPackaged);
    const modelCachePath = resolveModelCachePath(cacheDir, this.#modelId);

    try {
      const transformers = await import('@huggingface/transformers');
      if (transformers.env) {
        fs.mkdirSync(cacheDir, { recursive: true });
        transformers.env.allowLocalModels = true;
        transformers.env.useBrowserCache = false;
        transformers.env.useFSCache = true;
        transformers.env.cacheDir = cacheDir;
        transformers.env.localModelPath = cacheDir;
        transformers.env.allowRemoteModels = !isPackaged;
      }

      try {
        const modelOptions = { dtype: 'q8' as const };
        this.#textTokenizer = await transformers.AutoTokenizer.from_pretrained(this.#modelId);
        this.#textModel = await loadSiglipTextModel(transformers, this.#modelId, modelOptions);
        this.#imagePipeline = await transformers.pipeline(
          'image-feature-extraction',
          this.#modelId,
          modelOptions,
        );
      } catch (initError) {
        if (!isPackaged && shouldRepairCorruptedModelCache(initError)) {
          fs.rmSync(modelCachePath, { recursive: true, force: true });
          const modelOptions = { dtype: 'q8' as const };
          this.#textTokenizer = await transformers.AutoTokenizer.from_pretrained(this.#modelId);
          this.#textModel = await loadSiglipTextModel(transformers, this.#modelId, modelOptions);
          this.#imagePipeline = await transformers.pipeline(
            'image-feature-extraction',
            this.#modelId,
            modelOptions,
          );
        } else {
          throw initError;
        }
      }
      this.#status = 'ready';
      this.#initError = undefined;
    } catch (error) {
      this.#initError =
        error instanceof Error ? error : new Error('SemanticEmbedder: Unknown init error');
      this.#status = 'error';
      throw new Error(
        `SemanticEmbedder: Could not initialize model "${this.#modelId}". ${
          this.#initError.message
        }${
          isPackagedRuntime()
            ? ' Run `yarn prefetch:semantic-model` before packaging so the model cache is bundled.'
            : ''
        }`,
      );
    }
  }
}

async function loadSiglipTextModel(
  transformers: any,
  modelId: string,
  modelOptions: { dtype: 'q8' },
): Promise<any> {
  if (typeof transformers.SiglipTextModel?.from_pretrained === 'function') {
    return transformers.SiglipTextModel.from_pretrained(modelId, modelOptions);
  }

  // Fallback for older/newer transformers.js builds where SiglipTextModel is not exported.
  return transformers.AutoModel.from_pretrained(modelId, modelOptions);
}

function isPackagedRuntime(): boolean {
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') {
    return false;
  }

  const argvHasAsar = process.argv.some((arg) => arg.includes('app.asar'));
  const dirnameHasAsar = __dirname.includes('app.asar');
  return argvHasAsar || dirnameHasAsar;
}

function resolveSemanticCacheDir(isPackaged: boolean): string {
  if (isPackaged) {
    return path.resolve(process.resourcesPath, 'resources', SEMANTIC_CACHE_DIR_NAME);
  }
  return path.resolve(process.cwd(), 'resources', SEMANTIC_CACHE_DIR_NAME);
}

function resolveModelCachePath(cacheDir: string, modelId: string): string {
  return path.resolve(cacheDir, modelId);
}

function shouldRepairCorruptedModelCache(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('protobuf parsing failed') || message.includes('unexpected end of data');
}

/**
 * Computes sample timestamps (in seconds) from a video duration and a list of ratios.
 */
export function computeSampleTimestamps(
  durationSeconds: number,
  ratios: readonly number[],
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0, 1, 2, 3].slice(0, ratios.length);
  }

  const maxTimestamp = Math.max(0, durationSeconds - 0.05);
  return ratios.map((ratio) => {
    const normalizedRatio = Math.min(1, Math.max(0, ratio));
    return Math.min(maxTimestamp, durationSeconds * normalizedRatio);
  });
}

/**
 * Computes the mean-pooled (and L2-normalized) embedding from multiple frame embeddings.
 */
export function meanPoolEmbeddings(embeddings: number[][]): number[] {
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

export function sourceHashForFile(file: FileDTO): string {
  const parts = [
    file.absolutePath,
    String(file.size),
    String(file.width),
    String(file.height),
    String(file.dateModifiedOS.getTime()),
  ];
  return fnv1a(parts.join('|'));
}

export function vectorToFloat32Blob(vector: number[]): Uint8Array {
  const float32 = Float32Array.from(vector);
  return new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
}

export function float32BlobToVector(blob: Uint8Array): number[] {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
    return [];
  }
  const float32 = new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
  return Array.from(float32);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA <= 0 || normB <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizeVector(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm <= 0) {
    return vector;
  }
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

export function blendEmbeddings(a: number[], b: number[], textWeight: number): number[] {
  const w = Math.max(0, Math.min(1, textWeight));
  const blended = a.map((v, i) => v * w + b[i] * (1 - w));
  return normalizeVector(blended);
}

export function subtractEmbedding(positive: number[], negative: number[], negativeWeight: number): number[] {
  const w = Math.max(0, Math.min(1, negativeWeight));
  const result = positive.map((v, i) => v - w * negative[i]);
  return normalizeVector(result);
}

export function parseEmbeddingOutput(output: unknown): number[] {
  if (!output) {
    return [];
  }

  if (Array.isArray(output)) {
    return flattenNumericArray(output);
  }

  const outputAsRecord = output as { tolist?: () => unknown; data?: ArrayLike<number> };

  if (typeof outputAsRecord.tolist === 'function') {
    return flattenNumericArray(outputAsRecord.tolist());
  }

  if (outputAsRecord.data && typeof outputAsRecord.data.length === 'number') {
    return Array.from(outputAsRecord.data);
  }

  return [];
}

function parseTextEmbeddingOutput(output: any, attentionMask?: unknown): number[] {
  const direct = parseEmbeddingOutput(output?.text_embeds ?? output?.pooler_output);
  if (direct.length > 0) {
    return direct;
  }

  const hidden = output?.last_hidden_state;
  const hiddenFlat = parseEmbeddingOutput(hidden);
  if (hiddenFlat.length === 0) {
    return parseEmbeddingOutput(output);
  }

  const pooled = meanPoolHiddenState(hiddenFlat, hidden?.dims, attentionMask);
  if (pooled.length > 0) {
    return pooled;
  }

  return hiddenFlat;
}

function parseImageEmbeddingOutput(output: any): number[] {
  const direct = parseEmbeddingOutput(output?.image_embeds ?? output?.pooler_output);
  if (direct.length > 0) {
    return direct;
  }

  const hidden = output?.last_hidden_state ?? output;
  const hiddenFlat = parseEmbeddingOutput(hidden);
  if (hiddenFlat.length === 0) {
    return [];
  }

  const pooled = meanPoolHiddenState(hiddenFlat, hidden?.dims ?? output?.dims);
  if (pooled.length > 0) {
    return pooled;
  }

  return hiddenFlat;
}

function meanPoolHiddenState(flat: number[], rawDims: unknown, attentionMask?: unknown): number[] {
  const dims = Array.isArray(rawDims)
    ? rawDims.filter((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    : [];

  if (dims.length < 2) {
    return [];
  }

  const dim = dims.at(-1) ?? 0;
  const sequenceLength = dims.at(-2) ?? 0;
  if (dim <= 0 || sequenceLength <= 0 || flat.length < sequenceLength * dim) {
    return [];
  }

  // Mean-pool token embeddings for the first batch item.
  // For text embeddings, prefer the tokenizer attention mask so padding tokens do not dilute the vector.
  const mask = parseEmbeddingOutput(attentionMask);
  const maskForFirstBatch = mask.length >= sequenceLength ? mask.slice(0, sequenceLength) : [];

  const pooled = new Array<number>(dim).fill(0);
  let pooledTokenCount = 0;
  for (let token = 0; token < sequenceLength; token++) {
    if (maskForFirstBatch.length > 0 && maskForFirstBatch[token] <= 0) {
      continue;
    }
    const tokenOffset = token * dim;
    for (let i = 0; i < dim; i++) {
      pooled[i] += flat[tokenOffset + i];
    }
    pooledTokenCount++;
  }
  if (pooledTokenCount <= 0) {
    return [];
  }
  for (let i = 0; i < dim; i++) {
    pooled[i] /= pooledTokenCount;
  }
  return pooled;
}

function flattenNumericArray(value: any): number[] {
  const result: number[] = [];
  const stack: any[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]);
      }
      continue;
    }

    if (typeof current === 'number' && Number.isFinite(current)) {
      result.push(current);
    }
  }

  return result;
}

function fnv1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
