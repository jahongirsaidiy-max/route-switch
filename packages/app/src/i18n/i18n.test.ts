import { ERROR_CODES, LANGUAGES, RECONCILE_REASONS, RULE_REASON_CODES } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { en } from './en';
import { formatAgo, formatClock } from './format';
import {
  DEFAULT_LOCALE,
  i18nFor,
  isLocale,
  LANGUAGE_NAMES,
  LANGUAGE_PICKER_TITLE,
  LOCALES,
  localeFromSystem,
  MESSAGES,
  type Locale,
  type Messages,
} from './index';
import { plural, ruForms } from './plural';
import { ru } from './ru';
import { uz } from './uz';

// ---------------------------------------------------------------------------
// The dictionary's shape is checked by `tsc`: these lines must keep failing to
// compile (an unused `@ts-expect-error` is itself an error).
// ---------------------------------------------------------------------------

/** A copy of `value` without `key`, typed as such. */
const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;

describe('the dictionary type (Messages)', () => {
  it('refuses a missing section, a missing code, an extra key and a text that should be a function', () => {
    // @ts-expect-error -- a whole section missing from a language
    const missingSection: Messages = without(ru, 'ruleReason');
    // @ts-expect-error -- one code missing from a table
    const missingCode: Messages = { ...ru, ruleReason: without(ru.ruleReason, 'route-failed') };
    // @ts-expect-error -- a key that Uzbek (the source of keys) does not have
    const extraKey: Messages = { ...ru, onlyInRussian: 'лишний' };
    // @ts-expect-error -- a parameterised text must stay a function
    const notAFunction: Messages = { ...en, network: { ...en.network, rulesWaiting: 'rules are waiting' } };
    expect(Object.hasOwn(missingSection, 'ruleReason')).toBe(false);
    expect(Object.hasOwn(missingCode.ruleReason, 'route-failed')).toBe(false);
    expect(Object.hasOwn(extraKey, 'onlyInRussian')).toBe(true);
    expect(typeof notAFunction.network.rulesWaiting).toBe('string');
  });
});

/** Every key path of a dictionary, functions as leaves. */
const keyPaths = (value: unknown, prefix = ''): string[] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, inner]) => keyPaths(inner, prefix === '' ? key : `${prefix}.${key}`))
    : [prefix];

/** Every leaf value with its path. */
const leaves = (value: unknown, prefix = ''): [string, unknown][] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, prefix === '' ? key : `${prefix}.${key}`))
    : [[prefix, value]];

