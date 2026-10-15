// Config import / export files (TASK-215). The main process alone touches
// them: the path comes from the system file dialog (`dialog.showOpenDialog` /
// `showSaveDialog`) and never from, or to, the page.
//
// Reading is bounded and strict: a regular file of at most
// `MAX_CONFIG_FILE_BYTES`, valid UTF-8 (a leading BOM is allowed), JSON, a
// bounded structure, then the shared `Config` schema — every rule the helper
// applies (ADR-001 destinations, limits, one interface per target). A file
// that fails any step is refused here and never reaches the helper.
//
// Writing is atomic: the text goes to a new temporary file next to the chosen
// path (`O_EXCL`, synced), which is then renamed over it. Nothing is written
// anywhere else; the temporary file is removed when anything fails.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import { Config, describeIssues, findStructureViolation } from '@routeswitch/shared';

import type { RsConfigIssue, RsErrorCode } from '../renderer/src/rs';

/** A config of 500 rules is about 100 KiB of JSON; anything over 1 MiB is not one. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** The parts of a `FileHandle` used here. */
export interface ConfigFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The parts of `node:fs/promises` used here; tests pass a stand-in to make a step fail. */
export interface ConfigFileSystem {
  open(file: string, flags: number | string, mode?: number): Promise<ConfigFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export const nodeConfigFileSystem: ConfigFileSystem = {
  open: (file, flags, mode) => fsPromises.open(file, flags, mode),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (file) => fsPromises.unlink(file),
};

export type ConfigFileFailure = {
  readonly ok: false;
  readonly code: Extract<RsErrorCode, 'file-unreadable' | 'file-not-regular' | 'file-too-large' | 'file-not-text' | 'file-not-json' | 'invalid-config'>;
  /** English, for the log; built from fixed text, field names and numbers only. */
  readonly error: string;
  readonly issue?: RsConfigIssue;
};

export type ReadConfigResult = { readonly ok: true; readonly config: Config; readonly bytes: number } | ConfigFileFailure;

/** Field names of the config schema: the only words of a file that may appear in an issue path. */
const KNOWN_KEYS = new Set([
  'version',
  'enabled',
  'ifaceOverrides',
  'ethernet',
  'wifi',
  'rules',
  'id',
  'kind',
  'target',
  'iface',
  'dns',
  'refreshSec',
  'note',
]);
const ISSUE_CODE = /^[a-z][a-z_-]{0,39}$/;
const MAX_PATH_SEGMENTS = 8;

interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly params?: Record<string, unknown> | undefined;
}

/**
 * The first issue of a refused config, for the page to put into words: the
 * path keeps array indexes and known field names only (anything else becomes
 * `?`, so no text of the file is passed on), and the code is the shared
 * validation code when there is one (`default-route`, `iface-conflict`, …),
 * otherwise zod's (`invalid_type`, `too_big`, …).
 */
export function issueOf(issue: IssueLike): RsConfigIssue {
  const own = issue.params?.['code'];
  const code = typeof own === 'string' && ISSUE_CODE.test(own) ? own : ISSUE_CODE.test(issue.code) ? issue.code : null;
  const segments = issue.path
    .slice(0, MAX_PATH_SEGMENTS)
    .map((segment) => (typeof segment === 'number' ? segment : typeof segment === 'string' && KNOWN_KEYS.has(segment) ? segment : '?'));
  return { path: segments, code };
}

const refuse = (code: ConfigFileFailure['code'], error: string, issue?: RsConfigIssue): ConfigFileFailure =>
  issue === undefined ? { ok: false, code, error } : { ok: false, code, error, issue };

const BOM = '﻿';

/** Reads and checks a config file the user chose. Never throws. */
export async function readConfigFile(file: string, fs: ConfigFileSystem = nodeConfigFileSystem): Promise<ReadConfigResult> {
  let handle: ConfigFileHandle;
  try {
    // Non-blocking: a FIFO or device the user picked must not hang the open.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return refuse('file-unreadable', 'The file could not be opened');
  }
  let bytes: Uint8Array;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return refuse('file-not-regular', 'Not a regular file');
    if (stat.size > MAX_CONFIG_FILE_BYTES) return refuse('file-too-large', `Larger than ${String(MAX_CONFIG_FILE_BYTES)} bytes`);
    // Read at most one byte past the limit: the file may have grown since `stat`.
    const buffer = new Uint8Array(MAX_CONFIG_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CONFIG_FILE_BYTES) return refuse('file-too-large', `Larger than ${String(MAX_CONFIG_FILE_BYTES)} bytes`);
    }
    bytes = buffer.subarray(0, total);
  } catch {
    return refuse('file-unreadable', 'The file could not be read');
  } finally {
    await handle.close().catch(() => undefined);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('file-not-text', 'Not UTF-8 text');
  }
  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('file-not-json', 'Not JSON');
  }
  // Bounded walk first: zod does not stop early on an oversized array.
  const violation = findStructureViolation(value);
  if (violation !== null) {
    return refuse('invalid-config', `The file is too large or too deeply nested (${violation.kind})`, { path: [], code: violation.kind });
  }
  const parsed = Config.safeParse(value);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return refuse('invalid-config', describeIssues(parsed.error), first === undefined ? undefined : issueOf(first));
  }
  return { ok: true, config: parsed.data, bytes: bytes.length };
}

/** The text of an exported config: the stored config, indented, one trailing newline. */
export const configFileText = (config: Config): string => `${JSON.stringify(config, null, 2)}\n`;

export type WriteConfigResult = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly error: string };

/**
 * Writes `config` to `file` atomically: a fresh temporary file in the same
 * directory (created exclusively, mode 0644, synced) is renamed over `file`.
 * On any failure the temporary file is removed and `file` is left as it was.
 */
export async function writeConfigFile(
  file: string,
  config: Config,
  fs: ConfigFileSystem = nodeConfigFileSystem,
  newId: () => string = randomUUID,
): Promise<WriteConfigResult> {
  const text = configFileText(config);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${newId()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    created = true;
    try {
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    return { ok: true, bytes: Buffer.byteLength(text) };
  } catch (error) {
    if (created) await fs.unlink(temporary).catch(() => undefined);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    return { ok: false, error: `The file could not be written (${code})` };
  }
}
