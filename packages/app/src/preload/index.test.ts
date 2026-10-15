import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { RsApi, RsLogEntry, RsSnapshot } from '../renderer/src/rs';

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

/** Every invoke of `window.rs`: method, arguments, channel. */
const INVOKES = [
  ['getState', [], 'rs:getState'],
  ['getConfig', [], 'rs:getConfig'],
  ['saveRule', [RULE], 'rs:saveRule'],
  ['deleteRule', [RULE.id], 'rs:deleteRule'],
  ['toggleRule', [RULE.id, false], 'rs:toggleRule'],
  ['setEnabled', [true], 'rs:setEnabled'],
  ['apply', [], 'rs:apply'],
  ['test', ['10.1.2.3'], 'rs:test'],
  ['diagnose', ['corp.local'], 'rs:diagnose'],
  ['importConfig', [], 'rs:import'],
  ['applyImport', [RULE.id], 'rs:applyImport'],
  ['exportConfig', [], 'rs:export'],
  ['getLog', [], 'rs:getLog'],
  ['getSettings', [], 'rs:getSettings'],
  ['setOpenAtLogin', [true], 'rs:setOpenAtLogin'],
  ['setIfaceOverrides', [{ ethernet: 'en5' }], 'rs:setIfaceOverrides'],
  ['getServiceOrder', [], 'rs:getServiceOrder'],
  ['copyServiceOrderCommand', [], 'rs:copyServiceOrderCommand'],
  ['uninstallHelper', [], 'rs:uninstall'],
  ['openRulesWindow', [], 'rs:openRulesWindow'],
  ['reconnectHelper', [], 'rs:reconnect'],
  ['resetConfig', [], 'rs:resetConfig'],
  ['installHelper', [], 'rs:installHelper'],
  ['removeHelper', [], 'rs:removeHelper'],
  ['getLanguage', [], 'rs:getLanguage'],
  ['setLanguage', ['ru'], 'rs:setLanguage'],
  ['getBackup', [], 'rs:getBackup'],
  ['restoreBackup', [], 'rs:restoreBackup'],
  ['deleteBackup', [], 'rs:deleteBackup'],
  ['dismissBackup', [], 'rs:dismissBackup'],
] as const;

describe('preload', () => {
  it('exposes one object, `rs`, and nothing else', () => {
    expect([...electron.exposed.keys()]).toEqual(['rs']);
  });

  it('every method but the three subscriptions is in INVOKES (a new method cannot go untested)', () => {
    const invokes = INVOKES.map(([method]) => method as string);
    const subscriptions = ['onState', 'onLog', 'onLanguage'];
    expect(Object.keys(rs).filter((key) => !subscriptions.includes(key)).sort()).toEqual([...invokes].sort());
  });

  it.each(INVOKES)('%s is a bare invoke on %s with the arguments unchanged', async (method, args, channel) => {
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

  it('onLog delivers the entry without the event object, and the returned function unsubscribes', () => {
    const received: unknown[][] = [];
    const unsubscribe = rs.onLog((...args: unknown[]) => {
      received.push(args);
    });
    const [channel, forward] = electron.on.mock.lastCall ?? [];
    expect(channel).toBe('rs:log');
    const entry: RsLogEntry = { seq: 1, level: 'warn', msg: 'Interface down', at: '2026-01-02T03:04:05.000Z' };
    forward?.({ sender: 'ipc-renderer-event' }, entry);
    expect(received).toEqual([[entry]]);

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('rs:log', forward);
  });

  it('onLanguage delivers the language without the event object, and the returned function unsubscribes', () => {
    const received: unknown[][] = [];
    const unsubscribe = rs.onLanguage((...args: unknown[]) => {
      received.push(args);
    });
    const [channel, forward] = electron.on.mock.lastCall ?? [];
    expect(channel).toBe('rs:language');
    forward?.({ sender: 'ipc-renderer-event' }, 'en');
    expect(received).toEqual([['en']]);

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('rs:language', forward);
  });
});
