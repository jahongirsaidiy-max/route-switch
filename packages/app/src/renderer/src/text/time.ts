// Times as the UI writes them: local clock time and "N daq oldin", in the
// language of `i18n` (Uzbek when a screen does not pass its language yet).
// The formatting itself is `src/i18n/format.ts` (`Intl.DateTimeFormat`).

import type { I18n } from '../../../i18n';
import { UZ } from './errors';

/** "hozirgina", "2 daq oldin", "3 soat oldin", "4 kun oldin". A time in the future reads as just now. */
export function formatAgo(iso: string, now: number, i18n: I18n = UZ): string {
  return i18n.formatAgo(iso, now);
}

/** Local `HH:MM`, with the day and month in front (in the language's order) when it is not today. */
export function formatClock(iso: string, now: number, i18n: I18n = UZ): string {
  return i18n.formatTime(iso, now);
}
