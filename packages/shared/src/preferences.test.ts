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

  it('keeps the dismissed backup time, and reads a broken one as none', () => {
    expect(Preferences.parse({ language: 'en', dismissedBackupAt: '2026-10-15T08:30:00.000Z' })).toEqual({
      language: 'en',
      dismissedBackupAt: '2026-10-15T08:30:00.000Z',
    });
    expect(Preferences.parse({ language: 'en', dismissedBackupAt: 'soon' })).toEqual({ language: 'en' });
    expect(Preferences.parse({ language: 'en', dismissedBackupAt: 7 })).toEqual({ language: 'en' });
  });

  it.each([[{}], [{ language: 'de' }], [null], [['ru']], ['ru']])('refuses %j', (value) => {
    expect(Preferences.safeParse(value).success).toBe(false);
  });

  it('a preferences file is at most 64 KiB', () => {
    expect(MAX_PREFERENCES_FILE_BYTES).toBe(65_536);
  });
});
