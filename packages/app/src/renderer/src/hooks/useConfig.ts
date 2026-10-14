// The stored config as the renderer sees it. `EngineState.rules` carries no
// target, kind or interface, so a screen that names its rules joins the state
// with the config by `ruleId`. The config is read from the helper
// (`window.rs.getConfig`) and read again whenever the engine state reports a
// new `configRevision`, and on every (re)connect: the revision restarts with
// the helper, so the same number after a reconnect may be another config.
// Nothing here keeps a copy of its own: without a connection there is no
// config.

import type { Config } from '@routeswitch/shared';
import { useEffect, useSyncExternalStore } from 'react';

import type { RsApi, RsErrorCode } from '../rs';
import { useEngineState } from './useEngineState';

/**
 * - `idle`    — no connection to the helper: there is no config to show;
 * - `loading` — being read; `config` is the previous revision's while it loads (null on the first read);
 * - `ready`   — `config` is the one of `revision`;
 * - `failed`  — the read failed (`error` says why); `config` is the previous one, if any.
 */
export interface ConfigView {
  readonly phase: 'idle' | 'loading' | 'ready' | 'failed';
  readonly config: Config | null;
  /** The `configRevision` the view was asked for; null while `idle`. */
  readonly revision: number | null;
  readonly error: { readonly code: RsErrorCode; readonly message: string } | null;
}

export const IDLE_CONFIG: ConfigView = { phase: 'idle', config: null, revision: null, error: null };

type ConfigApi = Pick<RsApi, 'getConfig'>;

export interface ConfigStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ConfigView;
  /**
   * The revision the engine state reports, or null without a connection.
   * A new value starts a read; the same value again does nothing. Null drops
   * the config, so the next revision — even the same number after a
   * reconnect — is read again.
   */
  readonly sync: (revision: number | null) => void;
  /** Reads the current revision's config again (after a failed read). Does nothing while `idle`. */
  readonly reload: () => void;
}

/**
 * A store for `useSyncExternalStore`. Only the answer to the latest read is
 * applied: one that arrives after another `sync` is dropped.
 */
export function createConfigStore(rs: ConfigApi): ConfigStore {
  let view: ConfigView = IDLE_CONFIG;
  const listeners = new Set<() => void>();
  // Bumped by every read: only the answer to the latest one is applied.
  let generation = 0;

  const publish = (next: ConfigView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };

  const read = (revision: number | null) => {
    generation += 1;
    if (revision === null) {
      publish(IDLE_CONFIG);
      return;
    }
    const asked = generation;
    publish({ phase: 'loading', config: view.config, revision, error: null });
    const settle = (next: Omit<ConfigView, 'revision'>) => {
      if (asked === generation) publish({ ...next, revision });
    };
    rs.getConfig().then(
      (result) => {
        settle(
          result.ok
            ? { phase: 'ready', config: result.value, error: null }
            : { phase: 'failed', config: view.config, error: { code: result.code, message: result.error } },
        );
      },
      // `getConfig` never rejects by contract; if it ever does, say so rather than load forever.
      (error: unknown) => {
        settle({
          phase: 'failed',
          config: view.config,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        });
      },
    );
  };

  return {
    sync: (revision) => {
      if (revision !== view.revision) read(revision);
    },
    reload: () => {
      if (view.revision !== null) read(view.revision);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => view,
  };
}

const stores = new WeakMap<object, ConfigStore>();

/** The shared store of one API object (`window.rs` in the app, a fake in tests): one read per revision per window. */
export function configStoreFor(rs: ConfigApi): ConfigStore {
  let store = stores.get(rs);
  if (store === undefined) {
    store = createConfigStore(rs);
    stores.set(rs, store);
  }
  return store;
}

/** The revision to read the config for: the engine's `configRevision` while connected, otherwise null. */
export function wantedRevision(view: ReturnType<typeof useEngineState>): number | null {
  return view.helper === 'connected' && view.state !== null ? view.state.configRevision : null;
}

/**
 * The stored config, kept in step with the engine state. Screens join
 * `EngineState.rules` with `config.rules` by id (`ruleId` / `id`).
 */
export function useConfig(rs: Pick<RsApi, 'getConfig' | 'getState' | 'onState'> = window.rs): ConfigView {
  const store = configStoreFor(rs);
  const revision = wantedRevision(useEngineState(rs));
  useEffect(() => {
    store.sync(revision);
  }, [store, revision]);
  // The third argument serves static rendering (component tests); the app never renders on a server.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
