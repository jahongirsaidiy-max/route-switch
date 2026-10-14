import { vi } from 'vitest';

/**
 * Test-only (vitest `setupFiles`): no test may ever reach the real resolver
 * directory, whatever a test or a mutated module passes. Every function of
 * `node:fs/promises` and `node:fs` (and `node:fs`'s `promises`) is wrapped;
 * a call with any path argument inside `/etc/resolver` or
 * `/private/etc/resolver` (compared without regard to case, as APFS does) is
 * refused BEFORE the real call: rejected for a promise API, thrown otherwise,
 * with the code `FS_GUARD_CODE`. Both arguments of `rename`, `copyFile`,
 * `symlink`, `link` are checked, as is every other argument.
 *
 * Hits are counted on `globalThis` so a control test can see them.
 */

const guard = vi.hoisted(() => {
  const CODE = 'ETESTFSGUARD';
  const KEY = '__routeswitchFsGuardHits';
  const ROOTS = ['/etc/resolver', '/private/etc/resolver'];

  const textOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value instanceof URL) return value.protocol === 'file:' ? decodeURIComponent(value.pathname) : null;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return null;
  };

  /** `.` and `..` resolved, `//` collapsed, lower case; relative paths are resolved against the working directory. */
  const normalise = (path: string): string => {
    const absolute = path.startsWith('/') ? path : `${process.cwd()}/${path}`;
    const parts: string[] = [];
    for (const part of absolute.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return `/${parts.join('/')}`.toLowerCase();
  };

  const isGuarded = (value: unknown): boolean => {
    const text = textOf(value);
    if (text === null) return false;
    const path = normalise(text);
    return ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
  };

  const hit = (name: string, args: readonly unknown[]): Error => {
    const record = globalThis as unknown as Record<string, number | undefined>;
    record[KEY] = (record[KEY] ?? 0) + 1;
    const path = args.map(textOf).find((text) => text !== null && isGuarded(text)) ?? '?';
    return Object.assign(new Error(`${CODE}: a test tried ${name}() on ${path}`), { code: CODE });
  };

  /** Wraps every function of a module object; `promise` decides between rejecting and throwing. */
  const wrap = <T extends object>(module: T, promise: boolean): T => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'function') {
        wrapped[name] = value;
        continue;
      }
      const original = value as (...args: unknown[]) => unknown;
      const replacement = function (this: unknown, ...args: unknown[]): unknown {
        if (args.some(isGuarded)) {
          const error = hit(name, args);
          if (promise) return Promise.reject(error);
          throw error;
        }
        return original.apply(this, args);
      };
      // Classes and other properties hung on the function (e.g. `realpath.native`) keep working.
      Object.assign(replacement, original);
      replacement.prototype = (original as { prototype?: unknown }).prototype;
      wrapped[name] = replacement;
    }
    return wrapped as T;
  };

  return { CODE, KEY, wrap, isGuarded };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = guard.wrap(actual, true);
  return { ...wrapped, default: wrapped };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = guard.wrap(actual.promises, true);
  const wrapped = { ...guard.wrap(actual, false), promises };
  return { ...wrapped, default: wrapped };
});

/** The error code of a refused call. */
export const FS_GUARD_CODE = guard.CODE;

/** How many calls the guard refused so far in this test file's process. */
export const fsGuardHits = (): number =>
  (globalThis as unknown as Record<string, number | undefined>)[guard.KEY] ?? 0;

/** Exposed for the control test only. */
export const isGuardedPath = guard.isGuarded;