describe('the dictionary', () => {
  it('has the three languages of the shared enum, Uzbek first and by default', () => {
    expect(LOCALES).toEqual(['uz', 'ru', 'en']);
    expect([...LOCALES]).toEqual([...LANGUAGES]);
    expect(DEFAULT_LOCALE).toBe('uz');
    expect(MESSAGES).toEqual({ uz, ru, en });
  });

  it.each(LOCALES)('%s has exactly the keys of Uzbek, at runtime too', (locale) => {
    expect(keyPaths(MESSAGES[locale]).sort()).toEqual(keyPaths(uz).sort());
  });

  it.each(LOCALES)('%s: every text is a non-empty string or a function of the same arity', (locale) => {
    const source = new Map(leaves(uz));
    for (const [path, value] of leaves(MESSAGES[locale])) {
      const original = source.get(path);
      if (typeof original === 'function') {
        expect(typeof value, path).toBe('function');
        expect((value as (...args: never[]) => unknown).length, path).toBe(original.length);
      } else {
        expect(typeof value, path).toBe('string');
        expect((value as string).trim().length, path).toBeGreaterThan(0);
      }
    }
  });

  it.each(LOCALES)('%s words every code of the shared protocol lists (Record<Code, string>)', (locale) => {
    const t = MESSAGES[locale];
    expect(Object.keys(t.ruleReason).sort()).toEqual([...RULE_REASON_CODES].sort());
    expect(Object.keys(t.reconcileReason).sort()).toEqual([...RECONCILE_REASONS].sort());
    for (const code of ERROR_CODES) expect(t.errors[code].length).toBeGreaterThan(0);
    expect(t.validation['invalid-wildcard']).toContain('10.*.*.*');
  });

  it('Russian and English are translations, not copies of Uzbek', () => {
    const uzTexts = new Map(leaves(uz).filter(([, value]) => typeof value === 'string'));
    for (const locale of ['ru', 'en'] as const) {
      const same = leaves(MESSAGES[locale]).filter(([path, value]) => typeof value === 'string' && uzTexts.get(path) === value);
      // Only words that are the same in a language: the field name `id` (and English "DNS server").
      expect(same.map(([path]) => path)).toEqual(locale === 'en' ? ['configFile.fields.id', 'configFile.fields.dns'] : ['configFile.fields.id']);
    }
  });

  it('names each language in its own words; the picker title holds all three', () => {
    expect(LANGUAGE_NAMES).toEqual({ uz: "O'zbekcha", ru: 'Русский', en: 'English' });
    for (const word of ['Til', 'Язык', 'Language']) expect(LANGUAGE_PICKER_TITLE).toContain(word);
  });

  it('isLocale knows the three languages and nothing else', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    for (const value of ['de', 'RU', 'ru-RU', '', 'toString', null, undefined, 1]) expect(isLocale(value)).toBe(false);
  });
});

describe('plural', () => {
  const forms = ruForms('правило', 'правила', 'правил');

  it.each<[number, string]>([
    [1, 'правило'],
    [2, 'правила'],
    [4, 'правила'],
    [5, 'правил'],
    [11, 'правил'],
    [12, 'правил'],
    [21, 'правило'],
    [22, 'правила'],
    [25, 'правил'],
    [0, 'правил'],
    [111, 'правил'],
    [1.5, 'правила'],
  ])('Russian %d → %s', (n, word) => {
    expect(plural('ru', n, forms)).toBe(word);
  });

  it.each<[Locale, number, string]>([
    ['en', 1, 'rule'],
    ['en', 0, 'rules'],
    ['en', 2, 'rules'],
    ['en', 21, 'rules'],
    ['uz', 1, 'rule'],
    ['uz', 5, 'rules'],
  ])('%s %d → %s (one / other)', (locale, n, word) => {
    expect(plural(locale, n, { one: 'rule', other: 'rules' })).toBe(word);
  });

  it('a Russian form left out reads as other', () => {
    expect(plural('ru', 5, { one: 'a', other: 'b' })).toBe('b');
  });

  it.each<[Locale, number, string]>([
    ['uz', 1, '1 ta qoida kutilmoqda'],
    ['uz', 5, '5 ta qoida kutilmoqda'],
    ['ru', 1, '1 правило ждёт'],
    ['ru', 3, '3 правила ждут'],
    ['ru', 11, '11 правил ждут'],
    ['ru', 21, '21 правило ждёт'],
    ['en', 1, '1 rule is waiting — it applies'],
    ['en', 3, '3 rules are waiting — they apply'],
  ])('%s: "rules waiting" for %d', (locale, n, start) => {
    expect(MESSAGES[locale].network.rulesWaiting(n).startsWith(start)).toBe(true);
  });
});

describe('localeFromSystem: the first preferred language decides', () => {
  it.each<[readonly string[], Locale]>([
    [['ru-RU'], 'ru'],
    [['ru'], 'ru'],
    [['ru_RU'], 'ru'],
    [['RU-ru'], 'ru'],
    [['ru-UA', 'en-US'], 'ru'],
    [['en-US'], 'en'],
    [['en'], 'en'],
    [['en-GB', 'ru-RU'], 'en'],
    [['uz-Latn-UZ'], 'uz'],
    [['uz'], 'uz'],
    [['de-DE', 'ru-RU'], 'uz'],
    [['rus'], 'uz'],
    [['english'], 'uz'],
    [[''], 'uz'],
    [[], 'uz'],
  ])('%j → %s', (preferred, locale) => {
    expect(localeFromSystem(preferred)).toBe(locale);
  });
});

