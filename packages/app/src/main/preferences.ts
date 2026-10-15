// The app's own per-user preferences (TASK-DELTA-11): for now the UI
// language. They live in `userData/preferences.json`, never in the helper's
// config (the helper runs as root for every user of the Mac).
//
// Reading never fails: a missing, unreadable, oversized or malformed file —
// or one with an unknown language — gives the default, the first of the
// system's preferred languages (`ru*` → Russian, `en*` → English, else
// Uzbek). Writing is atomic and private: a fresh temporary file next to it
// (`O_EXCL | O_NOFOLLOW`, mode 0600, synced) is renamed over it.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import { MAX_PREFERENCES_FILE_BYTES, Preferences, type Language } from '@routeswitch/shared';

import { localeFromSystem } from '../i18n';
import type { Logger } from './logger';

export const PREFERENCES_FILE_NAME = 'preferences.json';
/** Only the user may read or write it. */
export const PREFERENCES_FILE_MODE = 0o600;

/** The parts of a `FileHandle` used here. */
export interface PreferencesFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The parts of `node:fs/promises` used here; tests pass a stand-in. */
export interface PreferencesFileSystem {
  readonly open: (file: string, flags: number, mode?: number) => Promise<PreferencesFileHandle>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (file: string) => Promise<void>;
}

export const nodePreferencesFileSystem: PreferencesFileSystem = {
  open: (file, flags, mode) => fsPromises.open(file, flags, mode),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (file) => fsPromises.unlink(file),
};

export interface PreferencesDeps {
  /** `app.getPath('userData')`: the file is `<dir>/preferences.json`. */
  readonly dir: string;
  /** `app.getPreferredSystemLanguages()`; asked only when the file holds no language. */
  readonly preferredLanguages: () => readonly string[];
  readonly logger: Logger;
  readonly fs?: PreferencesFileSystem;
  readonly newId?: () => string;
}

export interface PreferencesStore {
  /** The language: read from the file on the first call (all callers wait for the same read). Never rejects. */
  readonly language: () => Promise<Language>;
  /**
   * Sets the language and stores it. Listeners hear of a change (not of the
   * same language again). When the file cannot be written the language still
   * holds for this run; the failure is logged. Never rejects.
   */
  readonly setLanguage: (language: Language) => Promise<Language>;
  /** Called with every new language. Returns the unsubscribe. */
  readonly onLanguage: (listener: (language: Language) => void) => () => void;
}

type ReadOutcome =
  | { readonly kind: 'ok'; readonly language: Language }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly why: string };

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';

/** Reads and checks the file. Never throws. */
export async function readPreferencesFile(file: string, fs: PreferencesFileSystem = nodePreferencesFileSystem): Promise<ReadOutcome> {
  let handle: PreferencesFileHandle;
  try {
    // No symbolic link is followed and a FIFO does not block the open.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'refused', why: `cannot be opened (${code})` };
  }
  let bytes: Uint8Array;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'refused', why: 'not a regular file' };
    if (stat.size > MAX_PREFERENCES_FILE_BYTES) return { kind: 'refused', why: 'too large' };
    // One byte past the limit: the file may have grown since `stat`.
    const buffer = new Uint8Array(MAX_PREFERENCES_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PREFERENCES_FILE_BYTES) return { kind: 'refused', why: 'too large' };
    }
    bytes = buffer.subarray(0, total);
  } catch (error) {
    return { kind: 'refused', why: `cannot be read (${errorCode(error)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'refused', why: 'not UTF-8 JSON' };
  }
  const parsed = Preferences.safeParse(value);
  if (!parsed.success) return { kind: 'refused', why: 'not in the expected shape' };
  return { kind: 'ok', language: parsed.data.language };
}

/** Writes the preferences atomically with mode 0600. Never throws. */
export async function writePreferencesFile(
  file: string,
  preferences: Preferences,
  fs: PreferencesFileSystem = nodePreferencesFileSystem,
  newId: () => string = randomUUID,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const text = `${JSON.stringify(preferences, null, 2)}\n`;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${newId()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PREFERENCES_FILE_MODE,
    );
    created = true;
    try {
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    return { ok: true };
  } catch (error) {
    if (created) await fs.unlink(temporary).catch(() => undefined);
    return { ok: false, error: `The preferences could not be written (${errorCode(error)})` };
  }
}

export function createPreferences(deps: PreferencesDeps): PreferencesStore {
  const logger = deps.logger.child({ component: 'preferences' });
  const fs = deps.fs ?? nodePreferencesFileSystem;
  const newId = deps.newId ?? randomUUID;
  const file = path.join(deps.dir, PREFERENCES_FILE_NAME);
  const listeners = new Set<(language: Language) => void>();

  const systemLanguage = (): Language => {
    try {
      return localeFromSystem(deps.preferredLanguages());
    } catch (error) {
      logger.warn('Could not read the preferred system languages', { detail: error });
      return localeFromSystem([]);
    }
  };

  let current: Language | null = null;
  let loading: Promise<Language> | null = null;
  const load = (): Promise<Language> => {
    loading ??= readPreferencesFile(file, fs).then(
      (outcome) => {
        // A `setLanguage` that finished first wins over what the file said.
        if (current !== null) return current;
        if (outcome.kind === 'ok') {
          current = outcome.language;
          logger.info('Preferences read', { language: current });
        } else {
          current = systemLanguage();
          if (outcome.kind === 'refused') logger.warn('The preferences file was ignored', { why: outcome.why, language: current });
          else logger.info('No preferences file yet; using the system language', { language: current });
        }
        return current;
      },
      (error: unknown) => {
        current ??= systemLanguage();
        logger.error('Reading the preferences failed', { detail: error, language: current });
        return current;
      },
    );
    return loading;
  };

  // Writes run one at a time, in order: the last choice is the one on disk.
  let writes: Promise<unknown> = Promise.resolve();

  return {
    // The read happens once; afterwards the answer is whatever was set last.
    language: async () => {
      const read = await load();
      return current ?? read;
    },
    setLanguage: async (language) => {
      await load();
      const changed = current !== language;
      current = language;
      if (changed) {
        logger.info('Language changed', { language });
        for (const listener of [...listeners]) {
          try {
            listener(language);
          } catch (error) {
            logger.error('A language listener failed', { detail: error });
          }
        }
      }
      const write = writes.then(() => writePreferencesFile(file, { language }, fs, newId));
      writes = write.catch(() => undefined);
      const written = await write;
      if (!written.ok) logger.error('Could not save the preferences; the language holds until the app quits', { detail: written.error });
      return language;
    },
    onLanguage: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
