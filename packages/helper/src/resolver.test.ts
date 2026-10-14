import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config, PATHS, RESOLVER_MARKER, type Rule } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEngine } from './engine';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import type { DetectedInterfaces, InterfaceInfo } from './netinfo';
import {
  MAX_RESOLVER_FILE_BYTES,
  createResolverFiles,
  hasResolverMarker,
  resolverFileContent,
  resolverFileName,
  type ResolverFs,
} from './resolver';
import { createFakeCommandRunner, type FakeCommandRunner } from './test-utils';

// Every test works in a fresh directory under the system's temporary directory. Nothing here ever
// names the real resolver directory: the module only ever touches the `dir` it is given.

const DSCACHEUTIL = '/usr/bin/dscacheutil';
const KILLALL = '/usr/bin/killall';

const ruleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const domainRule = (n: number, target: string, extra: Partial<Rule> = {}): Rule => ({
  id: ruleId(n),
  enabled: true,
  kind: 'domain',
  target,
  iface: 'ethernet',
  dns: '10.30.0.53',
  refreshSec: 600,
  ...extra,
});
const config = (rules: readonly Rule[], extra: Partial<Config> = {}): Config =>
  Config.parse({ version: 1, enabled: true, rules, ...extra });
/** Skips the schema: proves the module checks names itself. */
const rawConfig = (rules: readonly Rule[]): Config => ({ version: 1, enabled: true, rules: [...rules] });

