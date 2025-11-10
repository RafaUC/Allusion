// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

// Import the styles here to let Webpack know to include them
// in the HTML file
import './style.scss';

import fse from 'fs-extra';
import { autorun, reaction, runInAction } from 'mobx';
import React from 'react';
import { Root, createRoot } from 'react-dom/client';

import { wrap, Remote, proxy } from 'comlink';
import Backend from './backend/backend';

import { IS_DEV } from 'common/process';
import { promiseRetry } from 'common/timeout';
import { IS_PREVIEW_WINDOW, WINDOW_STORAGE_KEY } from 'common/window';
import { RendererMessenger } from 'src/ipc/renderer';
import App from './frontend/App';
import SplashScreen from './frontend/containers/SplashScreen';
import StoreProvider from './frontend/contexts/StoreContext';
import Overlay from './frontend/Overlay';
import PreviewApp from './frontend/Preview';
import { FILE_STORAGE_KEY } from './frontend/stores/FileStore';
import RootStore from './frontend/stores/RootStore';
import { PREFERENCES_STORAGE_KEY } from './frontend/stores/UiStore';
import BackupScheduler from './backend/backup-scheduler';
import path from 'path';
import { DB_NAME, USE_BACKEND_AS_WORKER } from './backend/config';

async function main(): Promise<void> {
  // Render our react components in the div with id 'app' in the html file
  const container = document.getElementById('app');

  if (container === null) {
    throw new Error('Unable to create user interface.');
  }

  const root = createRoot(container);

  root.render(<SplashScreen />);

  const basePath = await RendererMessenger.getPath('userData');
  const databaseDirectory = path.join(basePath, 'databases');
  const databaseFilePath = path.join(databaseDirectory, `${DB_NAME}.sqlite`);

  if (!IS_PREVIEW_WINDOW) {
    await runMainApp(databaseFilePath, databaseDirectory, root);
  } else {
    await runPreviewApp(databaseFilePath, root);
  }
}

async function runMainApp(dbPath: string, dbDirectory: string, root: Root): Promise<void> {
  // Check if the database file already exists
  const dbExists = await fse.pathExists(dbPath);
  const defaultBackupDirectory = await RendererMessenger.getDefaultBackupDirectory();
  const { backupScheduler, tempJsonToImport } = await BackupScheduler.init(
    dbPath,
    dbDirectory,
    defaultBackupDirectory,
  );

  let backend: Backend;
  // If using worker mode and DB already exists, initialize backend in worker
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (USE_BACKEND_AS_WORKER && dbExists && !tempJsonToImport) {
    const backendService = new BackendService();
    const [remoteBackend] = await Promise.all([
      backendService.init(
        dbPath,
        () => backupScheduler.schedule(),
        () => backupScheduler.restoreEmpty(),
      ),
      fse.ensureDir(defaultBackupDirectory),
    ]);
    backend = remoteBackend as unknown as Backend;
  } else {
    // If DB does not exist or worker mode is disabled,
    // initialize backend in the main thread to safely run migrations
    backend = new Backend();
    await Promise.all([
      backend.init({
        dbPath: dbPath,
        jsonToImport: tempJsonToImport,
        notifyChange: () => backupScheduler.schedule(),
        restoreEmpty: () => backupScheduler.restoreEmpty(),
      }),
      fse.ensureDir(defaultBackupDirectory),
    ]);
    // remove temporal json to avoid infinite re import.
    if (tempJsonToImport) {
      await fse.remove(tempJsonToImport);
    }
  }

  const rootStore = await RootStore.main(backend, backupScheduler);

  RendererMessenger.initialized();

  // Recover global preferences
  try {
    const window_preferences = localStorage.getItem(WINDOW_STORAGE_KEY);
    if (window_preferences === null) {
      localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify({ isFullScreen: false }));
    } else {
      const prefs = JSON.parse(window_preferences);
      if (prefs.isFullScreen === true) {
        RendererMessenger.setFullScreen(true);
        rootStore.uiStore.setFullScreen(true);
      }
    }
  } catch (e) {
    console.error('Cannot load window preferences', e);
  }

  // Debounced and automatic storing of preferences
  reaction(
    () => rootStore.fileStore.getPersistentPreferences(),
    (preferences) => {
      localStorage.setItem(FILE_STORAGE_KEY, JSON.stringify(preferences));
    },
    { delay: 200 },
  );

  reaction(
    () => rootStore.uiStore.getPersistentPreferences(),
    (preferences) => {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    },
    { delay: 200 },
  );

  autorun(() => {
    document.title = rootStore.getWindowTitle();
  });

  root.render(
    <StoreProvider value={rootStore}>
      <App />
      <Overlay />
    </StoreProvider>,
  );

  // -------------------------------------------
  // Messaging with the main process
  // -------------------------------------------
  let f5Reload: boolean | undefined = undefined;
  RendererMessenger.onf5Reload((frontendOnly?: boolean) => {
    f5Reload = frontendOnly;
    RendererMessenger.reload(frontendOnly);
  });

  RendererMessenger.onImportExternalImage(async ({ item }) => {
    console.log('Importing image...', item);
    // Might take a while for the file watcher to detect the image - otherwise the image is not in the DB and cannot be tagged
    promiseRetry(() => addTagsToFile(item.filePath, item.tagNames));
  });

  RendererMessenger.onAddTagsToFile(async ({ item }) => {
    console.log('Adding tags to file...', item);
    await addTagsToFile(item.filePath, item.tagNames);
  });

  RendererMessenger.onGetTags(async () => ({ tags: (await backend?.fetchTags()) ?? [] }));

  RendererMessenger.onFullScreenChanged((val) => rootStore.uiStore.setFullScreen(val));

  RendererMessenger.onSetZoomFactor((val) => rootStore.uiStore.setZoomFactor(val));

  /**
   * Adds tags to a file, given its name and the names of the tags
   * @param filePath The path of the file
   * @param tagNames The names of the tags
   */
  async function addTagsToFile(filePath: string, tagNames: string[]) {
    const { fileStore, tagStore } = rootStore;
    const clientFile = runInAction(() =>
      fileStore.definedFiles.find((file) => file.absolutePath === filePath),
    );
    if (clientFile) {
      const tags = await Promise.all(
        tagNames.map(async (tagName) => {
          const clientTag = tagStore.findByNameOrAlias(tagName);
          if (clientTag !== undefined) {
            return clientTag;
          } else {
            const newClientTag = await tagStore.create(tagStore.root, tagName);
            return newClientTag;
          }
        }),
      );
      tags.forEach(clientFile.addTag);
    } else {
      throw new Error('Could not find image to set tags for ' + filePath);
    }
  }

  RendererMessenger.onClosedPreviewWindow(() => {
    rootStore.uiStore.closePreviewWindow();
  });

  /*
  // Runs operations to run before closing the app, e.g. closing child-processes
  // TODO: for async operations, look into https://github.com/electron/electron/issues/9433#issuecomment-960635576
  window.addEventListener('beforeunload', () => {
    rootStore.close();
  }); */
  let asyncOperationDone = false;
  const handleBeforeUnload = async (event: BeforeUnloadEvent) => {
    if (!asyncOperationDone) {
      event.preventDefault();
      event.returnValue = false;
      // TODO: Show a warning to prevent closing if rootStore.fileStore.isSaving is true.
      await rootStore.close();
      asyncOperationDone = true;
      console.log('async operation done, closing');
      if (f5Reload !== undefined) {
        RendererMessenger.reload(f5Reload);
      } else {
        window.close();
      }
    }
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
}

