import {
  app,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Menu,
  nativeImage,
  Rectangle,
  screen,
  Tray,
} from 'electron';
import path from 'path';
import fse from 'fs-extra';
import TrayIcon from '../../resources/logo/png/full-color/allusion-logomark-fc-256x256.png';
import AppIcon from '../../resources/logo/png/full-color/allusion-logomark-fc-512x512.png';
import TrayIconMac from '../../resources/logo/png/black/allusionTemplate@2x.png'; // filename convention: https://www.electronjs.org/docs/api/native-image#template-image
import { IS_DEV, IS_MAC } from '../../common/process';
import { MainMessenger } from '../ipc/main';
import ClipServer, { IImportItem } from '../clipper/server';

// TODO: change this when running in portable mode, see portable-improvements branch
const basePath = app.getPath('userData');
export const windowStateFilePath = path.join(basePath, 'windowState.json');

export const MIN_ZOOM_FACTOR = 0.5;
export const MAX_ZOOM_FACTOR = 2;
export const MIN_WINDOW_WIDTH = 240;
export const MIN_WINDOW_HEIGHT = 64;

export let mainWindow: BrowserWindow | null = null;
export let previewWindow: BrowserWindow | null = null;
export let tray: Tray | null = null;

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function getTray() {
  return tray;
}

// initialize() is defined in main.ts; set via setInitializer() to avoid circular imports
let _initialize: () => void = () => {};
export function setInitializer(fn: () => void) {
  _initialize = fn;
}

export function getMainWindowDisplay() {
  if (mainWindow !== null) {
    const winBounds = mainWindow.getBounds();
    return screen.getDisplayNearestPoint({
      x: winBounds.x + winBounds.width / 2,
      y: winBounds.y + winBounds.height / 2,
    });
  }
  return screen.getPrimaryDisplay();
}

// Based on https://github.com/electron/electron/issues/526
export function getPreviousWindowState(): Electron.Rectangle & { isMaximized?: boolean } {
  const options: Electron.Rectangle & { isMaximized?: boolean } = {
    x: 0,
    y: 0,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
  };
  try {
    const state = fse.readJSONSync(windowStateFilePath);
    state.x = Number(state.x);
    state.y = Number(state.y);
    state.width = Number(state.width);
    state.height = Number(state.height);
    state.isMaximized = Boolean(state.isMaximized);

    const area = screen.getDisplayMatching(state).workArea;
    // If the saved position still valid (the window is entirely inside the display area), use it.
    if (
      state.x >= area.x &&
      state.y >= area.y &&
      state.x + state.width <= area.x + area.width &&
      state.y + state.height <= area.y + area.height
    ) {
      options.x = state.x;
      options.y = state.y;
    }
    // If the saved size is still valid, use it.
    if (state.width <= area.width || state.height <= area.height) {
      options.width = state.width;
      options.height = state.height;
    }
    options.isMaximized = state.isMaximized;
  } catch (e) {
    console.error('Could not read window state file!', e);
    // Fallback to primary display screen size
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    options.width = width;
    options.height = height;
  }
  return options;
}

// Save window position and bounds: https://github.com/electron/electron/issues/526
let saveBoundsTimeout: ReturnType<typeof setTimeout> | null = null;
export function saveWindowState() {
  if (saveBoundsTimeout) {
    clearTimeout(saveBoundsTimeout);
  }
  saveBoundsTimeout = setTimeout(() => {
    saveBoundsTimeout = null;
    if (mainWindow !== null) {
      const state = Object.assign(
        { isMaximized: mainWindow.isMaximized() },
        mainWindow.getNormalBounds(),
      );
      fse.writeFileSync(windowStateFilePath, JSON.stringify(state, null, 2));
    }
  }, 1000);
}

export function forceRelaunch() {
  app.relaunch();
  app.exit();
}

export function getVersion(): string {
  if (IS_DEV) {
    // Weird quirk: it returns the Electron version in dev mode
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../package.json').version;
  } else {
    return app.getVersion();
  }
}

export async function tryCreateIcon(
  absolutePath: string,
  method: 'ThumbnailFromPath' | 'FromPath',
  description: string,
) {
  try {
    let icon;
    if (method === 'ThumbnailFromPath') {
      icon = await nativeImage.createThumbnailFromPath(absolutePath, { width: 150, height: 150 });
    } else {
      icon = nativeImage.createFromPath(absolutePath);
    }
    if (icon.isEmpty()) {
      throw new Error('Image is empty');
    }
    icon = icon.resize({ width: 150 });
    return icon;
  } catch (e) {
    console.error(`Could not create ${description}`, e);
    return null;
  }
}

