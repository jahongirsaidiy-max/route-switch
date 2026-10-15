import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { PATHS } from '@routeswitch/shared';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, Tray } from 'electron';

import trayActive1x from '../../resources/tray/trayActiveTemplate.png?asset';
import trayActive2x from '../../resources/tray/trayActiveTemplate@2x.png?asset';
import trayError1x from '../../resources/tray/trayErrorTemplate.png?asset';
import trayError2x from '../../resources/tray/trayErrorTemplate@2x.png?asset';
import trayOff1x from '../../resources/tray/trayOffTemplate.png?asset';
import trayOff2x from '../../resources/tray/trayOffTemplate@2x.png?asset';
import { startApp } from './bootstrap';
import { createDevelopmentRuntime } from './development';
import { createHelperClient } from './helperClient';
import { createInstaller, HELPER_RESOURCES_DIR, runWithExecFile } from './installer';
import { createJsonLinesSink, createLogger } from './logger';
import { createPreferences } from './preferences';
import { createSettings, listServiceOrderWithNetworksetup } from './settings';
import { loadTrayImage, startShell } from './tray';

const logger = createLogger({ sink: createJsonLinesSink((line) => process.stderr.write(line)) });

// The socket path is a constant of the product: never taken from the
// environment, a config file or the renderer.
const helperClient = createHelperClient({
  socketPath: PATHS.socket,
  logger: logger.child({ component: 'helper-client' }),
});

startApp({
  app,
  BrowserWindow,
  protocol,
  getDefaultSession: () => session.defaultSession,
  platform: process.platform,
  // A build-time constant: `electron-vite build` turns this into `null` and
  // drops `development.ts` from the bundle.
  development: import.meta.env.DEV ? createDevelopmentRuntime : null,
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  preloadPath: path.join(import.meta.dirname, '../preload/index.cjs'),
  rendererRoot: path.join(import.meta.dirname, '../renderer'),
  readFile,
  realpath,
  logger,
  helperClient,
  startShell: (context) => {
    // Bundled next to the main process by electron-vite (`?asset`), so the
    // paths hold in development and inside the packaged app alike.
    const imageDeps = { createEmpty: () => nativeImage.createEmpty(), readFile: (file: string) => readFileSync(file) };
    return startShell(
      {
        createTray: (image) => new Tray(image),
        images: {
          active: loadTrayImage(imageDeps, { x1: trayActive1x, x2: trayActive2x }),
          off: loadTrayImage(imageDeps, { x1: trayOff1x, x2: trayOff2x }),
          error: loadTrayImage(imageDeps, { x1: trayError1x, x2: trayError2x }),
        },
        buildMenu: (template) => Menu.buildFromTemplate(template),
        ipcMain,
        helperClient,
        workAreaAt: (point) => screen.getDisplayNearestPoint(point).workArea,
        activateApp: () => {
          app.focus({ steal: true });
        },
        quit: () => {
          app.quit();
        },
        // Per user, in the app's own data directory; read on the first `getLanguage`.
        preferences: createPreferences({
          dir: app.getPath('userData'),
          preferredLanguages: () => app.getPreferredSystemLanguages(),
          logger,
        }),
        settings: createSettings({
          loginItem: {
            get: () => app.getLoginItemSettings().openAtLogin,
            set: (openAtLogin) => {
              app.setLoginItemSettings({ openAtLogin });
            },
          },
          listServiceOrder: listServiceOrderWithNetworksetup,
          writeClipboard: (text) => clipboard.writeText(text),
          logger,
        }),
        // Config import / export: the only way a file path enters the app is the
        // user's choice in these system dialogs, attached to the focused window.
        configDialogs: {
          chooseImportFile: async () => {
            const options: Electron.OpenDialogOptions = {
              title: 'Config import',
              properties: ['openFile'],
              filters: [{ name: 'JSON', extensions: ['json'] }],
            };
            const parent = BrowserWindow.getFocusedWindow();
            const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
            return result.canceled ? null : (result.filePaths[0] ?? null);
          },
          chooseExportFile: async () => {
            const options: Electron.SaveDialogOptions = {
              title: 'Config export',
              defaultPath: path.join(app.getPath('documents'), 'routeswitch-config.json'),
              filters: [{ name: 'JSON', extensions: ['json'] }],
              properties: ['createDirectory', 'showOverwriteConfirmation'],
            };
            const parent = BrowserWindow.getFocusedWindow();
            const result = parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
            return result.canceled || result.filePath === '' ? null : result.filePath;
          },
        },
        // The helper package ships inside the packaged app only (`extraResources`, TASK-301).
        installer: createInstaller({
          resourcesDir: app.isPackaged ? path.join(process.resourcesPath, HELPER_RESOURCES_DIR) : null,
          uid: process.getuid?.() ?? -1,
          run: runWithExecFile,
          logger,
        }),
        logger,
      },
      context,
    );
  },
});
