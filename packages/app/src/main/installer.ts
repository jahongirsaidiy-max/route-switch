// Installing (and fully removing) the root helper from the app: the one place
// the app asks for the administrator password.
//
// Elevation is macOS's own: `/usr/bin/osascript` runs `do shell script … with
// administrator privileges`, which shows the system password dialog and runs
// one command as root. No npm package is involved (decision TASK-214: the
// `sudo-prompt` package is unmaintained since 2019 and builds a shell string
// itself; `osascript` is a system binary called through `execFile`, like
// `networksetup` in `settings.ts`).
//
// What reaches root is fixed here and nowhere else:
// - the AppleScript source is a constant, one per UI language
//   (`ELEVATION_SCRIPTS`: only the dialog's sentence differs, written out in
//   full — nothing is interpolated); it takes its words from `argv` and
//   quotes each one with AppleScript's own `quoted form of`, so no path is
//   ever part of the script text;
// - the words are `/bin/bash`, a script of the app's own resources
//   (`install-helper.sh` / `uninstall.sh`) and, for install, the resources
//   directory itself. The page sends no argument at all.
// Before anything runs, the resources directory and every file the script
// uses are checked: real directory / regular files (no symbolic link, by
// `lstat` and `realpath`), owned by root or by the user running the app, and
// writable by nobody else. A package another user could change is refused.

import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { LAUNCHD_LABEL } from '@routeswitch/shared';

import { DEFAULT_LOCALE, isLocale, type Locale } from '../i18n';
import type { RsHelperSetupResult, RsResult } from '../renderer/src/rs';
import type { Logger } from './logger';

/** The system binary that asks for the password; by absolute path, no PATH lookup, no shell. */
export const OSASCRIPT = '/usr/bin/osascript';
/** The shell the scripts are written for (`#!/bin/bash`); passed explicitly, the script's mode does not matter. */
export const BASH = '/bin/bash';

/** The folder inside the app's `Resources` that holds the helper package (TASK-301 `extraResources`). */
export const HELPER_RESOURCES_DIR = 'helper';
export const INSTALL_SCRIPT = 'install-helper.sh';
export const UNINSTALL_SCRIPT = 'uninstall.sh';
/** What `install-helper.sh <resources>` copies: the binary and its LaunchDaemon plist. */
export const HELPER_PACKAGE_FILES = [LAUNCHD_LABEL, `${LAUNCHD_LABEL}.plist`] as const;

/**
 * The text of the system password dialog, per UI language. Fixed: nothing of
 * the page or the system goes into it. Each is also written out, word for
 * word, in its `ELEVATION_SCRIPTS` line (a test holds the two together).
 */
export const PASSWORD_PROMPTS: Readonly<Record<Locale, string>> = {
  uz: "RouteSwitch routing helper'ini boshqarish uchun administrator paroli kerak.",
  ru: 'Для управления helper маршрутизации RouteSwitch нужен пароль администратора.',
  en: 'RouteSwitch needs an administrator password to manage its routing helper.',
};

/** The Uzbek prompt (the default language). */
export const PASSWORD_PROMPT = PASSWORD_PROMPTS.uz;

/** The lines of every script before and after the `do shell script` line. */
const SCRIPT_HEAD = ['on run argv', 'set cmd to ""', 'repeat with arg_ in argv', 'set cmd to cmd & " " & quoted form of (arg_ as text)', 'end repeat'] as const;
const SCRIPT_TAIL = ['end run'] as const;

/**
 * The AppleScript run by `osascript`, one `-e` per line, one per UI language.
 * Its arguments are the command's words; each is quoted by `quoted form of`,
 * and the command runs as root after the system dialog. Constant: the words
 * come only as `argv`, and each language's prompt line is a literal.
 */
export const ELEVATION_SCRIPTS: Readonly<Record<Locale, readonly string[]>> = {
  uz: [
    ...SCRIPT_HEAD,
    'do shell script cmd with prompt "RouteSwitch routing helper\'ini boshqarish uchun administrator paroli kerak." with administrator privileges',
    ...SCRIPT_TAIL,
  ],
  ru: [
    ...SCRIPT_HEAD,
    'do shell script cmd with prompt "Для управления helper маршрутизации RouteSwitch нужен пароль администратора." with administrator privileges',
    ...SCRIPT_TAIL,
  ],
  en: [
    ...SCRIPT_HEAD,
    'do shell script cmd with prompt "RouteSwitch needs an administrator password to manage its routing helper." with administrator privileges',
    ...SCRIPT_TAIL,
  ],
};

/** The Uzbek script (the default language). */
export const ELEVATION_SCRIPT = ELEVATION_SCRIPTS.uz;

/** Install waits for an old helper to stop (≤ 70 s) and the new one to start (≤ 20 s); the user types a password first. */
export const ELEVATION_TIMEOUT_MS = 10 * 60 * 1000;
export const ELEVATION_MAX_OUTPUT_BYTES = 1024 * 1024;
/** How much of the script's error is passed to the page. */
export const MAX_DETAIL_LENGTH = 300;