describe('time formats', () => {
  /** 2026-10-14 11:00 local time. */
  const NOW = new Date(2026, 9, 14, 11, 0, 0).getTime();
  const MINUTE = 60_000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it.each<[Locale, number, string]>([
    ['uz', 0, 'hozirgina'],
    ['uz', 2 * MINUTE, '2 daq oldin'],
    ['uz', 3 * 60 * MINUTE, '3 soat oldin'],
    ['uz', 4 * 24 * 60 * MINUTE, '4 kun oldin'],
    ['ru', 30_000, 'только что'],
    ['ru', 1 * MINUTE, '1 минуту назад'],
    ['ru', 2 * MINUTE, '2 минуты назад'],
    ['ru', 5 * MINUTE, '5 минут назад'],
    ['ru', 21 * MINUTE, '21 минуту назад'],
    ['ru', 1 * 60 * MINUTE, '1 час назад'],
    ['ru', 3 * 60 * MINUTE, '3 часа назад'],
    ['ru', 11 * 60 * MINUTE, '11 часов назад'],
    ['ru', 2 * 24 * 60 * MINUTE, '2 дня назад'],
    ['ru', 5 * 24 * 60 * MINUTE, '5 дней назад'],
    ['en', -5 * MINUTE, 'just now'],
    ['en', 2 * MINUTE, '2 min ago'],
    ['en', 60 * MINUTE, '1 hour ago'],
    ['en', 2 * 60 * MINUTE, '2 hours ago'],
    ['en', 24 * 60 * MINUTE, '1 day ago'],
    ['en', 3 * 24 * 60 * MINUTE, '3 days ago'],
  ])('%s, %i ms ago: %s', (locale, ms, text) => {
    expect(formatAgo(MESSAGES[locale].time, ago(ms), NOW)).toBe(text);
    expect(i18nFor(locale).formatAgo(ago(ms), NOW)).toBe(text);
  });

  it('an unreadable time reads as just now', () => {
    expect(formatAgo(MESSAGES.ru.time, 'nope', NOW)).toBe('только что');
  });

  it.each<[Locale, string, string]>([
    ['uz', '09:05', '13.10 23:59'],
    ['ru', '09:05', '13.10 23:59'],
    ['en', '09:05', '10/13 23:59'],
  ])('%s: a 24-hour clock today, the day and month before it on another day (uz/ru dotted, en Intl)', (locale, today, other) => {
    expect(formatClock(locale, new Date(2026, 9, 14, 9, 5).toISOString(), NOW)).toBe(today);
    expect(formatClock(locale, new Date(2026, 9, 13, 23, 59).toISOString(), NOW)).toBe(other);
    expect(i18nFor(locale).formatTime(new Date(2026, 9, 14, 9, 5).toISOString(), NOW)).toBe(today);
    expect(formatClock(locale, 'nope', NOW)).toBe('—');
  });
});

describe('i18nFor', () => {
  it('one frozen object per language, holding its dictionary', () => {
    for (const locale of LOCALES) {
      expect(i18nFor(locale)).toBe(i18nFor(locale));
      expect(i18nFor(locale).t).toBe(MESSAGES[locale]);
      expect(i18nFor(locale).locale).toBe(locale);
      expect(Object.isFrozen(i18nFor(locale))).toBe(true);
    }
  });

  it('plural is bound to the language', () => {
    const forms = { one: 'one', few: 'few', many: 'many', other: 'other' };
    expect(i18nFor('ru').plural(5, forms)).toBe('many');
    expect(i18nFor('en').plural(5, forms)).toBe('other');
  });
});
