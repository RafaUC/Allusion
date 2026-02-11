import { configure, reaction, runInAction } from 'mobx';

import { DataStorage } from 'src/api/data-storage';
import { DataBackup } from 'src/api/data-backup';

import FileStore from './FileStore';
import TagStore from './TagStore';
import UiStore from './UiStore';
import LocationStore from './LocationStore';
import ExifIO from 'common/ExifIO';
import ImageLoader from '../image/ImageLoader';

import { RendererMessenger } from 'src/ipc/renderer';
import SearchStore from './SearchStore';
import ExtraPropertyStore from './ExtraPropertyStore';
import { AppToaster } from '../components/Toaster';

// This will throw exceptions whenever we try to modify the state directly without an action
// Actions will batch state modifications -> better for performance
// https://mobx.js.org/refguide/action.html
configure({ observableRequiresReaction: true, reactionRequiresObservable: true });

/**
 * From: https://mobx.js.org/best/store.html
 * An often asked question is how to combine multiple stores without using singletons.
 * How will they know about each other?
 * An effective pattern is to create a RootStore that instantiates all stores,
 * and share references. The advantage of this pattern is:
 * 1. Simple to set up.
 * 2. Supports strong typing well.
 * 3. Makes complex unit tests easy as you just have to instantiate a root store.
 */
class RootStore {
  readonly #backend: DataStorage;
  readonly #backup: DataBackup;

  readonly tagStore: TagStore;
  readonly extraPropertyStore: ExtraPropertyStore;
  readonly fileStore: FileStore;
  readonly locationStore: LocationStore;
  readonly uiStore: UiStore;
  readonly searchStore: SearchStore;
  readonly exifTool: ExifIO;
  readonly imageLoader: ImageLoader;
  readonly getWindowTitle: () => string;

  private constructor(
    backend: DataStorage,
    backup: DataBackup,
    formatWindowTitle: (FileStore: FileStore, uiStore: UiStore) => string,
  ) {
    this.tagStore = new TagStore(backend, this);
    this.extraPropertyStore = new ExtraPropertyStore(backend, this);
    this.fileStore = new FileStore(backend, this);
    this.locationStore = new LocationStore(backend, this);
    this.uiStore = new UiStore(this);
    this.searchStore = new SearchStore(backend, this);
    this.#backend = backend;
    this.#backup = backup;
    this.exifTool = new ExifIO(localStorage.getItem('hierarchical-separator') || undefined);
    this.imageLoader = new ImageLoader(this.exifTool);
    this.getWindowTitle = () => formatWindowTitle(this.fileStore, this.uiStore);
  }

  static async main(backend: DataStorage, backup: DataBackup): Promise<RootStore> {
    const rootStore = new RootStore(backend, backup, (fileStore, uiStore) => {
      if (uiStore.isSlideMode && fileStore.fileList.length > 0) {
        const activeFile = fileStore.fileList[uiStore.firstItemIndex];
        return `${activeFile?.filename}.${activeFile?.extension} - Allusion`; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      } else {
        return 'Allusion';
      }
    });

    await Promise.all([
      // The tag store needs to be awaited because file and location entities have references
      // to tag entities.
      rootStore.tagStore.init(),
    ]);
    await Promise.all([
      // The location store must be initiated because the file entity constructor
      // uses the location reference to set values.
      rootStore.locationStore.init(),
      rootStore.extraPropertyStore.init(),
    ]);

    // Restore preferences, which affects how the file store initializes
    // It depends on tag store being initialized for reconstructing search criteria
    rootStore.uiStore.recoverPersistentPreferences();
    rootStore.fileStore.recoverPersistentPreferences();
    const isSlideMode = runInAction(() => rootStore.uiStore.isSlideMode);

    const numCriterias = runInAction(() => rootStore.uiStore.searchRootGroup.children.length);

    // There may already be a search already present, recovered from a previous session
    const fileStoreInit =
      numCriterias === 0
        ? rootStore.fileStore.fetchAllFiles
        : rootStore.fileStore.fetchFilesByQuery;

    // If slide mode was recovered from a previous session, it was disabled by setContentQuery.
    // Watch fileStore.numLoadedFiles until there are files in view to re-enable slide mode.
    if (isSlideMode) {
      const disposer = reaction(
        () => rootStore.fileStore.numLoadedFiles,
        (numLoadedFiles) => {
          if (numLoadedFiles > 0) {
            rootStore.uiStore.enableSlideMode();
            // Dispose the reaction in the next tick
            setTimeout(disposer, 0);
          }
        },
      );
    }

    // Load the files already in the database so user instantly sees their images
    fileStoreInit();
    rootStore.runPostInitializeTasks();

    return rootStore;
  }

