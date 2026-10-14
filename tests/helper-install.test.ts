// scripts/install-helper.sh, scripts/uninstall.sh and the LaunchDaemon plist (TASK-115).
//
// The scripts run for real, but never on the system: every run sets ROUTESWITCH_TEST_ROOT to a
// temporary directory (the scripts put it in front of every path and refuse it as root) and puts
// stubs of launchctl, chown and sleep first on PATH. The stubs only write to the temporary
// directory. cp, mv, rm, mkdir, chmod, xattr and plutil are the real ones, on files under the
// temporary root only. The tests refuse to run as root.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LAUNCHD_LABEL, PATHS, RESOLVER_MARKER } from '@routeswitch/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { SHUTDOWN_EXIT_TIMEOUT_SEC } from '../packages/helper/src/main';
import { assertFsGuardInstalled } from '../packages/helper/src/test-fs-guard-check';

assertFsGuardInstalled();
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  throw new Error('the install script tests never run as root');
}

const REPO = realpathSync(join(import.meta.dirname, '..'));
const INSTALL = join(REPO, 'scripts', 'install-helper.sh');
const UNINSTALL = join(REPO, 'scripts', 'uninstall.sh');
const PLIST = join(REPO, 'packages', 'helper', 'launchd', `${LAUNCHD_LABEL}.plist`);
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runFile = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, [...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A short temporary directory: unix socket paths are limited to 104 bytes. */
const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)));
  cleanups.push(dir);
  return dir;
};

const LAUNCHCTL_STUB = `#!/bin/bash
set -u
state="$STUB_DIR/state"
printf 'launchctl %s\\n' "$*" >>"$STUB_DIR/calls"
case "$1" in
  print)
    if [[ -f "$state/linger" ]]; then
      left="$(cat "$state/linger")"
      if [[ "$left" -gt 0 ]]; then
        printf '%s\\n' "$((left - 1))" >"$state/linger"
        printf 'state = running\\n'
        exit 0
      fi
      rm -f "$state/linger" "$state/loaded"
    fi
    if [[ -f "$state/loaded" ]]; then printf '%s\\n' "\${STUB_PRINT_STATE:-state = running}"; exit 0; fi
    printf 'Could not find service\\n' >&2
    exit 113
    ;;
  bootout)
    [[ -f "$state/loaded" ]] || { printf 'Boot-out failed: 3: No such process\\n' >&2; exit 3; }
    if [[ -n "\${STUB_BOOTOUT_LINGER:-}" ]]; then printf '%s\\n' "$STUB_BOOTOUT_LINGER" >"$state/linger"; else rm -f "$state/loaded"; fi
    [[ -n "\${STUB_KEEP_SOCKET:-}" ]] || rm -f "$STUB_ROOT/var/run/routeswitch.sock"
    exit "\${STUB_BOOTOUT_EXIT:-0}"
    ;;
  bootstrap)
    tries="$(cat "$state/bootstrap-tries" 2>/dev/null || printf '0')"
    printf '%s\\n' "$((tries + 1))" >"$state/bootstrap-tries"
    if [[ "$tries" -lt "\${STUB_BOOTSTRAP_FAILS:-0}" ]]; then printf 'Bootstrap failed: 5: Input/output error\\n' >&2; exit 5; fi
    [[ ! -f "$state/loaded" ]] || { printf 'Bootstrap failed: 37: Operation already in progress\\n' >&2; exit 37; }
    touch "$state/loaded"
    if [[ -z "\${STUB_NO_SOCKET:-}" ]]; then
      "$STUB_NODE" -e 'const s=require("net").createServer();s.listen(process.argv[1],()=>process.exit(0))' "$STUB_ROOT/var/run/routeswitch.sock"
    fi
    exit 0
    ;;
  enable) exit 0 ;;
  *) printf 'unexpected launchctl call\\n' >&2; exit 64 ;;
esac
`;

const RECORDING_STUB = (name: string): string => `#!/bin/bash
printf '${name} %s\\n' "$*" >>"$STUB_DIR/calls"
exit 0
`;

/** The helper binary: answers --version and --uninstall, records every call. */
const HELPER_STUB = `#!/bin/bash
printf 'helper %s\\n' "$*" >>"$STUB_DIR/calls"
if [[ -n "\${NODE_OPTIONS+set}" ]]; then printf 'helper-env NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" >>"$STUB_DIR/calls"; fi
case "\${1:-}" in
  --version) [[ -z "\${STUB_BROKEN_BINARY:-}" ]] || exit 1; printf '0.0.0\\n' ;;
  --uninstall) printf 'the running helper removed its routes and resolver files\\n'; exit "\${STUB_UNINSTALL_EXIT:-0}" ;;
  *) exit 2 ;;
esac
`;

