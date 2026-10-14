// Main entry of the packaged app (electron-builder `extraMetadata.main`): refuses command-line
// arguments (argv-guard.mjs), then starts the app (`out/main/index.js`, built by electron-vite).
// It runs before any app code; the check is synchronous, before the first await.
import process from 'node:process';

import { app } from 'electron';

import { forbiddenArguments } from './argv-guard.mjs';

const forbidden = forbiddenArguments(process.argv);
if (forbidden.length > 0) {
  process.stderr.write(`RouteSwitch: refusing to start with command-line arguments (${forbidden.join(', ')})\n`);
  app.exit(2);
} else {
  await import('./main/index.js');
}