let root = '';
let dir = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'routeswitch-resolver-test-'));
  dir = join(root, 'resolver');
  await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = (options: { fs?: ResolverFs; runner?: FakeCommandRunner; dir?: string } = {}) => {
  const runner = options.runner ?? createFakeCommandRunner().when(DSCACHEUTIL, ['-flushcache'], {}).when(KILLALL, ['-HUP', 'mDNSResponder'], {});
  const memory = createMemorySink();
  const files = createResolverFiles({
    dir: options.dir ?? dir,
    runner,
    logger: createLogger({ sinks: [memory.sink] }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  const flushes = (): number => runner.calls.filter((call) => call.bin === DSCACHEUTIL).length;
  return { files, runner, entries: memory.entries, flushes };
};

const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');
const list = async (): Promise<string[]> => (await readdir(dir)).sort();
const logs = (entries: readonly LogEntry[], level: LogEntry['level']): string[] =>
  entries.filter((entry) => entry.level === level).map((entry) => entry.msg);

describe('resolverFileName', () => {
  it.each(['corp.local', 'a.corp.local', 'x-1.corp.local', 'local'])('accepts the domain %s', (name) => {
    expect(resolverFileName(name)).toBe(name);
  });

  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot dot', '..'],
    ['a parent path', '../etc'],
    ['a parent path inside', 'corp/../../etc'],
    ['an absolute path', '/etc/hosts'],
    ['a slash', 'corp.local/x'],
    ['a backslash', 'corp\\local'],
    ['a NUL byte', 'corp.local\0'],
    ['upper case', 'Corp.local'],
    ['an empty label', 'corp..local'],
    ['a leading dot', '.corp.local'],
    ['a trailing dot', 'corp.local.'],
    ['a wildcard', '*.corp.local'],
    ['a numeric last label', '10.0.0.1'],
    ['not a string', 42],
  ])('refuses %s', (_name, value) => {
    expect(resolverFileName(value)).toBeNull();
  });
});

describe('file content and marker', () => {
  it('writes the server and the marker, each on a line of its own', () => {
    expect(resolverFileContent('10.30.0.53')).toBe(`nameserver 10.30.0.53\n${RESOLVER_MARKER}\n`);
    expect(RESOLVER_MARKER).toBe('# managed-by: routeswitch');
  });

  it('recognises the marker only as a whole line', () => {
    expect(hasResolverMarker(`nameserver 1.2.3.4\n${RESOLVER_MARKER}\n`)).toBe(true);
    expect(hasResolverMarker(`  ${RESOLVER_MARKER}  \r\n`)).toBe(true);
    expect(hasResolverMarker(`nameserver 1.2.3.4 ${RESOLVER_MARKER}\n`)).toBe(false);
    expect(hasResolverMarker('# managed-by: someone-else\n')).toBe(false);
    expect(hasResolverMarker('nameserver 1.2.3.4\n')).toBe(false);
  });
});

describe('sync: managed files', () => {
  it('creates one file per domain rule with `dns`, 0644, and flushes the DNS cache once', async () => {
    const { files, runner, flushes } = setup();

    const result = await files.sync(config([domainRule(5, 'corp.local'), domainRule(6, 'lab.corp.local', { dns: '10.30.0.54' })]));

    expect(result).toEqual({ issues: new Map(), changed: 2 });
    expect(await list()).toEqual(['corp.local', 'lab.corp.local']);
    expect(await read('corp.local')).toBe(`nameserver 10.30.0.53\n${RESOLVER_MARKER}\n`);
    expect(await read('lab.corp.local')).toBe(`nameserver 10.30.0.54\n${RESOLVER_MARKER}\n`);
    expect((await stat(join(dir, 'corp.local'))).mode & 0o777).toBe(0o644);
    expect(runner.calls.map((call) => [call.bin, ...call.args])).toEqual([
      [DSCACHEUTIL, '-flushcache'],
      [KILLALL, '-HUP', 'mDNSResponder'],
    ]);
    expect(flushes()).toBe(1);
  });

  it('changes nothing and runs no command when everything is in place', async () => {
    const { files, runner } = setup();
    const wanted = config([domainRule(5, 'corp.local')]);
    await files.sync(wanted);
    runner.reset();
    const before = (await stat(join(dir, 'corp.local'))).mtimeMs;

    const result = await files.sync(wanted);

    expect(result.changed).toBe(0);
    expect(runner.calls).toEqual([]);
    expect((await stat(join(dir, 'corp.local'))).mtimeMs).toBe(before);
  });

  it('rewrites its own file when the server changed, and repairs one that was edited', async () => {
    const { files, flushes } = setup();
    await files.sync(config([domainRule(5, 'corp.local')]));

    expect((await files.sync(config([domainRule(5, 'corp.local', { dns: '10.30.0.99' })]))).changed).toBe(1);
    expect(await read('corp.local')).toBe(resolverFileContent('10.30.0.99'));

    await writeFile(join(dir, 'corp.local'), `nameserver 10.66.6.6\n${RESOLVER_MARKER}\n`);
    expect((await files.sync(config([domainRule(5, 'corp.local', { dns: '10.30.0.99' })]))).changed).toBe(1);
    expect(await read('corp.local')).toBe(resolverFileContent('10.30.0.99'));
    expect(flushes()).toBe(3);
  });

  it('removes its own files no rule asks for any more: rule removed, disabled, without `dns`, global toggle off', async () => {
    const { files } = setup();
    const all = [domainRule(5, 'a.corp.local'), domainRule(6, 'b.corp.local'), domainRule(7, 'c.corp.local'), domainRule(8, 'd.corp.local')];
    await files.sync(config(all));

    const result = await files.sync(
      config([all[0] as Rule, { ...(all[1] as Rule), enabled: false }, { ...(all[2] as Rule), dns: undefined }]),
    );
    expect(result.changed).toBe(3);
    expect(await list()).toEqual(['a.corp.local']);

    expect((await files.sync(config(all, { enabled: false }))).changed).toBe(1);
    expect(await list()).toEqual([]);
  });

  it('removeAll takes away every file of its own and nothing else', async () => {
    const { files } = setup();
    await files.sync(config([domainRule(5, 'a.corp.local'), domainRule(6, 'b.corp.local')]));
    await writeFile(join(dir, 'user.local'), 'nameserver 10.1.1.1\n');

    expect((await files.removeAll()).changed).toBe(2);
    expect(await list()).toEqual(['user.local']);
    expect(await read('user.local')).toBe('nameserver 10.1.1.1\n');
  });

  it('gives a domain asked for twice with the same server one file, and refuses another server for it', async () => {
    const { files } = setup();

    // The schema refuses such configs already; the module does not rely on it.
    const same = await files.sync(rawConfig([domainRule(5, 'corp.local'), domainRule(6, 'corp.local', { iface: 'wifi' })]));
    expect(same.issues).toEqual(new Map());

    const other = await files.sync(rawConfig([domainRule(5, 'corp.local'), domainRule(6, 'corp.local', { dns: '10.30.0.54', iface: 'wifi' })]));
    expect(other.issues).toEqual(
      new Map([[ruleId(6), { reasonCode: 'resolver-conflict', reason: 'Another rule already sets 10.30.0.53 as the DNS server of corp.local' }]]),
    );
    expect(await read('corp.local')).toBe(resolverFileContent('10.30.0.53'));
  });

  it('needs no file, and writes none, for domain rules without `dns` and for other rules', async () => {
    const { files, runner } = setup();
    const rules: Rule[] = [
      domainRule(5, 'corp.local', { dns: undefined }),
      { id: ruleId(6), enabled: true, kind: 'ip', target: '10.30.0.1', iface: 'ethernet', refreshSec: 600 },
    ];

    expect(await files.sync(config(rules))).toEqual({ issues: new Map(), changed: 0 });
    expect(await list()).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});

describe('sync: files that are not ours are never touched', () => {
  it('leaves a file without the marker as it is, and makes the rule `resolver-conflict`', async () => {
    const { files, entries, runner } = setup();
    await writeFile(join(dir, 'corp.local'), 'nameserver 10.1.1.1\n');
    const before = await stat(join(dir, 'corp.local'));

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))).toEqual({
      reasonCode: 'resolver-conflict',
      reason: `${dir}/corp.local exists and is not managed by RouteSwitch (no managed-by marker); it is left as it is`,
    });
    expect(result.changed).toBe(0);
    expect(await read('corp.local')).toBe('nameserver 10.1.1.1\n');
    expect((await stat(join(dir, 'corp.local'))).mtimeMs).toBe(before.mtimeMs);
    expect(logs(entries, 'warn')).toEqual(['resolver file belongs to someone else; not touched']);
    expect(runner.calls).toEqual([]);
    // Nothing left behind either.
    expect(await list()).toEqual(['corp.local']);
  });

  it('never removes a file without the marker, whatever its name', async () => {
    const { files } = setup();
    const names = ['corp.local', 'other.local', 'README', '.hidden', 'Upper.local', '.routeswitch-x.local.tmp'];
    // Not a prefix of what this module writes: a temporary name with it is not ours either.
    for (const name of names) await writeFile(join(dir, name), 'nameserver 10.1.1.1\nsearch corp.local\n');

    expect((await files.sync(config([]))).changed).toBe(0);
    expect(await list()).toEqual([...names].sort());
  });

  it('never removes a file with the marker under a name that is not a domain', async () => {
    const { files } = setup();
    const names = ['README', 'Upper.local', 'corp..local', '.routeswitch-.tmp', '.routeswitch-UP.tmp'];
    for (const name of names) await writeFile(join(dir, name), resolverFileContent('10.1.1.1'));

    await files.sync(config([]));

    expect(await list()).toEqual([...names].sort());
  });

  it('does not follow a symbolic link, whatever it points to, and does not replace it', async () => {
    const { files } = setup();
    const outside = join(root, 'outside');
    await writeFile(outside, resolverFileContent('10.1.1.1'));
    await symlink(outside, join(dir, 'corp.local'));
    await symlink(outside, join(dir, 'stale.local'));

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))?.reason).toContain('(a symbolic link)');
    expect((await lstat(join(dir, 'corp.local'))).isSymbolicLink()).toBe(true);
    // The stale link "with the marker" stays too: the marker is read through no link.
    expect((await lstat(join(dir, 'stale.local'))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe(resolverFileContent('10.1.1.1'));
  });

  it('takes a file of exactly the size limit with the marker as its own, one byte more not', async () => {
    const { files } = setup();
    const fill = (size: number): string => {
      const head = `${RESOLVER_MARKER}\n`;
      return `${head}${'#'.repeat(size - head.length - 1)}\n`;
    };
    await writeFile(join(dir, 'at.local'), fill(MAX_RESOLVER_FILE_BYTES));
    await writeFile(join(dir, 'over.local'), fill(MAX_RESOLVER_FILE_BYTES + 1));

    await files.sync(config([]));

    expect(await list()).toEqual(['over.local']);
  });

  it('treats a directory, and a file too large to be ours, as not ours', async () => {
    const { files } = setup();
    await mkdir(join(dir, 'corp.local'));
    await writeFile(join(dir, 'big.local'), `${RESOLVER_MARKER}\n${'#'.repeat(MAX_RESOLVER_FILE_BYTES)}\n`);

    const result = await files.sync(config([domainRule(5, 'corp.local'), domainRule(6, 'big.local')]));

    expect(result.issues.get(ruleId(5))?.reason).toContain('(not a regular file)');
    expect(result.issues.get(ruleId(6))?.reason).toContain('(larger than a file of ours)');
    expect((await lstat(join(dir, 'corp.local'))).isDirectory()).toBe(true);
    expect((await stat(join(dir, 'big.local'))).size).toBeGreaterThan(MAX_RESOLVER_FILE_BYTES);
  });
});

