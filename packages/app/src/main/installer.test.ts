import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCALES, type Locale } from '../i18n';
import { memoryLogger } from './helperClient.fixtures';

type ExecCallback = (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void;
const childProcess = vi.hoisted(() => ({
  execFile: vi.fn<(file: string, args: string[], options: Record<string, unknown>, callback: ExecCallback) => void>(),
}));
vi.mock('node:child_process', () => ({ execFile: childProcess.execFile }));
import {
  BASH,
  checkPackage,
  classifyRun,
  createInstaller,
  ELEVATION_SCRIPT,
  ELEVATION_SCRIPTS,
  elevationArgs,
  HELPER_PACKAGE_FILES,
  INSTALL_SCRIPT,
  MAX_DETAIL_LENGTH,
  OSASCRIPT,
  PASSWORD_PROMPT,
  PASSWORD_PROMPTS,
  plainDetail,
  runWithExecFile,
  UNINSTALL_SCRIPT,
  type ElevationRun,
  type ElevationRunner,
  type PackageFileSystem,
} from './installer';

const UID = 501;
const RES = '/Applications/RouteSwitch.app/Contents/Resources/helper';

interface FakeEntry {
  readonly kind: 'file' | 'dir' | 'link';
  readonly uid?: number;
  readonly mode?: number;
}

/** An in-memory package: every path is canonical unless `links` says otherwise. */
const fakeFs = (entries: Record<string, FakeEntry>, links: Record<string, string> = {}): PackageFileSystem => ({
  lstat: (file) => {
    const entry = entries[file];
    if (entry === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    return Promise.resolve({
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'dir',
      isSymbolicLink: () => entry.kind === 'link',
      uid: entry.uid ?? UID,
      mode: entry.mode ?? (entry.kind === 'dir' ? 0o40755 : 0o100644),
    });
  },
  realpath: (file) => {
    if (links[file] !== undefined) return Promise.resolve(links[file]);
    return entries[file] === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(file);
  },
});

const fullPackage = (extra: Record<string, FakeEntry> = {}): Record<string, FakeEntry> => ({
  [RES]: { kind: 'dir' },
  [`${RES}/${INSTALL_SCRIPT}`]: { kind: 'file' },
  [`${RES}/${UNINSTALL_SCRIPT}`]: { kind: 'file' },
  [`${RES}/${HELPER_PACKAGE_FILES[0]}`]: { kind: 'file', mode: 0o100755 },
  [`${RES}/${HELPER_PACKAGE_FILES[1]}`]: { kind: 'file' },
  ...extra,
});

const run = (partial: Partial<ElevationRun>): ElevationRun => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...partial });

const setup = (
  options: { fs?: PackageFileSystem; result?: ElevationRun; resourcesDir?: string | null; language?: () => Promise<Locale> } = {},
) => {
  const { logger, entries } = memoryLogger(() => 0);
  const runner = vi.fn<ElevationRunner>(() => Promise.resolve(options.result ?? run({})));
  const installer = createInstaller({
    resourcesDir: options.resourcesDir === undefined ? RES : options.resourcesDir,
    uid: UID,
    run: runner,
    fs: options.fs ?? fakeFs(fullPackage()),
    ...(options.language === undefined ? {} : { language: options.language }),
    logger,
  });
  return { installer, runner, entries };
};

/** The command words `osascript` got as argv (after the fixed `-e` lines). */
const wordsOf = (args: readonly string[]): readonly string[] => args.slice(ELEVATION_SCRIPT.length * 2);

