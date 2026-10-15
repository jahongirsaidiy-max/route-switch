// The journal as the renderer sees it: the main process's history
// (`window.rs.getLog`) followed by the live stream (`window.rs.onLog`), joined
// on the entries' sequence numbers so nothing is shown twice or skipped.

import { useSyncExternalStore } from 'react';

import type { RsApi, RsErrorCode, RsLogEntry } from '../../rs';

/** As many entries as the main process keeps; a window open for long never holds more. */
export const LOG_VIEW_LIMIT = 500;

export interface LogView {
  /** `loading` until the history arrives; `failed` when it could not be read (live entries still show). */
  readonly phase: 'loading' | 'ready' | 'failed';
  /** Oldest first, at most `LOG_VIEW_LIMIT`, strictly increasing `seq`. */
  readonly entries: readonly RsLogEntry[];
  readonly error: { readonly code: RsErrorCode; readonly message: string } | null;
}

export const LOADING_LOG: LogView = { phase: 'loading', entries: [], error: null };

type LogApi = Pick<RsApi, 'getLog' | 'onLog'>;

export interface LogStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => LogView;
}

/** `entries` followed by those of `more` that are newer than all of them, trimmed to the limit. */
export function appendNewer(entries: readonly RsLogEntry[], more: readonly RsLogEntry[]): readonly RsLogEntry[] {
  let last = entries.at(-1)?.seq ?? 0;
  const added: RsLogEntry[] = [];
  for (const entry of more) {
    if (entry.seq > last) {
      added.push(entry);
      last = entry.seq;
    }
  }
  if (added.length === 0) return entries;
  const joined = [...entries, ...added];
  return joined.length > LOG_VIEW_LIMIT ? joined.slice(joined.length - LOG_VIEW_LIMIT) : joined;
}

/**
 * A store for `useSyncExternalStore`. With the first listener it subscribes
 * to `onLog` and then asks `getLog` (subscribe first: nothing is replayed).
 * Entries that arrive before the history are held and appended after it,
 * minus the ones the history already holds. With the last listener it
 * unsubscribes; the next first listener reads the history again.
 */
export function createLogStore(rs: LogApi): LogStore {
  let view: LogView = LOADING_LOG;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  // Live entries received while the history is still on its way.
  let early: RsLogEntry[] = [];

  const publish = (next: LogView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };

  const start = () => {
    generation += 1;
    const round = generation;
    early = [];
    unsubscribe = rs.onLog((entry) => {
      if (round !== generation) return;
      if (view.phase === 'loading') early.push(entry);
      else publish({ ...view, entries: appendNewer(view.entries, [entry]) });
    });
    const settle = (next: Omit<LogView, 'entries'>, history: readonly RsLogEntry[]) => {
      if (round !== generation) return;
      const entries = appendNewer(appendNewer([], history), early);
      early = [];
      publish({ ...next, entries });
    };
    rs.getLog().then(
      (result) => {
        if (result.ok) settle({ phase: 'ready', error: null }, result.value);
        else settle({ phase: 'failed', error: { code: result.code, message: result.error } }, []);
      },
      // `getLog` never rejects by contract; if it ever does, say so rather than load forever.
      (error: unknown) => {
        settle(
          { phase: 'failed', error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } },
          [],
        );
      },
    );
  };

  const stop = () => {
    generation += 1;
    const current = unsubscribe;
    unsubscribe = null;
    current?.();
    view = LOADING_LOG;
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
    getSnapshot: () => view,
  };
}

const stores = new WeakMap<object, LogStore>();

export function logStoreFor(rs: LogApi): LogStore {
  let store = stores.get(rs);
  if (store === undefined) {
    store = createLogStore(rs);
    stores.set(rs, store);
  }
  return store;
}

/** The journal, kept current by `onLog`. */
export function useLog(rs: LogApi = window.rs): LogView {
  const store = logStoreFor(rs);
  // The third argument serves static rendering (component tests); the app never renders on a server.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
