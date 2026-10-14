import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { RsApi, RsSnapshot } from '../renderer/src/rs';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  on: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
  removeListener: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      electron.exposed.set(key, api);
    },
  },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

let rs: RsApi;

beforeAll(async () => {
  await import('./index');
  rs = electron.exposed.get('rs') as RsApi;
});

const RULE = { id: '7f0e9a52-3c1b-4d8e-9a6f-2b5c8d1e4f70', kind: 'ip', target: '10.1.2.3', iface: 'wifi' } as const;

describe('preload', () => {
  it('exposes one object, `rs`, and nothing else', () => {
    expect([...electron.exposed.keys()]).toEqual(['rs']);
  });

  it.each([
    ['getState', [], 'rs:getState'],
    ['getConfig', [], 'rs:getConfig'],
    ['saveRule', [RULE], 'rs:saveRule'],
    ['deleteRule', [RULE.id], 'rs:deleteRule'],
    ['toggleRule', [RULE.id, false], 'rs:toggleRule'],
    ['setEnabled', [true], 'rs:setEnabled'],
    ['apply', [], 'rs:apply'],
    ['test', ['10.1.2.3'], 'rs:test'],
    ['importConfig', [], 'rs:import'],
    ['exportConfig', [], 'rs:export'],
  ] as const)('%s is a bare invoke on %s with the arguments unchanged', async (method, args, channel) => {
    const answer = { ok: true, value: method };
    electron.invoke.mockResolvedValueOnce(answer);
    const call = (rs[method] as (...values: unknown[]) => Promise<unknown>)(...args);
    expect(electron.invoke).toHaveBeenLastCalledWith(channel, ...args);
    expect(await call).toBe(answer);
  });

  it('passes a rejection of invoke through untouched (no logic of its own)', async () => {
    const error = new Error("No handler registered for 'rs:apply'");
    electron.invoke.mockRejectedValueOnce(error);
    await expect(rs.apply()).rejects.toBe(error);
  });

  it('onState delivers the snapshot without the event object, and the returned function unsubscribes', () => {
    const received: unknown[][] = [];
    const unsubscribe = rs.onState((...args: unknown[]) => {
      received.push(args);
    });
    const [channel, forward] = electron.on.mock.lastCall ?? [];
    expect(channel).toBe('rs:state');
    const snapshot: RsSnapshot = { connection: { kind: 'not-installed' }, state: null };
    forward?.({ sender: 'ipc-renderer-event' }, snapshot);
    expect(received).toEqual([[snapshot]]);

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('rs:state', forward);
  });

  it('each subscription has its own listener', () => {
    const first = rs.onState(() => undefined);
    const firstForward = electron.on.mock.lastCall?.[1];
    rs.onState(() => undefined);
    const secondForward = electron.on.mock.lastCall?.[1];
    expect(firstForward).not.toBe(secondForward);
    first();
    expect(electron.removeListener).toHaveBeenLastCalledWith('rs:state', firstForward);
  });
});
