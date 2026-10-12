import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, protocol, session } from 'electron';

import { startApp } from './bootstrap';
import { createDevelopmentRuntime } from './development';
import { createStderrReport } from './report';

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
  report: createStderrReport((line) => process.stderr.write(line)),
});
