import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';

import { Config, MAX_LINE_BYTES, PATHS, describeIssues, findStructureViolation } from '@routeswitch/shared';

import type { Logger } from './logger';

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
    const handle = await nodeFs.open(path, 'r');
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

// ---------------------------------------------------------------------------
// Writing (daemon only: the helper is the only writer of the config file)
// ---------------------------------------------------------------------------

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** The part of `node:fs/promises` the writer uses; tests point it at a temporary directory or inject failures. */
export interface ConfigFs {
  readonly open: typeof nodeFs.open;
  readonly rename: typeof nodeFs.rename;
  readonly unlink: typeof nodeFs.unlink;
  readonly mkdir: (path: string, options: { readonly mode: number }) => Promise<unknown>;
}

const realConfigFs: ConfigFs = {
  open: nodeFs.open,
  rename: nodeFs.rename,
  unlink: nodeFs.unlink,
  mkdir: (path, options) => nodeFs.mkdir(path, options),
};

/** `ok: false` carries a short system error code (`EACCES`) or `too-large`, never file content. */
export type SaveConfigResult = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly code: string };

export interface ConfigWriter {
  /** Writes a validated config. Writes are serialised. Never rejects. */
  save(config: Config): Promise<SaveConfigResult>;
}

export interface ConfigWriterDeps {
  readonly logger: Logger;
  /** `PATHS.config` in the daemon; a file in a temporary directory in tests. Must be absolute. */
  readonly path?: string | undefined;
  readonly fs?: ConfigFs | undefined;
}

/** Pretty-printed so the file stays readable for a person looking at it; `loadConfig` reads it back unchanged. */
export const serializeConfig = (config: Config): string => `${JSON.stringify(config, null, 2)}\n`;

const dirOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));

/**
 * The writer of `config.json`. Atomic: the content goes to a temporary file of
 * our own in the same directory (created exclusively, never following a link,
 * mode 0644 whatever the umask, synced) which is then renamed over the
 * config. A reader, and the helper after a crash, sees either the old or the
 * new file, never half of one. A leftover temporary file is ours by name and
 * removed first. A missing directory is created (0755) once.
 *
 * Only configs that passed the `Config` schema reach it (the socket request
 * was parsed with it), and nothing larger than `MAX_CONFIG_BYTES` is written:
 * `loadConfig` would refuse it at the next start.
 */
export const createConfigWriter = (deps: ConfigWriterDeps): ConfigWriter => {
  const fs = deps.fs ?? realConfigFs;
  const path = deps.path ?? PATHS.config;
  const dir = dirOf(path);
  const tempPath = `${dir}/.config.json.routeswitch.tmp`;
  const logger = deps.logger.child({ component: 'config' });

  const writeTemp = async (content: string): Promise<void> => {
    await fs.unlink(tempPath).catch((error: unknown) => {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    });
    const handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      // The mode given to open is reduced by the umask; the file must be readable as documented.
      await handle.chmod(FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const write = async (config: Config): Promise<SaveConfigResult> => {
    const content = serializeConfig(config);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_CONFIG_BYTES) {
      logger.error('config not saved: it would be larger than the helper reads back', { path, bytes, limit: MAX_CONFIG_BYTES });
      return { ok: false, code: 'too-large' };
    }
    try {
      try {
        await writeTemp(content);
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
        // The directory is missing (normally the install script creates it): create it, once, and retry.
        await fs.mkdir(dir, { mode: DIR_MODE });
        logger.warn('config directory was missing and has been created', { dir });
        await writeTemp(content);
      }
      await fs.rename(tempPath, path);
      logger.info('config saved', { path, rules: config.rules.length, enabled: config.enabled, bytes });
      return { ok: true, bytes };
    } catch (error) {
      const code = errorCodeOf(error);
      logger.error('config could not be saved; the previous one stays in effect', { path, error: code });
      // Best effort: the failure is logged above, and a leftover temporary file is removed before the next write.
      await fs.unlink(tempPath).catch(() => undefined);
      return { ok: false, code };
    }
  };

  let last: Promise<unknown> = Promise.resolve();
  return {
    save: (config) => {
      const result = last.then(() => write(config));
      last = result;
      return result;
    },
  };
};
