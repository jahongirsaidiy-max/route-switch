import { open } from 'node:fs/promises';

import { Config, MAX_LINE_BYTES, describeIssues, findStructureViolation } from '@routeswitch/shared';

/**
 * Reads the rules file. Nothing here throws or rejects for a runtime
 * condition: a missing, unreadable, oversized, malformed or invalid file is
 * returned as a value, and the caller must not touch any route when the
 * result is not `ok`.
 *
 * The file is parsed the way a message from the socket is: a size bound, then
 * `JSON.parse`, then the cheap structural guard, and only then the `Config`
 * schema, so the config in an `ok` result always holds normalised targets.
 * Error messages are built from fixed text, field names and error codes; the
 * content of the file is never copied into them.
 */

/** No legitimate config is larger than the largest protocol message that can carry one. */
export const MAX_CONFIG_BYTES = MAX_LINE_BYTES;

/** The config of a machine where none was saved yet. */
export const emptyConfig = (): Config => ({ version: 1, enabled: true, rules: [] });

export type ConfigErrorCode =
  /** The file exists but could not be read (permissions, a directory, an I/O error). */
  | 'unreadable'
  | 'too-large'
  | 'invalid-json'
  /** Valid JSON that exceeds the structural limits (array length, nesting, string length). */
  | 'invalid-structure'
  /** Refused by the `Config` schema. */
  | 'invalid-config';

export type LoadConfigResult =
  /** `file`: read from disk. `default`: there is no file yet, so this is the empty config. */
  | { readonly ok: true; readonly source: 'file' | 'default'; readonly config: Config }
  | { readonly ok: false; readonly code: ConfigErrorCode; readonly message: string };

export type ConfigFileRead =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large' }
  /** `detail` is a short system error code such as `EACCES`, never file content. */
  | { readonly kind: 'unreadable'; readonly detail: string };

/** Reads a file as UTF-8 text, refusing anything over `maxBytes`. Never rejects. */
export type ConfigFileReader = (path: string, maxBytes: number) => Promise<ConfigFileRead>;

const errorCodeOf = (error: unknown): string => {
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

/** The real reader: one open file handle, size checked before the content is read. */
export const readConfigFile: ConfigFileReader = async (path, maxBytes) => {
  try {
    const handle = await open(path, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { kind: 'unreadable', detail: 'ENOTFILE' };
      if (stats.size > maxBytes) return { kind: 'too-large' };
      const text = await handle.readFile({ encoding: 'utf8' });
      // The size can change between `stat` and the read.
      return Buffer.byteLength(text, 'utf8') > maxBytes ? { kind: 'too-large' } : { kind: 'content', text };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const detail = errorCodeOf(error);
    return detail === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', detail };
  }
};

const failure = (code: ConfigErrorCode, message: string): LoadConfigResult => ({ ok: false, code, message });

/** Validates decoded JSON as a config: structural guard first, then the schema. */
export const parseConfig = (value: unknown): LoadConfigResult => {
  const violation = findStructureViolation(value);
  if (violation !== null) {
    return failure('invalid-structure', `Config exceeds the structural limits (${violation.kind})`);
  }
  const parsed = Config.safeParse(value);
  if (!parsed.success) return failure('invalid-config', `Config is invalid: ${describeIssues(parsed.error)}`);
  return { ok: true, source: 'file', config: parsed.data };
};

export const loadConfig = async (path: string, read: ConfigFileReader = readConfigFile): Promise<LoadConfigResult> => {
  let file: ConfigFileRead;
  try {
    file = await read(path, MAX_CONFIG_BYTES);
  } catch (error) {
    // A reader is not supposed to reject; an injected one still must not take the caller down.
    file = { kind: 'unreadable', detail: errorCodeOf(error) };
  }

  switch (file.kind) {
    case 'missing':
      return { ok: true, source: 'default', config: emptyConfig() };
    case 'too-large':
      return failure('too-large', `Config file is larger than ${String(MAX_CONFIG_BYTES)} bytes`);
    case 'unreadable':
      return failure('unreadable', `Config file could not be read (${file.detail})`);
    case 'content':
      break;
  }

  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    // The parser's own message quotes the input, so it is not passed on.
    return failure('invalid-json', 'Config file is not valid JSON');
  }
  return parseConfig(value);
};
