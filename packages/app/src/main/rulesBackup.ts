// The app's copy of the rules (TASK-DELTA-16): `userData/rules-backup.json`.
//
// Uninstalling the helper removes its `config.json` with every rule. The app
// therefore keeps the last config it saw from the helper — per user, mode
// 0600 — and, after a (re)install with an empty config, offers it back. The
// offer goes through the import preview and the user's "Almashtirish"
// (`ipc.ts`: `rs:restoreBackup` → `rs:applyImport`); nothing here ever sends
// anything to the helper.
//
// Writing: every config the helper client accepts while connected
// (`onConfig`, i.e. every new `configRevision`) is written 2 s after the last
// one — a burst of edits is one write. A config with no rules never replaces
// a backup that has some (that is the very case the backup exists for); an
// unchanged config is not written again. The write is atomic and private
// (`writeTextFileAtomic`, mode 0600), and only into a directory that is not a
// symbolic link, belongs to the user and is not writable by anyone else.
//
// Reading is bounded and strict like a config import (`readBoundedFile`,
// `O_NOFOLLOW`, ≤ 1 MiB, UTF-8 JSON, bounded structure, the shared
// `RulesBackupFile` schema — every rule the helper itself would accept). A
// file that fails any step is no backup (logged). Nothing here throws.

import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  findStructureViolation,
  MAX_RULES_BACKUP_FILE_BYTES,
  RULES_BACKUP_VERSION,
  RulesBackupFile,
  type Config,
} from '@routeswitch/shared';

import { nodeConfigFileSystem, parseJsonBytes, readBoundedFile, writeTextFileAtomic, type ConfigFileSystem } from './configFile';
import type { HelperClient } from './helperClient';
import type { Logger } from './logger';

export const RULES_BACKUP_FILE_NAME = 'rules-backup.json';
/** Only the user may read or write it: it lists the user's internal networks. */
export const RULES_BACKUP_FILE_MODE = 0o600;
/** A burst of edits (or a reconnect's config right after a change) is one write. */
export const RULES_BACKUP_DEBOUNCE_MS = 2_000;

/** What `lstat` tells about the directory. */
export interface BackupDirStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/** The file access used here; tests pass a stand-in. */
export interface BackupFileSystem extends ConfigFileSystem {
  lstat(file: string): Promise<BackupDirStat>;
}

export const nodeBackupFileSystem: BackupFileSystem = {
  ...nodeConfigFileSystem,
  lstat: (file) => fsPromises.lstat(file),
};

export interface RulesBackupDeps {
  /** `app.getPath('userData')`: the file is `<dir>/rules-backup.json`. */
  readonly dir: string;
  /** `process.getuid()`: the only owner the directory may have. */
  readonly uid: number;
  readonly helperClient: Pick<HelperClient, 'onConfig' | 'snapshot'>;
  readonly logger: Logger;
  readonly fs?: BackupFileSystem;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface RulesBackupStore {
  /** The backup on disk (read once, then kept in step with every write and removal); null when there is none. Never rejects. */
  readonly read: () => Promise<RulesBackupFile | null>;
  /** Removes the backup (a pending write is dropped). False when the file could not be removed (logged). Never rejects. */
  readonly remove: () => Promise<boolean>;
  /** Writes a pending config now instead of after the debounce. Never rejects. */
  readonly flush: () => Promise<void>;
  /** Stops listening to the helper client and drops a pending write. Idempotent. */
  readonly dispose: () => void;
}

type ReadOutcome = { readonly kind: 'ok'; readonly backup: RulesBackupFile } | { readonly kind: 'missing' } | { readonly kind: 'refused'; readonly why: string };

/** Reads and checks the backup file. Never throws. */
export async function readRulesBackupFile(file: string, fs: ConfigFileSystem = nodeConfigFileSystem): Promise<ReadOutcome> {
  const read = await readBoundedFile(file, MAX_RULES_BACKUP_FILE_BYTES, { noFollow: true }, fs);
  if (!read.ok) return read.code === 'file-missing' ? { kind: 'missing' } : { kind: 'refused', why: read.error };
  const json = parseJsonBytes(read.bytes);
  if (!json.ok) return { kind: 'refused', why: json.error };
  // Bounded walk first: zod does not stop early on an oversized array.
  const violation = findStructureViolation(json.value);
  if (violation !== null) return { kind: 'refused', why: `too large or too deeply nested (${violation.kind})` };
  const parsed = RulesBackupFile.safeParse(json.value);
  if (!parsed.success) return { kind: 'refused', why: 'not in the expected shape' };
  return { kind: 'ok', backup: parsed.data };
}

/** The text of the backup file. */
export const rulesBackupText = (backup: RulesBackupFile): string => `${JSON.stringify(backup, null, 2)}\n`;

/** The directory may hold the backup: a real directory of the user's, writable by nobody else. */
export async function checkBackupDir(
  dir: string,
  uid: number,
  fs: Pick<BackupFileSystem, 'lstat'>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }> {
  let stat: BackupDirStat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    return { ok: false, why: `the directory cannot be read (${code})` };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, why: 'not a directory' };
  if (stat.uid !== uid) return { ok: false, why: 'the directory belongs to another user' };
  if ((stat.mode & 0o022) !== 0) return { ok: false, why: 'the directory is writable by other users' };
  return { ok: true };
}

