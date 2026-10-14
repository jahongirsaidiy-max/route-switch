import type { EngineState } from '@routeswitch/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RsApi, RsResult, RsSnapshot } from '../rs';
import {
  LOADING_VIEW,
  createEngineStateStore,
  engineStateStoreFor,
  useEngineState,
  viewOfSnapshot,
  type EngineStateView,
} from './useEngineState';

const STATE: EngineState = {
  helperVersion: '0.1.0',
  seq: 3,
  configRevision: 1,
  enabled: true,
  interfaces: {
    ethernet: { device: 'en5', ip: '10.20.4.37', gateway: '10.20.4.1', up: true },
    wifi: { device: 'en0', ip: '192.168.0.104', gateway: '192.168.0.1', up: true },
  },
  adapters: [],
  rules: [],
  lastApplyAt: null,
  lastReconcileReason: null,
};

const CONNECTED: RsSnapshot = { connection: { kind: 'connected', helperVersion: '0.1.0' }, state: STATE };
const NOT_INSTALLED: RsSnapshot = { connection: { kind: 'not-installed' }, state: null };
const DISCONNECTED: RsSnapshot = { connection: { kind: 'disconnected', reason: 'not-running' }, state: null };

/** A fake preload API whose `getState` answers when the test says so. */
function fakeRs() {
  const listeners = new Set<(snapshot: RsSnapshot) => void>();
  const answers: ((result: RsResult<RsSnapshot>) => void)[] = [];
  const rejections: ((error: unknown) => void)[] = [];
  const api: Pick<RsApi, 'getState' | 'onState'> = {
    getState: vi.fn(
      () =>
        new Promise<RsResult<RsSnapshot>>((resolve, reject) => {
          answers.push(resolve);
          rejections.push(reject);
        }),
    ),
    onState: vi.fn((listener: (snapshot: RsSnapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return {
    api,
    listeners,
    push: (snapshot: RsSnapshot) => {
      for (const listener of [...listeners]) listener(snapshot);
    },
    answer: async (result: RsResult<RsSnapshot>, index = answers.length - 1) => {
      answers[index]?.(result);
      await Promise.resolve();
      await Promise.resolve();
    },
    reject: async (error: unknown) => {
      rejections[rejections.length - 1]?.(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('viewOfSnapshot', () => {
  it('passes the state of a live connection through', () => {
    expect(viewOfSnapshot(CONNECTED)).toEqual({
      helper: 'connected',
      connection: CONNECTED.connection,
      state: STATE,
      error: null,
    });
  });

  it('reports a missing or unreachable helper without a state', () => {
    expect(viewOfSnapshot(NOT_INSTALLED)).toMatchObject({ helper: 'not-installed', state: null });
    expect(viewOfSnapshot(DISCONNECTED)).toMatchObject({
      helper: 'disconnected',
      connection: { kind: 'disconnected', reason: 'not-running' },
      state: null,
    });
    const incompatible: RsSnapshot = {
      connection: { kind: 'incompatible', helperVersion: '0.0.9', protocolVersion: 0, expectedProtocolVersion: 1 },
      state: null,
    };
    expect(viewOfSnapshot(incompatible).helper).toBe('incompatible');
  });

  it('never shows a state next to a connection that is not live', () => {
    expect(viewOfSnapshot({ connection: { kind: 'connecting' }, state: STATE }).state).toBeNull();
    // A helper whose stored config is unreadable (TASK-300): its own status, no state.
    expect(viewOfSnapshot({ connection: { kind: 'config-unreadable', helperVersion: '0.1.0' }, state: STATE })).toMatchObject({
      helper: 'config-unreadable',
      state: null,
    });
  });
});

describe('createEngineStateStore', () => {
  it('is loading and idle until someone listens', () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    expect(store.getSnapshot()).toBe(LOADING_VIEW);
    expect(rs.api.onState).not.toHaveBeenCalled();
    expect(rs.api.getState).not.toHaveBeenCalled();
  });

  it('subscribes to onState before asking getState, then shows the answer', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(vi.mocked(rs.api.onState).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(rs.api.getState).mock.invocationCallOrder[0] ?? 0,
    );

    await rs.answer({ ok: true, value: CONNECTED });
    expect(store.getSnapshot()).toMatchObject({ helper: 'connected', state: STATE });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('follows pushed snapshots: not installed, connected, disconnected', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    const seen: EngineStateView[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    await rs.answer({ ok: true, value: NOT_INSTALLED });
    rs.push(CONNECTED);
    rs.push(DISCONNECTED);
    expect(seen.map((view) => view.helper)).toEqual(['not-installed', 'connected', 'disconnected']);
    expect(store.getSnapshot().state).toBeNull();
  });

  it('drops a getState answer that a push has overtaken', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    store.subscribe(() => undefined);
    rs.push(DISCONNECTED);
    await rs.answer({ ok: true, value: CONNECTED });
    expect(store.getSnapshot().helper).toBe('disconnected');
  });

  it('shows a refused getState as unavailable', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    store.subscribe(() => undefined);
    await rs.answer({ ok: false, code: 'forbidden', error: 'Not the app page' });
    expect(store.getSnapshot()).toEqual({
      helper: 'unavailable',
      connection: null,
      state: null,
      error: { code: 'forbidden', message: 'Not the app page' },
    });
    // A later push still brings the screen back.
    rs.push(CONNECTED);
    expect(store.getSnapshot().helper).toBe('connected');
  });

  it('does not hang on a getState that rejects against its contract', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    store.subscribe(() => undefined);
    await rs.reject(new Error('boom'));
    expect(store.getSnapshot()).toMatchObject({ helper: 'unavailable', error: { code: 'internal', message: 'boom' } });
  });

  it('shares one subscription and unsubscribes with the last listener', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    const stopA = store.subscribe(() => undefined);
    const stopB = store.subscribe(() => undefined);
    expect(rs.api.onState).toHaveBeenCalledTimes(1);
    expect(rs.api.getState).toHaveBeenCalledTimes(1);
    expect(rs.listeners.size).toBe(1);

    stopA();
    stopA();
    expect(rs.listeners.size).toBe(1);
    stopB();
    expect(rs.listeners.size).toBe(0);

    // The answer of the stopped round is not applied.
    await rs.answer({ ok: true, value: CONNECTED }, 0);
    expect(store.getSnapshot()).toBe(LOADING_VIEW);
  });

  it('starts over with a fresh getState when listened to again', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    const stop = store.subscribe(() => undefined);
    await rs.answer({ ok: true, value: CONNECTED });
    stop();

    store.subscribe(() => undefined);
    expect(rs.api.getState).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().helper).toBe('connected');
    await rs.answer({ ok: true, value: NOT_INSTALLED });
    expect(store.getSnapshot().helper).toBe('not-installed');
  });

  it('lets a listener unsubscribe another while being notified', async () => {
    const rs = fakeRs();
    const store = createEngineStateStore(rs.api);
    const second = vi.fn();
    let stopSecond: () => void = () => undefined;
    store.subscribe(() => {
      stopSecond();
    });
    stopSecond = store.subscribe(second);
    await rs.answer({ ok: true, value: CONNECTED });
    expect(store.getSnapshot().helper).toBe('connected');
    rs.push(DISCONNECTED);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useEngineState', () => {
  it('shares one store per API object', () => {
    const rs = fakeRs();
    expect(engineStateStoreFor(rs.api)).toBe(engineStateStoreFor(rs.api));
    expect(engineStateStoreFor(fakeRs().api)).not.toBe(engineStateStoreFor(rs.api));
  });

  it('renders the current view of the store', async () => {
    const rs = fakeRs();
    const Probe = () => {
      const view = useEngineState(rs.api);
      return createElement('span', null, `${view.helper}:${view.state?.helperVersion ?? '-'}`);
    };
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>loading:-</span>');

    const store = engineStateStoreFor(rs.api);
    store.subscribe(() => undefined);
    await rs.answer({ ok: true, value: CONNECTED });
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>connected:0.1.0</span>');
  });
});
