/**
 * Pure helper functions for FileStore selection logic.
 * These functions have no side effects and do not reference `this`.
 */

import { ID } from '../../../api/id';
import { FileDTO } from '../../../api/file';

/**
 * Builds an inclusive array of indices between `start` and `end`.
 * Used when range-selecting files in the gallery.
 */
export function buildRange(start: number, end: number): number[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * Removes duplicate files from an array, keeping only the first occurrence
 * of each file ID. Returns the deduplicated array.
 * Extracted from the deduplication logic in FileStore#updateFromBackend.
 */
export function deduplicateById(files: FileDTO[]): FileDTO[] {
  const seenIds = new Set<ID>();
  return files.filter((file) => {
    if (seenIds.has(file.id)) {
      return false;
    }
    seenIds.add(file.id);
    return true;
  });
}
