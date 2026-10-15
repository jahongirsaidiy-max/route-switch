import { vi } from 'vitest';

import type * as FsGuardCore from './test-fs-guard-core';

/**
 * Test-only (vitest `setupFiles`, root and package config): no test may ever reach the real resolver
 * directory, whatever a test or a mutated module passes. Every function of
 * `node:fs/promises` and `node:fs` (and `node:fs`'s `promises`) is wrapped;
 * a call with any path argument inside `/etc/resolver` or
 * `/private/etc/resolver` (compared without regard to case, as APFS does) is
 * refused BEFORE the real call: rejected for a promise API, thrown otherwise,
 * with the code `FS_GUARD_CODE`. Both arguments of `rename`, `copyFile`,
 * `symlink`, `link` are checked, as is every other argument.
 *
 * Hits are counted on `globalThis` so a control test can see them. The
 * logic is in `test-fs-guard-core.ts`; tests import that and
 * `test-fs-guard-check.ts`, never this file.
 */

// The core is loaded inside the factories: a top-level import would be hoisted below `vi.mock`.
const loadCore = (): Promise<typeof FsGuardCore> => import('./test-fs-guard-core');

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const core = await loadCore();
  core.markFsGuardInstalled();
  const wrapped = core.wrapFsModule(actual, true);
  return { ...wrapped, default: wrapped };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const core = await loadCore();
  core.markFsGuardInstalled();
  const promises = core.wrapFsModule(actual.promises, true);
  const wrapped = { ...core.wrapFsModule(actual, false), promises };
  return { ...wrapped, default: wrapped };
});