interface Sandbox {
  /** The fake system root (ROUTESWITCH_TEST_ROOT). */
  readonly root: string;
  /** The app's resources directory: the helper stub and the real plist. */
  readonly resources: string;
  /** `root` + a system path. */
  at(path: string): string;
  run(script: string, args?: readonly string[], env?: Record<string, string>): Promise<Result>;
  /** Every stubbed call so far, in order: `launchctl …`, `chown …`, `sleep …`, `helper …`. */
  calls(): string[];
  /** Puts the service into the "loaded" state of the launchctl stub. */
  markLoaded(): void;
  isLoaded(): boolean;
  clearCalls(): void;
}

const sandbox = (): Sandbox => {
  const base = tempDir('rs-');
  const root = join(base, 'r');
  const stubs = join(base, 'bin');
  const stubDir = join(base, 'stub');
  const resources = join(base, 'res');
  for (const dir of [root, stubs, join(stubDir, 'state'), resources, join(root, 'var', 'run')]) mkdirSync(dir, { recursive: true });
  const executable = (path: string, content: string): void => {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  };
  executable(join(stubs, 'launchctl'), LAUNCHCTL_STUB);
  executable(join(stubs, 'chown'), RECORDING_STUB('chown'));
  executable(join(stubs, 'sleep'), RECORDING_STUB('sleep'));
  executable(join(resources, LAUNCHD_LABEL), HELPER_STUB);
  writeFileSync(join(resources, `${LAUNCHD_LABEL}.plist`), readFileSync(PLIST));
  const callsFile = join(stubDir, 'calls');
  return {
    root,
    resources,
    at: (path) => `${root}${path}`,
    run: (script, args = [], env = {}) =>
      runFile(script, args, {
        PATH: `${stubs}:${SYSTEM_PATH}`,
        ROUTESWITCH_TEST_ROOT: root,
        STUB_DIR: stubDir,
        STUB_ROOT: root,
        STUB_NODE: process.execPath,
        ...env,
      }),
    calls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter((line) => line !== '') : []),
    markLoaded: () => {
      writeFileSync(join(stubDir, 'state', 'loaded'), '');
    },
    isLoaded: () => existsSync(join(stubDir, 'state', 'loaded')),
    clearCalls: () => {
      rmSync(callsFile, { force: true });
    },
  };
};

const mode = (path: string): number => statSync(path).mode & 0o7777;

/** Every path under `dir`, relative, sorted (directories included). */
const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort() : []);

/** `readonly NAME='value'` and `readonly NAME=123` lines of a script. */
const constantsOf = (script: string): Record<string, string> => {
  const constants: Record<string, string> = {};
  for (const line of readFileSync(script, 'utf8').split('\n')) {
    const match = /^readonly ([A-Z_]+)=(?:'([^']*)'|(\d+))$/.exec(line);
    if (match?.[1] !== undefined) constants[match[1]] = match[2] ?? match[3] ?? '';
  }
  return constants;
};

// ---------------------------------------------------------------------------

describe('LaunchDaemon plist', () => {
  it('is a valid plist with the documented keys, every value taken from PATHS and main.ts', async () => {
    const dir = tempDir('rs-plist-');
    const copy = join(dir, 'p.plist');
    writeFileSync(copy, readFileSync(PLIST));
    expect(await runFile('/usr/bin/plutil', ['-lint', copy], { PATH: SYSTEM_PATH })).toMatchObject({ code: 0 });
    const json = await runFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', copy], { PATH: SYSTEM_PATH });
    expect(JSON.parse(json.stdout)).toEqual({
      Label: LAUNCHD_LABEL,
      ProgramArguments: [PATHS.helperBinary],
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      ExitTimeOut: SHUTDOWN_EXIT_TIMEOUT_SEC,
      StandardErrorPath: PATHS.log,
    });
  });

  it('sets no environment and no user: the helper runs as root with launchd defaults only', () => {
    const text = readFileSync(PLIST, 'utf8');
    for (const key of ['EnvironmentVariables', 'UserName', 'GroupName', 'StandardOutPath', 'WorkingDirectory', 'Program<']) {
      expect(text).not.toContain(`<key>${key}`);
    }
  });
});

