import { z } from 'zod';

import { Config } from './schema';

/**
 * The app's copy of the last config it saw (`userData/rules-backup.json`,
 * TASK-DELTA-16). Uninstalling the helper removes its `config.json`; this
 * copy lets the app offer the rules back after a reinstall — through the
 * import preview and the user's confirmation, never on its own. The helper
 * never reads it; it lives here so that the app checks the file with zod
 * without importing zod itself (one copy of zod, in this package).
 */

/** The version of the backup file's own envelope (not of the config inside it). */
export const RULES_BACKUP_VERSION = 1;

/**
 * A config of 500 rules is about 100 KiB of JSON (`MAX_CONFIG_FILE_BYTES` of
 * the import is 1 MiB); the envelope adds a few dozen bytes.
 */
export const MAX_RULES_BACKUP_FILE_BYTES = 1024 * 1024;

/** `Date.prototype.toISOString()` exactly: millisecond precision, `Z`. */
export const BackupTimestamp = z.iso.datetime({ precision: 3 });

/** The backup file. Keys this version does not know are dropped; anything else wrong refuses the whole file. */
export const RulesBackupFile = z.object({
  version: z.literal(RULES_BACKUP_VERSION),
  /** When the app wrote it. */
  savedAt: BackupTimestamp,
  /** The helper's `configRevision` the config was read with (it restarts with every helper start). */
  configRevision: z.int().min(0),
  /** The config as the helper stored it: every rule the helper itself would accept. */
  config: Config,
});
export type RulesBackupFile = z.infer<typeof RulesBackupFile>;