describe('the elevation command', () => {
  it('is osascript by absolute path with the fixed script, then the words as argv', () => {
    const args = elevationArgs([BASH, '/x/install-helper.sh', '/x']);
    expect(args.slice(0, ELEVATION_SCRIPT.length * 2)).toEqual(ELEVATION_SCRIPT.flatMap((line) => ['-e', line]));
    expect(wordsOf(args)).toEqual([BASH, '/x/install-helper.sh', '/x']);
    expect(OSASCRIPT).toBe('/usr/bin/osascript');
    expect(BASH).toBe('/bin/bash');
  });

  it('the script text holds no path and quotes every word with quoted form of', () => {
    const source = ELEVATION_SCRIPT.join('\n');
    expect(source).not.toContain('/');
    expect(source).toContain('quoted form of (arg_ as text)');
    expect(source).toContain('with administrator privileges');
    // The prompt is the only literal string besides "" and " ": no quote can end it early.
    expect(PASSWORD_PROMPT).not.toMatch(/["\\]/);
  });

  // TASK-DELTA-12: one fixed script per UI language; only the prompt sentence differs.
  it.each(LOCALES)('%s: the same constant script around its own prompt, written out in full', (locale) => {
    const script = ELEVATION_SCRIPTS[locale];
    const prompt = PASSWORD_PROMPTS[locale];
    // Same lines as Uzbek except the `do shell script` line.
    expect(script).toHaveLength(ELEVATION_SCRIPT.length);
    script.forEach((line, i) => {
      if (!line.startsWith('do shell script')) expect(line).toBe(ELEVATION_SCRIPT[i]);
    });
    expect(script.filter((line) => line.startsWith('do shell script'))).toEqual([
      `do shell script cmd with prompt "${prompt}" with administrator privileges`,
    ]);
    const source = script.join('\n');
    expect(source).not.toContain('/');
    expect(source).not.toContain('${');
    expect(source).toContain('quoted form of (arg_ as text)');
    // No quote or backslash can end the prompt early; no line break can start another statement.
    expect(prompt).not.toMatch(/["\\\n\r]/);
    expect(prompt).toContain('RouteSwitch');
  });

  it('the source of the scripts holds no template literal: each prompt line is written out as a plain string', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'installer.ts'), 'utf8');
    const start = source.indexOf('const SCRIPT_HEAD');
    const end = source.indexOf('export const ELEVATION_SCRIPT =');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // The code only: the doc comments may quote names in backticks.
    const block = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block).not.toContain('`');
    expect(block).not.toContain('${');
    expect(block).not.toContain('PASSWORD_PROMPT');
    for (const locale of LOCALES) expect(block).toContain(`with prompt "${PASSWORD_PROMPTS[locale].replace(/'/g, "\\'")}"`);
  });

  it('the three prompts are three languages', () => {
    expect(new Set(LOCALES.map((locale) => PASSWORD_PROMPTS[locale])).size).toBe(3);
    expect(PASSWORD_PROMPTS.ru).toMatch(/пароль администратора/);
    expect(PASSWORD_PROMPTS.en).toMatch(/administrator password/);
    expect(PASSWORD_PROMPT).toBe(PASSWORD_PROMPTS.uz);
  });

  it.each(LOCALES)('%s: elevationArgs puts that script first and the words after it, untouched', (locale) => {
    const words = [BASH, "/x y/it's \"quoted\" $(id)/install-helper.sh", '/x y'];
    const args = elevationArgs(words, locale);
    expect(args.slice(0, ELEVATION_SCRIPTS[locale].length * 2)).toEqual(ELEVATION_SCRIPTS[locale].flatMap((line) => ['-e', line]));
    expect(args.slice(ELEVATION_SCRIPTS[locale].length * 2)).toEqual(words);
  });

  it('without a language the script is Uzbek', () => {
    expect(elevationArgs([BASH])).toEqual(elevationArgs([BASH], 'uz'));
  });
});

describe('the language of the password dialog (TASK-DELTA-12)', () => {
  it.each(LOCALES)('%s: install and uninstall run the script of the UI language, with the same words', async (locale) => {
    const h = setup({ language: () => Promise.resolve(locale) });
    expect(await h.installer.install()).toEqual({ ok: true, value: null });
    expect(await h.installer.uninstall()).toEqual({ ok: true, value: null });
    const [install, uninstall] = h.runner.mock.calls.map(([, args]) => args);
    expect(install).toEqual(elevationArgs([BASH, `${RES}/${INSTALL_SCRIPT}`, RES], locale));
    expect(uninstall).toEqual(elevationArgs([BASH, `${RES}/${UNINSTALL_SCRIPT}`], locale));
    expect(h.entries.some((entry) => entry.msg === 'Asking for the administrator password' && entry['language'] === locale)).toBe(true);
  });

  it('a language that fails or is not one of the three falls back to Uzbek; the install still runs', async () => {
    const failing = setup({ language: () => Promise.reject(new Error('boom')) });
    expect(await failing.installer.install()).toEqual({ ok: true, value: null });
    expect(failing.runner.mock.calls[0]?.[1]).toEqual(elevationArgs([BASH, `${RES}/${INSTALL_SCRIPT}`, RES], 'uz'));
    const odd = setup({ language: () => Promise.resolve('de' as Locale) });
    expect(await odd.installer.install()).toEqual({ ok: true, value: null });
    expect(odd.runner.mock.calls[0]?.[1]).toEqual(elevationArgs([BASH, `${RES}/${INSTALL_SCRIPT}`, RES], 'uz'));
  });

  it('a refused package asks no language and runs nothing', async () => {
    const language = vi.fn(() => Promise.resolve<Locale>('ru'));
    const h = setup({ language, resourcesDir: null });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-unavailable' });
    expect(h.runner).not.toHaveBeenCalled();
    expect(language).not.toHaveBeenCalled();
  });
});

