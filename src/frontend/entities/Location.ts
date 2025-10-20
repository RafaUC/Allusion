import { Remote, wrap } from 'comlink';
import fse from 'fs-extra';
import {
  IObservableArray,
  ObservableSet,
  action,
  makeObservable,
  observable,
  runInAction,
} from 'mobx';
import SysPath from 'path';

import { retainArray } from 'common/core';
import { IMG_EXTENSIONS_TYPE } from '../../api/file';
import { generateId, ID } from '../../api/id';
import { LocationDTO, SubLocationDTO } from '../../api/location';
import { RendererMessenger } from '../../ipc/renderer';
import { AppToaster } from '../components/Toaster';
import LocationStore, { FileStats } from '../stores/LocationStore';
import { FolderWatcherWorker } from '../workers/folderWatcher.worker';
import { ClientTag } from './Tag';

/** Sorts alphanumerically, "natural" sort */
const sort = (a: SubLocationDTO | ClientSubLocation, b: SubLocationDTO | ClientSubLocation) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

export class ClientSubLocation {
  id: ID;
  @observable
  name: string;
  @observable
  isExcluded: boolean;
  readonly subLocations: IObservableArray<ClientSubLocation>;
  readonly tags: ObservableSet<ClientTag>;

  constructor(
    store: LocationStore,
    public location: ClientLocation,
    public path: string,
    id: ID,
    name: string,
    excluded: boolean,
    subLocations: SubLocationDTO[],
    tags: ID[],
  ) {
    this.id = id;
    this.name = name;
    this.isExcluded = excluded;
    this.subLocations = observable(
      subLocations
        .sort(sort)
        .map(
          (subLoc) =>
            new ClientSubLocation(
              store,
              this.location,
              SysPath.join(path, subLoc.name),
              subLoc.id,
              subLoc.name,
              subLoc.isExcluded,
              subLoc.subLocations,
              subLoc.tags,
            ),
        ),
    );
    this.tags = observable(store.getTags(tags));

    makeObservable(this);
  }

  @action.bound
  toggleExcluded = (): void => {
    this.isExcluded = !this.isExcluded;
    this.location.updateSublocationExclusion(this);
  };

  @action.bound
  serialize(): SubLocationDTO {
    return {
      id: this.id,
      name: this.name.toString(),
      isExcluded: Boolean(this.isExcluded),
      subLocations: this.subLocations.map((subLoc) => subLoc.serialize()),
      tags: Array.from(this.tags, (t) => t.id),
    };
  }
}

export class ClientLocation {
  private store: LocationStore;

  worker?: Remote<FolderWatcherWorker>;
  _worker?: Worker;

  // Whether the initial scan has been completed, and no watching setup is in process
  @observable isSettingWatcher = false;
  // whether initialization has started or has been completed
  @observable isInitialized = false;
  // whether sub-locations are being refreshed
  @observable isRefreshing = false;
  // true when the path no longer exists (broken link)
  @observable isBroken = false;
  //
  @observable isWatchingFiles: boolean;

  index: number;

  /** The file extensions for the files to be watched */
  extensions: IMG_EXTENSIONS_TYPE[];

  readonly subLocations: IObservableArray<ClientSubLocation>;
  readonly tags: ObservableSet<ClientTag>;
  /** A cached list of all sublocations that are excluded (isExcluded === true) */
  protected readonly excludedPaths: ClientSubLocation[] = [];

  readonly id: ID;
  readonly path: string;
  readonly dateAdded: Date;

  constructor(
    store: LocationStore,
    id: ID,
    path: string,
    dateAdded: Date,
    subLocations: SubLocationDTO[],
    tags: ID[],
    extensions: IMG_EXTENSIONS_TYPE[],
    index: number,
    isWatchingFiles: boolean,
  ) {
    this.store = store;
    this.id = id;
    this.path = path;
    this.dateAdded = dateAdded;
    this.extensions = extensions;
    this.index = index;
    this.isWatchingFiles = isWatchingFiles;

    this.subLocations = observable(
      subLocations
        .sort(sort)
        .map(
          (subLoc) =>
            new ClientSubLocation(
              this.store,
              this,
              SysPath.join(this.path, subLoc.name),
              subLoc.id,
              subLoc.name,
              subLoc.isExcluded,
              subLoc.subLocations,
              subLoc.tags,
            ),
        ),
    );
    this.tags = observable(this.store.getTags(tags));

    makeObservable(this);
  }