async function runPreviewApp(dbPath: string, root: Root): Promise<void> {
  //const backend = await Backend.init(dbPath, () => {});
  // TODO: create an apropiated initPreview mode
  const backend = new Backend();
  await backend.init({
    dbPath: dbPath,
    jsonToImport: undefined,
    notifyChange: () => {},
    restoreEmpty: async () => {},
  });
  const rootStore = await RootStore.preview(backend, new BackupScheduler(dbPath, '', ''));

  RendererMessenger.initialized();

  await new Promise<void>((executor) => {
    let initRender: (() => void) | undefined = executor;

    RendererMessenger.onReceivePreviewFiles(
      async ({ ids, thumbnailDirectory, viewMethod, activeImgId }) => {
        rootStore.uiStore.setThumbnailDirectory(thumbnailDirectory);
        rootStore.uiStore.setMethod(viewMethod);
        rootStore.uiStore.enableSlideMode();

        runInAction(() => {
          rootStore.uiStore.isInspectorOpen = false;
        });

        const files = await backend.fetchFilesByID(ids);

        // If a file has a location we don't know about (e.g. when a new location was added to the main window),
        // re-fetch the locations in the preview window
        const hasNewLocation = runInAction(() =>
          files.some((f) => !rootStore.locationStore.locationList.find((l) => l.id === f.id)),
        );
        if (hasNewLocation) {
          await rootStore.locationStore.init();
        }

        await rootStore.fileStore.updateFromBackend(files);
        rootStore.uiStore.setFirstItem((activeImgId && ids.indexOf(activeImgId)) || 0);

        if (initRender !== undefined) {
          initRender();
          initRender = undefined;
        }
      },
    );
  });

  autorun(() => {
    document.title = rootStore.getWindowTitle();
  });

  // Render our react components in the div with id 'app' in the html file
  // The Provider component provides the state management for the application
  root.render(
    <StoreProvider value={rootStore}>
      <PreviewApp />
      <Overlay />
    </StoreProvider>,
  );

  // Close preview with space
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Escape') {
      rootStore.uiStore.clearFileSelection();
      rootStore.fileStore.clearFileList();
      rootStore.uiStore.enableSlideMode();

      // remove focus from element so closing preview with spacebar does not trigger any ui elements
      if (document.activeElement && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      window.close();
    }
  });
}

class BackendService {
  worker?: Remote<Backend>;
  workerInstance?: Worker;
  private initialized = false;

  async init(
    dbPath: string,
    notifyChange: () => void,
    restoreEmpty: () => Promise<void>,
  ): Promise<Remote<Backend> | undefined> {
    if (this.initialized) {
      console.warn('BackendService: Already initialized');
      return this.worker;
    }

    console.log('BackendService: Creating worker...');

    const worker = new Worker(new URL('src/backend/backend', import.meta.url), {
      type: 'module',
    });
    const WorkerClass = wrap<typeof Backend>(worker);

    this.worker = await new WorkerClass();
    this.workerInstance = worker;

    console.log('BackendService: Initializing worker backend...');
    await this.worker.init({
      dbPath: dbPath,
      jsonToImport: undefined,
      notifyChange: proxy(notifyChange),
      restoreEmpty: proxy(restoreEmpty),
    });

    this.initialized = true;
    console.log('BackendService: Ready!');

    return this.worker;
  }
}

main()
  .then(() => console.info('Successfully initialized Allusion!'))
  .catch((err) => {
    console.error('Could not initialize Allusion!', err);
    window.alert('An error has occurred, check the console for more details');

    // In dev mode, the console is already automatically opened: only open in non-dev mode here
    if (!IS_DEV) {
      RendererMessenger.toggleDevTools();
    }
  });
