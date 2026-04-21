import path from 'path';
import { dialog, shell } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { IS_DEV } from '../../common/process';
import { getVersion, getTray } from './window';

// Auto-updates: using electron-builders autoUpdater: https://www.electron.build/auto-update#quick-setup-guide
// How it should go:
// - Auto check for updates on startup (toggleable in settings) -> show toast message if update available
// - Option to check for updates in settings
// - Only download and install when user agrees
autoUpdater.autoDownload = false;
let hasCheckedForUpdateOnStartup = false;
if (IS_DEV) {
  autoUpdater.updateConfigPath = path.join(__dirname, '..', '..', 'dev-app-update.yml');
}

export function setupUpdater(getMainWindow: () => Electron.BrowserWindow | null) {
  autoUpdater.on('error', (error) => {
    // Don't show error messages on startup
    if (!hasCheckedForUpdateOnStartup) {
      hasCheckedForUpdateOnStartup = true;
      console.error('Auto-update error', error);
      return;
    }

    let errorMsg: string = (error.stack || error).toString() || 'Reason unknown, try again later.';

    // In case of no network connection...
    if (errorMsg.includes('INTERNET_DISCONNECTED')) {
      // This error occured during a manual update check from the user, show a friendlier message
      errorMsg = 'There seems to be an issue with your internet connection.';
    }
    dialog.showErrorBox('Auto-update error: ', errorMsg);
    hasCheckedForUpdateOnStartup = true;
  });

  autoUpdater.on('update-available', async (info: UpdateInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }

    const message = `Update available: ${
      info.releaseName || info.version
    }:\nDo you wish to update now?`;
    // info.releaseNotes attribute is HTML, could show that in renderer at some point

    const dialogResult = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Found Updates',
      message,
      buttons: ['Yes', 'No', 'Open release page'],
    });

    if (dialogResult.response === 0) {
      autoUpdater.downloadUpdate();
    } else if (dialogResult.response === 2) {
      shell.openExternal('https://github.com/RafaUC/Allusion/releases/latest');
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (!hasCheckedForUpdateOnStartup) {
      // don't show a dialog if the update check was triggered automatically on start-up
      hasCheckedForUpdateOnStartup = true;
      return;
    }
    // Could also show this as a toast!
    const mainWindow = getMainWindow();
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }
    dialog.showMessageBox(mainWindow, {
      title: 'No Update Available',
      message: `Current version is up-to-date (v${getVersion()})!`,
    });
  });

  autoUpdater.on('update-downloaded', async () => {
    const mainWindow = getMainWindow();
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(10); // indeterminate mode until application is restarted
    }
    await dialog.showMessageBox({
      title: 'Install Updates',
      message: 'Updates downloaded, Allusion will restart...',
    });
    setImmediate(() => autoUpdater.quitAndInstall());
  });

  // Show the auto-update download progress in the task bar
  autoUpdater.on('download-progress', (progressObj: { percent: number }) => {
    const mainWindow = getMainWindow();
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }
    const currentTray = getTray();
    if (currentTray && !currentTray.isDestroyed()) {
      currentTray.setToolTip(`Allusion - Downloading update ${progressObj.percent.toFixed(0)}%`);
    }
    // TODO: could also do this for other tasks (e.g. importing folders)
    mainWindow.setProgressBar(progressObj.percent / 100);
  });
}