  get name(): string {
    return SysPath.basename(this.path);
  }

  @action async init(): Promise<void> {
    if (this.isInitialized === true) {
      return;
    }

    if (this.isWatchingFiles) {
      await this.refreshSublocations();
    }
    runInAction(() => {
      this.isInitialized = true;
      function* getExcludedSubLocsRecursively(
        subLocations: ClientSubLocation[],
      ): Generator<ClientSubLocation> {
        for (const s of subLocations) {
          if (s.isExcluded) {
            yield s;
          } else {
            yield* getExcludedSubLocsRecursively(s.subLocations);
          }
        }
      }
      this.excludedPaths.splice(0, this.excludedPaths.length);
      this.excludedPaths.push(...getExcludedSubLocsRecursively(this.subLocations));
    });

    if (await fse.pathExists(this.path)) {
      this.setBroken(false);
    } else {
      this.setBroken(true);
    }
  }

  @action setBroken(state: boolean): void {
    this.isBroken = state;
  }

  @action setSettingWatcher(state: boolean): void {
    this.isSettingWatcher = state;
  }

  @action.bound async toggleWatchFiles(): Promise<void> {
    if (this.isWatchingFiles) {
      if (this.worker !== undefined) {
        await this.worker.cancel();
        await this.worker.close();
        this.worker = undefined;
        this.isWatchingFiles = false;
      }
    } else {
      if (this.worker === undefined) {
        this.isWatchingFiles = true;
        this.store.watchLocations(this);
      }
    }
    this.store.save(this.serialize());
  }

  async delete(): Promise<void> {
    this.worker?.cancel();
    await this.drop();
    return this.store.delete(this);
  }

  async updateSublocationExclusion(subLocation: ClientSubLocation): Promise<void> {
    if (subLocation.isExcluded) {
      // If excluded:
      // - first update the cache, so new added images won't be detected
      if (!this.excludedPaths.includes(subLocation)) {
        this.excludedPaths.push(subLocation);
      }

      // What to do with current files?
      // Just hide them, in case it's included again?
      // Maybe move to separate collection? that won't work cleanly after tag removal
      // Looking at it realistically, this will be used for directories that contain animation frames, junk, timelapses, etc.
      // in which case it should be fine to just get rid of it all
      if (this.isInitialized) {
        await this.store.removeSublocationFiles(subLocation);
      }
    } else {
      // If included, re-scan for files in that path
      // - first, update cache
      const index = this.excludedPaths.findIndex((l) => l === subLocation);
      if (index !== -1) {
        this.excludedPaths.splice(index, 1);
      }

      // - not trivial to do a re-scan. Could also just re-start, won't be used that often anyways I think
      if (this.isInitialized) {
        AppToaster.show({
          message: 'Restart Allusion to re-detect any images',
          timeout: 8000,
          clickAction: {
            onClick: RendererMessenger.reload,
            label: 'Restart',
          },
        });
      }
    }

    // Save location to DB
    // Exclusion status is the only thing that can change for locations, so no need for saving through observing
    this.store.save(this.serialize());
  }

  @action.bound
  serialize(): LocationDTO {
    return {
      id: this.id,
      path: this.path,
      dateAdded: this.dateAdded,
      subLocations: this.subLocations.map((sl) => sl.serialize()),
      tags: Array.from(this.tags, (t) => t.id),
      index: this.index,
      isWatchingFiles: this.isWatchingFiles,
    };
  }

  @action.bound setIndex(index: number): void {
    this.index = index;
  }

  /** Cleanup resources */
  async drop(): Promise<void> {
    return this.worker?.close();
  }

