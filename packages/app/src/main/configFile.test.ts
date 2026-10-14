// Real files, only ever under a fresh directory of `os.tmpdir()`.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Config } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configFileText,
  issueOf,
  MAX_CONFIG_FILE_BYTES,
  nodeConfigFileSystem,
  readConfigFile,
  writeConfigFile,
  type ConfigFileSystem,
} from './configFile';

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG: Config = {
  version: 1,
  enabled: true,
  rules: [{ id: RULE_ID, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: true, refreshSec: 600, note: 'Ichki tarmoq' }],
};

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'routeswitch-config-file-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileWith = async (content: string | Uint8Array, name = 'config.json') => {
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
};

describe('readConfigFile', () => {
  it('reads a valid file and returns the config as the shared schema parsed it (normalised, defaults)', async () => {
    const file = await fileWith(
      JSON.stringify({ version: 1, rules: [{ id: RULE_ID, kind: 'subnet', target: '10.1.2.3/8', iface: 'ethernet' }], extra: 'dropped' }),
    );
    const result = await readConfigFile(file);
    expect(result).toMatchObject({ ok: true, config: { version: 1, enabled: true, rules: [{ target: '10.0.0.0/8', enabled: true, refreshSec: 600 }] } });
    expect(result.ok && 'extra' in result.config).toBe(false);
  });

  it('accepts a UTF-8 BOM and an exported file as it is', async () => {
    expect((await readConfigFile(await fileWith(`\uFEFF${configFileText(CONFIG)}`))).ok).toBe(true);
  });

  it.each([
    ['broken JSON', '{"version": 1, "rules": [', 'file-not-json'],
    ['empty file', '', 'file-not-json'],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'file-not-text'],
  ] as const)('refuses %s', async (_name, content, code) => {
    expect(await readConfigFile(await fileWith(content))).toMatchObject({ ok: false, code });
  });

  it.each([
    ['an older or newer version', { version: 2, rules: [] }, ['version'], 'invalid_value'],
    ['the default route', { version: 1, rules: [{ id: RULE_ID, kind: 'subnet', target: '0.0.0.0/0', iface: 'wifi' }] }, ['rules', 0, 'target'], 'default-route'],
    ['a /33 subnet', { version: 1, rules: [{ id: RULE_ID, kind: 'subnet', target: '10.0.0.0/33', iface: 'wifi' }] }, ['rules', 0, 'target'], 'invalid-prefix'],
    ['a path-like domain', { version: 1, rules: [{ id: RULE_ID, kind: 'domain', target: '../etc', iface: 'wifi' }] }, ['rules', 0, 'target'], 'invalid-domain'],
    ['a /7 subnet (ADR-001)', { version: 1, rules: [{ id: RULE_ID, kind: 'subnet', target: '10.0.0.0/7', iface: 'wifi' }] }, ['rules', 0, 'target'], 'prefix-too-wide'],
    [
      'one target on two interfaces',
      {
        version: 1,
        rules: [
          { id: RULE_ID, kind: 'ip', target: '10.1.1.1', iface: 'wifi' },
          { id: '22222222-2222-4222-8222-222222222222', kind: 'subnet', target: '10.1.1.1/32', iface: 'ethernet' },
        ],
      },
      ['rules', 1, 'target'],
      'iface-conflict',
    ],
    ['a refresh under 60 s', { version: 1, rules: [{ id: RULE_ID, kind: 'domain', target: 'corp.local', iface: 'wifi', refreshSec: 59 }] }, ['rules', 0, 'refreshSec'], 'too_small'],
    ['a JSON array', [], [], 'invalid_type'],
  ])('refuses %s with the first issue, as data', async (_name, value, issuePath, code) => {
    const result = await readConfigFile(await fileWith(JSON.stringify(value)));
    expect(result).toMatchObject({ ok: false, code: 'invalid-config', issue: { path: issuePath, code } });
  });

  it('refuses more than 500 rules', async () => {
    const rules = Array.from({ length: 501 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      kind: 'ip',
      target: `10.1.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
      iface: 'wifi',
    }));
    // 501 elements is over the structure walk's array limit, which runs before zod.
    expect(await readConfigFile(await fileWith(JSON.stringify({ version: 1, rules })))).toMatchObject({
      ok: false,
      code: 'invalid-config',
      issue: { path: [], code: 'array-too-long' },
    });
  });

  it('refuses a file over the size limit without parsing it', async () => {
    const file = await fileWith(`{"version":1,"rules":[],"pad":"${'x'.repeat(MAX_CONFIG_FILE_BYTES)}"}`);
    expect(await readConfigFile(file)).toMatchObject({ ok: false, code: 'file-too-large' });
  });

  it('refuses a file that grows past the limit while it is read', async () => {
    const fs: ConfigFileSystem = {
      ...nodeConfigFileSystem,
      open: () =>
        Promise.resolve({
          stat: () => Promise.resolve({ isFile: () => true, size: 10 }),
          read: (buffer: Uint8Array, offset: number, length: number) => {
            buffer.fill(0x20, offset, offset + length);
            return Promise.resolve({ bytesRead: length });
          },
          writeFile: () => Promise.reject(new Error('unused')),
          sync: () => Promise.reject(new Error('unused')),
          close: () => Promise.resolve(),
        }),
    };
    expect(await readConfigFile('/irrelevant.json', fs)).toMatchObject({ ok: false, code: 'file-too-large' });
  });

  it('refuses a directory, a missing file and an unreadable one', async () => {
    const folder = path.join(dir, 'folder.json');
    await mkdir(folder);
    expect(await readConfigFile(folder)).toMatchObject({ ok: false, code: 'file-not-regular' });
    expect(await readConfigFile(path.join(dir, 'missing.json'))).toMatchObject({ ok: false, code: 'file-unreadable' });
    const failing: ConfigFileSystem = { ...nodeConfigFileSystem, open: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) };
    expect(await readConfigFile('/x.json', failing)).toMatchObject({ ok: false, code: 'file-unreadable' });
  });

  it('follows a symlink the user chose to its regular file', async () => {
    const target = await fileWith(configFileText(CONFIG), 'real.json');
    const link = path.join(dir, 'link.json');
    await symlink(target, link);
    expect((await readConfigFile(link)).ok).toBe(true);
  });
});

describe('issueOf', () => {
  it('keeps indexes and schema field names only, and codes of a safe shape', () => {
    expect(issueOf({ code: 'custom', path: ['rules', 3, 'target'], params: { code: 'loopback' } })).toEqual({ path: ['rules', 3, 'target'], code: 'loopback' });
    expect(issueOf({ code: 'invalid_key', path: ['ifaceOverrides', '<script>'] })).toEqual({ path: ['ifaceOverrides', '?'], code: 'invalid_key' });
    expect(issueOf({ code: 'custom', path: [], params: { code: 'Not A Code!' } })).toEqual({ path: [], code: 'custom' });
    expect(issueOf({ code: 'X', path: Array.from({ length: 20 }, () => 0) })).toEqual({ path: Array.from({ length: 8 }, () => 0), code: null });
  });
});

describe('writeConfigFile', () => {
  it('writes the config as indented JSON that reads back the same', async () => {
    const file = path.join(dir, 'export.json');
    const result = await writeConfigFile(file, CONFIG);
    expect(result).toEqual({ ok: true, bytes: Buffer.byteLength(configFileText(CONFIG)) });
    expect(await readFile(file, 'utf8')).toBe(configFileText(CONFIG));
    expect(await readConfigFile(file)).toMatchObject({ ok: true, config: CONFIG });
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await readdir(dir)).toEqual(['export.json']);
  });

  it('replaces an existing file atomically (rename over it)', async () => {
    const file = await fileWith('old', 'export.json');
    expect((await writeConfigFile(file, CONFIG)).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(configFileText(CONFIG));
    expect(await readdir(dir)).toEqual(['export.json']);
  });

  it('a failed rename leaves the old file and no temporary file', async () => {
    const file = await fileWith('old', 'export.json');
    const fs: ConfigFileSystem = { ...nodeConfigFileSystem, rename: () => Promise.reject(Object.assign(new Error('x'), { code: 'EXDEV' })) };
    expect(await writeConfigFile(file, CONFIG, fs)).toEqual({ ok: false, error: 'The file could not be written (EXDEV)' });
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['export.json']);
  });

  it('a directory that does not exist is a failure, and nothing is created', async () => {
    const file = path.join(dir, 'missing', 'export.json');
    expect(await writeConfigFile(file, CONFIG)).toMatchObject({ ok: false });
    expect(await readdir(dir)).toEqual([]);
  });

  it('never writes through a symlink planted at the temporary name', async () => {
    const victim = await fileWith('victim', 'victim.txt');
    const file = path.join(dir, 'export.json');
    await symlink(victim, path.join(dir, '.export.json.fixed.tmp'));
    const result = await writeConfigFile(file, CONFIG, nodeConfigFileSystem, () => 'fixed');
    expect(result.ok).toBe(false);
    expect(await readFile(victim, 'utf8')).toBe('victim');
  });

  it('writes only the temporary file next to the chosen path, then the path itself', async () => {
    const opened: string[] = [];
    const renamed: [string, string][] = [];
    const fs: ConfigFileSystem = {
      open: vi.fn((file: string, flags: number | string, mode?: number) => {
        opened.push(file);
        return nodeConfigFileSystem.open(file, flags, mode);
      }),
      rename: vi.fn((from: string, to: string) => {
        renamed.push([from, to]);
        return nodeConfigFileSystem.rename(from, to);
      }),
      unlink: (file: string) => nodeConfigFileSystem.unlink(file),
    };
    const file = path.join(dir, 'export.json');
    await writeConfigFile(file, CONFIG, fs, () => 'abc');
    const temporary = path.join(dir, '.export.json.abc.tmp');
    expect(opened).toEqual([temporary]);
    expect(renamed).toEqual([[temporary, file]]);
  });
});
