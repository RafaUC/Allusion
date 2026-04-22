// tests/semantic-math.test.ts
import { ActiveSemanticQuery, SemanticMultiModalQuery } from '../src/api/semantic-search';
import {
  normalizeVector,
  meanPoolEmbeddings,
  cosineSimilarity,
  blendEmbeddings,
  subtractEmbedding,
} from '../src/backend/semantic';

describe('API type smoke tests', () => {
  it('ActiveSemanticQuery text variant type-checks', () => {
    const q: ActiveSemanticQuery = { mode: 'text', query: 'sunset', options: {} };
    expect(q.mode).toBe('text');
  });

  it('ActiveSemanticQuery image variant type-checks', () => {
    const q: ActiveSemanticQuery = { mode: 'image', fileId: 'abc', options: {} };
    expect(q.mode).toBe('image');
  });

  it('SemanticMultiModalQuery type-checks', () => {
    const q: SemanticMultiModalQuery = {
      text: 'sunset',
      imageFileId: 'abc',
      textWeight: 0.7,
    };
    expect(q.textWeight).toBe(0.7);
  });
});

describe('normalizeVector', () => {
  it('returns unit-length vector', () => {
    const result = normalizeVector([3, 4]);
    const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns values matching expected ratios', () => {
    const result = normalizeVector([3, 4]);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
  });

  it('returns original vector if norm is zero', () => {
    const result = normalizeVector([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });
});

describe('meanPoolEmbeddings', () => {
  it('averages two embeddings element-wise then normalizes', () => {
    const a = [1, 0];
    const b = [0, 1];
    const result = meanPoolEmbeddings([a, b]);
    // mean = [0.5, 0.5], normalized = [1/sqrt(2), 1/sqrt(2)]
    expect(result[0]).toBeCloseTo(1 / Math.sqrt(2), 5);
    expect(result[1]).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it('throws when embeddings have mismatched dimensions', () => {
    expect(() => meanPoolEmbeddings([[1, 2], [1, 2, 3]])).toThrow();
  });

  it('handles a single embedding (returns normalized copy)', () => {
    const result = meanPoolEmbeddings([[3, 4]]);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [0.6, 0.8];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposing vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

import type { DataStorage } from '../src/api/data-storage';

describe('DataStorage interface contract', () => {
  it('semanticSearchByImages is part of the DataStorage interface', () => {
    const keys: (keyof DataStorage)[] = ['semanticSearchByImages'];
    expect(keys[0]).toBe('semanticSearchByImages');
  });
});

describe('blendEmbeddings', () => {
  it('returns textEmb when textWeight=1', () => {
    const text = normalizeVector([1, 0]);
    const image = normalizeVector([0, 1]);
    const result = blendEmbeddings(text, image, 1);
    expect(result[0]).toBeCloseTo(1, 5);
    expect(result[1]).toBeCloseTo(0, 5);
  });

  it('returns imageEmb when textWeight=0', () => {
    const text = normalizeVector([1, 0]);
    const image = normalizeVector([0, 1]);
    const result = blendEmbeddings(text, image, 0);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(1, 5);
  });

  it('blends 50/50 correctly and stays unit length', () => {
    const text = normalizeVector([1, 0]);
    const image = normalizeVector([0, 1]);
    const result = blendEmbeddings(text, image, 0.5);
    const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
    expect(result[0]).toBeCloseTo(1 / Math.sqrt(2), 5);
    expect(result[1]).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

describe('subtractEmbedding', () => {
  it('subtracts negativeWeight * negativeEmb from positive then normalizes', () => {
    const positive = normalizeVector([1, 0]);
    const negative = normalizeVector([0.5, 0.5]);
    const result = subtractEmbedding(positive, negative, 0.5);
    const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns positive when negativeWeight is 0', () => {
    const positive = normalizeVector([1, 0]);
    const negative = normalizeVector([0, 1]);
    const result = subtractEmbedding(positive, negative, 0);
    expect(result[0]).toBeCloseTo(positive[0], 5);
    expect(result[1]).toBeCloseTo(positive[1], 5);
  });
});