export async function getPreviewIcon(absolutePath: string) {
  let icon = await tryCreateIcon(absolutePath, 'ThumbnailFromPath', 'thumbnail drag icon');
  if (!icon) {
    icon = await tryCreateIcon(absolutePath, 'FromPath', 'fallback resized icon');
  }
  if (!icon) {
    const fallbackIconPath = path.join(__dirname, TrayIcon);
    icon = await tryCreateIcon(fallbackIconPath, 'FromPath', 'fallback tray icon');
  }
  return icon || nativeImage.createEmpty();
}

export function createTrayMenu() {
  if (tray === null || tray.isDestroyed()) {
    const onTrayClick = () =>
      mainWindow === null || mainWindow.isDestroyed() ? _initialize() : mainWindow.focus();

    tray = new Tray(`${__dirname}/${IS_MAC ? TrayIconMac : TrayIcon}`);
    const trayMenu = Menu.buildFromTemplate([
      {
        label: 'Open',
        type: 'normal',
        click: onTrayClick,
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(trayMenu);
    tray.setToolTip('Allusion - Your Visual Library');
    tray.on('click', onTrayClick);
  }
}

export function createPreviewWindow() {
  // Get display where main window is located
  const display = getMainWindowDisplay();

  // preview window is is sized relative to screen resolution by default
  const bounds: Rectangle = {
    width: (display.size.width * 3) / 4,
    height: (display.size.height * 3) / 4,
    x: display.bounds.x + display.bounds.width / 8,
    y: display.bounds.y + display.bounds.height / 8,
  };

  previewWindow = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
    },
    minWidth: 224,
    minHeight: 224,
    ...bounds,
    icon: `${__dirname}/${AppIcon}`,
    // Should be same as body background: Only for split second before css is loaded
    backgroundColor: '#14181a',
    title: 'Allusion Quick View',
    show: false, // invis by default
  });
  previewWindow.setMenuBarVisibility(false);
  previewWindow.loadURL(`file://${__dirname}/index.html?preview=true`);
  previewWindow.on('close', (e) => {
    // Prevent close, hide the window instead, for faster launch next time
    if (mainWindow !== null) {
      e.preventDefault();
      MainMessenger.sendClosedPreviewWindow(mainWindow.webContents);
      mainWindow.focus();
    }
    if (previewWindow !== null) {
      previewWindow.hide();
    }
  });
  return previewWindow;
}

