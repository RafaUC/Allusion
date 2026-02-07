/**
 * Like Promise.all, but runs batches of N promises in sequence
 * @param batchSize The amount of promises in a batch
 * @param proms The promises to run
 */
export async function promiseAllBatch<T>(batchSize = 50, proms: Promise<T>[]) {
  const res: T[] = [];
  for (let i = 0; i < proms.length; i += batchSize) {
    res.push(...(await Promise.all(proms.slice(i, i + batchSize))));
  }
  return res;
}

/**
 * Like Promise.all, but only runs N promises in parallel
 * https://gist.github.com/jcouyang/632709f30e12a7879a73e9e132c0d56b
 * @param n The amount of promises to run in parallel
 * @param list The promises to run
 * @param progressCallback Returns the progress as a value between 0 and 1
 * @param cancel A callback function that, when returning true, can cancel any new promises from being awaited
 */
export function promiseAllLimit<T>(
  collection: Array<() => Promise<T>>,
  n: number = 100,
  progressCallback?: (progress: number) => void,
  cancel?: () => boolean,
): Promise<T[]> {
  // Prevents returning a Promise that is never resolved!
  if (collection.length === 0) {
    return new Promise((resolve) => resolve([]));
  }

  let i = 0;
  let jobsLeft = collection.length;
  const outcome: T[] = [];
  let rejected = false;
  // create a new promise and capture reference to resolve and reject to avoid nesting of code
  let resolve: (o: T[]) => void;
  let reject: (e: Error) => void;
  const pendingPromise: Promise<T[]> = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });

  // execute the j'th thunk
  function runJob(j: number) {
    collection[j]()
      .then((result) => {
        if (rejected) {
          return; // no op!
        }
        jobsLeft--;
        outcome[j] = result;

        progressCallback?.(1 - jobsLeft / collection.length);
        if (cancel?.()) {
          rejected = true;
          console.log('CANCELLING!');
          reject(new Error('Promise chain cancelled'));
          return;
        }

        if (jobsLeft <= 0) {
          resolve(outcome);
        } else if (i < collection.length) {
          runJob(i);
          i++;
        } else {
          return; // nothing to do here.
        }
      })
      .catch((e) => {
        if (rejected) {
          return; // no op!
        }
        rejected = true;
        reject(e);
        return;
      });
  }

  // bootstrap, while handling cases where the length of the given array is smaller than maxConcurrent jobs
  while (i < Math.min(collection.length, n)) {
    runJob(i);
    i++;
  }

  return pendingPromise;
}

export type BatchFetcher<T, NextOpts> = (opts?: NextOpts) => Promise<{
  items: T[];
  nextOpts?: NextOpts;
}>;

export type BatchProcessor<T, Acc> = (batch: T[], acc: Acc) => Promise<Acc> | Acc;

/**
 * Iterates over paginated resources and applies a processing function to each batch.
 * @template T - The type of items retrieved.
 * @template NextOpts - The type of the cursor for pagination or any options to compute the next batch.
 * @template Acc - The type of the result accumulator.
 * @param fetchBatch - Function to retrieve the next batch of data.
 * @param processBatch - Function to apply logic to the current batch and update the accumulator.
 * @param initialAcc - The starting value for the accumulation.
 * @param cancel - Optional callback to abort the process prematurely.
 * @returns A promise that resolves to the final accumulated value.
 */
export async function batchReducer<T, NextOpts, Acc>(
  fetchBatch: BatchFetcher<T, NextOpts>,
  processBatch: BatchProcessor<T, Acc>,
  initialAcc: Acc,
  cancel?: () => boolean,
): Promise<Acc> {
  let opts: NextOpts | undefined;
  let acc = initialAcc;

  while (true) {
    if (cancel?.()) {
      console.log('CANCELLING!');
      break;
    }
    const { items, nextOpts } = await fetchBatch(opts);

    if (!items.length) {
      break;
    }

    acc = await processBatch(items, acc);

    if (!nextOpts) {
      break;
    }
    opts = nextOpts;
  }

  return acc;
}
