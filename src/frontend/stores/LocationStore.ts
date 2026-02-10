import fse from 'fs-extra';
import { action, makeObservable, observable, runInAction } from 'mobx';
import SysPath from 'path';

import { getThumbnailPath } from 'common/fs';
import { batchReducer, promiseAllLimit } from 'common/promise';
import { DataStorage, makeFileBatchFetcher } from '../../api/data-storage';
import { OrderDirection } from '../../api/data-storage-search';
import { FileStats, FileDTO, IMG_EXTENSIONS, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ID, generateId } from '../../api/id';
import { LocationDTO } from '../../api/location';
import { RendererMessenger } from '../../ipc/renderer';
import { AppToaster } from '../components/Toaster';
import { getMetaData, mergeMovedFile } from '../entities/File';
import { ClientLocation, ClientSubLocation } from '../entities/Location';
import { ClientStringSearchCriteria } from '../entities/SearchCriteria';
import ImageLoader from '../image/ImageLoader';
import RootStore from './RootStore';
import { ClientTag } from '../entities/Tag';
import { IS_MAC, IS_WIN } from 'common/process';
import { BackendType } from '@parcel/watcher';
import { execSync } from 'child_process';

const PREFERENCES_STORAGE_KEY = 'location-store-preferences';
type Preferences = { extensions: IMG_EXTENSIONS_TYPE[] };

/**
 * Compares metadata of two files to determine whether the files are (likely to be) identical
 * Note: note comparing size, since it can change, e.g. when writing tags to file metadata.
 *   Could still include it, but just to check whether it's in the same ballpark
 */
function areFilesIdenticalBesidesName(a: FileDTO, b: FileDTO): boolean {
  return (
    a.ino === b.ino ||
    (a.width === b.width &&
      a.height === b.height &&
      a.dateCreated.getTime() === b.dateCreated.getTime())
  );
}

