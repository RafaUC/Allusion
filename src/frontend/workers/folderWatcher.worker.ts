import { expose } from 'comlink';
import { statSync } from 'fs';
import SysPath from 'path';
import { FileStats, IMG_EXTENSIONS_TYPE } from 'src/api/file';
import * as parcelWatcher from '@parcel/watcher';

const ctx: Worker = self as any;

export class FolderWatcherWorker {
  private watcher?: parcelWatcher.AsyncSubscription;
  private isCancelled = false;
  private directory?: string;
  private snapshotFilePath?: string;
  private backend?: parcelWatcher.BackendType;

  cancel() {
    this.isCancelled = true;
  }

  async close() {
    if (this.watcher) {
      this.watcher.unsubscribe();
      this.watcher = undefined;
    }
    // Save watcher snapshot on close
    if (this.snapshotFilePath && this.directory) {
      console.debug(`Creating watcher snapshot for ${this.directory}: ${this.snapshotFilePath}`);
      try {
        await parcelWatcher.writeSnapshot(this.directory, this.snapshotFilePath, {
          backend: this.backend,
        });
      } catch (err) {
        console.error(`${this.snapshotFilePath} - Failed writing snapshot on close:`, err);
      }
    }
  }

  /** Returns all supported image files in the given directly, and callbacks for new or removed files */
  async watch(
    directory: string,
    extensions: IMG_EXTENSIONS_TYPE[],
    snapshotFilePath: string,
    backend: parcelWatcher.BackendType,
  ): Promise<void> {
    this.isCancelled = false;
    this.backend = backend;

    // Replace backslash with forward slash, recommended by chokidar
    // See docs for the .watch method: https://github.com/paulmillr/chokidar#api
    directory = directory.replace(/\\/g, '/');
    snapshotFilePath = snapshotFilePath.replace(/\\/g, '/');
    this.directory = directory;
    this.snapshotFilePath = snapshotFilePath;

    // Watch for files being added/changed/removed:
    // Usually you'd include a glob in the watch argument, e.g. `directory/**/.{jpg|png|...}`, but we cannot use globs unfortunately (see disableGlobbing)
    // watch for this https://github.com/parcel-bundler/watcher/pull/207

    const handleEvents = // Small indentation hack to avoid affecting git blame
      (events: parcelWatcher.Event[], extensions: IMG_EXTENSIONS_TYPE[]) => {
        for (const event of events) {
          // Ignore Files that aren't our extension type
          const ext = SysPath.extname(event.path).toLowerCase().split('.')[1];
          if (!extensions.includes(ext as IMG_EXTENSIONS_TYPE)) {
            continue;
          }
          if (event.type === 'create') {
            const stats = statSync(event.path);
            if (this.isCancelled) {
              console.log('Cancelling file watching');
              this.watcher?.unsubscribe();
              this.isCancelled = false;
            }
            /**
             * Chokidar and @parcel/watcher doesn't detect renames as a unique event, it detects a "remove" and "add" event.
             * We use the "ino" field of file stats to detect whether a new file is a previously detected file that was moved/renamed
             * Relevant issue https://github.com/paulmillr/chokidar/issues/303#issuecomment-127039892
             * Inspiration for using "ino" from https://github.com/chrismaltby/gb-studio/pull/576
             * The stats given by chokidar is supposedly BigIntStats for Windows (since the ino is a 64 bit integer),
             * https://github.com/paulmillr/chokidar/issues/844
             * But my tests don't confirm this: console.log('ino', stats.ino, typeof stats.ino); -> type is number
             */

            const fileStats: FileStats = {
              absolutePath: event.path,
              dateCreated: stats.birthtime,
              dateModified: stats.mtime,
              size: Number(stats.size),
              ino: stats.ino.toString(),
            };

            ctx.postMessage({ type: 'add', value: fileStats });
          } else if (event.type === 'update') {
            const stats = statSync(event.path);
            if (this.isCancelled) {
              console.log('Cancelling file watching');
              this.watcher?.unsubscribe();
              this.isCancelled = false;
            }
            const ext = SysPath.extname(event.path).toLowerCase().split('.')[1];
            if (extensions.includes(ext as IMG_EXTENSIONS_TYPE)) {
              const fileStats: FileStats = {
                absolutePath: event.path,
                dateCreated: stats.birthtime,
                dateModified: stats.mtime,
                size: Number(stats.size),
                ino: stats.ino.toString(),
              };
              ctx.postMessage({ type: 'update', value: fileStats });
            }
          } else if (event.type === 'delete') {
            ctx.postMessage({ type: 'remove', value: event.path });
          }
        }
      };

    //Query for changes made while the watcher was down.
    try {
      console.debug('Reading watcher snapshot...', directory);
      const historical = await parcelWatcher.getEventsSince(directory, this.snapshotFilePath, {
        backend: this.backend,
      });
      handleEvents(historical, extensions);
    } catch (err) {
      console.warn('No snapshot available, skipping historical events.', err);
    }

    this.watcher = await parcelWatcher.subscribe(
      directory,
      (err, events) => {
        if (err) {
          console.error('Error fired in watcher', directory, err);
          ctx.postMessage({ type: 'error', value: err });
        }
        handleEvents(events, extensions);
      },
      { ignore: [], backend: backend },
    );
  }
}

// https://lorefnon.tech/2019/03/24/using-comlink-with-typescript-and-worker-loader/
expose(FolderWatcherWorker, self);