  @action async refreshSublocations(rootDirectoryItem?: IDirectoryTreeItem): Promise<void> {
    // Trigger loading icon
    this.isRefreshing = true;

    // TODO: Can also get this from watching
    let rootItem;
    if (rootDirectoryItem === undefined) {
      const directoryTree = await getDirectoryTree(this.path);
      rootItem = {
        name: 'root',
        fullPath: this.path,
        children: directoryTree,
      };
    } else {
      rootItem = rootDirectoryItem;
    }

    // Replaces the subLocations on every subLocation recursively
    // Doesn't deal specifically with renamed directories, only added/deleted ones
    const updateSubLocations = action(
      (loc: ClientLocation | ClientSubLocation, dir: IDirectoryTreeItem) => {
        const newSublocations: ClientSubLocation[] = [];
        for (const item of dir.children) {
          const subLoc =
            loc.subLocations.find((subLoc) => subLoc.name === item.name) ??
            new ClientSubLocation(
              this.store,
              this,
              item.fullPath,
              generateId(),
              item.name,
              item.name.startsWith('.'),
              [],
              [],
            );
          newSublocations.push(subLoc);
          if (item.children.length > 0) {
            updateSubLocations(subLoc, item);
          } else {
            subLoc.subLocations.clear();
          }
        }
        loc.subLocations.replace(newSublocations.sort(sort));

        this.isRefreshing = false;
      },
    );

    updateSubLocations(this, rootItem);
    // TODO: optimization: only update if sublocations changed
    this.store.save(this.serialize());
  }

  @action async getDiskFilesAndDirectories(): Promise<
    [FileStats[], IDirectoryTreeItem | undefined] | [undefined, undefined]
  > {
    if (this.isBroken) {
      console.error(
        'Location error:',
        'Cannot get disk files from a location because it is broken or not initialized.',
      );
      return [undefined, undefined];
    }
    // Copied logic from src\frontend\workers\folderWatcher.worker.ts\folderWatcher.watch.ignored
    const extensions = this.extensions;
    // Replace backslash with forward slash, recommended by chokidar
    // See docs for the .watch method: https://github.com/paulmillr/chokidar#api
    const directory = this.path.replace(/\\/g, '/');
    const shouldIgnore = (path: string, dirent?: fse.Dirent) => {
      const basename = SysPath.basename(path);
      // Ignore .dot files and folders.
      if (basename.startsWith('.')) {
        return true;
      }
      // If the path doesn't have an extension (likely a directory), don't ignore it.
      // In the unlikely situation it is a file, we'll filter it out later in the .on('add', ...)
      const ext = SysPath.extname(path).toLowerCase().split('.')[1];
      if (!ext) {
        return false;
      }
      // If the path (file or directory) ends with an image extension, don't ignore it.
      if (extensions.includes(ext as IMG_EXTENSIONS_TYPE)) {
        return false;
      }
      // Otherwise, we need to know whether it is a file or a directory before making a decision.
      // If we don't return anything, this callback will be called a second time, with the stats
      // variable as second argument
      if (dirent) {
        // Ignore if
        // * dot directory like `/home/.hidden-directory/` but not `/home/directory.with.dots/` and
        // * not a directory, and not an image file either.
        return !dirent.isDirectory() || SysPath.basename(path).startsWith('.');
      }
      return false;
    };

    const getAllFilesRecursive = async (
      dir: string,
    ): Promise<[FileStats[], IDirectoryTreeItem[]]> => {
      const dirents = await fse.readdir(dir, { withFileTypes: true });
      const filesDirectoriesPairs: [FileStats[], IDirectoryTreeItem[]][] = await Promise.all(
        dirents.map(async (dirent) => {
          const absolutePath = SysPath.join(dir, dirent.name);
          if (shouldIgnore(absolutePath, dirent)) {
            return [[], []];
          }
          if (dirent.isDirectory()) {
            const [files, directories] = await getAllFilesRecursive(absolutePath);
            return [
              files,
              [
                {
                  name: SysPath.basename(absolutePath),
                  fullPath: absolutePath,
                  children: directories,
                },
              ],
            ];
          } else {
            const stats = dirent.isDirectory() ? undefined : await fse.stat(absolutePath);
            if (stats === undefined) {
              return [[], []];
            }
            return [
              [
                {
                  absolutePath: absolutePath,
                  dateCreated: stats.birthtime,
                  dateModified: stats.mtime,
                  size: Number(stats.size),
                  ino: stats.ino.toString(),
                },
              ],
              [],
            ];
          }
        }),
      );

      const flatFiles: FileStats[] = [];
      const flatDirs: IDirectoryTreeItem[] = [];
      for (let i = 0; i < filesDirectoriesPairs.length; i++) {
        const [files, dirs] = filesDirectoriesPairs[i];
        for (let j = 0; j < files.length; j++) {
          flatFiles.push(files[j]);
        }
        for (let j = 0; j < dirs.length; j++) {
          flatDirs.push(dirs[j]);
        }
      }

      return [flatFiles, flatDirs];
    };

    const [diskFiles, directoryTree] = await getAllFilesRecursive(directory);
    const rootItem = {
      name: 'root',
      fullPath: this.path,
      children: directoryTree,
    };

    const filteredDiskFiles = diskFiles.filter(
      ({ absolutePath }) =>
        !this.excludedPaths.some((subLoc) => absolutePath.startsWith(subLoc.path)),
    );
    return [filteredDiskFiles, rootItem];
  }

