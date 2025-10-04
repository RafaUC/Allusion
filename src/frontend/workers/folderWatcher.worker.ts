import { expose } from 'comlink';
import { statSync } from 'fs';
import SysPath from 'path';
import { IMG_EXTENSIONS_TYPE } from 'src/api/file';
import { FileStats } from '../stores/LocationStore';
import * as parcelWatcher from '@parcel/watcher';

const ctx: Worker = self as any;

export class FolderWatcherWorker {
  private watcher?: parcelWatcher.AsyncSubscription;
  // Whether the initial scan has been completed, and new/removed files are being watched
  private isReady = false;
  private isCancelled = false;

  cancel() {
    this.isCancelled = true;
  }

  async close() {
    this.watcher?.unsubscribe();
  }

  /** Returns all supported image files in the given directly, and callbacks for new or removed files */
  async watch(directory: string, extensions: IMG_EXTENSIONS_TYPE[]) {
    this.isCancelled = false;

    // Replace backslash with forward slash, recommended by chokidar
    // See docs for the .watch method: https://github.com/paulmillr/chokidar#api
    directory = directory.replace(/\\/g, '/');

    // Watch for files being added/changed/removed:
    // Usually you'd include a glob in the watch argument, e.g. `directory/**/.{jpg|png|...}`, but we cannot use globs unfortunately (see disableGlobbing)
    // watch for this https://github.com/parcel-bundler/watcher/pull/207
    this.isReady = true;

    this.watcher = await parcelWatcher.subscribe(
      directory,
      (err, events) => {
        for (const event of events) {
          if (err) {
            console.error('Error fired in watcher', directory, err);
            ctx.postMessage({ type: 'error', value: err });
          }
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

            if (this.isReady) {
              ctx.postMessage({ type: 'add', value: fileStats });
            } else {
              initialFiles.push(fileStats);
            }
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
      },
      { ignore: [] },
    );

    // Make a list of all files in this directory, which will be returned when all subdirs have been traversed
    const initialFiles: FileStats[] = [];

    // This is stubbed out as @parcel/watcher doesn't have a ready event like chokidar
    // Because @parcel/watcher has the ability to have snapshots and historical changes, we can use it to reduce startup time
    return new Promise<FileStats[]>((resolve) => {
      resolve([]);
    });
  }
}

// https://lorefnon.tech/2019/03/24/using-comlink-with-typescript-and-worker-loader/
expose(FolderWatcherWorker, self);