describe('install', () => {
  it('checks the package, then runs install-helper.sh with the resources folder, as words', async () => {
    const h = setup();
    expect(await h.installer.install()).toEqual({ ok: true, value: null });
    expect(h.runner).toHaveBeenCalledTimes(1);
    const [file, args] = h.runner.mock.calls[0] ?? [];
    expect(file).toBe(OSASCRIPT);
    expect(wordsOf(args ?? [])).toEqual([BASH, `${RES}/${INSTALL_SCRIPT}`, RES]);
    expect(h.entries.some((entry) => entry.msg === 'Asking for the administrator password' && entry['action'] === 'install')).toBe(true);
    expect(h.entries.some((entry) => entry.msg === 'Helper install finished')).toBe(true);
  });

  it('a cancelled dialog is install-cancelled', async () => {
    const h = setup({ result: run({ code: 1, stderr: '0:200: execution error: User canceled. (-128)\n' }) });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-cancelled' });
  });

  it('a refused authorization is install-denied', async () => {
    const h = setup({ result: run({ code: 1, stderr: '0:200: execution error: The administrator user name or password was incorrect. (-60005)' }) });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-denied' });
  });

  it("a failing script is install-failed with the script's error line and exit code", async () => {
    const stderr =
      'execution error: install-helper: installing from /x\ninstall-helper: error: the helper is not running with its socket after 20 s; see /Library/Logs/RouteSwitch/helper.log (1)';
    const h = setup({ result: run({ code: 1, stderr }) });
    const result = await h.installer.install();
    expect(result).toEqual({
      ok: false,
      code: 'install-failed',
      error: 'The install script failed (exit 1)',
      detail: 'install-helper: error: the helper is not running with its socket after 20 s; see /Library/Logs/RouteSwitch/helper.log',
    });
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Helper install failed' && entry['exitCode'] === 1)).toBe(true);
  });

  it('a runner that throws is install-failed, logged', async () => {
    const h = setup();
    h.runner.mockRejectedValueOnce(new Error('spawn EACCES'));
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-failed' });
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Helper install could not be started')).toBe(true);
  });

  it('one run at a time: a second call while the first waits is busy; afterwards it runs again', async () => {
    const h = setup();
    let finish: (value: ElevationRun) => void = () => undefined;
    h.runner.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.installer.install();
    await vi.waitFor(() => {
      expect(h.runner).toHaveBeenCalledTimes(1);
    });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'busy' });
    expect(await h.installer.uninstall()).toMatchObject({ ok: false, code: 'busy' });
    finish(run({}));
    expect(await first).toEqual({ ok: true, value: null });
    expect(await h.installer.install()).toEqual({ ok: true, value: null });
    expect(h.runner).toHaveBeenCalledTimes(2);
  });

  it('not packaged: install-unavailable, nothing run', async () => {
    const h = setup({ resourcesDir: null });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-unavailable' });
    expect(h.runner).not.toHaveBeenCalled();
  });

  it.each([
    ['the folder missing', fakeFs({})],
    ['the binary missing', fakeFs({ ...fullPackage(), [`${RES}/${HELPER_PACKAGE_FILES[0]}`]: undefined as never })],
    ['the plist a symbolic link', fakeFs(fullPackage({ [`${RES}/${HELPER_PACKAGE_FILES[1]}`]: { kind: 'link' } }))],
    ['the script a folder', fakeFs(fullPackage({ [`${RES}/${INSTALL_SCRIPT}`]: { kind: 'dir' } }))],
    ['the script group-writable', fakeFs(fullPackage({ [`${RES}/${INSTALL_SCRIPT}`]: { kind: 'file', mode: 0o100664 } }))],
    ['the binary world-writable', fakeFs(fullPackage({ [`${RES}/${HELPER_PACKAGE_FILES[0]}`]: { kind: 'file', mode: 0o100757 } }))],
    ['the script owned by another user', fakeFs(fullPackage({ [`${RES}/${INSTALL_SCRIPT}`]: { kind: 'file', uid: 502 } }))],
    ['the folder writable by others', fakeFs(fullPackage({ [RES]: { kind: 'dir', mode: 0o40777 } }))],
    ['the folder owned by another user', fakeFs(fullPackage({ [RES]: { kind: 'dir', uid: 502 } }))],
    ['the folder reached through a link', fakeFs(fullPackage({ '/tmp/elsewhere': { kind: 'dir' } }), { [RES]: '/tmp/elsewhere' })],
  ])('refuses a package with %s: install-unavailable, nothing run', async (_name, fs) => {
    const h = setup({ fs });
    expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-unavailable' });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Refused the helper package')).toBe(true);
  });

  it('root-owned files are accepted', async () => {
    const root = (kind: 'file' | 'dir'): FakeEntry => ({ kind, uid: 0 });
    const fs = fakeFs({
      [RES]: root('dir'),
      [`${RES}/${INSTALL_SCRIPT}`]: root('file'),
      [`${RES}/${HELPER_PACKAGE_FILES[0]}`]: root('file'),
      [`${RES}/${HELPER_PACKAGE_FILES[1]}`]: root('file'),
    });
    expect(await setup({ fs }).installer.install()).toEqual({ ok: true, value: null });
  });

  it.each([['relative/helper'], ['/Applications/Route\nSwitch.app/helper'], ['/Applications/RouteSwitch.app/../x']])(
    'refuses a resources path that is not plain and canonical: %j',
    async (dir) => {
      const fs = fakeFs({ [dir]: { kind: 'dir' } }, { [dir]: '/x' });
      const h = setup({ resourcesDir: dir, fs });
      expect(await h.installer.install()).toMatchObject({ ok: false, code: 'install-unavailable' });
      expect(h.runner).not.toHaveBeenCalled();
    },
  );
});

