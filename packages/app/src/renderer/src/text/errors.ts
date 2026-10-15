// The words for a failed `window.rs` call, shared by every screen. The
// English `error` of an `RsResult` is for the log and is never shown. The
// words live in the dictionary (`src/i18n`, `t.errors`); a screen passes its
// `useI18n()` value, and without one it gets Uzbek.

import { DEFAULT_LOCALE, i18nFor, type I18n } from '../../../i18n';
import type { RsErrorCode } from '../rs';

export interface Feedback {
  readonly tone: 'success' | 'danger';
  readonly text: string;
}

/** Uzbek, the default language: the Uzbek constants below and the components' fallback. The `text/*` functions take `i18n` as a required argument. */
export const UZ: I18n = i18nFor(DEFAULT_LOCALE);

/** The words for a failed call. */
export function errorText(code: RsErrorCode, i18n: I18n): string {
  // A code from outside the closed set (a newer main process) still gets words.
  return Object.hasOwn(i18n.t.errors, code) ? i18n.t.errors[code] : i18n.t.unexpectedError(code);
}
