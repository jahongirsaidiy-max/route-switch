import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PATHS } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppliedRoute } from './engine';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import { MAX_STATE_BYTES, MAX_STATE_ROUTES, STATE_VERSION, createStateStore, parseState, serializeState, type StateFs } from './state-store';
import { assertFsGuardInstalled } from './test-fs-guard-check';

// Touches the file system: refuse to run at all without the guard of the test setup.
assertFsGuardInstalled();

// Every test works in a fresh temporary directory; the real `PATHS.state` is never named as a path to write.

const ROUTES: AppliedRoute[] = [
  { dst: '10.0.0.0/8', gateway: '10.20.4.1', ruleIds: ['00000000-0000-4000-8000-000000000001'] },
  { dst: '172.16.12.40', gateway: '192.168.1.1', ruleIds: [] },
];

let root = '';
let path = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'routeswitch-state-test-'));
  path = join(root, 'state.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = (options: { fs?: StateFs; path?: string } = {}) => {
  const memory = createMemorySink();
  const store = createStateStore({ logger: createLogger({ sinks: [memory.sink] }), path: options.path ?? path, fs: options.fs });
  const logs = (level: LogEntry['level']): LogEntry[] => memory.entries.filter((entry) => entry.level === level);
  return { store, entries: memory.entries, logs };
};

describe('state.json: save', () => {
  it('writes the routes as versioned JSON, 0644 even under a strict umask, and leaves no temporary file', async () => {
    const { store } = setup();
    // 077 would leave a file created with 0644 at 0600: only the explicit chmod gives 0644.
    const previous = process.umask(0o077);
    try {
      expect(await store.save(ROUTES)).toBe(true);
    } finally {
      process.umask(previous);
    }

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: STATE_VERSION, routes: ROUTES });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(await readdir(root)).toEqual(['state.json']);
  });

  it('replaces the file by rename: a reader never sees a half-written one', async () => {
    const { store } = setup();
    await store.save(ROUTES);
    const before = (await stat(path)).ino;
    await store.save([]);
    // A new inode: the old file was replaced, not rewritten in place.
    expect((await stat(path)).ino).not.toBe(before);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: STATE_VERSION, routes: [] });
  });

  it('writes in order and only the newest of the saves that wait', async () => {
    const opened: string[] = [];
    const fs: StateFs = {
      ...nodeFs,
      mkdir: (dir, options) => nodeFs.mkdir(dir, options),
      open: (...args: Parameters<typeof nodeFs.open>) => {
        opened.push(String(args[0]));
        return nodeFs.open(...args);
      },
    };
    const { store } = setup({ fs });
    const results = await Promise.all([store.save(ROUTES), store.save([]), store.save(ROUTES.slice(0, 1))]);
    expect(results).toEqual([true, true, true]);
    // The first write, then one for the two that waited.
    expect(opened).toHaveLength(2);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: STATE_VERSION, routes: ROUTES.slice(0, 1) });
  });

  it('copies the routes when called: a later change of the caller is not written', async () => {
    const { store } = setup();
    const routes = ROUTES.map((route) => ({ ...route, ruleIds: [...route.ruleIds] }));
    const saving = store.save(routes);
    routes.length = 0;
    await saving;
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: STATE_VERSION, routes: ROUTES });
  });

  it('creates a missing directory (0755) and writes', async () => {
    const nested = join(root, 'RouteSwitch', 'state.json');
    const { store, logs } = setup({ path: nested });
    expect(await store.save(ROUTES)).toBe(true);
    expect((await stat(join(root, 'RouteSwitch'))).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await readFile(nested, 'utf8'))).toMatchObject({ routes: ROUTES });
    expect(logs('warn').map((entry) => entry.msg)).toEqual(['state directory was missing and has been created']);
  });

  it('removes a temporary file left by a crash first', async () => {
    await writeFile(join(root, '.state.json.routeswitch.tmp'), '{"version":1,"rou');
    const { store } = setup();
    expect(await store.save(ROUTES)).toBe(true);
    expect(await readdir(root)).toEqual(['state.json']);
  });

  it('does not follow a symlink at the temporary name', async () => {
    const target = join(root, 'elsewhere');
    await writeFile(target, 'untouched');
    // The leftover is removed (the link itself, not its target), then the file is created exclusively.
    await symlink(target, join(root, '.state.json.routeswitch.tmp'));
    const { store } = setup();
    expect(await store.save(ROUTES)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });

  it('reports a failed write with false and an error, never a rejection, and cleans up the temporary file', async () => {
    const fs: StateFs = {
      ...nodeFs,
      mkdir: (dir, options) => nodeFs.mkdir(dir, options),
      rename: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })),
    };
    const { store, logs } = setup({ fs });
    expect(await store.save(ROUTES)).toBe(false);
    expect(logs('error')[0]?.context).toMatchObject({ error: 'ENOSPC', routes: 2 });
    expect(await readdir(root)).toEqual([]);
    // The next save works again.
    const ok = createStateStore({ logger: createLogger({ sinks: [] }), path });
    expect(await ok.save(ROUTES)).toBe(true);
  });

  it('defaults to PATHS.state', () => {
    // Only the default is checked; nothing is written there.
    expect(PATHS.state).toBe('/Library/Application Support/RouteSwitch/state.json');
  });
});

