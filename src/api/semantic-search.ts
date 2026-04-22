import { ConditionGroupDTO } from './data-storage-search';
import { FileDTO } from './file';
import { ID } from './id';

export const SemanticStatusStates = ['idle', 'loading', 'ready', 'error'] as const;
export type SemanticStatusState = (typeof SemanticStatusStates)[number];

export type SemanticIndexingStatus = {
  isRunning: boolean;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  progress: number;
};

export type SemanticSearchStatus = {
  modelId: string;
  state: SemanticStatusState;
  error?: string;
  indexing: SemanticIndexingStatus;
};

export type SemanticSearchOptions = {
  /** Maximum number of matches to return */
  topK?: number;
  /** Ignore matches below this cosine similarity threshold */
  minScore?: number;
  /** Optional structured filter to combine with semantic ranking */
  criteria?: ConditionGroupDTO<FileDTO>;
  /** Include the query image itself in image-to-image results */
  includeQueryFile?: boolean;
};

/**
 * Describes the active semantic query so it can be persisted in saved searches.
 * Exported here so both the frontend store and the backend search schema can reference it.
 */
export type ActiveSemanticQuery =
  | { mode: 'text'; query: string; options: SemanticSearchOptions }
  | { mode: 'image'; fileId: ID; options: SemanticSearchOptions };

/**
 * A query that blends text and/or image embeddings with optional negative terms.
 * Vector arithmetic: positive = lerp(textEmb, imageEmb, textWeight), then subtract negativeEmb * negativeWeight.
 */
export type SemanticMultiModalQuery = {
  /** Text component of the positive query */
  text?: string;
  /** Image component of the positive query (file ID) */
  imageFileId?: ID;
  /**
   * Weight for the text component when both text and imageFileId are provided.
   * 0 = pure image, 1 = pure text. Default 0.5.
   */
  textWeight?: number;
  /** Subtract this image's embedding from the positive embedding (file ID) */
  negativeImageFileId?: ID;
  /**
   * How strongly to subtract the negative embedding (0–1). Default 0.5.
   * Applied after blending positive components.
   */
  negativeWeight?: number;
};