  static async preview(backend: DataStorage, backup: DataBackup): Promise<RootStore> {
    const rootStore = new RootStore(backend, backup, (fileStore, uiStore) => {
      const PREVIEW_WINDOW_BASENAME = 'Allusion Quick View';
      const index = uiStore.firstItemIndex;
      if (index >= 0 && index < fileStore.fileList.length) {
        const file = fileStore.fileList[index];
        return `${file ? file.absolutePath : ''} • ${PREVIEW_WINDOW_BASENAME}`;
      } else {
        return PREVIEW_WINDOW_BASENAME;
      }
    });

    await Promise.all([
      // The location store must be initiated because the file entity constructor
      // uses the location reference to set values.
      rootStore.locationStore.init(),
      // The tag store needs to be awaited because file entities have references
      // to tag entities.
      rootStore.tagStore.init(),
      rootStore.imageLoader.init(),
      // Not: not initializing exiftool.
      // Might be needed for extracting thumbnails in preview mode, but can't be closed reliably,
      // causing exiftool to keep running after quitting
    ]);

    // Restore preferences, which affects how the file store initializes
    // It depends on tag store being initialized for reconstructing search criteria
    rootStore.uiStore.recoverPersistentPreferences();
    rootStore.fileStore.recoverPersistentPreferences();

    // The preview window is opened while the locations are already watched. The
    // files are fetched based on the file selection.

    return rootStore;
  }

  arePostInitTaskRun = false;

  async runPostInitializeTasks(): Promise<void> {
    if (this.arePostInitTaskRun) {
      return;
    }
    this.arePostInitTaskRun = true;

    // init searchStore before other longer inits
    await this.searchStore.init();

    // Init locations
    const locations = runInAction(() => this.locationStore.locationList.slice());
    for (const location of locations) {
      await location.init();
    }
    // look for any new or removed images, handled by parcel/watcher
    await this.locationStore.watchLocations();

    // Run user configured startup actions
    const { isRefreshLocationsStartupEnabled } = runInAction(() => ({
      isRefreshLocationsStartupEnabled: this.uiStore.isRefreshLocationsStartupEnabled,
    }));
    if (isRefreshLocationsStartupEnabled) {
      await this.locationStore.updateLocations();
    }

    // this modules can be initialized just-in-time so we can let thei genereal init at the end.
    await this.imageLoader.init();
    await this.exifTool.initialize();
  }

  async backupDatabaseToFile(path: string): Promise<void> {
    return this.#backup.backupToFile(path);
  }

  async restoreDatabaseFromFile(path: string): Promise<void> {
    return this.#backup.restoreFromFile(path);
  }

  async peekDatabaseFile(path: string): Promise<[numTags: number, numFiles: number]> {
    return this.#backup.peekFile(path);
  }

  async clearDatabase(): Promise<void> {
    await this.#backend.clear();
    RendererMessenger.clearDatabase();
    this.uiStore.clearPersistentPreferences();
    this.fileStore.clearPersistentPreferences();
  }

  async close(): Promise<void> {
    AppToaster.show({ message: 'Closing Allusion...', type: 'info', timeout: 0 }, 'closing');
    await this.locationStore.close();
    // TODO: should be able to be done more reliably by running exiftool as a child process
    await this.exifTool.close();
    AppToaster.show({ message: 'Closing Allusion...', type: 'success', timeout: 0 }, 'closing');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export default RootStore;
