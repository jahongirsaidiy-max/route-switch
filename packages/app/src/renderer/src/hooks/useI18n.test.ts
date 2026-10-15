import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Locale } from '../../../i18n';
import { renderMarkup } from '../components/test-utils';
import type { RsResult } from '../rs';
import { createLanguageStore, I18nProvider, languageStoreFor, useI18n, type LanguageApi } from './useI18n';

/** A preload stand-in: `getLanguage` answers when the test says so; `push` is the main process's `rs:language`. */
function fakeRs() {
  const answers: ((result: RsResult<Locale>) => void)[] = [];
  const listeners = new Set<(language: Locale) => void>();
  const rs = {
    getLanguage: vi.fn(
      () =>
        new Promise<RsResult<Locale>>((resolve) => {
          answers.push(resolve);
        }),
    ),
    onLanguage: vi.fn((listener: (language: Locale) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies LanguageApi;
  const answer = async (result: RsResult<Locale>, index = answers.length - 1) => {
    answers[index]?.(result);
    await Promise.resolve();
    await Promise.resolve();
  };
  const push = (language: Locale) => {
    for (const listener of [...listeners]) listener(language);
  };
  return { rs, answer, push, listeners };
}

describe('createLanguageStore', () => {
  it('subscribes first, then asks; null until the answer', async () => {
    const { rs, answer } = fakeRs();
    const store = createLanguageStore(rs);
    const seen: (Locale | null)[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    expect(rs.onLanguage.mock.invocationCallOrder[0]).toBeLessThan(rs.getLanguage.mock.invocationCallOrder[0] ?? 0);
    expect(store.getSnapshot()).toBeNull();
    await answer({ ok: true, value: 'ru' });
    expect(seen).toEqual(['ru']);
  });

  it('a push changes the language at once; the same language again notifies nobody', async () => {
    const { rs, answer, push } = fakeRs();
    const store = createLanguageStore(rs);
    const listener = vi.fn();
    store.subscribe(listener);
    await answer({ ok: true, value: 'uz' });
    push('en');
    push('en');
    expect(store.getSnapshot()).toBe('en');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('an answer that was under way when a push arrived is dropped (the push is newer)', async () => {
    const { rs, answer, push } = fakeRs();
    const store = createLanguageStore(rs);
    store.subscribe(() => undefined);
    push('en');
    await answer({ ok: true, value: 'uz' });
    expect(store.getSnapshot()).toBe('en');
  });

  it('a refused or rejected call shows the page in Uzbek rather than nothing', async () => {
    const refused = fakeRs();
    const store = createLanguageStore(refused.rs);
    store.subscribe(() => undefined);
    await refused.answer({ ok: false, code: 'forbidden', error: 'x' });
    expect(store.getSnapshot()).toBe('uz');

    const rejected = fakeRs();
    rejected.rs.getLanguage.mockImplementationOnce(() => Promise.reject(new Error('gone')));
    const second = createLanguageStore(rejected.rs);
    second.subscribe(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(second.getSnapshot()).toBe('uz');
  });

  it('the last listener leaving unsubscribes; the next one asks again', async () => {
    const { rs, answer, listeners } = fakeRs();
    const store = createLanguageStore(rs);
    const off = store.subscribe(() => undefined);
    await answer({ ok: true, value: 'ru' });
    off();
    off();
    expect(listeners.size).toBe(0);
    store.subscribe(() => undefined);
    expect(rs.getLanguage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe('ru');
  });

  it('one store per API object', () => {
    const { rs } = fakeRs();
    expect(languageStoreFor(rs)).toBe(languageStoreFor(rs));
    expect(languageStoreFor(fakeRs().rs)).not.toBe(languageStoreFor(rs));
  });
});

describe('I18nProvider / useI18n', () => {
  function Probe() {
    const { locale, t, formatAgo, plural } = useI18n();
    const now = Date.UTC(2026, 9, 15, 12, 0);
    return createElement(
      'p',
      { 'data-locale': locale },
      `${t.helperStatus.connected} | ${formatAgo(new Date(now - 5 * 60_000).toISOString(), now)} | ${plural(5, { one: 'one', few: 'few', many: 'many', other: 'other' })}`,
    );
  }

  it.each<[Locale, string]>([
    ['uz', 'Helper ishlayapti | 5 daq oldin | other'],
    ['ru', 'Helper работает | 5 минут назад | many'],
    ['en', 'Helper is running | 5 min ago | other'],
  ])('%s: the dictionary, the time words and the plural rules of the language', (language, text) => {
    const html = renderMarkup(createElement(I18nProvider, { language }, createElement(Probe)));
    expect(html).toContain(`data-locale="${language}"`);
    expect(html).toContain(text);
  });

  it('outside a provider a component speaks Uzbek (screens not wrapped yet, component tests)', () => {
    expect(renderMarkup(createElement(Probe))).toContain('Helper ishlayapti');
  });

  it('shows the fallback until the language is known', () => {
    const { rs } = fakeRs();
    expect(renderMarkup(createElement(I18nProvider, { rs, fallback: 'wait' }, createElement(Probe)))).toBe('wait');
  });
});
