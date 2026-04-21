/**
 * Pure helper functions for FileStore fetch/search logic.
 * These functions have no side effects and do not reference `this`.
 */

import { OrderBy } from '../../../api/data-storage-search';
import { FileDTO } from '../../../api/file';
import { ClientExtraProperty } from '../../entities/ExtraProperty';
import { ClientFile } from '../../entities/File';
import { serializeDate } from 'src/backend/schemaTypes';

/**
 * Returns the cursor value for the given file and ordering field.
 * Extracted from FileStore#toCursor — pure, no side effects.
 */
export function getCursorValue(
  file: ClientFile | FileDTO,
  orderBy: OrderBy<FileDTO>,
  orderByExtraProperty: string,
  getExtraProperty: (id: string) => ClientExtraProperty | undefined,
): string | number | bigint | null {
  if (orderBy === 'random') {
    return null;
  }
  if (orderBy === 'extraProperty') {
    const ep = getExtraProperty(orderByExtraProperty);
    if (file instanceof ClientFile) {
      return ep ? (file.extraProperties.get(ep) as string | number | null) ?? null : null;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      return ep ? (file.extraProperties[ep.id] as string | number | null) ?? null : null;
    }
  }
  const val = file[orderBy];
  if (val instanceof Date) {
    return serializeDate(val);
  }
  if (typeof val === 'object') {
    return null;
  }
  return val as string | number;
}

/**
 * Computes the order in which batches should be processed, prioritizing the
 * batch nearest to `initialIndex` and expanding outward in both directions.
 * Extracted from FileStore#filesFromBackend — pure, no side effects.
 *
 * @param initialIndex  Index of the "first visible" item.
 * @param total         Total number of items.
 * @param batchSize     Number of items per batch.
 * @returns Array of batch indices in priority order.
 */
export function buildBatchOrder(initialIndex: number, total: number, batchSize: number): number[] {
  const initialBatchStart = initialIndex - Math.floor(batchSize / 2);
  const initialBatchIndex = Math.ceil(initialBatchStart / batchSize);
  const absoluteBatchStart = initialBatchStart - batchSize * initialBatchIndex;
  const totalBatches = Math.ceil((total - absoluteBatchStart) / batchSize);

  const batchOrder: number[] = [];
  for (let offset = 0; batchOrder.length < totalBatches; offset++) {
    const before = initialBatchIndex - offset;
    const after = initialBatchIndex + offset;
    if (offset === 0) {
      batchOrder.push(initialBatchIndex);
    } else {
      if (after < totalBatches) {
        batchOrder.push(after);
      }
      if (before >= 0) {
        batchOrder.push(before);
      }
    }
  }

  return batchOrder;
}

/**
 * Returns the absolute start and end indices (inclusive) for a given batch index,
 * clamped to valid array bounds. Pair with `buildBatchOrder`.
 */
export function getBatchBounds(
  batchIndex: number,
  absoluteBatchStart: number,
  batchSize: number,
  total: number,
): { start: number; end: number } {
  const rawStart = absoluteBatchStart + batchIndex * batchSize;
  const start = Math.max(rawStart, 0);
  const end = Math.min(rawStart + batchSize - 1, total - 1);
  return { start, end };
}

/**
 * Computes the `absoluteBatchStart` used by both `buildBatchOrder` and
 * `getBatchBounds` so callers don't need to repeat the formula.
 */
export function computeAbsoluteBatchStart(initialIndex: number, batchSize: number): number {
  const initialBatchStart = initialIndex - Math.floor(batchSize / 2);
  const initialBatchIndex = Math.ceil(initialBatchStart / batchSize);
  return initialBatchStart - batchSize * initialBatchIndex;
}