/** AppleScript error numbers of the password dialog. */
const USER_CANCELED = -128;
/** `errAuthorizationDenied`, `errAuthorizationCanceled`, `errAuthorizationInteractionNotAllowed`. */
const AUTHORIZATION_DENIED = new Set([-60005, -60006, -60007]);

/** What one `osascript` run produced. Never thrown: a spawn failure is `code: null` with the reason in `stderr`. */
export interface ElevationRun {
  /** The exit code of `osascript`; null when it could not start or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs `file` with `args` (no shell). Injected: tests never run `osascript`. */
export type ElevationRunner = (file: string, args: readonly string[]) => Promise<ElevationRun>;

/** The part of `node:fs/promises` used to check the package. */
export interface PackageFileSystem {
  readonly lstat: (file: string) => Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    readonly uid: number;
    readonly mode: number;
  }>;
  readonly realpath: (file: string) => Promise<string>;
}

export interface InstallerDeps {
  /** The app's `Resources/helper` folder (`process.resourcesPath`); null when the app is not packaged (development). */
  readonly resourcesDir: string | null;
  /** The user running the app (`process.getuid()`): with root, the only owner a package file may have. */
  readonly uid: number;
  readonly run: ElevationRunner;
  readonly fs?: PackageFileSystem;
  /** The UI language, for the password dialog's text (`PreferencesStore.language`; never rejects). Uzbek without it. */
  readonly language?: () => Promise<Locale>;
  readonly logger: Logger;
}

export type HelperSetupResult = RsResult<RsHelperSetupResult>;

export interface Installer {
  /** `install-helper.sh <resources>` as root. One run at a time (`busy`). */
  readonly install: () => Promise<HelperSetupResult>;
  /** `uninstall.sh` as root: routes, resolver files, the daemon and its files. One run at a time (`busy`). */
  readonly uninstall: () => Promise<HelperSetupResult>;
}

type Failure = Extract<HelperSetupResult, { ok: false }>;
const failure = (code: Failure['code'], error: string, detail?: string): Failure =>
  detail === undefined ? { ok: false, code, error } : { ok: false, code, error, detail };

/** Control characters (C0, DEL, C1) and the line/paragraph separators: a path holding one is refused, a message loses them. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

type PackageCheck = { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly error: string };

/**
 * Checks the helper package before it is handed to root: the canonical
 * directory (no link anywhere on the way), and each named file in it.
 */
export async function checkPackage(
  resourcesDir: string,
  files: readonly string[],
  uid: number,
  fs: PackageFileSystem,
): Promise<PackageCheck> {
  if (!path.isAbsolute(resourcesDir) || CONTROL.test(resourcesDir)) {
    return { ok: false, error: 'The helper package path is not a plain absolute path' };
  }
  let dir: string;
  try {
    dir = await fs.realpath(resourcesDir);
  } catch {
    return { ok: false, error: 'The helper package folder is missing' };
  }
  if (dir !== path.normalize(resourcesDir) || CONTROL.test(dir)) {
    return { ok: false, error: 'The helper package path goes through a symbolic link' };
  }
  const owned = (entry: { readonly uid: number; readonly mode: number }): boolean =>
    (entry.uid === 0 || entry.uid === uid) && (entry.mode & 0o022) === 0;
  try {
    const folder = await fs.lstat(dir);
    if (folder.isSymbolicLink() || !folder.isDirectory()) return { ok: false, error: 'The helper package is not a folder' };
    if (!owned(folder)) return { ok: false, error: 'The helper package folder can be changed by another user' };
  } catch {
    return { ok: false, error: 'The helper package folder cannot be read' };
  }
  for (const name of files) {
    let entry: Awaited<ReturnType<PackageFileSystem['lstat']>>;
    try {
      entry = await fs.lstat(path.join(dir, name));
    } catch {
      return { ok: false, error: `The helper package has no ${name}` };
    }
    if (entry.isSymbolicLink() || !entry.isFile()) return { ok: false, error: `${name} of the helper package is not a regular file` };
    if (!owned(entry)) return { ok: false, error: `${name} of the helper package can be changed by another user` };
  }
  return { ok: true, dir };
}

/** The `osascript` arguments for one command: the fixed script of the language, then the command's words as `argv`. */
export function elevationArgs(words: readonly string[], locale: Locale = DEFAULT_LOCALE): string[] {
  return [...ELEVATION_SCRIPTS[locale].flatMap((line) => ['-e', line]), ...words];
}

