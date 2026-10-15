/**
 * Test-only: the logic of the file-system guard, free of `node:fs` and of
 * `vitest`, so that the setup file (`test-fs-guard.ts`, which registers the
 * mocks) is the only module that ever calls `vi.mock` for the file system.
 * Test files import this module and `test-fs-guard-check.ts`, never the setup
 * file itself: importing that from a test would register the mocks at run
 * time, too late for some modules and in time for others.
 */

export const FS_GUARD_CODE = 'ETESTFSGUARD';
/** Marks every wrapped function; `test-fs-guard-check.ts` looks for it. */
export const FS_GUARD_MARK = Symbol.for('routeswitch.fs-guard');
const KEY = '__routeswitchFsGuardHits';
const INSTALLED = '__routeswitchFsGuardInstalled';
/**
 * Lower case (paths are compared case-insensitively, like the default macOS volume). The resolver
 * directory, `PATHS.supportDir` (config.json, state.json), and every file the install script puts
 * on the system (TASK-115: binary, plist, log directory, newsyslog file) — a test must never read
 * or write the daemon's real files there. `/etc` is also reached as `/private/etc`.
 */
export const FS_GUARD_ROOTS: readonly string[] = [
  '/etc/resolver',
  '/private/etc/resolver',
  '/library/application support/routeswitch',
  '/library/privilegedhelpertools/com.routeswitch.helper',
  '/library/launchdaemons/com.routeswitch.helper.plist',
  '/library/logs/routeswitch',
  '/etc/newsyslog.d/com.routeswitch.helper.conf',
  '/private/etc/newsyslog.d/com.routeswitch.helper.conf',
];
const ROOTS = FS_GUARD_ROOTS;
const CODE = FS_GUARD_CODE;

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

export const isGuardedPath = (value: unknown): boolean => {
  const text = textOf(value);
  if (text === null) return false;
  const path = normalise(text);
  return ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
};

const hit = (name: string, args: readonly unknown[]): Error => {
  const record = globalThis as unknown as Record<string, number | undefined>;
  record[KEY] = (record[KEY] ?? 0) + 1;
  const path = args.map(textOf).find((text) => text !== null && isGuardedPath(text)) ?? '?';
  return Object.assign(new Error(`${CODE}: a test tried ${name}() on ${path}`), { code: CODE });
};

/** Wraps every function of a module object; `promise` decides between rejecting and throwing. */
export const wrapFsModule = <T extends object>(module: T, promise: boolean): T => {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    const original = value as (...args: unknown[]) => unknown;
    const replacement = function (this: unknown, ...args: unknown[]): unknown {
      if (args.some(isGuardedPath)) {
        const error = hit(name, args);
        if (promise) return Promise.reject(error);
        throw error;
      }
      return original.apply(this, args);
    };
    // Classes and other properties hung on the function (e.g. `realpath.native`) keep working.
    Object.assign(replacement, original);
    // What `assertFsGuardInstalled` looks for on the module a test really got.
    Object.defineProperty(replacement, FS_GUARD_MARK, { value: true });
    replacement.prototype = (original as { prototype?: unknown }).prototype;
    wrapped[name] = replacement;
  }
  return wrapped as T;
};

/** Set by the mock factories when they run. */
export const markFsGuardInstalled = (): void => {
  (globalThis as unknown as Record<string, boolean | undefined>)[INSTALLED] = true;
};


/** How many calls the guard refused so far in this test file's process. */
export const fsGuardHits = (): number => (globalThis as unknown as Record<string, number | undefined>)[KEY] ?? 0;

/** The mock factories ran in this process (see `test-fs-guard-check.ts` for the check that matters). */
export const fsGuardInstalled = (): boolean =>
  (globalThis as unknown as Record<string, boolean | undefined>)[INSTALLED] === true;