describe('uninstall', () => {
  it('runs uninstall.sh alone: no folder argument, no --force', async () => {
    const h = setup();
    expect(await h.installer.uninstall()).toEqual({ ok: true, value: null });
    expect(wordsOf(h.runner.mock.calls[0]?.[1] ?? [])).toEqual([BASH, `${RES}/${UNINSTALL_SCRIPT}`]);
  });

  it('only uninstall.sh is needed; without it install-unavailable', async () => {
    const onlyUninstall = fakeFs({ [RES]: { kind: 'dir' }, [`${RES}/${UNINSTALL_SCRIPT}`]: { kind: 'file' } });
    expect(await setup({ fs: onlyUninstall }).installer.uninstall()).toEqual({ ok: true, value: null });
    const without = fakeFs({ ...fullPackage(), [`${RES}/${UNINSTALL_SCRIPT}`]: undefined as never });
    const h = setup({ fs: without });
    expect(await h.installer.uninstall()).toMatchObject({ ok: false, code: 'install-unavailable' });
    expect(h.runner).not.toHaveBeenCalled();
  });

  it('a helper that cannot confirm the cleanup is install-failed with the error line', async () => {
    const stderr =
      'execution error: uninstall: error: the helper could not confirm the cleanup (exit 8); nothing was removed. Run this script again (1)';
    const result = await setup({ result: run({ code: 1, stderr }) }).installer.uninstall();
    expect(result).toMatchObject({ ok: false, code: 'install-failed', error: 'The uninstall script failed (exit 1)' });
    expect(result.ok ? '' : result.detail).toMatch(/^uninstall: error: the helper could not confirm the cleanup/);
  });
});

describe('classifyRun', () => {
  it('a timeout is a failure even with exit 0', () => {
    expect(classifyRun(run({ code: null, timedOut: true }))).toEqual({ kind: 'failed', exitCode: null, detail: 'Timed out' });
  });

  it('output that is not an AppleScript error keeps its last line', () => {
    expect(classifyRun(run({ code: 1, stderr: 'first\nspawn /usr/bin/osascript ENOENT\n' }))).toEqual({
      kind: 'failed',
      exitCode: 1,
      detail: 'spawn /usr/bin/osascript ENOENT',
    });
  });

  it('another negative AppleScript number is a failure with the exit code of osascript', () => {
    expect(classifyRun(run({ code: 1, stderr: 'execution error: Something else. (-1743)' }))).toEqual({
      kind: 'failed',
      exitCode: 1,
      detail: 'Something else.',
    });
  });

  it('script output with carriage returns (do shell script) is split into lines', () => {
    const outcome = classifyRun(run({ code: 1, stderr: 'execution error: install-helper: a\rinstall-helper: error: b (2)' }));
    expect(outcome).toEqual({ kind: 'failed', exitCode: 2, detail: 'install-helper: error: b' });
  });
});

