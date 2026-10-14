import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import { FS_GUARD_MARK } from './test-fs-guard-core';

/**
 * Test-only. Throws unless the file-system guard of `test-fs-guard.ts` is in
 * force for THIS module graph: it looks at the very `node:fs` and
 * `node:fs/promises` objects that the code under test imports (one module
 * cache), not at a flag, so a guard that was registered too late, or not at
 * all (vitest started without a config naming the setup file), is noticed
 * before a test makes its first file-system call. Every test file that
 * touches the file system calls it at load.
 */

const guarded = (fn: unknown): boolean =>
  typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[FS_GUARD_MARK] === true;

export const fsGuardActive = (): boolean =>
  [fsPromises.open, fsPromises.readdir, fsPromises.lstat, fsPromises.unlink, fs.readdirSync, fs.writeFileSync, fs.promises.open].every(
    guarded,
  );

export const assertFsGuardInstalled = (): void => {
  if (!fsGuardActive()) {
    throw new Error(
      'The test file-system guard is not in force: run vitest with the root or the package config (setupFiles: test-fs-guard.ts)',
    );
  }
};