describe('sync: names are checked again (path traversal)', () => {
  it.each(['../escaped', '../../etc/hosts', '/etc/hosts', 'a/b', '', '.', '..', 'Corp.local'])(
    'refuses the target %j that skipped the schema, and writes nothing anywhere',
    async (target) => {
      const { files, runner } = setup();

      const result = await files.sync(rawConfig([domainRule(5, target)]));

      expect(result.issues.get(ruleId(5))).toEqual({
        reasonCode: 'resolver-failed',
        reason: 'The domain or DNS server of the rule cannot be used for a resolver file',
      });
      expect(await list()).toEqual([]);
      expect((await readdir(root)).sort()).toEqual(['resolver']);
      expect(runner.calls).toEqual([]);
    },
  );

  it('refuses a server that is not a usable address', async () => {
    const { files } = setup();

    const result = await files.sync(rawConfig([domainRule(5, 'corp.local', { dns: '127.0.0.1' }), domainRule(6, 'b.local', { dns: '10.0.0.1\nnameserver 6.6.6.6' })]));

    expect([...result.issues.values()].map((issue) => issue.reasonCode)).toEqual(['resolver-failed', 'resolver-failed']);
    expect(await list()).toEqual([]);
  });
});

describe('sync: the directory', () => {
  it('sets the modes itself, whatever the umask of the process', async () => {
    const previous = process.umask(0o077);
    try {
      const created = join(root, 'created');
      const { files } = setup({ dir: created });
      await files.sync(config([domainRule(5, 'corp.local')]));
      expect((await stat(created)).mode & 0o777).toBe(0o755);
      expect((await stat(join(created, 'corp.local'))).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previous);
    }
  });

  it('creates a missing directory when a file is needed, and only then', async () => {
    const missing = join(root, 'created');
    const { files } = setup({ dir: missing });

    await files.sync(config([]));
    await expect(stat(missing)).rejects.toThrow();

    await files.sync(config([domainRule(5, 'corp.local')]));
    expect((await stat(missing)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(missing, 'corp.local'), 'utf8')).toBe(resolverFileContent('10.30.0.53'));
  });

  it('refuses to work in a directory that is a symbolic link or not a directory', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    await writeFile(join(real, 'stale.local'), resolverFileContent('10.1.1.1'));
    const linked = join(root, 'linked');
    await symlink(real, linked);
    const plainFile = join(root, 'plain');
    await writeFile(plainFile, '');

    for (const target of [linked, plainFile]) {
      const { files, entries } = setup({ dir: target });
      const result = await files.sync(config([domainRule(5, 'corp.local')]));
      expect(result.issues.get(ruleId(5))).toEqual({
        reasonCode: 'resolver-failed',
        reason: 'Resolver files cannot be managed: the resolver directory is not a directory',
      });
      expect(logs(entries, 'error')).toEqual(['resolver files cannot be managed']);
    }
    // Nothing written through the link, nothing removed behind it.
    expect((await readdir(real)).sort()).toEqual(['stale.local']);
  });

  it('defaults to nothing else than the path it is given (the daemon passes PATHS.resolverDir)', () => {
    expect(PATHS.resolverDir).toBe('/etc/resolver');
  });
});

