import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `tests/`: cross-package integration tests (app client <-> helper daemon) that the package boundaries keep out of `packages/`.
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // No test may reach the real resolver directory (TASK-111 QA): every fs call is checked first.
    setupFiles: ['packages/helper/src/test-fs-guard.ts'],
  },
});
