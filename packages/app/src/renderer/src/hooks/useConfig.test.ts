import type { Config } from '@routeswitch/shared';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../components/test-utils';
import type { RsApi, RsResult } from '../rs';
import { configStoreFor, createConfigStore, IDLE_CONFIG, useConfig, wantedRevision } from './useConfig';
import { LOADING_VIEW, type EngineStateView } from './useEngineState';

const config = (note: string): Config => ({
  version: 1,
  enabled: true,
  rules: [{ id: '7f0e9a52-3c1b-4d8e-9a6f-2b5c8d1e4f70', kind: 'ip', target: '10.1.2.3', iface: 'ethernet', enabled: true, refreshSec: 600, note }],
});

/** A `getConfig` whose answers the test hands out one by one. */
function fakeApi() {
  const pending: ((result: RsResult<Config>) => void)[] = [];
  const getConfig = vi.fn(
    () =>
      new Promise<RsResult<Config>>((resolve) => {
        pending.push(resolve);
      }),
  );
  const answer = (index: number, result: RsResult<Config>) => {
    const resolve = pending[index];
    if (resolve === undefined) throw new Error(`no read #${String(index)}`);
    resolve(result);
  };
  return { rs: { getConfig }, getConfig, answer };
}

/** Lets settled promises run their callbacks. */
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

describe('createConfigStore', () => {
  it('is idle until a revision is wanted, then reads the config for it', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    expect(store.getSnapshot()).toBe(IDLE_CONFIG);
    expect(api.getConfig).not.toHaveBeenCalled();

    store.sync(3);
    expect(store.getSnapshot()).toEqual({ phase: 'loading', config: null, revision: 3, error: null });
    api.answer(0, { ok: true, value: config('a') });
    await flush();
    expect(store.getSnapshot()).toEqual({ phase: 'ready', config: config('a'), revision: 3, error: null });
  });

  it('the same revision again does not read again; a new one does, keeping the old config while it loads', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    store.sync(1);
    api.answer(0, { ok: true, value: config('a') });
    await flush();
    store.sync(1);
    expect(api.getConfig).toHaveBeenCalledTimes(1);

    store.sync(2);
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ phase: 'loading', config: config('a'), revision: 2 });
    api.answer(1, { ok: true, value: config('b') });
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', config: config('b'), revision: 2 });
  });

  it('applies only the answer to the latest read', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    store.sync(1);
    store.sync(2);
    api.answer(1, { ok: true, value: config('new') });
    await flush();
    api.answer(0, { ok: true, value: config('old') });
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', config: config('new'), revision: 2 });
  });

  it('without a connection there is no config; after a reconnect the same revision is read again', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    store.sync(4);
    api.answer(0, { ok: true, value: config('a') });
    await flush();

    store.sync(null);
    expect(store.getSnapshot()).toBe(IDLE_CONFIG);
    // An answer to a read made before the disconnect is dropped too.
    store.sync(4);
    store.sync(null);
    api.answer(1, { ok: true, value: config('late') });
    await flush();
    expect(store.getSnapshot()).toBe(IDLE_CONFIG);

    store.sync(4);
    expect(api.getConfig).toHaveBeenCalledTimes(3);
    api.answer(2, { ok: true, value: config('b') });
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', config: config('b'), revision: 4 });
  });

  it('a failed read keeps the previous config and says why; reload reads the same revision again', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    store.sync(1);
    api.answer(0, { ok: true, value: config('a') });
    await flush();
    store.sync(2);
    api.answer(1, { ok: false, code: 'timeout', error: 'The helper did not answer' });
    await flush();
    expect(store.getSnapshot()).toEqual({
      phase: 'failed',
      config: config('a'),
      revision: 2,
      error: { code: 'timeout', message: 'The helper did not answer' },
    });

    store.reload();
    expect(api.getConfig).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).toMatchObject({ phase: 'loading', revision: 2 });
    api.answer(2, { ok: true, value: config('b') });
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', config: config('b') });
  });

  it('reload does nothing while idle', () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    store.reload();
    expect(api.getConfig).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(IDLE_CONFIG);
  });

  it('a rejected read (never by contract) is shown as failed, not loading for ever', async () => {
    const store = createConfigStore({ getConfig: () => Promise.reject(new Error('bridge gone')) });
    store.sync(1);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'internal', message: 'bridge gone' } });
  });

  it('tells its listeners of every change until they unsubscribe', async () => {
    const api = fakeApi();
    const store = createConfigStore(api.rs);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.sync(1);
    api.answer(0, { ok: true, value: config('a') });
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.sync(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('wantedRevision', () => {
  const connected = (configRevision: number): EngineStateView => ({
    helper: 'connected',
    connection: { kind: 'connected', helperVersion: '0.1.0' },
    state: {
      helperVersion: '0.1.0',
      seq: 1,
      configRevision,
      enabled: true,
      interfaces: {
        ethernet: { device: null, ip: null, gateway: null, up: false },
        wifi: { device: null, ip: null, gateway: null, up: false },
      },
      adapters: [],
      rules: [],
      lastApplyAt: null,
      lastReconcileReason: null,
    },
    error: null,
  });

  it('is the engine state’s configRevision while connected, otherwise null', () => {
    expect(wantedRevision(connected(7))).toBe(7);
    expect(wantedRevision(LOADING_VIEW)).toBeNull();
    expect(wantedRevision({ helper: 'connecting', connection: { kind: 'connecting' }, state: null, error: null })).toBeNull();
    // A stray state outside `connected` is never used.
    expect(wantedRevision({ ...connected(7), helper: 'disconnected' })).toBeNull();
  });
});

describe('useConfig', () => {
  it('one store per API object, shared by every caller', () => {
    const rs = { getConfig: vi.fn() };
    expect(configStoreFor(rs)).toBe(configStoreFor(rs));
    expect(configStoreFor(rs)).not.toBe(configStoreFor({ getConfig: vi.fn() }));
  });

  it('renders the current view (static rendering reads the snapshot, effects do not run)', () => {
    const rs: Pick<RsApi, 'getConfig' | 'getState' | 'onState'> = {
      getConfig: vi.fn(),
      getState: vi.fn(() => new Promise<never>(() => undefined)),
      onState: vi.fn(() => () => undefined),
    };
    function Probe(): ReactElement {
      return createElement('p', null, useConfig(rs).phase);
    }
    expect(renderMarkup(createElement(Probe))).toBe('<p>idle</p>');
    expect(rs.getConfig).not.toHaveBeenCalled();
  });
});