const sameConfig = (a: Config, b: Config): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createRulesBackup(deps: RulesBackupDeps): RulesBackupStore {
  const logger = deps.logger.child({ component: 'rules-backup' });
  const fs = deps.fs ?? nodeBackupFileSystem;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const setTimer = deps.setTimer ?? ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const file = path.join(deps.dir, RULES_BACKUP_FILE_NAME);

  // What is on disk, as far as this process knows: read once, then kept in step.
  let current: RulesBackupFile | null = null;
  let loading: Promise<void> | null = null;
  const load = (): Promise<void> => {
    loading ??= readRulesBackupFile(file, fs).then(
      (outcome) => {
        if (outcome.kind === 'ok') {
          current = outcome.backup;
          logger.info('Rules backup read', { rules: current.config.rules.length, savedAt: current.savedAt });
        } else if (outcome.kind === 'refused') {
          logger.warn('The rules backup was ignored', { why: outcome.why });
        }
      },
      (error: unknown) => {
        logger.error('Reading the rules backup failed', { detail: error });
      },
    );
    return loading;
  };

  // Writes and removals run one at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  let pending: { readonly config: Config; readonly configRevision: number } | null = null;
  let timer: unknown = null;
  let disposed = false;

  const write = async (next: { readonly config: Config; readonly configRevision: number }): Promise<void> => {
    await load();
    if (current !== null && next.config.rules.length === 0 && current.config.rules.length > 0) {
      logger.info('A config without rules does not replace the rules backup', { kept: current.config.rules.length });
      return;
    }
    if (current !== null && sameConfig(current.config, next.config)) return;
    if (current === null && next.config.rules.length === 0) return;
    const dir = await checkBackupDir(deps.dir, deps.uid, fs);
    if (!dir.ok) {
      logger.error('The rules backup was not written', { why: dir.why });
      return;
    }
    const backup: RulesBackupFile = {
      version: RULES_BACKUP_VERSION,
      savedAt: new Date(now()).toISOString(),
      configRevision: next.configRevision,
      config: next.config,
    };
    const written = await writeTextFileAtomic(file, rulesBackupText(backup), RULES_BACKUP_FILE_MODE, fs, newId);
    if (!written.ok) {
      logger.error('Could not write the rules backup', { detail: written.error });
      return;
    }
    current = backup;
    logger.info('Rules backup written', { rules: backup.config.rules.length, configRevision: backup.configRevision, bytes: written.bytes });
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const next = pending;
    pending = null;
    if (next === null) return queue.then(() => undefined);
    return serially(() => write(next)).catch((error: unknown) => {
      logger.error('Writing the rules backup failed', { detail: error });
    });
  };

  const unsubscribe = deps.helperClient.onConfig((config) => {
    if (disposed) return;
    const snapshot = deps.helperClient.snapshot();
    // Only a config the helper loaded and runs: never one of a helper that cannot load its own.
    if (snapshot.status.kind !== 'connected' || snapshot.configRevision === null) return;
    pending = { config, configRevision: snapshot.configRevision };
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, RULES_BACKUP_DEBOUNCE_MS);
  });

  return {
    read: async () => {
      await queue;
      await load();
      return current;
    },
    remove: () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
      return serially(async () => {
        await load();
        try {
          await fs.unlink(file);
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
          if (code !== 'ENOENT') {
            logger.error('Could not remove the rules backup', { code });
            return false;
          }
        }
        current = null;
        logger.info('Rules backup removed');
        return true;
      }).catch((error: unknown) => {
        logger.error('Removing the rules backup failed', { detail: error });
        return false;
      });
    },
    flush,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}
