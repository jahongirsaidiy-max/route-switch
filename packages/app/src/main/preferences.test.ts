import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_PREFERENCES_FILE_BYTES, type Language } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryLogger } from './helperClient.fixtures';
import {
  createPreferences,
  nodePreferencesFileSystem,
  PREFERENCES_FILE_MODE,
  PREFERENCES_FILE_NAME,
  readPreferencesFile,
  writePreferencesFile,
  type PreferencesFileSystem,
} from './preferences';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'routeswitch-preferences-'));
  file = path.join(dir, PREFERENCES_FILE_NAME);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = (options: { preferred?: () => readonly string[]; fs?: PreferencesFileSystem } = {}) => {
  const { logger, entries } = memoryLogger();
  const preferences = createPreferences({
    dir,
    preferredLanguages: options.preferred ?? (() => ['ru-RU', 'en-US']),
    logger,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  return { preferences, entries };
};

describe('reading: never fails, falls back to the system language', () => {
  it.each<[readonly string[], Language]>([
    [['ru-RU', 'en-US'], 'ru'],
    [['ru'], 'ru'],
    [['en-US'], 'en'],
    [['en-GB', 'ru-RU'], 'en'],
    [['uz-Latn-UZ'], 'uz'],
    [['de-DE', 'ru-RU'], 'uz'],
    [[], 'uz'],
  ])('no file, system languages %j → %s', async (preferred, expected) => {
    const { preferences, entries } = store({ preferred: () => preferred });
    expect(await preferences.language()).toBe(expected);
    expect(entries.some((entry) => entry.msg === 'No preferences file yet; using the system language')).toBe(true);
  });

  it('a system that cannot name its languages gives Uzbek (logged, not thrown)', async () => {
    const { preferences, entries } = store({
      preferred: () => {
        throw new Error('not ready');
      },
    });
    expect(await preferences.language()).toBe('uz');
    expect(entries.some((entry) => entry.level === 'warn' && entry.msg === 'Could not read the preferred system languages')).toBe(true);
  });

  it('a stored language wins over the system', async () => {
    await writeFile(file, JSON.stringify({ language: 'en' }));
    const preferred = vi.fn(() => ['ru-RU']);
    const { preferences } = store({ preferred });
    expect(await preferences.language()).toBe('en');
    expect(preferred).not.toHaveBeenCalled();
  });

  it('keys this version does not know are ignored', async () => {
    await writeFile(file, JSON.stringify({ language: 'uz', notifications: true }));
    expect(await store().preferences.language()).toBe('uz');
  });

  it.each<[string, string | Uint8Array]>([
    ['not JSON', '{language:'],
    ['an unknown language', JSON.stringify({ language: 'de' })],
    ['a differently spelled language', JSON.stringify({ language: 'RU' })],
    ['no language', JSON.stringify({})],
    ['an array', JSON.stringify(['ru'])],
    ['null', 'null'],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ['larger than 64 KiB', JSON.stringify({ language: 'en', padding: 'x'.repeat(MAX_PREFERENCES_FILE_BYTES) })],
  ])('a file that is %s is ignored: the system language, and a warning', async (_name, content) => {
    await writeFile(file, content);
    const { preferences, entries } = store();
    expect(await preferences.language()).toBe('ru');
    expect(entries.some((entry) => entry.level === 'warn' && entry.msg === 'The preferences file was ignored')).toBe(true);
  });

  it('a directory in its place is ignored', async () => {
    await mkdir(file);
    expect(await readPreferencesFile(file)).toEqual({ kind: 'refused', why: 'not a regular file' });
    expect(await store().preferences.language()).toBe('ru');
  });

  it('a symbolic link is not followed', async () => {
    const target = path.join(dir, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ language: 'en' }));
    await symlink(target, file);
    expect(await readPreferencesFile(file)).toMatchObject({ kind: 'refused' });
    expect(await store().preferences.language()).toBe('ru');
  });

  it('after a change the answer is the new language, not what the file said at start', async () => {
    await writeFile(file, JSON.stringify({ language: 'en' }));
    const { preferences } = store();
    expect(await preferences.language()).toBe('en');
    await preferences.setLanguage('uz');
    expect(await preferences.language()).toBe('uz');
  });

  it('a change made before the first read finished is not undone by the read', async () => {
    await writeFile(file, JSON.stringify({ language: 'en' }));
    const { preferences } = store();
    const [, set] = await Promise.all([preferences.language(), preferences.setLanguage('ru')]);
    expect(set).toBe('ru');
    expect(await preferences.language()).toBe('ru');
  });

  it('every caller waits for the same single read', async () => {
    await writeFile(file, JSON.stringify({ language: 'en' }));
    const open = vi.fn(nodePreferencesFileSystem.open);
    const { preferences } = store({ fs: { ...nodePreferencesFileSystem, open } });
    expect(await Promise.all([preferences.language(), preferences.language(), preferences.language()])).toEqual(['en', 'en', 'en']);
    expect(await preferences.language()).toBe('en');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('writing: atomic, private, last choice wins', () => {
  it('stores the language as JSON with mode 0600 and leaves no temporary file', async () => {
    const { preferences } = store();
    expect(await preferences.setLanguage('en')).toBe('en');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ language: 'en' });
    expect((await stat(file)).mode & 0o777).toBe(PREFERENCES_FILE_MODE);
    expect(await readdir(dir)).toEqual([PREFERENCES_FILE_NAME]);
    // A new run reads it back.
    expect(await store().preferences.language()).toBe('en');
  });

  it('replaces a file another program made readable by others with a private one', async () => {
    await writeFile(file, JSON.stringify({ language: 'uz' }));
    await chmod(file, 0o644);
    await store().preferences.setLanguage('ru');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('writes one at a time, in order: the last choice is the one on disk', async () => {
    const { preferences } = store({ preferred: () => ['en-US'] });
    await Promise.all([preferences.setLanguage('ru'), preferences.setLanguage('en'), preferences.setLanguage('uz')]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ language: 'uz' });
    expect(await preferences.language()).toBe('uz');
  });

  it('listeners hear of a change, not of the same language again; a failing listener is logged', async () => {
    const { preferences, entries } = store({ preferred: () => ['en-US'] });
    const heard: Language[] = [];
    preferences.onLanguage(() => {
      throw new Error('window gone');
    });
    const unsubscribe = preferences.onLanguage((language) => heard.push(language));
    await preferences.setLanguage('en');
    await preferences.setLanguage('ru');
    await preferences.setLanguage('ru');
    unsubscribe();
    await preferences.setLanguage('uz');
    expect(heard).toEqual(['ru']);
    expect(entries.some((entry) => entry.level === 'error' && entry.msg === 'A language listener failed')).toBe(true);
  });

  it('a file that cannot be written: the language still holds for this run, the temporary file is removed, the failure is logged', async () => {
    const unlink = vi.fn(nodePreferencesFileSystem.unlink);
    const fs: PreferencesFileSystem = {
      ...nodePreferencesFileSystem,
      rename: () => Promise.reject(Object.assign(new Error('read-only'), { code: 'EROFS' })),
      unlink,
    };
    const { preferences, entries } = store({ fs });
    const heard: Language[] = [];
    preferences.onLanguage((language) => heard.push(language));
    expect(await preferences.setLanguage('en')).toBe('en');
    expect(await preferences.language()).toBe('en');
    expect(heard).toEqual(['en']);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
    expect(entries.some((entry) => entry.level === 'error' && entry.msg.startsWith('Could not save the preferences'))).toBe(true);
  });

  it('writePreferencesFile refuses to write through a symbolic link at the temporary name', async () => {
    const target = path.join(dir, 'target');
    await symlink(target, path.join(dir, `.${PREFERENCES_FILE_NAME}.fixed.tmp`));
    const result = await writePreferencesFile(file, { language: 'en' }, nodePreferencesFileSystem, () => 'fixed');
    expect(result.ok).toBe(false);
    await expect(stat(target)).rejects.toThrow();
  });
});

describe('the dismissed rules backup (TASK-DELTA-16)', () => {
  const SAVED_AT = '2026-10-15T08:30:00.000Z';

  it('is none without a file, and read back from one', async () => {
    expect(await store().preferences.dismissedBackupAt()).toBeNull();
    await writeFile(file, JSON.stringify({ language: 'en', dismissedBackupAt: SAVED_AT }));
    const { preferences } = store();
    expect(await preferences.dismissedBackupAt()).toBe(SAVED_AT);
    expect(await preferences.language()).toBe('en');
  });

  it('a broken value reads as none and does not cost the language', async () => {
    await writeFile(file, JSON.stringify({ language: 'en', dismissedBackupAt: 'later' }));
    const { preferences } = store();
    expect(await preferences.dismissedBackupAt()).toBeNull();
    expect(await preferences.language()).toBe('en');
  });

  it('is stored next to the language; a later language change keeps it', async () => {
    await writeFile(file, JSON.stringify({ language: 'en' }));
    const { preferences, entries } = store();
    await preferences.setDismissedBackupAt(SAVED_AT);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ language: 'en', dismissedBackupAt: SAVED_AT });
    await preferences.setLanguage('ru');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ language: 'ru', dismissedBackupAt: SAVED_AT });
    expect((await stat(file)).mode & 0o777).toBe(PREFERENCES_FILE_MODE);
    expect(entries.some((entry) => entry.msg === 'Rules backup offer dismissed')).toBe(true);
    expect(await store().preferences.dismissedBackupAt()).toBe(SAVED_AT);
  });

  it('a file that cannot be written: the value holds for this run, the failure is logged', async () => {
    const failing: PreferencesFileSystem = {
      ...nodePreferencesFileSystem,
      rename: () => Promise.reject(Object.assign(new Error('no'), { code: 'EACCES' })),
    };
    const { preferences, entries } = store({ fs: failing });
    await preferences.setDismissedBackupAt(SAVED_AT);
    expect(await preferences.dismissedBackupAt()).toBe(SAVED_AT);
    expect(entries.some((entry) => entry.level === 'error')).toBe(true);
  });
});
