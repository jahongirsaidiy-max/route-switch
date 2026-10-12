import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config } from '@routeswitch/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_CONFIG_BYTES,
  emptyConfig,
  loadConfig,
  parseConfig,
  readConfigFile,
  type ConfigFileRead,
  type ConfigFileReader,
} from './config-store';

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';

const VALID = {
  version: 1,
  rules: [
    { id: ID_A, kind: 'subnet', target: '10.1.2.3/8', iface: 'ethernet' },
    { id: ID_B, kind: 'ip', target: '172.16.12.40', iface: 'wifi', enabled: false, note: 'printer' },
  ],
};

/** A reader that never touches the disk. */
const reading =
  (result: ConfigFileRead): ConfigFileReader =>
  () =>
    Promise.resolve(result);

const content = (value: unknown): ConfigFileReader =>
  reading({ kind: 'content', text: typeof value === 'string' ? value : JSON.stringify(value) });

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routeswitch-config-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig from a real file', () => {
  it('reads, validates and normalises a config', async () => {
    const path = join(dir, 'valid.json');
    await writeFile(path, JSON.stringify(VALID));

    const result = await loadConfig(path);

    expect(result).toEqual({
      ok: true,
      source: 'file',
      config: {
        version: 1,
        enabled: true,
        rules: [
          { id: ID_A, enabled: true, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', refreshSec: 600 },
          { id: ID_B, enabled: false, kind: 'ip', target: '172.16.12.40', iface: 'wifi', refreshSec: 600, note: 'printer' },
        ],
      },
    });
  });

  it('returns the empty config, marked as a default, when there is no file yet', async () => {
    const result = await loadConfig(join(dir, 'does-not-exist.json'));

    expect(result).toEqual({ ok: true, source: 'default', config: { version: 1, enabled: true, rules: [] } });
  });

  it('reports a directory as unreadable', async () => {
    const path = join(dir, 'a-directory');
    await mkdir(path);

    expect(await loadConfig(path)).toEqual({
      ok: false,
      code: 'unreadable',
      message: 'Config file could not be read (ENOTFILE)',
    });
  });

  it('reports a path below a file as unreadable, not as missing', async () => {
    const file = join(dir, 'plain.json');
    await writeFile(file, '{}');

    expect(await loadConfig(join(file, 'child.json'))).toEqual({
      ok: false,
      code: 'unreadable',
      message: 'Config file could not be read (ENOTDIR)',
    });
  });

  it.skipIf(process.getuid?.() === 0)('reports a file without read permission as unreadable', async () => {
    const path = join(dir, 'secret.json');
    await writeFile(path, JSON.stringify(VALID));
    await chmod(path, 0o000);

    expect(await loadConfig(path)).toEqual({
      ok: false,
      code: 'unreadable',
      message: 'Config file could not be read (EACCES)',
    });
  });

  it('refuses a file over the size limit without parsing it', async () => {
    const path = join(dir, 'big.json');
    await writeFile(path, JSON.stringify(VALID));

    expect(await readConfigFile(path, 16)).toEqual({ kind: 'too-large' });
    expect(await readConfigFile(path, 1_000_000)).toMatchObject({ kind: 'content' });
    expect(MAX_CONFIG_BYTES).toBe(4 * 1024 * 1024);
  });

  it('reports corrupt JSON without repeating the content', async () => {
    const path = join(dir, 'corrupt.json');
    await writeFile(path, '{"version":1,"rules":[SECRET-TOKEN');

    const result = await loadConfig(path);

    expect(result).toEqual({ ok: false, code: 'invalid-json', message: 'Config file is not valid JSON' });
  });
});

