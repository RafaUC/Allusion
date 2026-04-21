import { FileDTO } from 'src/api/file';

export interface DbLookupCacheEntry {
  file: FileDTO | undefined;
  expiresAt: number;
}

/**
 * Returns the cached FileDTO for a given key, or null if not found / expired.
 * Returning null means "no cache hit"; returning undefined means "cache hit: file not found".
 */
export function getCachedValue<K>(
  cache: Map<K, DbLookupCacheEntry>,
  key: K,
): FileDTO | undefined | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.file;
}

export function makeCacheEntry(file: FileDTO | undefined, ttlMs: number): DbLookupCacheEntry {
  return { file, expiresAt: Date.now() + ttlMs };
}
