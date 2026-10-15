import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_RULES_BACKUP_FILE_BYTES, type Config } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyConfig, fakeScheduler, memoryLogger, oneRuleConfig } from './helperClient.fixtures';
import type { HelperSnapshot, HelperStatus } from './helperClient';
import {
  checkBackupDir,
  createRulesBackup,
  nodeBackupFileSystem,
  readRulesBackupFile,
  RULES_BACKUP_DEBOUNCE_MS,
  RULES_BACKUP_FILE_MODE,
  RULES_BACKUP_FILE_NAME,
  type BackupFileSystem,
} from './rulesBackup';

let dir: string;
let file: string;
const UID = process.getuid?.() ?? 501;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'routeswitch-backup-'));
  await chmod(dir, 0o700);
  file = path.join(dir, RULES_BACKUP_FILE_NAME);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const twoRuleConfig = (): Config => ({
  ...oneRuleConfig(),
  rules: [
    ...oneRuleConfig().rules,
    { id: '3a9d2c41-8e7f-4b6a-a5d0-1c2b3e4f5a6b', enabled: true, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', refreshSec: 900 },
  ],
});

/** A helper client that hands configs over by hand. */
function fakeClient() {
  const listeners = new Set<(config: Config) => void>();
  let status: HelperStatus = { kind: 'connected', helperVersion: '0.2.0' };
  let configRevision: number | null = 1;
  return {
    client: {
      onConfig: (listener: (config: Config) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: (): HelperSnapshot => ({ status, state: null, config: null, configRevision }),
    },
    deliver: (config: Config, revision = (configRevision ?? 0) + 1) => {
      configRevision = revision;
      for (const listener of [...listeners]) listener(config);
    },
    setStatus: (next: HelperStatus, revision: number | null = null) => {
      status = next;
      configRevision = revision;
    },
    listeners,
  };
}

function setup(options: { fs?: BackupFileSystem; uid?: number } = {}) {
  const scheduler = fakeScheduler();
  const { logger, entries } = memoryLogger(() => scheduler.now);
  const helper = fakeClient();
  let clock = Date.parse('2026-10-15T08:30:00.000Z');
  const backup = createRulesBackup({
    dir,
    uid: options.uid ?? UID,
    helperClient: helper.client,
    logger,
    fs: options.fs ?? nodeBackupFileSystem,
    now: () => clock,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  /** Runs the debounce and waits for the write. */
  const settle = async () => {
    scheduler.advance(RULES_BACKUP_DEBOUNCE_MS);
    await backup.flush();
  };
  return {
    backup,
    helper,
    scheduler,
    entries,
    settle,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8')) as unknown;

describe('writing: the last config the helper reported, debounced, private', () => {
  it('writes {version, savedAt, configRevision, config} 2 s after the last config, mode 0600, no temporary file left', async () => {
    const h = setup();
    h.helper.deliver(oneRuleConfig(), 4);
    h.scheduler.advance(RULES_BACKUP_DEBOUNCE_MS - 1);
    await Promise.resolve();
    expect(await readdir(dir)).toEqual([]);
    await h.settle();
    expect(await onDisk()).toEqual({ version: 1, savedAt: '2026-10-15T08:30:00.000Z', configRevision: 4, config: oneRuleConfig() });
    expect((await stat(file)).mode & 0o777).toBe(RULES_BACKUP_FILE_MODE);
    expect(await readdir(dir)).toEqual([RULES_BACKUP_FILE_NAME]);
    expect(await h.backup.read()).toMatchObject({ configRevision: 4, config: oneRuleConfig() });
    expect(h.entries.some((entry) => entry.msg === 'Rules backup written')).toBe(true);
  });

  it('a burst of configs is one write of the last one', async () => {
    const h = setup();
    h.helper.deliver(oneRuleConfig(), 2);
    h.scheduler.advance(1_000);
    h.helper.deliver(twoRuleConfig(), 3);
    h.scheduler.advance(1_500);
    expect(await readdir(dir)).toEqual([]);
    await h.settle();
    expect(await onDisk()).toMatchObject({ configRevision: 3, config: twoRuleConfig() });
  });

  it('a config without rules never replaces a backup that has some; it is logged', async () => {
    const h = setup();
    h.helper.deliver(twoRuleConfig(), 2);
    await h.settle();
    h.helper.deliver(emptyConfig(), 1);
    await h.settle();
    expect(await onDisk()).toMatchObject({ config: twoRuleConfig() });
    expect(h.entries.some((entry) => entry.msg === 'A config without rules does not replace the rules backup')).toBe(true);
  });

  it('an empty config is not written when there is no backup; an unchanged config is not written again', async () => {
    const h = setup();
    h.helper.deliver(emptyConfig(), 1);
    await h.settle();
    expect(await readdir(dir)).toEqual([]);
    h.helper.deliver(oneRuleConfig(), 2);
    await h.settle();
    const first = await readFile(file, 'utf8');
    h.tick(60_000);
    h.helper.deliver(oneRuleConfig(), 7);
    await h.settle();
    expect(await readFile(file, 'utf8')).toBe(first);
  });

  it('only while connected: a config of a helper that is not connected is not written', async () => {
    const h = setup();
    h.helper.setStatus({ kind: 'config-unreadable', helperVersion: '0.2.0' });
    for (const listener of h.helper.listeners) listener(oneRuleConfig());
    await h.settle();
    expect(await readdir(dir)).toEqual([]);
  });

  it('a directory of another user, or one others may write, is not written into (logged)', async () => {
    const other = setup({ uid: UID + 1 });
    other.helper.deliver(oneRuleConfig(), 2);
    await other.settle();
    expect(await readdir(dir)).toEqual([]);
    expect(other.entries.some((entry) => entry.level === 'error' && entry.msg === 'The rules backup was not written')).toBe(true);

    await chmod(dir, 0o777);
    const open = setup();
    open.helper.deliver(oneRuleConfig(), 2);
    await open.settle();
    await chmod(dir, 0o700);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a write that fails leaves the old backup and no temporary file; the failure is logged', async () => {
    const h = setup();
    h.helper.deliver(oneRuleConfig(), 2);
    await h.settle();
    const failing: BackupFileSystem = {
      ...nodeBackupFileSystem,
      rename: () => Promise.reject(Object.assign(new Error('no'), { code: 'EACCES' })),
    };
    const g = setup({ fs: failing });
    g.helper.deliver(twoRuleConfig(), 3);
    await g.settle();
    expect(await onDisk()).toMatchObject({ config: oneRuleConfig() });
    expect(await readdir(dir)).toEqual([RULES_BACKUP_FILE_NAME]);
    expect(g.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not write the rules backup')).toBe(true);
  });

  it('dispose stops listening and drops a pending write', async () => {
    const h = setup();
    h.helper.deliver(oneRuleConfig(), 2);
    h.backup.dispose();
    h.backup.dispose();
    await h.settle();
    expect(h.helper.listeners.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('reading: strict like an import, never throws', () => {
  const valid = () => ({ version: 1, savedAt: '2026-10-15T08:30:00.000Z', configRevision: 2, config: oneRuleConfig() });

  it('reads a valid backup; none without a file', async () => {
    expect(await setup().backup.read()).toBeNull();
    await writeFile(file, JSON.stringify(valid()));
    expect(await setup().backup.read()).toEqual(valid());
  });

  it.each<[string, string | Uint8Array]>([
    ['not JSON', '{'],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['another envelope version', JSON.stringify({ ...valid(), version: 2 })],
    ['a forbidden destination (ADR-001)', JSON.stringify({ ...valid(), config: { ...oneRuleConfig(), rules: [{ ...oneRuleConfig().rules[0], target: '0.0.0.0/0' }] } })],
    ['a /33', JSON.stringify({ ...valid(), config: { ...oneRuleConfig(), rules: [{ ...oneRuleConfig().rules[0], target: '10.0.0.0/33' }] } })],
    ['nested too deep', `${'['.repeat(200)}${']'.repeat(200)}`],
  ])('%s is no backup (logged)', async (_name, content) => {
    await writeFile(file, content);
    const h = setup();
    expect(await h.backup.read()).toBeNull();
    expect(h.entries.some((entry) => entry.level === 'warn' && entry.msg === 'The rules backup was ignored')).toBe(true);
  });

  it('a file over 1 MiB is refused', async () => {
    await writeFile(file, ' '.repeat(MAX_RULES_BACKUP_FILE_BYTES + 1));
    expect(await readRulesBackupFile(file)).toMatchObject({ kind: 'refused' });
  });

  it('a symbolic link is not followed; a directory in its place is refused', async () => {
    const target = path.join(dir, 'elsewhere.json');
    await writeFile(target, JSON.stringify(valid()));
    await symlink(target, file);
    expect(await readRulesBackupFile(file)).toMatchObject({ kind: 'refused' });
    await rm(file);
    await mkdir(file);
    expect(await readRulesBackupFile(file)).toMatchObject({ kind: 'refused' });
  });
});

describe('removal', () => {
  it('removes the file and forgets it; a missing file counts as removed; a pending write is dropped', async () => {
    const h = setup();
    h.helper.deliver(oneRuleConfig(), 2);
    await h.settle();
    h.helper.deliver(twoRuleConfig(), 3);
    expect(await h.backup.remove()).toBe(true);
    await h.settle();
    expect(await readdir(dir)).toEqual([]);
    expect(await h.backup.read()).toBeNull();
    expect(await h.backup.remove()).toBe(true);
  });

  it('a file that cannot be removed keeps the backup; logged', async () => {
    await writeFile(file, JSON.stringify({ version: 1, savedAt: '2026-10-15T08:30:00.000Z', configRevision: 2, config: oneRuleConfig() }));
    const h = setup({ fs: { ...nodeBackupFileSystem, unlink: () => Promise.reject(Object.assign(new Error('no'), { code: 'EPERM' })) } });
    expect(await h.backup.remove()).toBe(false);
    expect(await h.backup.read()).not.toBeNull();
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not remove the rules backup')).toBe(true);
  });
});

describe('checkBackupDir', () => {
  it('refuses a symbolic link and a missing directory', async () => {
    const link = path.join(dir, 'link');
    await symlink(dir, link);
    expect(await checkBackupDir(link, UID, nodeBackupFileSystem)).toMatchObject({ ok: false, why: 'not a directory' });
    expect(await checkBackupDir(path.join(dir, 'missing'), UID, nodeBackupFileSystem)).toMatchObject({ ok: false });
    expect(await checkBackupDir(dir, UID, nodeBackupFileSystem)).toEqual({ ok: true });
  });
});