describe('plainDetail', () => {
  it('drops control characters and bounds the length', () => {
    expect(plainDetail('a\u0000b\u001b[31mc\u2028d')).toBe('a b [31mc d');
    const long = plainDetail('x'.repeat(1000));
    expect(long).toHaveLength(MAX_DETAIL_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('checkPackage on a real folder', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rs-installer-')));
    await chmod(dir, 0o755);
    for (const name of [INSTALL_SCRIPT, ...HELPER_PACKAGE_FILES]) await writeFile(path.join(dir, name), 'x', { mode: 0o644 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const files = [INSTALL_SCRIPT, ...HELPER_PACKAGE_FILES];
  const uid = process.getuid?.() ?? -1;
  const nodeFs: PackageFileSystem = { lstat: (file) => import('node:fs/promises').then((fs) => fs.lstat(file)), realpath };

  it('accepts a package of the user, mode 0644 / 0755', async () => {
    expect(await checkPackage(dir, files, uid, nodeFs)).toEqual({ ok: true, dir });
  });

  it('refuses a symbolic link to the script and a group-writable binary', async () => {
    await rm(path.join(dir, INSTALL_SCRIPT));
    await writeFile(path.join(dir, 'real.sh'), 'x', { mode: 0o644 });
    await symlink(path.join(dir, 'real.sh'), path.join(dir, INSTALL_SCRIPT));
    expect(await checkPackage(dir, files, uid, nodeFs)).toMatchObject({ ok: false });
    await rm(path.join(dir, INSTALL_SCRIPT));
    await writeFile(path.join(dir, INSTALL_SCRIPT), 'x', { mode: 0o644 });
    await chmod(path.join(dir, HELPER_PACKAGE_FILES[0]), 0o664);
    expect(await checkPackage(dir, files, uid, nodeFs)).toMatchObject({ ok: false });
  });

  it('refuses the folder reached through a symbolic link, and a file owned by someone else', async () => {
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      expect(await checkPackage(link, files, uid, nodeFs)).toMatchObject({ ok: false });
    } finally {
      await rm(link);
    }
    expect(await checkPackage(dir, files, uid + 1, nodeFs)).toMatchObject({ ok: false });
  });

  it('refuses a folder in place of a file', async () => {
    await rm(path.join(dir, HELPER_PACKAGE_FILES[1]));
    await mkdir(path.join(dir, HELPER_PACKAGE_FILES[1]));
    expect(await checkPackage(dir, files, uid, nodeFs)).toMatchObject({ ok: false });
  });
});

describe('runWithExecFile (child_process mocked: osascript never runs)', () => {
  it('execFile by absolute path, argument array, no shell, a bare environment, bounded; exit 0 is done', async () => {
    childProcess.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, 'out', '');
    });
    const args = elevationArgs([BASH, '/x/install-helper.sh', '/x']);
    expect(await runWithExecFile(OSASCRIPT, args)).toEqual({ code: 0, stdout: 'out', stderr: '', timedOut: false });
    const [file, passed, options] = childProcess.execFile.mock.calls[0] ?? [];
    expect(file).toBe('/usr/bin/osascript');
    expect(passed).toEqual(args);
    expect(options).toMatchObject({ shell: false, timeout: 600_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } });
    expect(Object.keys(options?.['env'] as object).sort()).toEqual(['LANG', 'PATH']);
  });

  it('a non-zero exit keeps the code and stderr; a kill by the timeout is timedOut; a spawn error keeps its message', async () => {
    childProcess.execFile.mockImplementationOnce((_f, _a, _o, callback) => {
      callback(Object.assign(new Error('Command failed'), { code: 1 }), '', 'execution error: User canceled. (-128)');
    });
    expect(await runWithExecFile(OSASCRIPT, [])).toEqual({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)', timedOut: false });
    childProcess.execFile.mockImplementationOnce((_f, _a, _o, callback) => {
      callback(Object.assign(new Error('killed'), { killed: true }), '', '');
    });
    expect(await runWithExecFile(OSASCRIPT, [])).toMatchObject({ code: null, timedOut: true });
    childProcess.execFile.mockImplementationOnce((_f, _a, _o, callback) => {
      callback(Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' }), '', '');
    });
    expect(await runWithExecFile(OSASCRIPT, [])).toEqual({ code: null, stdout: '', stderr: 'spawn /usr/bin/osascript ENOENT', timedOut: false });
  });
});