describe('loadConfig outcomes', () => {
  it('asks the reader for the path with the size limit', async () => {
    const seen: [string, number][] = [];
    const reader: ConfigFileReader = (path, maxBytes) => {
      seen.push([path, maxBytes]);
      return Promise.resolve({ kind: 'missing' });
    };

    await loadConfig('/some/where/config.json', reader);

    expect(seen).toEqual([['/some/where/config.json', MAX_CONFIG_BYTES]]);
  });

  it.each([
    [{ kind: 'too-large' } as const, 'too-large', `Config file is larger than ${String(MAX_CONFIG_BYTES)} bytes`],
    [{ kind: 'unreadable', detail: 'EACCES' } as const, 'unreadable', 'Config file could not be read (EACCES)'],
  ])('turns %j into an error value', async (read, code, message) => {
    expect(await loadConfig('/x', reading(read))).toEqual({ ok: false, code, message });
  });

  it('turns a reader that rejects into an error value', async () => {
    const reader: ConfigFileReader = () => Promise.reject(Object.assign(new Error('secret path /Users/x'), { code: 'EIO' }));

    expect(await loadConfig('/x', reader)).toEqual({
      ok: false,
      code: 'unreadable',
      message: 'Config file could not be read (EIO)',
    });
  });

  it('does not pass on an error code that is not a plain system code', async () => {
    const reader: ConfigFileReader = () => Promise.reject(Object.assign(new Error('x'), { code: 'rm -rf / $(evil)' }));

    expect(await loadConfig('/x', reader)).toMatchObject({ message: 'Config file could not be read (UNKNOWN)' });
  });

  it.each(['', '   ', 'not json', '{"version":1,', '﻿{"version":1,"rules":[]}', "{'version':1}"])(
    'reports %j as invalid JSON',
    async (text) => {
      expect(await loadConfig('/x', content(text))).toEqual({
        ok: false,
        code: 'invalid-json',
        message: 'Config file is not valid JSON',
      });
    },
  );

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'config'],
    ['a number', 42],
    ['an empty object', {}],
    ['another version', { version: 2, rules: [] }],
    ['no rules', { version: 1 }],
    ['an invalid prefix', { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '10.0.0.0/33', iface: 'ethernet' }] }],
    ['the default route', { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '0.0.0.0/0', iface: 'ethernet' }] }],
    ['a block wider than /8', { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '0.0.0.0/1', iface: 'ethernet' }] }],
    ['a loopback address', { version: 1, rules: [{ id: ID_A, kind: 'ip', target: '127.0.0.1', iface: 'ethernet' }] }],
    ['a traversal domain', { version: 1, rules: [{ id: ID_A, kind: 'domain', target: '../etc', iface: 'ethernet' }] }],
    ['an unknown interface', { version: 1, rules: [{ id: ID_A, kind: 'ip', target: '172.16.12.40', iface: 'utun3' }] }],
    ['a device override that is not en*', { version: 1, ifaceOverrides: { ethernet: 'lo0; rm' }, rules: [] }],
    [
      'a repeated id',
      {
        version: 1,
        rules: [
          { id: ID_A, kind: 'ip', target: '172.16.12.40', iface: 'ethernet' },
          { id: ID_A, kind: 'ip', target: '172.16.12.41', iface: 'ethernet' },
        ],
      },
    ],
    [
      'one target on two interfaces',
      {
        version: 1,
        rules: [
          { id: ID_A, kind: 'ip', target: '172.16.12.40', iface: 'ethernet' },
          { id: ID_B, kind: 'subnet', target: '172.16.12.40/32', iface: 'wifi' },
        ],
      },
    ],
  ])('refuses a config with %s', async (_name, value) => {
    const result = await loadConfig('/x', content(JSON.stringify(value)));

    expect(result).toMatchObject({ ok: false, code: 'invalid-config' });
    expect(result.ok ? '' : result.message).toMatch(/^Config is invalid: /);
  });

  it('names the field and the validation code, never the offending value', async () => {
    const hostile = '<script>alert(1)</script>';
    const result = await loadConfig(
      '/x',
      content({ version: 1, rules: [{ id: ID_A, kind: 'ip', target: hostile, iface: 'ethernet', [hostile]: 1 }] }),
    );

    expect(result).toEqual({
      ok: false,
      code: 'invalid-config',
      message: 'Config is invalid: rules.0.target: is invalid (invalid-ipv4)',
    });
  });

  it.each([
    ['too many rules', { version: 1, rules: Array.from({ length: 501 }, () => ({})) }, 'array-too-long'],
    ['an overlong string', { version: 1, rules: [], note: 'x'.repeat(5000) }, 'string-too-long'],
    ['deep nesting', { version: 1, rules: [[[[[[[[[[[[[1]]]]]]]]]]]]] }, 'too-deep'],
  ])('stops a config with %s at the structural guard, before the schema', async (_name, value, kind) => {
    expect(await loadConfig('/x', content(value))).toEqual({
      ok: false,
      code: 'invalid-structure',
      message: `Config exceeds the structural limits (${kind})`,
    });
  });

  it('refuses 500 empty rules quickly', async () => {
    const startedAt = performance.now();
    const result = await loadConfig('/x', content({ version: 1, rules: Array.from({ length: 500 }, () => ({})) }));

    expect(result).toMatchObject({ ok: false, code: 'invalid-config' });
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('drops unknown keys instead of refusing them', async () => {
    const result = await loadConfig('/x', content({ ...VALID, comment: 'hand written', rules: [] }));

    expect(result).toEqual({ ok: true, source: 'file', config: { version: 1, enabled: true, rules: [] } });
  });
});

describe('parseConfig and emptyConfig', () => {
  it('parses an already decoded value the same way', () => {
    expect(parseConfig(VALID)).toMatchObject({ ok: true, source: 'file' });
    expect(parseConfig({ version: 1, rules: 'none' })).toMatchObject({ ok: false, code: 'invalid-config' });
  });

  it('returns a fresh, valid empty config every time', () => {
    const first = emptyConfig();
    first.rules.push({ id: ID_A, enabled: true, kind: 'ip', target: '172.16.12.40', iface: 'ethernet', refreshSec: 600 });

    expect(emptyConfig()).toEqual({ version: 1, enabled: true, rules: [] });
    expect(Config.parse(emptyConfig())).toEqual(emptyConfig());
  });
});