describe('scripts: shape and the paths they share with PATHS', () => {
  it.each([INSTALL, UNINSTALL])('%s: bash, strict mode, executable, valid syntax, no recursive delete', async (script) => {
    const text = readFileSync(script, 'utf8');
    expect(text.startsWith('#!/bin/bash\n')).toBe(true);
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(mode(script) & 0o111).toBe(0o111);
    expect(await runFile('/bin/bash', ['-n', script], { PATH: SYSTEM_PATH })).toMatchObject({ code: 0 });
    expect(text).not.toMatch(/\brm\s+(-[a-zA-Z]*r|--recursive)/);
    expect(text).not.toMatch(/\beval\b/);
  });

  it.each([INSTALL, UNINSTALL])('%s: every system path is one of PATHS', (script) => {
    const constants = constantsOf(script);
    const expected: Record<string, string> = {
      LABEL: LAUNCHD_LABEL,
      HELPER_BINARY: PATHS.helperBinary,
      LAUNCH_DAEMON_PLIST: PATHS.launchDaemonPlist,
      SUPPORT_DIR: PATHS.supportDir,
      LOG_DIR: PATHS.logDir,
      LOG_FILE: PATHS.log,
      SOCKET: PATHS.socket,
      NEWSYSLOG_CONF: PATHS.newsyslogConf,
      CONFIG_FILE: PATHS.config,
      STATE_FILE: PATHS.state,
      HELPER_EXIT_TIMEOUT_SEC: String(SHUTDOWN_EXIT_TIMEOUT_SEC),
    };
    const named = Object.keys(constants).filter((name) => name in expected);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const name of named) expect([name, constants[name]]).toEqual([name, expected[name]]);

    // No system path outside those constants (comments aside): a path written twice drifts.
    const literals = readFileSync(script, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && !line.startsWith('readonly '))
      .flatMap((line) => line.match(/\/(?:Library|var|etc|private)\/[^\s"'}]*/g) ?? []);
    expect(literals).toEqual([]);
  });

  it('the build script produces the binary the install script expects', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const { scripts } = manifest;
    expect(scripts['build:helper']).toBe('npm run build:helper:bundle && npm run build:helper:arm64 && npm run build:helper:x64 && npm run build:helper:universal');
    expect(scripts['build:helper:universal']).toContain(`-output build/${LAUNCHD_LABEL} `);
    expect(scripts['build:helper:universal']).toContain(`--identifier ${LAUNCHD_LABEL}`);
    // One pinned Node for both slices, of the major the bundle targets.
    const arm = /--targets node(\d+)\.(\d+)\.(\d+)-macos-arm64 /.exec(scripts['build:helper:arm64'] ?? '');
    const x64 = /--targets node(\d+)\.(\d+)\.(\d+)-macos-x64 /.exec(scripts['build:helper:x64'] ?? '');
    expect(arm?.slice(1)).toEqual(x64?.slice(1));
    expect(scripts['build:helper:bundle']).toContain(`--target=node${arm?.[1] ?? '?'} `);
    expect(scripts['build:helper:bundle']).toContain('--define:import.meta.main=true');
    expect(manifest.devDependencies['@yao-pkg/pkg']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies['esbuild']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('install-helper.sh', () => {
  const expectInstalled = (box: Sandbox): void => {
    const binary = box.at(PATHS.helperBinary);
    expect(readFileSync(binary, 'utf8')).toBe(HELPER_STUB);
    expect(mode(binary)).toBe(0o755);
    expect(readFileSync(box.at(PATHS.launchDaemonPlist))).toEqual(readFileSync(PLIST));
    expect(mode(box.at(PATHS.launchDaemonPlist))).toBe(0o644);
    for (const dir of [PATHS.supportDir, PATHS.logDir, '/Library/PrivilegedHelperTools']) expect(mode(box.at(dir))).toBe(0o755);
    const rotation = readFileSync(box.at(PATHS.newsyslogConf), 'utf8');
    expect(mode(box.at(PATHS.newsyslogConf))).toBe(0o644);
    expect(rotation).toContain('# managed-by: routeswitch');
    expect(rotation.split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual([
      `${PATHS.log}   root:wheel     644   5      5120      *     JN`,
    ]);
    // No temporary file is left anywhere.
    expect(tree(box.root).filter((path) => path.includes('.install.'))).toEqual([]);
  };

  it('installs into an empty system: files, owners, modes, then starts the daemon', async () => {
    const box = sandbox();
    const result = await box.run(INSTALL, [box.resources]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expectInstalled(box);
    expect(result.stdout).toContain('installed helper 0.0.0');
    expect(result.stdout).toContain('the helper is running (system/com.routeswitch.helper)');

    const calls = box.calls();
    // Every file and directory of ours is root:wheel; system directories that already exist are left alone.
    for (const path of [PATHS.supportDir, PATHS.logDir, '/Library/PrivilegedHelperTools']) {
      expect(calls).toContain(`chown root:wheel ${box.at(path)}`);
    }
    for (const dest of [PATHS.helperBinary, PATHS.launchDaemonPlist, PATHS.newsyslogConf]) {
      const temporary = `${box.at(dest.slice(0, dest.lastIndexOf('/')))}/.${dest.slice(dest.lastIndexOf('/') + 1)}.install.`;
      expect(calls.some((call) => call.startsWith(`chown root:wheel ${temporary}`))).toBe(true);
    }
    // The new binary was checked before anything was started.
    expect(calls.filter((call) => !call.startsWith('chown'))).toEqual([
      expect.stringMatching(/^helper --version$/),
      'launchctl print system/com.routeswitch.helper',
      'launchctl enable system/com.routeswitch.helper',
      `launchctl bootstrap system ${box.at(PATHS.launchDaemonPlist)}`,
      'launchctl print system/com.routeswitch.helper',
    ]);
    expect(box.isLoaded()).toBe(true);
  });

  it('takes a resources directory whose path has spaces (an app bundle in a folder with a space)', async () => {
    const box = sandbox();
    const spaced = join(box.root, '..', 'My Apps', 'Route Switch.app', 'Contents', 'Resources', 'helper');
    mkdirSync(spaced, { recursive: true });
    for (const name of [LAUNCHD_LABEL, `${LAUNCHD_LABEL}.plist`]) {
      writeFileSync(join(spaced, name), readFileSync(join(box.resources, name)));
    }
    chmodSync(join(spaced, LAUNCHD_LABEL), 0o755);
    expect(await box.run(INSTALL, [spaced])).toMatchObject({ code: 0, stderr: '' });
    expectInstalled(box);
  });

  it('drops extended attributes such as a quarantine flag copied out of a downloaded app', async () => {
    const box = sandbox();
    const source = join(box.resources, LAUNCHD_LABEL);
    expect(await runFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;RouteSwitch;', source], { PATH: SYSTEM_PATH })).toMatchObject({ code: 0 });
    expect((await runFile('/usr/bin/xattr', [source], { PATH: SYSTEM_PATH })).stdout).toContain('com.apple.quarantine');
    expect(await box.run(INSTALL, [box.resources])).toMatchObject({ code: 0 });
    for (const path of [PATHS.helperBinary, PATHS.launchDaemonPlist]) {
      // Only the quarantine flag matters; macOS may add `com.apple.provenance` by itself.
      const listed = await runFile('/usr/bin/xattr', [box.at(path)], { PATH: SYSTEM_PATH });
      expect(listed.code).toBe(0);
      expect(listed.stdout).not.toContain('com.apple.quarantine');
    }
  });

  it('is idempotent: an update replaces the files, keeps config.json and state.json, and restarts the daemon', async () => {
    const box = sandbox();
    expect(await box.run(INSTALL, [box.resources])).toMatchObject({ code: 0 });
    writeFileSync(box.at(PATHS.config), '{"version":1,"rules":[]}');
    writeFileSync(box.at(PATHS.state), '{"version":1,"routes":[]}');
    const before = { config: statSync(box.at(PATHS.config)).mtimeMs, state: statSync(box.at(PATHS.state)).mtimeMs };
    const firstTree = tree(box.root);
    box.clearCalls();

    const result = await box.run(INSTALL, [box.resources]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expectInstalled(box);
    expect(tree(box.root)).toEqual(firstTree);
    expect(readFileSync(box.at(PATHS.config), 'utf8')).toBe('{"version":1,"rules":[]}');
    expect({ config: statSync(box.at(PATHS.config)).mtimeMs, state: statSync(box.at(PATHS.state)).mtimeMs }).toEqual(before);
    const launchctl = box.calls().filter((call) => call.startsWith('launchctl'));
    expect(launchctl).toEqual([
      'launchctl print system/com.routeswitch.helper',
      'launchctl bootout system/com.routeswitch.helper',
      'launchctl print system/com.routeswitch.helper',
      'launchctl enable system/com.routeswitch.helper',
      `launchctl bootstrap system ${box.at(PATHS.launchDaemonPlist)}`,
      'launchctl print system/com.routeswitch.helper',
    ]);
  });

  it('waits while the old helper still cleans up after bootout, then starts the new one', async () => {
    const box = sandbox();
    box.markLoaded();
    const result = await box.run(INSTALL, [box.resources], { STUB_BOOTOUT_LINGER: '3', STUB_BOOTOUT_EXIT: '36' });
    expect(result).toMatchObject({ code: 0 });
    expect(box.calls().filter((call) => call.startsWith('sleep'))).toEqual(['sleep 1', 'sleep 1', 'sleep 1']);
    expect(box.calls()).toContain(`launchctl bootstrap system ${box.at(PATHS.launchDaemonPlist)}`);
  });

  it('gives up when the old helper does not stop within ExitTimeOut + 10 s, without starting a second one', async () => {
    const box = sandbox();
    box.markLoaded();
    const result = await box.run(INSTALL, [box.resources], { STUB_BOOTOUT_LINGER: '1000' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`did not stop within ${String(SHUTDOWN_EXIT_TIMEOUT_SEC + 10)} s`);
    expect(box.calls().filter((call) => call === 'sleep 1')).toHaveLength(SHUTDOWN_EXIT_TIMEOUT_SEC + 10);
    expect(box.calls().some((call) => call.startsWith('launchctl bootstrap'))).toBe(false);
  });

  it('retries a bootstrap launchd refuses right after the bootout, then gives up after 5 attempts', async () => {
    const retried = sandbox();
    expect(await retried.run(INSTALL, [retried.resources], { STUB_BOOTSTRAP_FAILS: '2' })).toMatchObject({ code: 0 });
    expect(retried.calls().filter((call) => call.startsWith('launchctl bootstrap'))).toHaveLength(3);

    const refused = sandbox();
    const result = await refused.run(INSTALL, [refused.resources], { STUB_BOOTSTRAP_FAILS: '99' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('launchctl bootstrap failed');
    expect(refused.calls().filter((call) => call.startsWith('launchctl bootstrap'))).toHaveLength(5);
  });

  it('fails when the helper does not come up with its socket', async () => {
    const box = sandbox();
    const result = await box.run(INSTALL, [box.resources], { STUB_NO_SOCKET: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not running with its socket after 20 s');
    expect(box.calls().filter((call) => call === 'sleep 1')).toHaveLength(20);

    const waiting = sandbox();
    const stalled = await waiting.run(INSTALL, [waiting.resources], { STUB_PRINT_STATE: 'state = spawn scheduled' });
    expect(stalled.code).toBe(1);
  });

  it.each([
    ['a binary that does not run', { STUB_BROKEN_BINARY: '1' }, 'the new helper binary does not run'],
    ['an invalid plist', {}, 'the new plist is not valid'],
  ])('replaces nothing and stops nothing for %s', async (name, env, message) => {
    const box = sandbox();
    expect(await box.run(INSTALL, [box.resources])).toMatchObject({ code: 0 });
    const installed = { binary: readFileSync(box.at(PATHS.helperBinary)), plist: readFileSync(box.at(PATHS.launchDaemonPlist)) };
    if (name === 'an invalid plist') writeFileSync(join(box.resources, `${LAUNCHD_LABEL}.plist`), '<plist><dict><key>Label</key></dict>');
    else writeFileSync(join(box.resources, LAUNCHD_LABEL), `${HELPER_STUB}# new\n`);
    box.clearCalls();

    const result = await box.run(INSTALL, [box.resources], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readFileSync(box.at(PATHS.helperBinary))).toEqual(installed.binary);
    expect(readFileSync(box.at(PATHS.launchDaemonPlist))).toEqual(installed.plist);
    expect(box.calls().filter((call) => call.startsWith('launchctl'))).toEqual([]);
    expect(box.isLoaded()).toBe(true);
    expect(tree(box.root).filter((path) => path.includes('.install.'))).toEqual([]);
  });

  it.each([
    ['no argument', [], 2, 'Usage:'],
    ['two arguments', ['/a', '/b'], 2, 'Usage:'],
    ['a relative path', ['res'], 1, 'must be an absolute path'],
    ['a missing directory', ['/nonexistent-routeswitch'], 1, 'not a directory'],
  ])('refuses %s and touches nothing', async (_name, args, code, message) => {
    const box = sandbox();
    const result = await box.run(INSTALL, args);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
    expect(tree(box.root)).toEqual(['var', 'var/run']);
    expect(box.calls()).toEqual([]);
  });

  it('refuses a resources directory with a symbolic link for the binary, and a destination that is a link', async () => {
    const linked = sandbox();
    rmSync(join(linked.resources, LAUNCHD_LABEL));
    symlinkSync('/bin/ls', join(linked.resources, LAUNCHD_LABEL));
    const result = await linked.run(INSTALL, [linked.resources]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing or not a regular file');
    expect(tree(linked.root)).toEqual(['var', 'var/run']);

    const target = sandbox();
    const elsewhere = join(target.root, 'elsewhere.plist');
    writeFileSync(elsewhere, 'theirs');
    mkdirSync(target.at('/Library/LaunchDaemons'), { recursive: true });
    symlinkSync(elsewhere, target.at(PATHS.launchDaemonPlist));
    const refused = await target.run(INSTALL, [target.resources]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`refusing a symbolic link: ${target.at(PATHS.launchDaemonPlist)}`);
    expect(readFileSync(elsewhere, 'utf8')).toBe('theirs');
    expect(target.calls().some((call) => call.startsWith('launchctl'))).toBe(false);
  });

  it.each([
    ['/Library/PrivilegedHelperTools', 'own'],
    [PATHS.supportDir, 'own'],
    [PATHS.logDir, 'own'],
    ['/Library/LaunchDaemons', 'system'],
    ['/etc/newsyslog.d', 'system'],
  ])('refuses a planted directory symlink at %s (%s directory): nothing reaches its target', async (path) => {
    const box = sandbox();
    const target = join(box.root, 'target');
    mkdirSync(target);
    chmodSync(target, 0o700);
    writeFileSync(join(target, 'keep'), 'theirs');
    mkdirSync(box.at(path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    symlinkSync(target, box.at(path));

    const result = await box.run(INSTALL, [box.resources]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`refusing a symbolic link: ${box.at(path)}`);
    expect(mode(target)).toBe(0o700);
    expect(readdirSync(target)).toEqual(['keep']);
    expect(box.calls().filter((call) => call.includes(box.at(path)) || call.includes(target))).toEqual([]);
    expect(box.calls().some((call) => call.startsWith('launchctl'))).toBe(false);
  });

  it('refuses a newsyslog file that is a symbolic link, and leaves its target alone', async () => {
    const box = sandbox();
    const target = join(box.root, 'elsewhere.conf');
    writeFileSync(target, 'theirs');
    mkdirSync(box.at('/etc/newsyslog.d'), { recursive: true });
    symlinkSync(target, box.at(PATHS.newsyslogConf));
    const result = await box.run(INSTALL, [box.resources]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`refusing a symbolic link: ${box.at(PATHS.newsyslogConf)}`);
    expect(readFileSync(target, 'utf8')).toBe('theirs');
    expect(lstatSync(box.at(PATHS.newsyslogConf)).isSymbolicLink()).toBe(true);
    expect(box.calls().some((call) => call.startsWith('launchctl'))).toBe(false);
  });

  it('runs the new binary without the caller\'s NODE_OPTIONS', async () => {
    const box = sandbox();
    expect(await box.run(INSTALL, [box.resources], { NODE_OPTIONS: '--require=/tmp/evil.js' })).toMatchObject({ code: 0 });
    expect(box.calls()).toContain('helper --version');
    expect(box.calls().filter((call) => call.startsWith('helper-env'))).toEqual([]);
  });

  it('refuses to run without root when not in test mode, before touching anything', async () => {
    const box = sandbox();
    const result = await runFile(INSTALL, [box.resources], { PATH: SYSTEM_PATH });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must run as root');
    expect(box.calls()).toEqual([]);
  });

  it('refuses a test root that is not an existing absolute directory', async () => {
    const box = sandbox();
    for (const value of ['relative/dir', '/nonexistent-routeswitch-root']) {
      const result = await box.run(INSTALL, [box.resources], { ROUTESWITCH_TEST_ROOT: value });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ROUTESWITCH_TEST_ROOT must be an existing absolute directory');
    }
    expect(box.calls()).toEqual([]);
  });
});

describe('uninstall.sh', () => {
  /** An installed helper with everything it writes while it runs, plus crash leftovers. */
  const installed = async (): Promise<Sandbox> => {
    const box = sandbox();
    expect(await box.run(INSTALL, [box.resources])).toMatchObject({ code: 0 });
    writeFileSync(box.at(PATHS.config), '{"version":1,"rules":[]}');
    writeFileSync(box.at(PATHS.state), '{"version":1,"routes":[]}');
    writeFileSync(box.at(`${PATHS.supportDir}/.config.json.routeswitch.tmp`), '');
    writeFileSync(box.at(PATHS.log), '{"level":"info"}\n');
    writeFileSync(box.at(`${PATHS.log}.0.bz2`), '');
    writeFileSync(box.at(`${PATHS.log}.1.bz2`), '');
    writeFileSync(box.at(`${PATHS.helperBinary.slice(0, PATHS.helperBinary.lastIndexOf('/'))}/.${LAUNCHD_LABEL}.install.4242`), '');
    box.clearCalls();
    return box;
  };

  it('asks the helper to clean up first, then boots it out, then removes every file of ours and nothing else', async () => {
    const box = await installed();
    mkdirSync(box.at('/etc/resolver'), { recursive: true });
    writeFileSync(box.at('/etc/resolver/user.example'), 'nameserver 192.0.2.53\n');
    writeFileSync(box.at('/Library/LaunchDaemons/com.example.other.plist'), 'other');

    const result = await box.run(UNINSTALL);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('the running helper removed its routes and resolver files');
    expect(result.stdout).toContain('done: the RouteSwitch helper is uninstalled');
    expect(box.calls()).toEqual([
      'helper --uninstall',
      'launchctl print system/com.routeswitch.helper',
      'launchctl bootout system/com.routeswitch.helper',
      'launchctl print system/com.routeswitch.helper',
      'launchctl print system/com.routeswitch.helper',
    ]);
    // Left: the system directories, other software's files, the user's resolver file.
    expect(tree(box.root)).toEqual([
      'Library',
      'Library/Application Support',
      'Library/LaunchDaemons',
      'Library/LaunchDaemons/com.example.other.plist',
      'Library/Logs',
      'Library/PrivilegedHelperTools',
      'etc',
      'etc/newsyslog.d',
      'etc/resolver',
      'etc/resolver/user.example',
      'var',
      'var/run',
    ]);
    expect(box.isLoaded()).toBe(false);
  });

  it('removes a socket left by a killed helper, and only a socket', async () => {
    const box = await installed();
    // The stub's bootout removes the socket like a helper that stops; this one was killed and left it,
    // with the temporary socket of a start that did not finish.
    const temporary = box.at(`/var/run/.routeswitch.sock.4242.tmp`);
    await runFile(process.execPath, ['-e', 'const s=require("net").createServer();s.listen(process.argv[1],()=>process.exit(0))', temporary], {});
    expect(lstatSync(box.at(PATHS.socket)).isSocket()).toBe(true);
    expect(lstatSync(temporary).isSocket()).toBe(true);
    const result = await box.run(UNINSTALL, [], { STUB_KEEP_SOCKET: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`removed ${box.at(PATHS.socket)}`);
    expect(existsSync(box.at(PATHS.socket))).toBe(false);
    expect(existsSync(temporary)).toBe(false);

    const other = sandbox();
    writeFileSync(other.at(PATHS.socket), 'not a socket');
    expect(await other.run(UNINSTALL)).toMatchObject({ code: 0 });
    expect(readFileSync(other.at(PATHS.socket), 'utf8')).toBe('not a socket');
  });

  it('stops and removes nothing when the helper cannot confirm the cleanup', async () => {
    const box = await installed();
    const before = tree(box.root);
    const result = await box.run(UNINSTALL, [], { STUB_UNINSTALL_EXIT: '8' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the helper could not confirm the cleanup (exit 8); nothing was removed');
    expect(box.calls()).toEqual(['helper --uninstall']);
    expect(tree(box.root)).toEqual(before);
    expect(box.isLoaded()).toBe(true);
  });

  it('--force goes on after a failed cleanup', async () => {
    const box = await installed();
    const result = await box.run(UNINSTALL, ['--force'], { STUB_UNINSTALL_EXIT: '8' });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('going on because of --force');
    expect(existsSync(box.at(PATHS.helperBinary))).toBe(false);
    expect(existsSync(box.at(PATHS.state))).toBe(false);
    expect(box.isLoaded()).toBe(false);
  });

  it('without the binary: refuses while state.json lists routes, unless --force', async () => {
    const box = await installed();
    rmSync(box.at(PATHS.helperBinary));
    const before = tree(box.root);
    const refused = await box.run(UNINSTALL);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('run with --force');
    expect(tree(box.root)).toEqual(before);

    const forced = await box.run(UNINSTALL, ['--force']);
    expect(forced.code).toBe(0);
    expect(existsSync(box.at(PATHS.state))).toBe(false);
  });

  it('is idempotent: a second run on an uninstalled system changes nothing and exits 0', async () => {
    const box = await installed();
    expect(await box.run(UNINSTALL)).toMatchObject({ code: 0 });
    const after = tree(box.root);
    box.clearCalls();
    const again = await box.run(UNINSTALL);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).toContain('no route of RouteSwitch is on record');
    expect(tree(box.root)).toEqual(after);
    expect(box.calls()).toEqual(['launchctl print system/com.routeswitch.helper', 'launchctl print system/com.routeswitch.helper']);
  });

  it('leaves a directory holding files RouteSwitch did not create, with a warning', async () => {
    const box = await installed();
    writeFileSync(box.at(`${PATHS.supportDir}/notes.txt`), 'mine');
    const result = await box.run(UNINSTALL);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`left in place (holds files RouteSwitch did not create): ${box.at(PATHS.supportDir)}`);
    expect(readdirSync(box.at(PATHS.supportDir))).toEqual(['notes.txt']);
    expect(existsSync(box.at(PATHS.logDir))).toBe(false);
  });

  it('never follows a symbolic link: a linked log directory stays, and so does what it points to', async () => {
    const box = await installed();
    const outside = join(box.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'helper.log'), 'outside');
    rmSync(box.at(PATHS.logDir), { recursive: true });
    symlinkSync(outside, box.at(PATHS.logDir));
    const result = await box.run(UNINSTALL);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`left in place (its directory is a symbolic link): ${box.at(PATHS.log)}`);
    expect(lstatSync(box.at(PATHS.logDir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'helper.log'), 'utf8')).toBe('outside');
  });

  it('stops before removing files when the helper does not stop in time', async () => {
    const box = await installed();
    const result = await box.run(UNINSTALL, [], { STUB_BOOTOUT_LINGER: '1000' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`did not stop within ${String(SHUTDOWN_EXIT_TIMEOUT_SEC + 10)} s`);
    expect(existsSync(box.at(PATHS.helperBinary))).toBe(true);
    expect(existsSync(box.at(PATHS.launchDaemonPlist))).toBe(true);
  });

  it('never runs a symbolic link in place of the binary', async () => {
    const box = await installed();
    const target = join(box.root, 'planted');
    writeFileSync(target, '#!/bin/bash\nprintf "planted %s\\n" "$*" >>"$STUB_DIR/calls"\n');
    chmodSync(target, 0o755);
    rmSync(box.at(PATHS.helperBinary));
    symlinkSync(target, box.at(PATHS.helperBinary));
    const before = tree(box.root);

    const refused = await box.run(UNINSTALL);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('run with --force');
    expect(box.calls().filter((call) => call.startsWith('planted') || call.startsWith('helper'))).toEqual([]);
    expect(tree(box.root)).toEqual(before);

    const forced = await box.run(UNINSTALL, ['--force']);
    expect(forced.code).toBe(0);
    expect(box.calls().filter((call) => call.startsWith('planted'))).toEqual([]);
    expect(existsSync(box.at(PATHS.helperBinary)) || lstatSync(box.at(PATHS.helperBinary), { throwIfNoEntry: false }) !== undefined).toBe(false);
    expect(readFileSync(target, 'utf8')).toContain('planted');
  });

  it('runs the binary without the caller\'s NODE_OPTIONS', async () => {
    const box = await installed();
    expect(await box.run(UNINSTALL, [], { NODE_OPTIONS: '--require=/tmp/evil.js' })).toMatchObject({ code: 0 });
    expect(box.calls()).toContain('helper --uninstall');
    expect(box.calls().filter((call) => call.startsWith('helper-env'))).toEqual([]);
  });

  it('refuses unknown arguments, and running without root outside test mode', async () => {
    const box = await installed();
    expect(await box.run(UNINSTALL, ['--all'])).toMatchObject({ code: 2 });
    const notRoot = await runFile(UNINSTALL, [], { PATH: SYSTEM_PATH });
    expect(notRoot.code).toBe(1);
    expect(notRoot.stderr).toContain('must run as root');
    expect(box.calls()).toEqual([]);
    expect(existsSync(box.at(PATHS.helperBinary))).toBe(true);
  });

  it('never touches /etc/resolver itself: managed files are the helper binary\'s job', () => {
    const code = readFileSync(UNINSTALL, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('/etc/resolver');
    expect(code).not.toContain(RESOLVER_MARKER.slice(2));
  });
});

// Sanity of the harness itself: the stubs, not the system, answered.
describe('test harness', () => {
  it('runs the scripts with the stubs first on PATH and the fake root in front of every path', async () => {
    const box = sandbox();
    expect(await box.run(INSTALL, [box.resources])).toMatchObject({ code: 0 });
    expect(box.calls().some((call) => call.startsWith('launchctl bootstrap system /tmp/') || call.startsWith('launchctl bootstrap system /private/tmp/'))).toBe(true);
    expect(box.root.startsWith(realpathSync(tmpdir())) || box.root.startsWith('/private/tmp/')).toBe(true);
  });
});
