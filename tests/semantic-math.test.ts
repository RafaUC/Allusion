// tests/semantic-math.test.ts
import { ActiveSemanticQuery, SemanticMultiModalQuery } from '../src/api/semantic-search';

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
