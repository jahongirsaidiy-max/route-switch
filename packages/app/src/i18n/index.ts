// The UI's languages without a library (TASK-DELTA-11): a typed dictionary
// per language, the platform's plural rules and date formats. Plain data and
// functions — no DOM, no Node, no Electron — so the main process (tray,
// dialogs) and the renderer import the same words.

import { LANGUAGES } from '@routeswitch/shared';

import { en } from './en';
import { formatAgo, formatClock } from './format';
import { plural } from './plural';
import { ru } from './ru';
import type { Locale, Messages, PluralForms } from './types';
import { uz } from './uz';

export { formatAgo, formatClock } from './format';
export { plural, ruForms } from './plural';
export type { Locale, Messages, PluralForms, TimeWords } from './types';
export type { ConfigFieldKey, ConfigIssueKey, DisconnectedReason, HelperStatusKey } from './uz';

/** Every language, in the order the picker lists them. */
export const LOCALES: readonly Locale[] = LANGUAGES;

/** The language of the texts before the user (or the system) chose one, and the fallback. */
export const DEFAULT_LOCALE: Locale = 'uz';

export const MESSAGES: Readonly<Record<Locale, Messages>> = { uz, ru, en };

/** Each language in its own words: the picker must be readable whatever language is on. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { uz: "O'zbekcha", ru: 'Русский', en: 'English' };

/** The title of the language picker: the same in every language, so it can be found from any of them. */
export const LANGUAGE_PICKER_TITLE = 'Til / Язык / Language';

export const isLocale = (value: unknown): value is Locale => LOCALES.some((locale) => locale === value);

/**
 * The language for a first start, from the system's preferred languages
 * (`app.getPreferredSystemLanguages()`, e.g. `ru-RU`, `en-US`): only the
 * first one counts — `ru*` is Russian, `en*` English, anything else
 * (Uzbek, another language, none) Uzbek.
 */
export function localeFromSystem(preferred: readonly string[]): Locale {
  const first = (preferred[0] ?? '').toLowerCase();
  if (/^ru(?:[-_]|$)/.test(first)) return 'ru';
  if (/^en(?:[-_]|$)/.test(first)) return 'en';
  return DEFAULT_LOCALE;
}

/** Everything a screen needs to speak one language. */
export interface I18n {
  readonly locale: Locale;
  /** The dictionary: `t.errors[code]`, `t.network.rulesWaiting(3)`. */
  readonly t: Messages;
  /** `plural(locale, n, forms)` in this language. */
  readonly plural: (n: number, forms: PluralForms) => string;
  /** Local `HH:MM` (with the day in front when it is not today), in this language's format. */
  readonly formatTime: (iso: string, now: number) => string;
  /** "2 daq oldin" in this language. */
  readonly formatAgo: (iso: string, now: number) => string;
}

const create = (locale: Locale): I18n => {
  const t = MESSAGES[locale];
  return Object.freeze({
    locale,
    t,
    plural: (n: number, forms: PluralForms) => plural(locale, n, forms),
    formatTime: (iso: string, now: number) => formatClock(locale, iso, now),
    formatAgo: (iso: string, now: number) => formatAgo(t.time, iso, now),
  });
};

/** One object per language, so it can be compared (and memoised on) by identity. */
const I18N: Readonly<Record<Locale, I18n>> = { uz: create('uz'), ru: create('ru'), en: create('en') };

export const i18nFor = (locale: Locale): I18n => I18N[locale];
