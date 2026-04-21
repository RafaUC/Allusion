import { app, dialog, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import ClipServer from './clipper/server';
import { createBugReport, githubUrl } from '../common/config';
import {
  mainWindow,
  createWindow,
  setInitializer,
  forceRelaunch,
  getVersion,
} from './main/window';
import { loadPreferences, preferences } from './main/preferences';
import { setupUpdater } from './main/updater';
import { registerIpcHandlers, importExternalImage, addTagsToFile, getTags } from './main/ipc-handlers';

let clipServer: ClipServer | null = null;

function initialize() {
  console.log('Initializing Allusion...');

  // Disable spellchecker languages and block any download requests for spellcheck dictionaries *.bdic
  // TODO: Currently there are no spellchecker enhanced features implemented, like contextual menu
  // options or configurations, and it becomes annoying for users who use multiple languages or words not in the dictionary.
  // Maybe in the future it would be nice to have those features and allow configuring the spellchecker.
  session.defaultSession.setSpellCheckerLanguages([]);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.includes('.bdic')) {
      return callback({ cancel: true });
    }
    callback({});
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders === undefined) {
      callback({});
    } else {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['require-corp'],
        },
      });
    }
  });

  if (clipServer === null) {
    clipServer = new ClipServer(importExternalImage, addTagsToFile, getTags);
  }

  createWindow(clipServer, importExternalImage);

  // TODO: During DB backup import, initializing a second window at the same time
  // will access the database and prevent the DB file from being removed when
  // importing a backup at startup. In the future, we could implement a preview
  // initialization that doesn't cause this conflict.
  // The preview window can safely be initialized at any time after the main
  // window initialization has completed.
  //createPreviewWindow();

  // Initialize preferences file and its consequences
  loadPreferences();
  if (preferences.checkForUpdatesOnStartup) {
    autoUpdater.checkForUpdates();
  }
}

// Register the initialize function with window.ts so tray can call it
setInitializer(initialize);

// Register all IPC handlers
registerIpcHandlers(() => clipServer);

// Set up auto-updater event handlers
setupUpdater(() => mainWindow);

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  if (clipServer === null || !clipServer.isRunInBackgroundEnabled()) {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});

// Ensure only a single instance of Allusion can be open
// https://www.electronjs.org/docs/api/app#apprequestsingleinstancelock
const HAS_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_INSTANCE_LOCK) {
  console.log('Another instance of Allusion is already running');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow === null || mainWindow.isDestroyed()) {
      // In case there is no main window (could be running in background): re-initialize
      initialize();
    } else {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
  // Enable manual garbage collector
  app.commandLine.appendSwitch('js-flags', '--expose-gc');

  // Only initialize window if no other instance is already running:
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(initialize);
}

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow(clipServer, importExternalImage);
  }
});

// Handling uncaught exceptions:
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception', error);

  const errorMessage = `An unexpected error occurred. Please file a bug report if you think this needs fixing!\n${
    error.stack?.includes(error.message) ? '' : `${error.name}: ${error.message.slice(0, 200)}\n`
  }\n${error.stack?.slice(0, 300)}`;

  try {
    if (mainWindow != null && !mainWindow.isDestroyed()) {
      // Show a dialog prompting the user to either restart, continue on or quit
      const dialogResult = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Unexpected error',
        message: errorMessage,
        buttons: ['Try to keep running', 'File bug report', 'Restart Allusion', 'Quit Allusion'],
      });
      if (dialogResult.response === 0) {
        // Keep running
      } else if (dialogResult.response === 1) {
        // File bug report
        const encodedBody = encodeURIComponent(
          createBugReport(error.stack || error.name + ': ' + error.message, getVersion()),
        );
        const url = `${githubUrl}/issues/new?body=${encodedBody}`;
        shell.openExternal(url);
      } else if (dialogResult.response === 2) {
        forceRelaunch(); // Restart
      } else if (dialogResult.response === 3) {
        app.exit(0); // Quit
      }
    } else {
      // No main window, show a fallback dialog
      dialog.showErrorBox('Unexpected error', errorMessage);
      app.exit(1);
    }
  } catch (e) {
    console.error('Could not show error dialog', e);
    app.exit(1);
  }
});