describe('state.json: load', () => {
  it('reads back what was saved', async () => {
    const { store } = setup();
    await store.save(ROUTES);
    expect(await store.load()).toEqual({ source: 'file', routes: ROUTES });
  });

  it('reads a missing file as nothing applied, at info', async () => {
    const { store, logs } = setup();
    expect(await store.load()).toEqual({ source: 'none', routes: [] });
    expect(logs('error')).toEqual([]);
  });

  it.each([
    ['not JSON', '{"version":1,"routes":[', 'state file is not valid JSON; starting without it'],
    ['another version', '{"version":2,"routes":[]}', 'state file has an unexpected shape; starting without it'],
    ['no routes', '{"version":1}', 'state file has an unexpected shape; starting without it'],
    ['a route without a gateway', '{"version":1,"routes":[{"dst":"10.0.0.0/8"}]}', 'state file has an unexpected shape; starting without it'],
    ['an array', '[]', 'state file has an unexpected shape; starting without it'],
    ['empty', '', 'state file is not valid JSON; starting without it'],
  ])('reads a file that is %s as nothing applied and logs an error', async (_name, content, msg) => {
    await writeFile(path, content);
    const { store, logs } = setup();
    expect(await store.load()).toEqual({ source: 'unusable', routes: [] });
    expect(logs('error').map((entry) => entry.msg)).toEqual([msg]);
    // The content is never logged.
    expect(JSON.stringify(logs('error'))).not.toContain('10.0.0.0');
  });

  it('refuses a file larger than the limit without reading it', async () => {
    await writeFile(path, ' '.repeat(MAX_STATE_BYTES + 1));
    const { store, logs } = setup();
    expect(await store.load()).toEqual({ source: 'unusable', routes: [] });
    expect(logs('error')[0]?.context).toMatchObject({ error: 'too large' });
  });

  it('refuses a directory and a symlink', async () => {
    await mkdir(path);
    expect(await setup().store.load()).toEqual({ source: 'unusable', routes: [] });
    await rm(path, { recursive: true });
    const target = join(root, 'target.json');
    await writeFile(target, serializeState(ROUTES));
    await symlink(target, path);
    expect(await setup().store.load()).toEqual({ source: 'unusable', routes: [] });
  });

  it('never rejects when the file system throws', async () => {
    const fs: StateFs = { ...nodeFs, mkdir: (dir, options) => nodeFs.mkdir(dir, options), open: () => { throw new Error('boom'); } };
    expect(await setup({ fs }).store.load()).toEqual({ source: 'unusable', routes: [] });
  });
});

describe('parseState', () => {
  it('keeps only string rule ids and passes values on unvalidated (the engine validates them)', () => {
    expect(parseState({ version: 1, routes: [{ dst: 'junk', gateway: 'x', ruleIds: ['a', 7, null] }] })).toEqual([
      { dst: 'junk', gateway: 'x', ruleIds: ['a'] },
    ]);
    expect(parseState({ version: 1, routes: [{ dst: '10.0.0.0/8', gateway: '10.20.4.1' }] })).toEqual([
      { dst: '10.0.0.0/8', gateway: '10.20.4.1', ruleIds: [] },
    ]);
  });

  it(`refuses more than ${String(MAX_STATE_ROUTES)} routes`, () => {
    const route = { dst: '10.0.0.0/8', gateway: '10.20.4.1', ruleIds: [] };
    expect(parseState({ version: 1, routes: Array.from({ length: MAX_STATE_ROUTES }, () => route) })).toHaveLength(MAX_STATE_ROUTES);
    expect(parseState({ version: 1, routes: Array.from({ length: MAX_STATE_ROUTES + 1 }, () => route) })).toBeNull();
  });
});
