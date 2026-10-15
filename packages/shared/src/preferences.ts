import { z } from 'zod';

/**
 * The app's own per-user preferences (`userData/preferences.json`, TASK-DELTA-11).
 * The helper never reads them; they live here only so that the app checks
 * the file and its IPC arguments with zod without importing zod itself
 * (one copy of zod, in this package).
 */

/** The UI languages: Uzbek (the source of every text), Russian, English. */
export const LANGUAGES = ['uz', 'ru', 'en'] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;

/** The preferences file is tiny; anything larger is not one. */
export const MAX_PREFERENCES_FILE_BYTES = 64 * 1024;

/**
 * The stored preferences. Keys this version does not know are dropped (a
 * newer app may add some); a known key with a wrong value fails the parse.
 */
export const Preferences = z.object({
  language: Language,
  /**
   * The `savedAt` of the rules backup whose restore offer the user turned
   * down (TASK-DELTA-16): that backup is not offered again; a newer one is.
   * A broken value reads as none, so it never costs the language.
   */
  dismissedBackupAt: z.iso.datetime({ precision: 3 }).optional().catch(undefined),
});
export type Preferences = z.infer<typeof Preferences>;