/** One line of text for the page: no control characters, at most `MAX_DETAIL_LENGTH`. */
export function plainDetail(text: string): string {
  const flat = text.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH - 1)}…` : flat;
}

export type ElevationOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'failed'; readonly exitCode: number | null; readonly detail: string };

/**
 * Reads an `osascript` run. A failed `do shell script` ends `osascript` with
 * `… execution error: <message> (<number>)`: a negative number is the
 * dialog's (-128 the user cancelled, -6000x authorization refused), a positive
 * one the script's exit code, `<message>` its stderr.
 */
export function classifyRun(run: ElevationRun): ElevationOutcome {
  if (run.code === 0 && !run.timedOut) return { kind: 'done' };
  if (run.timedOut) return { kind: 'failed', exitCode: null, detail: 'Timed out' };
  const text = run.stderr.trim();
  const match = /execution error: ([\s\S]*?)\s*\((-?\d+)\)\s*$/.exec(text);
  const number = match === null ? null : Number(match[2]);
  if (number === USER_CANCELED) return { kind: 'cancelled' };
  if (number !== null && AUTHORIZATION_DENIED.has(number)) return { kind: 'denied' };
  const message = match === null ? text : (match[1] ?? '');
  // The script's own error line is the useful one (`install-helper: error: …`); else the last line.
  const lines = message.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== '');
  const errorLine = [...lines].reverse().find((line) => /^(install-helper|uninstall): error: /.test(line)) ?? lines.at(-1) ?? '';
  return { kind: 'failed', exitCode: number !== null && number > 0 ? number : run.code, detail: plainDetail(errorLine) };
}

const ACTIONS = {
  install: { script: INSTALL_SCRIPT, files: [INSTALL_SCRIPT, ...HELPER_PACKAGE_FILES], withDir: true, verb: 'install' },
  uninstall: { script: UNINSTALL_SCRIPT, files: [UNINSTALL_SCRIPT], withDir: false, verb: 'uninstall' },
} as const;

/** The language of the password dialog: Uzbek when none is given, the answer is not a language, or it fails. */
async function languageOf(deps: Pick<InstallerDeps, 'language'>): Promise<Locale> {
  if (deps.language === undefined) return DEFAULT_LOCALE;
  const chosen = await deps.language().catch(() => DEFAULT_LOCALE);
  return isLocale(chosen) ? chosen : DEFAULT_LOCALE;
}

export function createInstaller(deps: InstallerDeps): Installer {
  const logger = deps.logger.child({ component: 'installer' });
  const fs: PackageFileSystem = deps.fs ?? { lstat, realpath };
  let running = false;

  const runAs = async (action: keyof typeof ACTIONS): Promise<HelperSetupResult> => {
    const { script, files, withDir, verb } = ACTIONS[action];
    if (running) return failure('busy', 'The helper is already being installed or removed');
    running = true;
    try {
      if (deps.resourcesDir === null) {
        logger.warn('No helper package: the app is not packaged', { action });
        return failure('install-unavailable', 'The helper package is part of the packaged app only');
      }
      const checked = await checkPackage(deps.resourcesDir, files, deps.uid, fs);
      if (!checked.ok) {
        logger.error('Refused the helper package', { action, reason: checked.error });
        return failure('install-unavailable', checked.error);
      }
      const scriptPath = path.join(checked.dir, script);
      const words = withDir ? [BASH, scriptPath, checked.dir] : [BASH, scriptPath];
      const locale = await languageOf(deps);
      logger.info('Asking for the administrator password', { action, binary: OSASCRIPT, command: words.join(' '), language: locale });
      const run = await deps.run(OSASCRIPT, elevationArgs(words, locale));
      const outcome = classifyRun(run);
      switch (outcome.kind) {
        case 'done':
          logger.info(`Helper ${verb} finished`, { action, exitCode: 0 });
          return { ok: true, value: null };
        case 'cancelled':
          logger.info('The administrator password was cancelled', { action, exitCode: run.code });
          return failure('install-cancelled', 'The password dialog was cancelled; nothing was run');
        case 'denied':
          logger.warn('The administrator password was refused', { action, exitCode: run.code });
          return failure('install-denied', 'The system refused the authorization; nothing was run');
        case 'failed':
          logger.error(`Helper ${verb} failed`, { action, exitCode: outcome.exitCode, timedOut: run.timedOut, reason: outcome.detail });
          return failure('install-failed', `The ${verb} script failed (exit ${String(outcome.exitCode)})`, outcome.detail);
      }
    } catch (error) {
      logger.error(`Helper ${verb} could not be started`, { action, detail: error });
      return failure('install-failed', `The ${verb} could not be started`);
    } finally {
      running = false;
    }
  };

  return { install: () => runAs('install'), uninstall: () => runAs('uninstall') };
}

/** The real runner: `execFile` with an absolute path and an argument array, bounded in time and size. Never rejects. */
export const runWithExecFile: ElevationRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: ELEVATION_TIMEOUT_MS,
        maxBuffer: ELEVATION_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        shell: false,
        // Nothing of the app's environment (NODE_OPTIONS, DYLD_*) goes on to root.
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr, timedOut: error.killed === true && code === null });
      },
    );
  });
