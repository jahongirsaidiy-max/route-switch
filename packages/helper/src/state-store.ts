import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';

import { PATHS, PROTOCOL_LIMITS, LIMITS } from '@routeswitch/shared';

import type { AppliedRoute } from './engine';
import type { Logger } from './logger';

/**
 * `state.json`: the routes the helper has applied, so that a helper that
 * crashed (or was killed before its cleanup finished) can remove them when it
 * starts again.
 *
 *     {"version":1,"routes":[{"dst":"10.0.0.0/8","gateway":"192.0.2.1","ruleIds":["…"]}]}
 *
 * Written on every change of the applied set (`EngineDeps.onApplied`),
 * atomically: the content goes to a temporary file of our own in the same
 * directory (created exclusively, never following a link, mode 0644, synced)
 * which is then renamed over `state.json`. A reader therefore sees either the
 * old or the new file, never half of one. Writes are serialised; when several
 * are waiting only the newest is written.
 *
 * The file is read once, at start, and trusted for nothing but shape: every
 * entry is validated again by `Engine.restoreApplied`. A missing, unreadable,
 * oversized or malformed file is logged and read as "nothing applied"; it
 * never stops the helper. Resolver files are not listed: they are found by
 * their marker line (`ResolverFiles.removeAll`), which also finds those a
 * crash left behind before the state was written.
 *
 * Never rejects.
 */

export const STATE_VERSION = 1;
/** Every route the engine can hold: 500 rules with up to 33 destinations each. */
export const MAX_STATE_ROUTES = LIMITS.maxRules * PROTOCOL_LIMITS.maxAppliedDestinationsPerRule;
/** Far above the largest real file (≈ 2 MB with every route and rule id); anything larger is not read. */
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** The part of `node:fs/promises` this module uses; tests point it at a temporary directory or inject failures. */
export interface StateFs {
  readonly open: typeof nodeFs.open;
  readonly rename: typeof nodeFs.rename;
  readonly unlink: typeof nodeFs.unlink;
  readonly mkdir: (path: string, options: { readonly mode: number }) => Promise<unknown>;
}

const realFs: StateFs = {
  open: nodeFs.open,
  rename: nodeFs.rename,
  unlink: nodeFs.unlink,
  mkdir: (path, options) => nodeFs.mkdir(path, options),
};

export type StateLoadResult =
  /** `file`: read from disk; `none`: no file; `unusable`: there was one, but it could not be used (logged). */
  { readonly source: 'file' | 'none' | 'unusable'; readonly routes: readonly AppliedRoute[] };

export interface StateStore {
  /** Reads `state.json`. Never rejects; anything wrong gives no routes. */
  load(): Promise<StateLoadResult>;
  /** Writes the applied routes. Resolves with whether this content (or a newer one) reached the disk. Never rejects. */
  save(routes: readonly AppliedRoute[]): Promise<boolean>;
}

export interface StateStoreDeps {
  readonly logger: Logger;
  /** `PATHS.state` in the daemon; a file in a temporary directory in tests. Must be absolute. */
  readonly path?: string | undefined;
  readonly fs?: StateFs | undefined;
}

const errorCodeOf = (error: unknown): string => {
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

const dirOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));

/**
 * The routes of a decoded `state.json`, or `null` when its shape is wrong.
 * Only the shape is checked here; `restoreApplied` validates every value.
 */
export const parseState = (value: unknown): AppliedRoute[] | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { version, routes } = value as { version?: unknown; routes?: unknown };
  if (version !== STATE_VERSION || !Array.isArray(routes) || routes.length > MAX_STATE_ROUTES) return null;
  const result: AppliedRoute[] = [];
  for (const entry of routes as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { dst, gateway, ruleIds } = entry as { dst?: unknown; gateway?: unknown; ruleIds?: unknown };
    if (typeof dst !== 'string' || typeof gateway !== 'string') return null;
    const ids = Array.isArray(ruleIds) ? (ruleIds as unknown[]).filter((id): id is string => typeof id === 'string') : [];
    result.push({ dst, gateway, ruleIds: ids });
  }
  return result;
};

export const serializeState = (routes: readonly AppliedRoute[]): string =>
  `${JSON.stringify({
    version: STATE_VERSION,
    routes: routes.map(({ dst, gateway, ruleIds }) => ({ dst, gateway, ruleIds: [...ruleIds] })),
  })}\n`;