export function createWindow(
  clipServer: ClipServer | null,
  importExternalImage: (item: IImportItem) => Promise<boolean>,
) {
  // Remember window size and position
  const previousWindowState = getPreviousWindowState();

  const mainOptions: BrowserWindowConstructorOptions = {
    titleBarStyle: 'hidden',
    // Disable native frame: we use a custom titlebar for all platforms: a unique one for MacOS, and one for windows/linux
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      spellcheck: false,
    },
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: `${__dirname}/${AppIcon}`,
    // Should be same as body background: Only for split second before css is loaded
    backgroundColor: '#1c1e23',
    title: 'Allusion',
    show: false, // only show once initial loading is finished
    ...previousWindowState,
  };

  // Create the browser window.
  mainWindow = new BrowserWindow(mainOptions);
  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Customize new window opening
  // https://www.electronjs.org/docs/api/window-open
  mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return { action: 'deny' };
    }

    const WINDOW_TITLES: { [key: string]: string } = {
      settings: 'Settings',
      'help-center': 'Help Center',
      about: 'About',
    };

    if (!(frameName in WINDOW_TITLES)) {
      return { action: 'deny' };
    }

    // Open window on same display as main window
    const targetDisplay = getMainWindowDisplay();
    const bounds: Rectangle = { width: 680, height: 480, x: 0, y: 0 };
    bounds.x = targetDisplay.bounds.x + bounds.width / 2;
    bounds.y = targetDisplay.bounds.y + bounds.height / 2;

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...bounds,
        icon: `${__dirname}/${AppIcon}`,
        // Should be same as body background: Only for split second before css is loaded
        backgroundColor: '#1c1e23',
        parent: mainWindow,
        title: `${WINDOW_TITLES[frameName]} • Allusion`,
        frame: true,
        titleBarStyle: 'default',
      },
    };
  });

  mainWindow.webContents.on('did-create-window', (childWindow) => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }

    childWindow.center(); // "center" in additionalOptions doesn't work :/
    childWindow.setMenu(null); // no toolbar needed

    if (IS_DEV) {
      childWindow.webContents.openDevTools();
    }

    mainWindow.webContents.once('will-navigate', () => {
      if (!childWindow.isDestroyed()) {
        childWindow.close(); // close when main window is reloaded
      }
    });
  });

  mainWindow.addListener('enter-full-screen', () => {
    if (mainWindow !== null) {
      MainMessenger.fullscreenChanged(mainWindow.webContents, true);
    }
  });

  mainWindow.addListener('leave-full-screen', () => {
    if (mainWindow !== null) {
      MainMessenger.fullscreenChanged(mainWindow.webContents, false);
    }
  });

  mainWindow.addListener('resize', saveWindowState);
  mainWindow.addListener('move', saveWindowState);
  mainWindow.addListener('unmaximize', saveWindowState);
  mainWindow.addListener('maximize', saveWindowState);

  let menu = null;

  // Mac App menu - used for styling so shortcuts work
  // https://livebook.manning.com/book/cross-platform-desktop-applications/chapter-9/78

  // Create our menu entries so that we can use MAC shortcuts
  const menuBar: Electron.MenuItemConstructorOptions[] = [];

  menuBar.push({
    label: 'Allusion',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services', submenu: [] },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => app.quit(),
      },
    ],
  });

  menuBar.push({
    label: 'Edit',
    submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
  });

  menuBar.push({
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CommandOrControl+R',
        click: forceRelaunch,
      },
      {
        label: 'Refresh',
        accelerator: 'F5',
        click: (_, win) => (win ? MainMessenger.f5Reload(win.webContents, true) : undefined),
      },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CommandOrControl+0',
        click: (_, browserWindow) => {
          if (browserWindow) {
            MainMessenger.setZoomFactor(browserWindow.webContents, 1);
          }
        },
      },
      {
        label: 'Zoom In',
        // TODO: Fix by using custom solution...
        accelerator: 'CommandOrControl+=',
        click: (_, browserWindow) => {
          if (browserWindow !== undefined) {
            MainMessenger.setZoomFactor(
              browserWindow.webContents,
              Math.min(browserWindow.webContents.zoomFactor + 0.1, MAX_ZOOM_FACTOR),
            );
          }
        },
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        click: (_, browserWindow) => {
          if (browserWindow !== undefined) {
            MainMessenger.setZoomFactor(
              browserWindow.webContents,
              Math.max(browserWindow.webContents.zoomFactor - 0.1, MIN_ZOOM_FACTOR),
            );
          }
        },
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  menu = Menu.buildFromTemplate(menuBar);

  Menu.setApplicationMenu(menu);

  // and load the index.html of the app.
  mainWindow.loadURL(`file://${__dirname}/index.html`);

  // then maximize the window if it was previously
  if (previousWindowState.isMaximized) {
    mainWindow.maximize();
  }

  // Open the DevTools if in dev mode.
  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
    if (previewWindow !== null && !previewWindow.isDestroyed()) {
      previewWindow.close();
    }
  });

  mainWindow.on('maximize', () => {
    if (mainWindow !== null) {
      MainMessenger.maximize(mainWindow.webContents);
    }
  });

  mainWindow.on('unmaximize', () => {
    if (mainWindow !== null) {
      MainMessenger.unmaximize(mainWindow.webContents);
    }
  });

  mainWindow.addListener(
    'focus',
    () => mainWindow !== null && MainMessenger.focus(mainWindow.webContents),
  );

  mainWindow.addListener(
    'blur',
    () => mainWindow !== null && MainMessenger.blur(mainWindow.webContents),
  );

  // System tray icon: Always show on Mac, or other platforms when the app is running in the background
  // Useful for browser extension, so it will work even when the window is closed
  if (IS_MAC || clipServer?.isRunInBackgroundEnabled()) {
    createTrayMenu();
  }

  // Import images that were added while the window was closed
  MainMessenger.onceInitialized().then(async () => {
    if (clipServer === null || mainWindow === null) {
      return;
    }
    const importItems = await clipServer.getImportQueue();
    await Promise.all(importItems.map(importExternalImage));
    clipServer.clearImportQueue();
  });
}
