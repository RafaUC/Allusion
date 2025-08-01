import fse from 'fs-extra';
import { action, makeObservable, observable, runInAction } from 'mobx';
import SysPath from 'path';

import { getThumbnailPath } from 'common/fs';
import { promiseAllLimit } from 'common/promise';
import { DataStorage } from '../../api/data-storage';
import { OrderDirection } from '../../api/data-storage-search';
import { FileDTO, IMG_EXTENSIONS, IMG_EXTENSIONS_TYPE } from '../../api/file';
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

class LocationStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

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
        ),
    );
    runInAction(() => this.locationList.replace(locations));
  }

  save(loc: LocationDTO): void {
    this.backend.saveLocation(loc);
  }

  // chokidar.watch is significantly slower in windows. This negatively affects UX at
  // Startup when dealing with locations containing a large number of files.
  // Performing the initial scan for new or removed images directly with fse greatly
  // improves the initial sync on Windows.
  // TODO: this method could be used to do manual syncs by the user.
  updateLocations(): Promise<boolean> {
    return this.compareLocations(false);
  }

  // We still need to initialize the watching and compare disk and db files like before,
  // since changes may occur on disk during watcher initialization.
  watchLocations(): Promise<boolean> {
    return this.compareLocations(true);
  }

  // E.g. in preview window, it's not needed to watch the locations
  // Returns whether files have been added, changed or removed
  @action async compareLocations(watch = true): Promise<boolean> {
    const progressToastKey = 'progress';
    let foundNewFiles = false;
    const len = this.locationList.length;
    const getLocation = action((index: number) => this.locationList[index]);

    // Get all files in the DB, set up data structures for quick lookups
    // Doing it for all locations, so files moved to another Location on disk, it's properly re-assigned in Allusion too
    const dbFiles: FileDTO[] = await this.backend.fetchFiles('id', OrderDirection.Asc);
    // Taking advantage of the fact that we're doing a full fetch here, try to initialize file counts if they haven't been initialized yet.
    this.rootStore.tagStore.initializeFileCounts(dbFiles);
    const dbFilesPathSet = new Set(dbFiles.map((f) => f.absolutePath));
    const dbFilesByCreatedDate = new Map<number, FileDTO[]>();
    for (const file of dbFiles) {
      const time = file.dateCreated.getTime();
      const entry = dbFilesByCreatedDate.get(time);
      if (entry) {
        entry.push(file);
      } else {
        dbFilesByCreatedDate.set(time, [file]);
      }
    }

    const toastsMsg = watch ? 'Syncing locations' : 'Looking for new images';

    // For every location, find created/moved/deleted files, and update the database accordingly.
    // TODO: Do this in a web worker, not in the renderer thread!
    for (let i = 0; i < len; i++) {
      const location = getLocation(i);

      AppToaster.show(
        {
          message: `${toastsMsg}... [${i + 1} / ${len}]`,
          timeout: 6000,
        },
        progressToastKey,
      );

      // TODO: Add a maximum timeout for init: sometimes it's hanging for me. Could also be some of the following steps though
      // added a retry toast for now, can't figure out the cause, and it's hard to reproduce
      // FIXME: Toasts should not be abused for error handling. Create some error messaging mechanism.
      const readyTimeout = setTimeout(() => {
        AppToaster.show(
          {
            message: `${toastsMsg}... [${i + 1} / ${len}]`,
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

      const wasInitialized = runInAction(() => location.isInitialized);
      if (!wasInitialized) {
        console.group(`Initializing location ${location.name}`);
        await location.init();
      }
      const diskFiles = watch ? await location.watch() : await location.getDiskFiles();
      const diskFileMap = new Map<string, FileStats>(
        diskFiles?.map((f) => [f.absolutePath, f]) ?? [],
      );

      clearTimeout(readyTimeout);
      AppToaster.dismiss('retry-init');

      if (diskFiles === undefined) {
        AppToaster.show(
          {
            message: `Cannot find Location "${location.name}"`,
            timeout: 0,
          },
          // a key such that the toast can be dismissed automatically on recovery
          `missing-loc-${location.id}`,
        );
        continue;
      }

      console.log('Finding created files...');
      // Find all files that have been created (those on disk but not in DB)
      const createdPaths = diskFiles.filter((f) => !dbFilesPathSet.has(f.absolutePath));
      const createdFiles = await Promise.all(
        createdPaths.map((path) => pathToIFile(path, location, this.rootStore.imageLoader)),
      );

      // Find all files of this location that have been removed (those in DB but not on disk anymore)
      const missingFiles = dbFiles.filter(
        (file) => file.locationId === location.id && !diskFileMap.has(file.absolutePath),
      );

      // Find matches between removed and created images (different name/path but same characteristics)
      // TODO: use the ino field on files for this
      const createdMatches = missingFiles.map((mf) =>
        createdFiles.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
      );
      // Also look for duplicate files: when a files is renamed/moved it will become a new entry, should be de-duplicated
      const dbMatches = missingFiles.map((missingDbFile, i) => {
        if (createdMatches[i]) {
          return false;
        } // skip missing files that match with a newly created file
        // Quick lookup for files with same created date,
        const candidates = dbFilesByCreatedDate.get(missingDbFile.dateCreated.getTime()) || [];

        // then first look for a file with the same name + resolution (for when file is moved to different path)
        const matchWithName = candidates.find(
          (otherDbFile) =>
            missingDbFile !== otherDbFile &&
            missingDbFile.name === otherDbFile.name &&
            areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
        );

        // If no match, try looking without filename in case the file was renamed (prone to errors, but better than nothing)
        return (
          matchWithName ||
          candidates.find(
            (otherDbFile) =>
              missingDbFile !== otherDbFile &&
              areFilesIdenticalBesidesName(missingDbFile, otherDbFile),
          )
        );
      });

      console.debug({ missingFiles, createdFiles, createdMatches, dbMatches });

      // Update renamed files in backend
      const foundCreatedMatches = createdMatches.filter((m) => m !== undefined) as FileDTO[];
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
            this.rootStore.fileStore.replaceMovedFile(updatedFileData.id, updatedFileData);
          }
        }
        // There might be duplicates, so convert to set
        await this.backend.saveFiles(Array.from(new Set(renamedFilesToUpdate)));
      }

      const numDbMatches = dbMatches.filter((f) => Boolean(f));
      if (numDbMatches.length > 0) {
        // Renaming/moving files will be created as new files while the old one sticks around
        // In here we transfer the tag data over from the old entry to the new one, and delete the old entry
        console.debug(
          `Found ${numDbMatches.length} renamed/moved files in location ${location.name} that were already present in the database. Removing duplicates`,
          numDbMatches,
        );
        const files: FileDTO[] = [];
        for (let i = 0; i < dbMatches.length; i++) {
          const match = dbMatches[i];
          if (match) {
            files.push({
              ...match,
              tags: Array.from(new Set([...missingFiles[i].tags, ...match.tags])),
              extraProperties: { ...missingFiles[i].extraProperties, ...match.extraProperties },
              extraPropertyIDs: Array.from(
                new Set([...missingFiles[i].extraPropertyIDs, ...match.extraPropertyIDs]),
              ),
            });
          }
        }
        // Transfer over tag data on the matched files
        await this.backend.saveFiles(Array.from(new Set(files)));
        // Remove missing files that have a match in the database
        await this.backend.removeFiles(
          missingFiles.filter((_, i) => Boolean(dbMatches[i])).map((f) => f.id),
        );
        foundNewFiles = true; // Set a flag to trigger a refetch
      }

      // For createdFiles without a match, insert them in the DB as new files
      const newFiles = createdFiles.filter((cf) => !foundCreatedMatches.includes(cf));
      if (newFiles.length) {
        await this.backend.createFilesFromPath(location.path, newFiles);
      }

      await this.updateChangedFiles(dbFiles, diskFileMap);

      if (!wasInitialized) {
        console.groupEnd();
      }

      foundNewFiles = foundNewFiles || newFiles.length > 0;
    }

    if (foundNewFiles) {
      AppToaster.show({ message: 'New images detected.', timeout: 5000 }, progressToastKey);
    } else {
      AppToaster.dismiss(progressToastKey);
    }
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
          dbFile.OrigDateModified.getTime() !== diskFile.dateModified.getTime()) &&
          diskFile.size !== dbFile.size) ||
          diskFile.ino !== dbFile.ino)
      ) {
        const newFile: FileDTO = {
          ...dbFile,
          // Recreate metadata which checks the resolution of the image
          ...(await getMetaData(diskFile, this.rootStore.imageLoader)),
          ino: diskFile.ino,
          OrigDateModified: diskFile.dateModified,
          dateLastIndexed: new Date(),
        };

        console.debug(
          `Updating modified file: ${JSON.stringify(
            {
              ino: dbFile.ino,
              size: dbFile.size,
              OrigDateModified: dbFile.OrigDateModified,
              dateLastIndexed: dbFile.dateLastIndexed,
              name: dbFile.absolutePath,
            },
            null,
            2,
          )} to ${JSON.stringify(
            {
              ino: newFile.ino,
              size: newFile.size,
              OrigDateModified: newFile.OrigDateModified,
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
    const filePaths = await location.getDiskFiles();
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

    if (clientFile) {
      fileStore.hideFile(clientFile);
      fileStore.debouncedRefetch();
    }
  }

  /**
   * Fetches the files belonging to a location
   */
  @action async findLocationFiles(locationId: ID): Promise<FileDTO[]> {
    const crit = new ClientStringSearchCriteria('locationId', locationId, 'equals').toCondition();
    return this.backend.searchFiles(crit, 'id', OrderDirection.Asc);
  }

  @action async removeSublocationFiles(subLoc: ClientSubLocation): Promise<void> {
    const crit = new ClientStringSearchCriteria(
      'absolutePath',
      subLoc.path,
      'startsWith',
    ).toCondition();
    const files = await this.backend.searchFiles(crit, 'id', OrderDirection.Asc);
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
}

export type FileStats = {
  absolutePath: string;
  /** When file was last modified on disk */
  dateModified: Date;
  /** When file was created on disk */
  dateCreated: Date;
  /** Current size of the file in bytes */
  size: number;
  /** A unique identifier of the file created by the OS, stays identical even when renaming/moving files */
  ino: string;
};

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
    extraPropertyIDs: [],
    extraProperties: {},
    dateAdded: now,
    dateModified: now,
    OrigDateModified: stats.dateModified,
    dateLastIndexed: now,
    ...(await getMetaData(stats, imageLoader)),
  };
}

export default LocationStore;
