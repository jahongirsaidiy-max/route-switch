// The UI language of the page: `window.rs.getLanguage` and
// `window.rs.onLanguage`, kept in one store per API object like the engine
// state (`useEngineState`). `I18nProvider` puts the dictionary of the current
// language into context; `useI18n()` reads it. A language change reaches every
// open window through `onLanguage`, so the page switches without a reload.

import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';

import { DEFAULT_LOCALE, i18nFor, type I18n, type Locale } from '../../../i18n';
import type { RsApi } from '../rs';

export type LanguageApi = Pick<RsApi, 'getLanguage' | 'onLanguage'>;

/** The language of the page; null until the main process has answered (or failed, then `uz`). */
export interface LanguageStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Locale | null;
}

/**
 * A store over the preload API for `useSyncExternalStore`.
 *
 * With the first listener it subscribes to `onLanguage` and then asks
 * `getLanguage` (nothing is replayed). A pushed language is newer than the
 * answer of a call already under way, so once one has arrived that answer is
 * dropped. A failed call gives Uzbek rather than a page that never shows. The
 * last language is kept when the last listener leaves.
 */
export function createLanguageStore(rs: LanguageApi): LanguageStore {
  let language: Locale | null = null;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let generation = 0;

  const publish = (next: Locale) => {
    if (next === language) return;
    language = next;
    for (const listener of [...listeners]) listener();
  };

  const start = () => {
    generation += 1;
    unsubscribe = rs.onLanguage((pushed) => {
      generation += 1;
      publish(pushed);
    });
    const asked = generation;
    const settle = (next: Locale) => {
      if (asked === generation) publish(next);
    };
    rs.getLanguage().then(
      (result) => {
        settle(result.ok ? result.value : (language ?? DEFAULT_LOCALE));
      },
      // `getLanguage` never rejects by contract; if it ever does, show the page in Uzbek rather than nothing.
      () => {
        settle(language ?? DEFAULT_LOCALE);
      },
    );
  };

  const stop = () => {
    generation += 1;
    const current = unsubscribe;
    unsubscribe = null;
    current?.();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => language,
  };
}

const stores = new WeakMap<object, LanguageStore>();

/** The shared store of one API object (`window.rs` in the app, a fake in tests). */
export function languageStoreFor(rs: LanguageApi): LanguageStore {
  let store = stores.get(rs);
  if (store === undefined) {
    store = createLanguageStore(rs);
    stores.set(rs, store);
  }
  return store;
}

/** A store that always holds one language: a fixed `language` for tests and static rendering. */
const fixedStores = new Map<Locale, LanguageStore>();
const fixedStore = (language: Locale): LanguageStore => {
  let store = fixedStores.get(language);
  if (store === undefined) {
    store = { subscribe: () => () => undefined, getSnapshot: () => language };
    fixedStores.set(language, store);
  }
  return store;
};

/** Outside a provider (component tests, screens not wrapped yet) the page speaks Uzbek. */
const I18nContext = createContext<I18n>(i18nFor(DEFAULT_LOCALE));

export interface I18nProviderProps {
  /** The preload API; `window.rs` in the app. Ignored when `language` is given. */
  readonly rs?: LanguageApi | undefined;
  /** A fixed language instead of the main process's (tests, static rendering). */
  readonly language?: Locale | undefined;
  /** What to show until the language is known (one answer from the main process's memory); nothing by default. */
  readonly fallback?: ReactNode;
  readonly children?: ReactNode;
}

/** Puts the current language's dictionary into context for everything below it, and onto `<html lang>`. */
export function I18nProvider({ rs, language, fallback = null, children }: I18nProviderProps): ReactElement {
  const store = language === undefined ? languageStoreFor(rs ?? window.rs) : fixedStore(language);
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (current !== null) document.documentElement.lang = current;
  }, [current]);
  // Nothing until the language is known: a Russian page must not flash its Uzbek texts first.
  if (current === null) return createElement(I18nContext.Provider, { value: i18nFor(DEFAULT_LOCALE) }, fallback);
  return createElement(I18nContext.Provider, { value: i18nFor(current) }, children);
}

/** The page's language: `t` (the dictionary), `locale`, `plural`, `formatTime`, `formatAgo`. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}
