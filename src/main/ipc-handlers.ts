import { autoUpdater } from 'electron-updater';
import { dialog, nativeTheme, shell } from 'electron';
import { MainMessenger } from '../ipc/main';
import { WindowSystemButtonPress } from '../ipc/messages';
import { TagDTO } from '../api/tag';
import ClipServer, { IImportItem } from '../clipper/server';
import {
  mainWindow,
  previewWindow,
  createPreviewWindow,
  createTrayMenu,
  destroyTray,
  forceRelaunch,
  getVersion,
  getPreviewIcon,
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
} from './window';
import { preferences, updatePreferences } from './preferences';

export function registerIpcHandlers(getClipServer: () => ClipServer | null) {
  //---------------------------------------------------------------------------------//
  // Messaging: Sending and receiving messages between the main and renderer process //
  //---------------------------------------------------------------------------------//
  MainMessenger.onIsClipServerRunning(() => getClipServer()?.isEnabled() === true);
  MainMessenger.onIsRunningInBackground(() => getClipServer()?.isRunInBackgroundEnabled() === true);

  MainMessenger.onSetClipServerEnabled(({ isClipServerRunning }) =>
    getClipServer()?.setEnabled(isClipServerRunning),
  );
  MainMessenger.onSetClipServerImportLocation((dir) => getClipServer()?.setImportLocation(dir));
  MainMessenger.onSetRunningInBackground(({ isRunInBackground }) => {
    const clipServer = getClipServer();
    if (clipServer === null) {
      return;
    }
    clipServer.setRunInBackground(isRunInBackground);
    if (isRunInBackground) {
      createTrayMenu();
    } else {
      destroyTray();
    }
  });

  MainMessenger.onStoreFile(({ directory, filenameWithExt, imgBase64 }) =>
    getClipServer()!.storeImageWithoutImport(directory, filenameWithExt, imgBase64),
  );

  // Forward files from the main window to the preview window
  MainMessenger.onSendPreviewFiles((msg) => {
    // Create preview window if needed, and send the files selected in the primary window
    if (previewWindow === null || previewWindow.isDestroyed()) {
      // The Window object might've been destroyed if it was hidden for too long -> Recreate it
      if (previewWindow?.isDestroyed()) {
        console.warn('Preview window was destroyed! Attemping to recreate...');
      }

      const newPreviewWindow = createPreviewWindow();
      MainMessenger.onceInitialized().then(() => {
        if (newPreviewWindow) {
          MainMessenger.sendPreviewFiles(newPreviewWindow.webContents, msg);
        }
      });
    } else {
      MainMessenger.sendPreviewFiles(previewWindow.webContents, msg);
      if (!previewWindow.isVisible()) {
        previewWindow.show();
      }
      previewWindow.focus();
    }
  });

  // Set native window theme (frame, menu bar)
  MainMessenger.onSetTheme((msg) => (nativeTheme.themeSource = msg.theme));

  MainMessenger.onDragExport(async (absolutePaths) => {
    if (mainWindow === null || absolutePaths.length === 0) {
      return;
    }
    const previewIcon = await getPreviewIcon(absolutePaths[0]);
    mainWindow.webContents.startDrag({
      file: absolutePaths[0],
      files: absolutePaths,
      // Just show the first image as a thumbnail for now
      // TODO: Show some indication that multiple images are dragged, would be cool to show a stack of the first few of them
      // TODO: The icon doesn't seem to work at all since we upgraded Electron a while back
      icon: previewIcon,
    });
  });

  MainMessenger.onClearDatabase(forceRelaunch);

  MainMessenger.onToggleDevTools(() => mainWindow?.webContents.toggleDevTools());

  MainMessenger.onReload((frontEndOnly) =>
    frontEndOnly ? mainWindow?.webContents.reload() : forceRelaunch(),
  );

  MainMessenger.onOpenDialog(dialog);

  MainMessenger.onMessageBox(dialog);

  MainMessenger.onMessageBoxSync(dialog);

  MainMessenger.onGetPath((path) => require('electron').app.getPath(path));

  MainMessenger.onTrashFile((absolutePath) => shell.trashItem(absolutePath));

  MainMessenger.onIsFullScreen(() => mainWindow?.isFullScreen() ?? false);

  MainMessenger.onSetFullScreen((isFullScreen) => mainWindow?.setFullScreen(isFullScreen));

  MainMessenger.onGetZoomFactor(() => mainWindow?.webContents.zoomFactor ?? 1);

  MainMessenger.onSetZoomFactor((factor) => {
    if (mainWindow !== null) {
      const zoom = Math.max(MIN_ZOOM_FACTOR, Math.min(factor, MAX_ZOOM_FACTOR));
      mainWindow.webContents.setZoomFactor(zoom);
    }
  });

  MainMessenger.onWindowSystemButtonPressed((button: WindowSystemButtonPress) => {
    if (mainWindow !== null) {
      switch (button) {
        case WindowSystemButtonPress.Close:
          mainWindow.close();
          break;

        case WindowSystemButtonPress.Maximize:
          mainWindow.maximize();
          break;

        case WindowSystemButtonPress.Minimize:
          mainWindow.minimize();
          break;

        case WindowSystemButtonPress.Restore:
          mainWindow.restore();
          break;

        default:
          break;
      }
    }
  });

  MainMessenger.onIsMaximized(() => mainWindow?.isMaximized() ?? false);

  MainMessenger.onGetVersion(getVersion);

  MainMessenger.onCheckForUpdates(() => autoUpdater.checkForUpdates());

  MainMessenger.onToggleCheckUpdatesOnStartup(() => {
    updatePreferences({
      ...preferences,
      checkForUpdatesOnStartup: !preferences.checkForUpdatesOnStartup,
    });
  });

  MainMessenger.onIsCheckUpdatesOnStartupEnabled(() => preferences.checkForUpdatesOnStartup === true);
}

/** Returns whether main window is open - so whether files can be immediately imported */
export async function importExternalImage(item: IImportItem): Promise<boolean> {
  if (mainWindow !== null) {
    MainMessenger.sendImportExternalImage(mainWindow.webContents, { item });
    return true;
  }
  return false;
}

export async function addTagsToFile(item: IImportItem): Promise<boolean> {
  if (mainWindow !== null) {
    MainMessenger.sendAddTagsToFile(mainWindow.webContents, { item });
    return true;
  }
  return false;
}

export async function getTags(): Promise<TagDTO[]> {
  if (mainWindow !== null) {
    const { tags } = await MainMessenger.getTags(mainWindow.webContents);
    const { ROOT_TAG_ID } = require('../api/tag') as typeof import('../api/tag');
    return tags.filter((t) => t.id !== ROOT_TAG_ID);
  }
  return [];
}
