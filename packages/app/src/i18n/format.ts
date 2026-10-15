// Times as the UI writes them: the local clock time through
// `Intl.DateTimeFormat(locale)`, and "N daq oldin" in the dictionary's words.

import type { Locale, TimeWords } from './types';

const MINUTE = 60_000;

/** "hozirgina", "2 daq oldin", "3 soat oldin", "4 kun oldin" (in `words`). A time in the future reads as just now. */
export function formatAgo(words: TimeWords, iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return words.justNow;
  const minutes = Math.floor(elapsed / MINUTE);
  if (minutes < 60) return words.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return words.hoursAgo(hours);
  return words.daysAgo(Math.floor(hours / 24));
}

interface ClockFormats {
  readonly time: Intl.DateTimeFormat;
  /** `HH:MM:SS` (the journal). */
  readonly timeWithSeconds: Intl.DateTimeFormat;
  /** The day and month of another day: `13.10` (Uzbek, Russian), `10/13` (English, the Intl default). */
  readonly day: (at: Date) => string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `DD.MM`: the written Uzbek form (ICU's `uz` data gives `13/10`) and Russian's own. */
const dottedDay = (at: Date): string => `${pad(at.getDate())}.${pad(at.getMonth() + 1)}`;

const ENGLISH_DAY = new Intl.DateTimeFormat('en', { day: '2-digit', month: '2-digit' });
const englishDay = (at: Date): string => ENGLISH_DAY.format(at);

const FORMATS = new Map<Locale, ClockFormats>();

const formatsFor = (locale: Locale): ClockFormats => {
  let formats = FORMATS.get(locale);
  if (formats === undefined) {
    formats = {
      // 24-hour clock in every language: the times of a network log read the same way everywhere.
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      timeWithSeconds: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
      day: locale === 'en' ? englishDay : dottedDay,
    };
    FORMATS.set(locale, formats);
  }
  return formats;
};

export interface ClockOptions {
  /** `HH:MM:SS` instead of `HH:MM` (the journal, TASK-DELTA-14). */
  readonly seconds?: boolean;
}

/** Local `HH:MM`, with the day and month in front when it is not today (`13.10` uz/ru, `10/13` en); "—" for an unreadable time. */
export function formatClock(locale: Locale, iso: string, now: number, options: ClockOptions = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const today = new Date(now);
  const { time, timeWithSeconds, day } = formatsFor(locale);
  const clock = (options.seconds === true ? timeWithSeconds : time).format(at);
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock : `${day(at)} ${clock}`;
}
