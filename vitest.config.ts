import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    // No test may reach the real resolver directory (TASK-111 QA): every fs call is checked first.
    setupFiles: ['packages/helper/src/test-fs-guard.ts'],
  },
});
