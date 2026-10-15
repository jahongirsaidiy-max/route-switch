import { describe, expect, it } from 'vitest';

import { LANGUAGES, Language, MAX_PREFERENCES_FILE_BYTES, Preferences } from './index';

describe('Language', () => {
  it('is exactly uz, ru, en', () => {
    expect(LANGUAGES).toEqual(['uz', 'ru', 'en']);
    for (const language of LANGUAGES) expect(Language.safeParse(language).success).toBe(true);
  });

  it.each([['de'], ['RU'], ['ru-RU'], [' ru'], [''], [null], [1], [['ru']], [{}], ['toString'], ['__proto__']])('refuses %j', (value) => {
    expect(Language.safeParse(value).success).toBe(false);
  });
});

describe('Preferences', () => {
  it('reads the language and drops keys it does not know', () => {
    expect(Preferences.parse({ language: 'ru', notifications: true })).toEqual({ language: 'ru' });
  });

  it.each([[{}], [{ language: 'de' }], [null], [['ru']], ['ru']])('refuses %j', (value) => {
    expect(Preferences.safeParse(value).success).toBe(false);
  });

  it('a preferences file is at most 64 KiB', () => {
    expect(MAX_PREFERENCES_FILE_BYTES).toBe(65_536);
  });
});
