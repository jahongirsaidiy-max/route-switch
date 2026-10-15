import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

import { productionCspMetaTag } from './src/main/csp';

// Writes the production policy into the built index.html. The app:// handler
// sends the same policy as a response header; the <meta> copy keeps the page
// restricted even if the file is ever opened some other way. The dev server
// never gets it — in development the main process adds the development policy
// as a header instead.
const productionCspMeta = (): Plugin => ({
  name: 'routeswitch:production-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ ...productionCspMetaTag(), injectTo: 'head-prepend' }],
});

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // A sandboxed preload cannot be an ES module.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), productionCspMeta()],
    build: { sourcemap: false },
  },
});