function isWatchmanInstalled(): boolean {
  try {
    execSync('watchman --version', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

class LocationStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;
  watcherSnapshotDirectory!: string;
  PARCEL_WATCHER_BACKEND!: BackendType;

  readonly locationList = observable<ClientLocation>([]);

  // Allow users to disable certain file types. Global option for now, needs restart
  // TODO: Maybe per location/sub-location?
  readonly enabledFileExtensions = observable(new Set<IMG_EXTENSIONS_TYPE>());

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    makeObservable(this);
  }

  @action async init(): Promise<void> {
    // Restore preferences
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) || '') as Preferences;
      (prefs.extensions || IMG_EXTENSIONS).forEach((ext) => this.enabledFileExtensions.add(ext));
    } catch (e) {
      // If no preferences found, use defaults
      IMG_EXTENSIONS.forEach((ext) => this.enabledFileExtensions.add(ext));
      // By default, disable EXR for now (experimental)
      this.enabledFileExtensions.delete('exr');
    }
    this.watcherSnapshotDirectory = await RendererMessenger.getWatcherSnapshotsDirectory();

    // Fix the console popup bug when initializing the watcher by ensuring the watcher backend to use.
    // look at https://github.com/eclipse-theia/theia/pull/16335
    const isWatchman = isWatchmanInstalled();
    this.PARCEL_WATCHER_BACKEND = isWatchman
      ? 'watchman'
      : IS_WIN
      ? 'windows'
      : IS_MAC
      ? 'fs-events'
      : 'inotify';
    console.debug('Watcher backend:', this.PARCEL_WATCHER_BACKEND);

    // Get dirs from backend
    const dirs = await this.backend.fetchLocations();

    // backwards compatibility
    dirs.sort((a, b) =>
      a.index === b.index ? a.dateAdded.getTime() - b.dateAdded.getTime() : a.index - b.index,
    );

    const locations = dirs.map(
      (dir, i) =>
        new ClientLocation(
          this,
          dir.id,
          dir.path,
          dir.dateAdded,
          dir.subLocations,
          dir.tags,
          runInAction(() => Array.from(this.enabledFileExtensions)),
          dir.index ?? i,
          dir.isWatchingFiles,
        ),
    );
    runInAction(() => this.locationList.replace(locations));
  }

  save(loc: LocationDTO): void {
    this.backend.saveLocation(loc);
  }

  retryToastTimeout: NodeJS.Timeout | undefined;
  private showLocationProcessToast(
    action: 'show' | 'cancel-retry' | 'show-missing' | 'hide',
    msgMode: 'update' | 'watch',
    location: ClientLocation | { name: 'None'; id: 'None' } = { name: 'None', id: 'None' },
    total: number = 0,
    progress: number = 0,
  ) {
    const watch = msgMode === 'watch';
    const progressToastKey = 'progress';
    switch (action) {
      case 'show':
        const toastsMsg = watch ? 'Syncing locations' : 'Looking for new images';

        AppToaster.show(
          {
            message: `${toastsMsg}... [${progress + 1} / ${total}]`,
            timeout: 6000,
          },
          progressToastKey,
        );

        // TODO: Add a maximum timeout for init: sometimes it's hanging for me. Could also be some of the following steps though
        // added a retry toast for now, can't figure out the cause, and it's hard to reproduce
        // FIXME: Toasts should not be abused for error handling. Create some error messaging mechanism.
        this.retryToastTimeout = setTimeout(() => {
          AppToaster.show(
            {
              message: `${toastsMsg}... [${progress + 1} / ${total}]`,
              timeout: 6000,
            },
            progressToastKey,
          );
          AppToaster.show(
            {
              message: 'This appears to be taking longer than usual.',
              timeout: 10000,
              clickAction: {
                onClick: RendererMessenger.reload,
                label: 'Retry?',
              },
            },
            'retry-init',
          );
        }, 20000);
        break;
      case 'cancel-retry':
        clearTimeout(this.retryToastTimeout);
        AppToaster.dismiss('retry-init');
        break;
      case 'show-missing':
        AppToaster.show(
          {
            message: `Cannot ${watch ? 'watch' : 'find'} Location "${location.name}"`,
            timeout: 6000,
          },
          // a key such that the toast can be dismissed automatically on recovery
          `missing-loc-${location.id}`,
        );
        break;
      case 'hide':
      default:
        AppToaster.dismiss(progressToastKey);
        break;
    }
  }

  @action async watchLocations(locations?: ClientLocation | ClientLocation[]): Promise<void> {
    let locs: ClientLocation[];
    if (locations === undefined) {
      locs = this.locationList;
    } else if (!Array.isArray(locations)) {
      locs = [locations];
    } else {
      locs = locations;
    }
    locs = locs.filter((l) => l.isWatchingFiles);
    const len = locs.length;
    for (let i = 0; i < len; i++) {
      const location = locs[i];
      this.showLocationProcessToast('show', 'watch', location, len, i);
      const success = await location.watch();
      this.showLocationProcessToast('cancel-retry', 'watch', location);
      if (!success) {
        this.showLocationProcessToast('show-missing', 'watch', location);
      }
    }
    this.showLocationProcessToast('hide', 'watch');
  }

  /** Manually synchronizes the database files and locations with the current file system state using a brute-force scan. */
  @action async updateLocations(locations?: ClientLocation | ClientLocation[]): Promise<boolean> {
    let locs: ClientLocation[];
    if (locations === undefined) {
      locs = this.locationList.slice();
    } else if (!Array.isArray(locations)) {
      locs = [locations];
    } else {
      locs = locations;
    }
    locs.forEach((loc) => (loc.isRefreshing = true));
    const foundNewFiles = await this.compareLocations(locs);
    if (foundNewFiles) {
      this.rootStore.fileStore.refetch();
    }
    return foundNewFiles;
  }

  // Returns whether files have been added, changed or removed
  @action async compareLocations(locations: ClientLocation[]): Promise<boolean> {
    let foundNewFiles = false;
    const len = locations.length;

    // For every location, find created/moved/deleted files, and update the database accordingly.
    // TODO: Do this in a web worker, not in the renderer thread!
    for (let i = 0; i < len; i++) {
      const location = locations[i];

      this.showLocationProcessToast('show', 'update', location, len, i);

      const wasInitialized = runInAction(() => location.isInitialized);
      if (!wasInitialized) {
        console.group(`Initializing location ${location.name}`);
        await location.init();
      }
      const diskFiles = await (async () => {
        const [files, rootDirectoryItem] = await location.getDiskFilesAndDirectories();
        location.refreshSublocations(rootDirectoryItem);
        return files;
      })();
      const diskFileMap = new Map<string, FileStats>(
        diskFiles?.map((f) => [f.absolutePath, f]) ?? [],
      );

      this.showLocationProcessToast('cancel-retry', 'update', location);

      if (diskFiles === undefined) {
        this.showLocationProcessToast('show-missing', 'update', location);
        continue;
      }

      console.log('Finding created files...');

      // Find all files that have been created (those on disk but not in DB)
      // Find all files of this location that have been removed (those in DB but not on disk anymore)
      const { createdStats, missingFiles } = await this.backend.compareFiles(
        location.id,
        diskFiles,
      );
      const createdFiles = await Promise.all(
        createdStats.map((stats) => pathToIFile(stats, location, this.rootStore.imageLoader)),
      );
      // Find matches between removed and created images (different name/path but same characteristics)
      const createdMatches = missingFiles.map((mf) =>
        createdFiles.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
      );
      // Also look for duplicate files: when a files is renamed/moved it will become a new entry, should be de-duplicated
      const dbMatches = new Map<ID, FileDTO>(await this.backend.findMissingDBMatches(missingFiles));

      console.debug({ missingFiles, createdFiles, createdMatches, dbMatches });

      const foundCreatedMatches = createdMatches.filter((m) => m !== undefined) as FileDTO[];

      runInAction(() => {
        if (
          missingFiles.length - dbMatches.size - foundCreatedMatches.length >
          this.rootStore.fileStore.numMissingFiles
        ) {
          this.rootStore.fileStore.setDirtyMissingFiles(true);
        }
      });

      // Update renamed files in backend
      const updatedFileIds = new Set<ID>();
      if (foundCreatedMatches.length > 0) {
        console.debug(
          `Found ${foundCreatedMatches.length} renamed/moved files in location ${location.name}. These are detected as new files, but will instead replace their original entry in the DB of Allusion`,
          foundCreatedMatches,
        );
        // TODO: remove thumbnail as well (clean-up needed, since the path changed)
        const renamedFilesToUpdate: FileDTO[] = [];
        for (let i = 0; i < createdMatches.length; i++) {
          const match = createdMatches[i];
          if (match) {
            const updatedFileData = {
              ...missingFiles[i],
              absolutePath: match.absolutePath,
              relativePath: match.relativePath,
              name: match.name,
            };
            renamedFilesToUpdate.push(updatedFileData);
            updatedFileIds.add(updatedFileData.id);
            this.rootStore.fileStore.replaceMovedFile(updatedFileData.id, updatedFileData);
          }
        }
        // There might be duplicates, so convert to set
        await this.backend.saveFiles(Array.from(new Set(renamedFilesToUpdate)));
        foundNewFiles = true;
      }

      if (dbMatches.size > 0) {
        // Renaming/moving files will be created as new files while the old one sticks around
        // In here we transfer the tag data over from the old entry to the new one, and delete the old entry
        console.debug(
          `Found ${dbMatches.size} renamed/moved files in location ${location.name} that were already present in the database. Removing duplicates`,
          dbMatches,
        );
        const files: FileDTO[] = [];
        for (let i = 0; i < missingFiles.length; i++) {
          const missingfile = missingFiles[i];
          const match = dbMatches.get(missingfile.id);
          if (match && !updatedFileIds.has(missingfile.id)) {
            files.push({
              ...match,
              tags: Array.from(new Set([...missingfile.tags, ...match.tags])),
              extraProperties: { ...missingfile.extraProperties, ...match.extraProperties },
            });
          }
        }
        // Transfer over tag data on the matched files
        await this.backend.saveFiles(Array.from(new Set(files)));
        // Remove missing files that have a match in the database
        await this.backend.removeFiles(
          missingFiles.filter((mf) => Boolean(dbMatches.get(mf.id))).map((mf) => mf.id),
        );
        foundNewFiles = true; // Set a flag to trigger a refetch
      }

      // For createdFiles without a match, insert them in the DB as new files
      const newFiles = createdFiles.filter((cf) => !foundCreatedMatches.includes(cf));
      if (newFiles.length) {
        await this.backend.createFilesFromPath(location.path, newFiles);
      }

      // Check adn update all metadata in files that have changed on disk
      await batchReducer(
        makeFileBatchFetcher(this.backend, 1000, {
          conjunction: 'and',
          children: [
            { key: 'locationId', operator: 'equals', value: location.id, valueType: 'string' },
          ],
        }),
        async (batch) => {
          await this.updateChangedFiles(batch, diskFileMap);
          return undefined;
        },
        undefined,
      );

      if (!wasInitialized) {
        console.groupEnd();
      }

      foundNewFiles = foundNewFiles || newFiles.length > 0; /**/
      console.groupEnd();
    }

    if (foundNewFiles) {
      AppToaster.show({ message: 'New images detected.', timeout: 5000 }, 'new-images');
    } else {
      this.showLocationProcessToast('hide', 'update');
    }
    this.rootStore.fileStore.refetchFileCounts();
    return foundNewFiles;
  }

  @action async updateChangedFiles(
    dbFiles: FileDTO[],
    diskFileMap: Map<string, FileStats>,
  ): Promise<void> {
    // Also update files that have changed, e.g. when overwriting a file (with same filename)
    // --> update metadata (resolution, size) and recreate thumbnail
    // This can be accomplished by comparing the dateLastIndexed of the file in DB to dateModified of the file on disk
    const updatedFiles: FileDTO[] = [];
    const thumbnailDirectory = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
    for (const dbFile of dbFiles) {
      const diskFile = diskFileMap.get(dbFile.absolutePath);
      if (
        diskFile &&
        (((dbFile.dateLastIndexed.getTime() < diskFile.dateModified.getTime() ||
          dbFile.dateModifiedOS.getTime() !== diskFile.dateModified.getTime()) &&
          diskFile.size !== dbFile.size) ||
          diskFile.ino !== dbFile.ino)
      ) {
        const newFile: FileDTO = {
          ...dbFile,
          // Recreate metadata which checks the resolution of the image
          ...(await getMetaData(diskFile, this.rootStore.imageLoader)),
          ino: diskFile.ino,
          dateModifiedOS: diskFile.dateModified,
          dateLastIndexed: new Date(),
        };

        console.debug(
          `Updating modified file: ${JSON.stringify(
            {
              ino: dbFile.ino,
              size: dbFile.size,
              OrigDateModified: dbFile.dateModifiedOS,
              dateLastIndexed: dbFile.dateLastIndexed,
              name: dbFile.absolutePath,
            },
            null,
            2,
          )} to ${JSON.stringify(
            {
              ino: newFile.ino,
              size: newFile.size,
              OrigDateModified: newFile.dateModifiedOS,
              dateLastIndexed: newFile.dateLastIndexed,
              name: newFile.absolutePath,
            },
            null,
            2,
          )}`,
        );

        updatedFiles.push(newFile);

        // Delete thumbnail if size has changed, will be re-created automatically when needed
        const thumbPath = getThumbnailPath(dbFile.absolutePath, thumbnailDirectory);
        await fse.remove(thumbPath).catch(console.error);
        this.rootStore.fileStore.get(newFile.id)?.setThumbnailPath(thumbPath);
      }
    }
    if (updatedFiles.length > 0) {
      console.debug('Re-indexed files changed on disk', updatedFiles);
      await this.backend.saveFiles(updatedFiles);
    }
  }

  @action get(locationId: ID): ClientLocation | undefined {
    return this.locationList.find((loc) => loc.id === locationId);
  }

  getTags(ids: ID[]): Set<ClientTag> {
    return this.rootStore.tagStore.getTags(ids);
  }

  @action async changeLocationPath(location: ClientLocation, newPath: string): Promise<void> {
    const index = this.locationList.findIndex((l) => l.id === location.id);
    if (index === -1) {
      throw new Error(`The location ${location.name} has already been removed.`);
    }
    console.log('changing location path', location, newPath);
    // First, update the absolute path of all files from this location
    const locFiles = await this.findLocationFiles(location.id);
    const files: FileDTO[] = locFiles.map((f) => ({
      ...f,
      absolutePath: SysPath.join(newPath, f.relativePath),
    }));
    await this.backend.saveFiles(files);

    const newLocation = new ClientLocation(
      this,
      location.id,
      newPath,
      location.dateAdded,
      location.subLocations.map((sl) => sl.serialize()),
      Array.from(location.tags, (t) => t.id),
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
      location.isWatchingFiles,
    );
    runInAction(() => (this.locationList[index] = newLocation));
    await this.initLocation(newLocation);
    await this.backend.saveLocation(newLocation.serialize());
    // Refetch files in case some were from this location and could not be found before
    this.rootStore.fileStore.refetch();

    // Dismiss the 'Cannot find location' toast if it is still open
    AppToaster.dismiss(`missing-loc-${newLocation.id}`);
  }

  @action exists(predicate: (location: ClientLocation) => boolean): boolean {
    return this.locationList.some(predicate);
  }

  @action.bound async create(path: string): Promise<ClientLocation> {
    const location = new ClientLocation(
      this,
      generateId(),
      path,
      new Date(),
      [],
      [],
      runInAction(() => Array.from(this.enabledFileExtensions)),
      this.locationList.length,
      true,
    );
    await this.backend.createLocation(location.serialize());
    runInAction(() => this.locationList.push(location));
    return location;
  }

  /** Imports all files from a location into the FileStore */
  @action.bound async initLocation(location: ClientLocation): Promise<void> {
    const toastKey = `initialize-${location.id}`;

    let isCancelled = false;
    const handleCancelled = () => {
      console.debug('Aborting location initialization', location.name);
      isCancelled = true;
      location.delete();
    };

    AppToaster.show(
      {
        message: 'Finding all images...',
        timeout: 0,
        clickAction: {
          label: 'Cancel',
          onClick: handleCancelled,
        },
      },
      toastKey,
    );

    await location.init();
    const [filePaths] = await location.getDiskFilesAndDirectories();
    location.watch();

    if (isCancelled || filePaths === undefined) {
      return;
    }

    const showProgressToaster = (progress: number) =>
      !isCancelled &&
      AppToaster.show(
        {
          // message: 'Gathering image metadata...',
          message: `Loading ${(progress * 100).toFixed(1)}%...`,
          timeout: 0,
        },
        toastKey,
      );

    showProgressToaster(0);

    // Load file meta info, with only N jobs in parallel and a progress + cancel callback
    // TODO: Should make N configurable, or determine based on the system/disk performance
    const N = 50;
    const files = await promiseAllLimit(
      filePaths.map((path) => () => pathToIFile(path, location, this.rootStore.imageLoader)),
      N,
      showProgressToaster,
      () => isCancelled,
    );

    AppToaster.show({ message: 'Updating database...', timeout: 0 }, toastKey);
    await this.backend.createFilesFromPath(location.path, files);

    AppToaster.show({ message: `Location "${location.name}" is ready!`, timeout: 5000 }, toastKey);
    this.rootStore.fileStore.refetch();
    this.rootStore.fileStore.refetchFileCounts();
  }

  @action.bound async delete(location: ClientLocation): Promise<void> {
    // Remove location from DB through backend
    await this.backend.removeLocation(location.id);
    runInAction(() => {
      // Remove deleted files from selection
      for (const file of this.rootStore.uiStore.fileSelection) {
        if (file.locationId === location.id) {
          this.rootStore.uiStore.deselectFile(file);
        }
      }
      // Remove location locally
      this.locationList.remove(location);
    });
    this.rootStore.fileStore.refetch();
    this.rootStore.fileStore.refetchFileCounts();
  }

  @action.bound setSupportedImageExtensions(extensions: Set<IMG_EXTENSIONS_TYPE>): void {
    this.enabledFileExtensions.replace(extensions);
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify(
        { extensions: Array.from(this.enabledFileExtensions) } as Preferences,
        null,
        2,
      ),
    );
  }

  @action async addFile(fileStats: FileStats, location: ClientLocation): Promise<void> {
    const fileStore = this.rootStore.fileStore;

    // Gather file data
    const file = await pathToIFile(fileStats, location, this.rootStore.imageLoader);

    // Check if file is being moved/renamed (which is detected as a "add" event followed by "remove" event)
    const match = runInAction(() => fileStore.fileList.find((f) => f && f.ino === fileStats.ino));
    const dbMatch = match
      ? undefined
      : (await this.backend.fetchFilesByKey('ino', fileStats.ino))[0];
    const dbMatchOverwrite = match
      ? undefined
      : (await this.backend.fetchFilesByKey('absolutePath', fileStats.absolutePath))[0];

    if (match) {
      if (fileStats.absolutePath === match.absolutePath) {
        fileStore.debouncedRefetch();
        return;
      }
      fileStore.replaceMovedFile(match, file);
    } else if (dbMatch) {
      const newIFile = mergeMovedFile(dbMatch, file);
      this.rootStore.fileStore.save(newIFile);
    } else if (dbMatchOverwrite) {
      await this.updateChangedFiles(
        [dbMatchOverwrite],
        new Map<string, FileStats>([[fileStats.absolutePath, fileStats]]),
      );
    } else {
      await this.backend.createFilesFromPath(fileStats.absolutePath, [file]);
      fileStore.setDirtyTotalFiles(true);
      fileStore.setDirtyUntaggedFiles(true);
      AppToaster.show({ message: 'New images have been detected.', timeout: 5000 }, 'new-images');
      // might be called a lot when moving many images into a folder, so debounce it
    }
    fileStore.debouncedRefetch();
  }

  @action async updateFile(fileStats: FileStats): Promise<void> {
    const fileStore = this.rootStore.fileStore;
    const dbMatchOverwrites = await this.backend.fetchFilesByKey(
      'absolutePath',
      fileStats.absolutePath,
    );
    const dbMatchOverwrite = dbMatchOverwrites.length > 0 ? dbMatchOverwrites[0] : undefined;
    if (dbMatchOverwrite) {
      await this.updateChangedFiles(
        [dbMatchOverwrite],
        new Map<string, FileStats>([[fileStats.absolutePath, fileStats]]),
      );
      fileStore.debouncedRefetch();
    }
  }

  @action hideFile(path: string): void {
    // This is called when an image is removed from the filesystem.
    // Could also mean that a file was renamed or moved, in which case addFile was called already:
    // its path will have changed, so we won't find it here, which is fine, it'll be detected as missing later.
    const fileStore = this.rootStore.fileStore;
    const clientFile = fileStore.fileList.find((f) => f && f.absolutePath === path);

    fileStore.setDirtyMissingFiles(true);
    if (clientFile) {
      fileStore.hideFile(clientFile);
      fileStore.debouncedRefetch();
    }
  }

  /**
   * Fetches the files belonging to a location
   */
  @action async findLocationFiles(locationId: ID): Promise<FileDTO[]> {
    const crit = new ClientStringSearchCriteria(
      undefined,
      'locationId',
      locationId,
      'equals',
    ).toCondition();
    return this.backend.searchFiles(
      { conjunction: 'and', children: [crit] },
      'id',
      OrderDirection.Asc,
      false,
    );
  }

  @action async removeSublocationFiles(subLoc: ClientSubLocation): Promise<void> {
    const crit = new ClientStringSearchCriteria(
      undefined,
      'absolutePath',
      subLoc.path,
      'startsWith',
    ).toCondition();
    const files = await this.backend.searchFiles(
      { conjunction: 'and', children: [crit] },
      'id',
      OrderDirection.Asc,
      false,
    );
    await this.backend.removeFiles(files.map((f) => f.id));
    this.rootStore.fileStore.refetch();
  }

  /** Source is moved to where Target currently is */
  @action.bound reorder(source: ClientLocation, target: ClientLocation): void {
    const sourceIndex = this.locationList.indexOf(source);
    const targetIndex = this.locationList.indexOf(target);

    // Remove the source element and insert it at the target index
    this.locationList.remove(source);
    this.locationList.splice(targetIndex, 0, source);

    // Update the index for all changed items: all items between source and target have been moved
    const startIndex = Math.min(sourceIndex, targetIndex);
    const endIndex = Math.max(sourceIndex, targetIndex);
    for (let i = startIndex; i <= endIndex; i++) {
      this.locationList[i].setIndex(i);
      this.save(this.locationList[i].serialize());
    }
  }

  // Close and save snapshots for all watcher workers
  @action async close(): Promise<void> {
    for (const location of this.locationList.slice()) {
      await location.close();
    }
  }
}

export async function pathToIFile(
  stats: FileStats,
  loc: ClientLocation,
  imageLoader: ImageLoader,
): Promise<FileDTO> {
  const now = new Date();
  return {
    absolutePath: stats.absolutePath,
    relativePath: stats.absolutePath.replace(loc.path, ''),
    ino: stats.ino,
    id: generateId(),
    locationId: loc.id,
    tags: [],
    tagSorting: 'hierarchy',
    extraProperties: {},
    dateAdded: now,
    dateModified: now,
    dateModifiedOS: stats.dateModified,
    dateLastIndexed: now,
    ...(await getMetaData(stats, imageLoader)),
  };
}

export default LocationStore;
