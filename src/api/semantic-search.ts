import { ConditionGroupDTO } from './data-storage-search';
import { FileDTO } from './file';

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