  @action async watch(): Promise<FileStats[] | undefined> {
    if (this.isBroken) {
      console.error(
        'Location watch error:',
        'Cannot watch a location because it is broken or not initialized.',
      );
      return undefined;
    }
    this.setSettingWatcher(true);
    const directory = this.path;
    console.debug('Loading folder watcher worker...', directory);
    const worker = new Worker(
      new URL('src/frontend/workers/folderWatcher.worker', import.meta.url),
    );
    worker.onmessage = ({
      data,
    }: {
      data:
        | { type: 'remove' | 'error'; value: string }
        | { type: 'add'; value: FileStats }
        | { type: 'update'; value: FileStats };
    }) => {
      if (data.type === 'add') {
        const { absolutePath } = data.value;
        // Filter out files located in any excluded subLocations
        if (this.excludedPaths.some((subLoc) => data.value.absolutePath.startsWith(subLoc.path))) {
          console.debug('File added to excluded sublocation', absolutePath);
        } else {
          console.log(`File ${absolutePath} has been added after initialization`);
          this.store.addFile(data.value, this);
        }
      } else if (data.type === 'update') {
        // when update set a short timeout because in the case the update was caused by writting tags with exiftool
        // the update event gets executed before exiftool can finish
        // so chokidar and fse dont use the presserved modified date exiftool set
        // why wait?: because comparing with the preserved modified date prevents the thumbnails from regenerating,
        // saving a lot of memory and processing when exporting tags to files.
        setTimeout(async () => {
          // get updated stats, because the Filestats generated by the event have the not-presserved modified date
          const updatesStats = await fse.stat(data.value.absolutePath);
          data.value.dateModified = updatesStats.mtime;
          this.store.updateFile(data.value);
        }, 500);
      } else if (data.type === 'remove') {
        const { value } = data;
        console.log(`Location "${this.name}": File ${value} has been removed.`);
        this.store.hideFile(value);
      } else if (data.type === 'error') {
        const { value } = data;
        console.error('Location watch error:', value);
        AppToaster.show(
          {
            message: `An error has occured while ${
              this.isSettingWatcher ? 'watching' : 'initializing watch'
            } location "${this.name}".`,
            timeout: 0,
          },
          'location-error',
        );
      }
    };

    const WorkerFactory = wrap<typeof FolderWatcherWorker>(worker);
    this.worker = await new WorkerFactory();
    this._worker?.terminate();
    this._worker = worker;
    // Make a list of all files in this directory, which will be returned when all subdirs have been traversed
    const initialFiles = await this.worker.watch(directory, this.extensions);

    this.setSettingWatcher(false);
    // Filter out images from excluded sub-locations
    // TODO: Could also put them in the chokidar ignore property
    return initialFiles?.filter(
      ({ absolutePath }) =>
        !this.excludedPaths.some((subLoc) => absolutePath.startsWith(subLoc.path)),
    );
  }
}
interface IDirectoryTreeItem {
  name: string;
  fullPath: string;
  children: IDirectoryTreeItem[];
}

/**
 * Recursive function that returns the dir list for a given path
 */
async function getDirectoryTree(path: string): Promise<IDirectoryTreeItem[]> {
  try {
    const NULL = { name: '', fullPath: '', children: [] };
    const dirs = await Promise.all(
      Array.from(await fse.readdir(path), async (file) => {
        const fullPath = SysPath.join(path, file);
        if ((await fse.stat(fullPath)).isDirectory()) {
          return {
            name: SysPath.basename(fullPath),
            fullPath,
            children: await getDirectoryTree(fullPath),
          };
        } else {
          return NULL;
        }
      }),
    );
    retainArray(dirs, (dir) => dir !== NULL);
    return dirs;
  } catch (e) {
    return [];
  }
}