export const createStateStore = (deps: StateStoreDeps): StateStore => {
  const fs = deps.fs ?? realFs;
  const path = deps.path ?? PATHS.state;
  const dir = dirOf(path);
  const tempPath = `${dir}/.state.json.routeswitch.tmp`;
  const logger = deps.logger.child({ component: 'state' });

  const read = async (): Promise<{ kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'unusable'; why: string }> => {
    let handle: nodeFs.FileHandle;
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = errorCodeOf(error);
      return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unusable', why: code };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { kind: 'unusable', why: 'not a regular file' };
      if (stats.size > MAX_STATE_BYTES) return { kind: 'unusable', why: 'too large' };
      const text = await handle.readFile({ encoding: 'utf8' });
      return Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES ? { kind: 'unusable', why: 'too large' } : { kind: 'text', text };
    } catch (error) {
      return { kind: 'unusable', why: errorCodeOf(error) };
    } finally {
      await handle.close().catch((error: unknown) => {
        logger.warn('state file could not be closed', { path, error: errorCodeOf(error) });
      });
    }
  };

  const load = async (): Promise<StateLoadResult> => {
    try {
      const file = await read();
      if (file.kind === 'missing') {
        logger.info('no state file; nothing left over to clean up', { path });
        return { source: 'none', routes: [] };
      }
      if (file.kind === 'unusable') {
        logger.error('state file could not be read; starting without it', { path, error: file.why });
        return { source: 'unusable', routes: [] };
      }
      let value: unknown;
      try {
        value = JSON.parse(file.text);
      } catch {
        // The parser's message quotes the input, so it is not passed on.
        logger.error('state file is not valid JSON; starting without it', { path });
        return { source: 'unusable', routes: [] };
      }
      const routes = parseState(value);
      if (routes === null) {
        logger.error('state file has an unexpected shape; starting without it', { path });
        return { source: 'unusable', routes: [] };
      }
      logger.info('state file read', { path, routes: routes.length });
      return { source: 'file', routes };
    } catch (error) {
      logger.error('state file could not be read; starting without it', { path, error: errorCodeOf(error) });
      return { source: 'unusable', routes: [] };
    }
  };

  const writeTemp = async (content: string): Promise<void> => {
    // A temporary file left by a crash is ours by name: remove it first, it never holds anything we need.
    await fs.unlink(tempPath).catch((error: unknown) => {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    });
    const handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      // The mode given to open is reduced by the umask; the file must be readable as documented.
      await handle.chmod(FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const write = async (routes: readonly AppliedRoute[]): Promise<boolean> => {
    const content = serializeState(routes);
    try {
      try {
        await writeTemp(content);
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
        // The directory is missing (normally the install script creates it): create it, once, and retry.
        await fs.mkdir(dir, { mode: DIR_MODE });
        logger.warn('state directory was missing and has been created', { dir });
        await writeTemp(content);
      }
      await fs.rename(tempPath, path);
      logger.debug('state file written', { path, routes: routes.length, bytes: Buffer.byteLength(content, 'utf8') });
      return true;
    } catch (error) {
      logger.error('state file could not be written; a crash now may leave routes behind', {
        path,
        routes: routes.length,
        error: errorCodeOf(error),
      });
      // Best effort: the failure is logged above, and a leftover temporary file is removed before the next write.
      await fs.unlink(tempPath).catch(() => undefined);
      return false;
    }
  };

  /** One write at a time; while one runs, only the newest waiting content is kept. */
  let writing: Promise<void> | null = null;
  let waiting: { routes: readonly AppliedRoute[]; settle: ((ok: boolean) => void)[] } | null = null;

  const drain = async (): Promise<void> => {
    while (waiting !== null) {
      const job = waiting;
      waiting = null;
      const ok = await write(job.routes);
      for (const settle of job.settle) settle(ok);
    }
    writing = null;
  };

  const save = (routes: readonly AppliedRoute[]): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      // Copied now: the caller may change its array later.
      const snapshot = routes.map(({ dst, gateway, ruleIds }) => ({ dst, gateway, ruleIds: [...ruleIds] }));
      if (waiting === null) waiting = { routes: snapshot, settle: [resolve] };
      else {
        waiting.routes = snapshot;
        waiting.settle.push(resolve);
      }
      writing ??= drain();
    });

  return { load, save };
};
