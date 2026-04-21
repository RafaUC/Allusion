/**
 * Pure helper functions for FileStore tag/file operations.
 * These functions have no side effects and do not reference `this`.
 */

import { ID } from '../../../api/id';
import { FileDTO } from '../../../api/file';

/**
 * Filters out files whose tag list contains any ID from `hiddenTagIds`.
 * Extracted from FileStore#updateFromBackend — pure, no side effects.
 */
export function filterHiddenFiles(files: FileDTO[], hiddenTagIds: Set<ID>): FileDTO[] {
  return files.filter((f) => !f.tags.some((t) => hiddenTagIds.has(t)));
}

/**
 * Returns the set of tag IDs that are present in **every** file in the selection.
 * Useful for determining which tags to show as "active" when multiple files are selected.
 *
 * @param selectedFiles  Iterable of selected files (each exposes a `tags` Set).
 * @returns Set of tag IDs shared by all selected files, or empty set if selection is empty.
 */
export function getTagsIntersection<T extends { tags: Iterable<{ id: ID }> }>(
  selectedFiles: Iterable<T>,
): Set<ID> {
  let intersection: Set<ID> | undefined;
  for (const file of selectedFiles) {
    const fileTags = new Set<ID>();
    for (const tag of file.tags) {
      fileTags.add(tag.id);
    }
    if (intersection === undefined) {
      intersection = fileTags;
    } else {
      for (const id of intersection) {
        if (!fileTags.has(id)) {
          intersection.delete(id);
        }
      }
    }
  }
  return intersection ?? new Set();
}