describe('sync: failures', () => {
  /** The real file system with one operation made to fail. */
  const failing = (overrides: Partial<ResolverFs>): ResolverFs => ({
    open: nodeFs.open,
    readdir: (path) => nodeFs.readdir(path),
    lstat: nodeFs.lstat,
    rename: nodeFs.rename,
    unlink: nodeFs.unlink,
    mkdir: (path, options) => nodeFs.mkdir(path, options),
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    ...overrides,
  });
  const fsError = (code: string): Error => Object.assign(new Error(code), { code });

  it('makes the rule `resolver-failed` when the file cannot be created, and leaves no temporary file', async () => {
    const fs = failing({
      open: ((path: string, flags?: number, mode?: number) =>
        typeof flags === 'number' && (flags & nodeFs.constants.O_CREAT) !== 0
          ? Promise.reject(fsError('EROFS'))
          : nodeFs.open(path, flags, mode)) as typeof nodeFs.open,
    });
    const { files, entries, runner } = setup({ fs });

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))).toEqual({
      reasonCode: 'resolver-failed',
      reason: `${dir}/corp.local: the file could not be created (EROFS)`,
    });
    expect(result.changed).toBe(0);
    expect(await list()).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(logs(entries, 'error')).toEqual(['resolver file could not be written']);
  });

  it('cleans up the temporary file when the rename fails', async () => {
    // The listing fails too, so the clean-up of leftovers at the end of the pass cannot do it instead.
    const { files } = setup({
      fs: failing({ rename: () => Promise.reject(fsError('EIO')), readdir: () => Promise.reject(fsError('EACCES')) }),
    });

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))?.reason).toBe(`${dir}/corp.local: the file could not be put in place (EIO)`);
    expect(await list()).toEqual([]);
  });

  it('does not replace a file that appeared while its own was being written', async () => {
    const fs = failing({
      open: (async (path: string, flags?: number, mode?: number) => {
        const handle = await nodeFs.open(path, flags, mode);
        if (typeof flags === 'number' && (flags & nodeFs.constants.O_CREAT) !== 0) {
          await writeFile(join(dir, 'corp.local'), 'nameserver 10.1.1.1\n');
        }
        return handle;
      }) as typeof nodeFs.open,
    });
    const { files, runner } = setup({ fs });

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))?.reasonCode).toBe('resolver-conflict');
    expect(await read('corp.local')).toBe('nameserver 10.1.1.1\n');
    expect(await list()).toEqual(['corp.local']);
    expect(runner.calls).toEqual([]);
  });

  it('keeps a stale file it cannot remove, logs it and tries again on the next pass', async () => {
    let refuse = true;
    const fs = failing({ unlink: (path) => (refuse ? Promise.reject(fsError('EPERM')) : nodeFs.unlink(path)) });
    const { files, entries } = setup({ fs });
    await files.sync(config([domainRule(5, 'corp.local')]));

    expect((await files.sync(config([]))).changed).toBe(0);
    expect(await list()).toEqual(['corp.local']);
    expect(logs(entries, 'error')).toEqual(['resolver file could not be removed; tried again next time']);

    refuse = false;
    expect((await files.sync(config([]))).changed).toBe(1);
    expect(await list()).toEqual([]);
  });

  it('removes a leftover temporary file of its own, and refuses to write over one that is not', async () => {
    const { files } = setup();
    await writeFile(join(dir, '.routeswitch-old.local.tmp'), resolverFileContent('10.1.1.1'));
    await writeFile(join(dir, '.routeswitch-corp.local.tmp'), 'not ours\n');

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))).toEqual({
      reasonCode: 'resolver-conflict',
      reason: `${dir}/.routeswitch-corp.local.tmp, the temporary name of ${dir}/corp.local, is not managed by RouteSwitch (no managed-by marker); it is left as it is`,
    });
    expect(await list()).toEqual(['.routeswitch-corp.local.tmp']);
    expect(await read('.routeswitch-corp.local.tmp')).toBe('not ours\n');
  });

  it.each([
    ['empty', ''],
    ['cut in the keyword', 'namese'],
    ['cut after the keyword', 'nameserver '],
    ['cut in the address', 'nameserver 10.30.0.'],
    ['cut after the address', 'nameserver 10.30.0.53\n'],
    ['cut in the marker', `nameserver 10.30.0.53\n${RESOLVER_MARKER.slice(0, 9)}`],
    ['complete but for the last newline', `nameserver 10.30.0.53\n${RESOLVER_MARKER}`],
  ])('treats a temporary file of its own cut short (%s) as a leftover: removed, and the file written (QA verdict 1)', async (_name, content) => {
    const { files, flushes } = setup();
    await writeFile(join(dir, '.routeswitch-corp.local.tmp'), content);
    await writeFile(join(dir, '.routeswitch-stale.local.tmp'), content);

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues).toEqual(new Map());
    expect(await list()).toEqual(['corp.local']);
    expect(await read('corp.local')).toBe(resolverFileContent('10.30.0.53'));
    expect(flushes()).toBe(1);
  });

  it.each([
    ['other text', 'search corp.local\n'],
    ['a second address line', 'nameserver 10.30.0.53\nnameserver 10.30.0.54\n'],
    ['an address that is not one', 'nameserver 10.30.0.999\n'],
    ['letters in the address', 'nameserver 10.30.x'],
    ['an address too long to be one', 'nameserver 10.30.0.53.10.30'],
    ['a different marker', 'nameserver 10.30.0.53\n# managed-by: other'],
  ])('keeps a temporary name holding anything else (%s) and names that file in the reason', async (_name, content) => {
    const { files, runner } = setup();
    await writeFile(join(dir, '.routeswitch-corp.local.tmp'), content);

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result.issues.get(ruleId(5))?.reason).toContain(`${dir}/.routeswitch-corp.local.tmp, the temporary name of ${dir}/corp.local`);
    expect(await list()).toEqual(['.routeswitch-corp.local.tmp']);
    expect(await read('.routeswitch-corp.local.tmp')).toBe(content);
    expect(runner.calls).toEqual([]);
  });

  it('logs a failed cache flush and still reports the files as in place', async () => {
    const runner = createFakeCommandRunner()
      .when(DSCACHEUTIL, ['-flushcache'], { exitCode: 1, stderr: 'nope' })
      .when(KILLALL, ['-HUP', 'mDNSResponder'], { exitCode: 1 });
    const { files, entries } = setup({ runner });

    const result = await files.sync(config([domainRule(5, 'corp.local')]));

    expect(result).toEqual({ issues: new Map(), changed: 1 });
    expect(logs(entries, 'warn')).toEqual(['flushing the DNS cache failed', 'flushing the DNS cache failed']);
  });

  it('never rejects, also when the listing fails, and runs one pass at a time', async () => {
    let listing = 0;
    let running = 0;
    let overlap = false;
    const fs = failing({
      readdir: async (path) => {
        running += 1;
        if (running > 1) overlap = true;
        listing += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if (listing === 1) throw fsError('EACCES');
        return nodeFs.readdir(path);
      },
    });
    const { files, entries } = setup({ fs });

    const results = await Promise.all([
      files.sync(config([domainRule(5, 'corp.local')])),
      files.sync(config([domainRule(5, 'corp.local')])),
      files.removeAll(),
    ]);

    expect(overlap).toBe(false);
    expect(results.map((result) => result.changed)).toEqual([1, 0, 1]);
    expect(logs(entries, 'error')).toContain('the resolver directory could not be listed; stale files stay for now');
    expect(await list()).toEqual([]);
  });
});

