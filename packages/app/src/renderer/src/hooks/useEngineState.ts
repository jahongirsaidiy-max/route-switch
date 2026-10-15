// The renderer's one view of the helper: the connection and the engine state,
// from `window.rs.getState` and `window.rs.onState`. Every screen reads it
// through `useEngineState()`; nothing in the UI keeps its own copy of the
// truth. All components share one subscription per API object.

import type { EngineState } from '@routeswitch/shared';
import { useSyncExternalStore } from 'react';

import type { RsApi, RsConnection, RsErrorCode, RsSnapshot } from '../rs';

/**
 * What the UI shows about the helper, derived from the connection:
 * - `loading`       — the first snapshot has not arrived yet;
 * - `connected`     — the helper answers; `state` is present;
 * - `connecting`    — a (re)connect is under way;
 * - `not-installed` — there is no helper: offer to install it;
 * - `disconnected`  — installed but not reachable now (`connection.reason` says why);
 * - `incompatible`  — the helper speaks another protocol version: offer to reinstall;
 * - `stopped`       — the app is shutting down;
 * - `unavailable`   — the main process refused to give a snapshot (`error` says why).
 */
export type HelperStatus = RsConnection['kind'] | 'loading' | 'unavailable';

export interface EngineStateView {
  readonly helper: HelperStatus;
  /** Null while `loading` and when `unavailable`. */
  readonly connection: RsConnection | null;
  /** Present only while `helper` is `connected`. */
  readonly state: EngineState | null;
  /** Why the snapshot could not be read; only when `helper` is `unavailable`. */
  readonly error: { readonly code: RsErrorCode; readonly message: string } | null;
}

export const LOADING_VIEW: EngineStateView = { helper: 'loading', connection: null, state: null, error: null };

export function viewOfSnapshot(snapshot: RsSnapshot): EngineStateView {
  const connected = snapshot.connection.kind === 'connected';
  return {
    helper: snapshot.connection.kind,
    connection: snapshot.connection,
    // `state` is null whenever the connection is not `connected`; this keeps a
    // stray value from a broken snapshot from being shown as live.
    state: connected ? snapshot.state : null,
    error: null,
  };
}

export interface EngineStateStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => EngineStateView;
}

/**
 * A store over the preload API for `useSyncExternalStore`.
 *
 * With the first listener it subscribes to `onState` and then asks
 * `getState` (subscribe first: nothing is replayed). A pushed snapshot is
 * always newer than the answer of a `getState` call that was already under
 * way, so once one has arrived that answer is dropped. With the last listener
 * it unsubscribes; the last view is kept, and the next first listener starts
 * over with a fresh `getState`.
 */
export function createEngineStateStore(rs: Pick<RsApi, 'getState' | 'onState'>): EngineStateStore {
  let view: EngineStateView = LOADING_VIEW;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  // Bumped on every (re)start and stop and by every push: a `getState` answer
  // is applied only if nothing has happened since it was asked for.
  let generation = 0;

  const publish = (next: EngineStateView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };

  const start = () => {
    generation += 1;
    unsubscribe = rs.onState((snapshot) => {
      generation += 1;
      publish(viewOfSnapshot(snapshot));
    });
    const asked = generation;
    const settle = (next: EngineStateView) => {
      if (asked === generation) publish(next);
    };
    rs.getState().then(
      (result) => {
        settle(
          result.ok
            ? viewOfSnapshot(result.value)
            : { helper: 'unavailable', connection: null, state: null, error: { code: result.code, message: result.error } },
        );
      },
      // `getState` never rejects by contract; if it ever does, show it rather than spin forever.
      (error: unknown) => {
        settle({
          helper: 'unavailable',
          connection: null,
          state: null,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        });
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
    getSnapshot: () => view,
  };
}

const stores = new WeakMap<object, EngineStateStore>();

/** The shared store of one API object (`window.rs` in the app, a fake in tests). */
export function engineStateStoreFor(rs: Pick<RsApi, 'getState' | 'onState'>): EngineStateStore {
  let store = stores.get(rs);
  if (store === undefined) {
    store = createEngineStateStore(rs);
    stores.set(rs, store);
  }
  return store;
}

/**
 * The helper connection and engine state, kept current by `onState`.
 * `helper` tells a missing or unreachable helper apart from a live one.
 */
export function useEngineState(rs: Pick<RsApi, 'getState' | 'onState'> = window.rs): EngineStateView {
  const store = engineStateStoreFor(rs);
  // The third argument serves static rendering (component tests); the app never renders on a server.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
