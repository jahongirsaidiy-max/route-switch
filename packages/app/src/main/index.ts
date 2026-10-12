import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { PATHS } from '@routeswitch/shared';
import { app, BrowserWindow, protocol, session } from 'electron';

import { startApp } from './bootstrap';
import { createDevelopmentRuntime } from './development';
import { createHelperClient } from './helperClient';
import { createJsonLinesSink, createLogger } from './logger';

const logger = createLogger({ sink: createJsonLinesSink((line) => process.stderr.write(line)) });

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
  // The socket path is a constant of the product: never taken from the
  // environment, a config file or the renderer.
  helperClient: createHelperClient({
    socketPath: PATHS.socket,
    logger: logger.child({ component: 'helper-client' }),
  }),
});