describe('with the engine', () => {
  const info = (role: InterfaceInfo['role']): InterfaceInfo => ({
    role,
    device: role === 'wifi' ? 'en0' : 'en5',
    port: 'Port',
    ip: role === 'wifi' ? '192.168.1.23' : '10.20.4.23',
    gateway: role === 'wifi' ? '192.168.1.1' : '10.20.4.1',
    netmask: '255.255.255.0',
    subnet: role === 'wifi' ? '192.168.1.0/24' : '10.20.4.0/24',
    up: true,
    routable: true,
    reason: null,
    overridden: false,
  });
  const DETECTED: DetectedInterfaces = { ethernet: info('ethernet'), wifi: info('wifi'), adapters: [], degraded: false };

  it('writes the file, routes the server, reports a foreign file, and cleans both up when the rule goes', async () => {
    const calls: string[] = [];
    const { files, flushes } = setup();
    const engine = createEngine({
      netinfo: { detectInterfaces: () => Promise.resolve(DETECTED), invalidate: () => undefined },
      routes: {
        routeAdd: (request) => {
          calls.push(`add ${request.dst} ${request.gateway}`);
          return Promise.resolve({ ok: true, outcome: 'added', dst: request.dst, kind: 'host', gateway: request.gateway });
        },
        routeDelete: (request) => {
          calls.push(`delete ${request.dst}`);
          return Promise.resolve({ ok: true, outcome: 'deleted', dst: request.dst, kind: 'host' });
        },
      },
      logger: createLogger({ sinks: [] }),
      helperVersion: '1.2.3',
      initialConfig: config([domainRule(5, 'corp.local'), domainRule(6, 'user.local', { dns: '10.30.0.54' })]),
      syncResolvers: (snapshot) => files.sync(snapshot),
    });
    await writeFile(join(dir, 'user.local'), 'nameserver 10.1.1.1\n');

    const outcome = await engine.reconcile('startup');

    expect(await read('corp.local')).toBe(resolverFileContent('10.30.0.53'));
    expect(await read('user.local')).toBe('nameserver 10.1.1.1\n');
    expect(calls).toEqual(['add 10.30.0.53 10.20.4.1', 'add 10.30.0.54 10.20.4.1']);
    const rules = new Map(outcome.state.rules.map((rule) => [rule.ruleId, rule]));
    expect(rules.get(ruleId(5))).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
    expect(rules.get(ruleId(6))).toMatchObject({ status: 'error', reasonCode: 'resolver-conflict' });
    expect(flushes()).toBe(1);

    engine.setConfig(config([]));
    await engine.reconcile('config-change');

    expect(await list()).toEqual(['user.local']);
    expect(calls.slice(2).sort()).toEqual(['delete 10.30.0.53', 'delete 10.30.0.54']);
    expect(flushes()).toBe(2);
  });
});
