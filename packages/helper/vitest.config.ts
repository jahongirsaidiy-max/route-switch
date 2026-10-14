import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Used when vitest runs from this directory. It loads the same file-system guard as the root
// config, so no test can reach the real resolver directory whichever way the suite is started.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: [fileURLToPath(new URL('./src/test-fs-guard.ts', import.meta.url))],
  },
});
