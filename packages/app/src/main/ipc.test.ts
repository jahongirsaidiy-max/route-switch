import { LIMITS, type Config, type EngineState, type RuleInput } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsApi, RsLogEntry, RsResult, RsSnapshot } from '../renderer/src/rs';
import { createHelperClient, type HelperClient } from './helperClient';
import {
  engineState,
  FakeSocket,
  fakeScheduler,
  flush,
  memoryLogger,
  ok,
  oneRuleConfig,
  refused,
  RULE_ID,
  statusResult,
} from './helperClient.fixtures';
import { INVOKE_CHANNELS, LOG_CHANNEL, registerIpcHandlers, STATE_CHANNEL, type InvokeEvent, type StateRecipient } from './ipc';
import { createLogBuffer, type LogBuffer } from './logBuffer';
import { APP_ENTRY_URL } from './runtime';

// ---------------------------------------------------------------------------
// The preload, loaded against a stand-in for Electron's renderer side. Its
// `ipcRenderer.invoke` is wired to the fake `ipcMain` below, so a call made on
// `window.rs` travels the same way it does in the app.
// ---------------------------------------------------------------------------

const bridge = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  const rendererListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let invokeTarget: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null = null;
  return {
    exposed,
    rendererListeners,
    setInvokeTarget: (target: typeof invokeTarget) => {
      invokeTarget = target;
    },
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      if (invokeTarget === null) throw new Error('no ipcMain is wired');
      return invokeTarget(channel, ...args);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      bridge.exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const set = bridge.rendererListeners.get(channel) ?? new Set();
      set.add(listener);
      bridge.rendererListeners.set(channel, set);
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      bridge.rendererListeners.get(channel)?.delete(listener);
    },
  },
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (event: InvokeEvent, ...args: unknown[]) => Promise<unknown>;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
}

const TRUSTED: InvokeEvent = { senderFrame: { url: APP_ENTRY_URL, parent: null } };

/** The helper's side of the socket: answers each request from a small in-memory model. */
interface FakeHelper {
  config: Config;
  configRevision: number;
  seq: number;
  /** Overrides the answer to one method (once). */
  readonly answerOnce: Map<string, (request: { id: number; [key: string]: unknown }) => unknown>;
  /** Methods whose requests are left unanswered. */
  readonly silent: Set<string>;
}

function attachHelper(socket: FakeSocket, helper: FakeHelper): void {
  const write = socket.write.bind(socket);
  socket.write = (data: string): boolean => {
    const result = write(data);
    const request = JSON.parse(data) as { id: number; method: string; [key: string]: unknown };
    setImmediate(() => {
      if (socket.destroyed || helper.silent.has(request.method)) return;
      const custom = helper.answerOnce.get(request.method);
      if (custom !== undefined) {
        helper.answerOnce.delete(request.method);
        socket.receive(custom(request));
        return;
      }
      const state = (): EngineState => {
        helper.seq += 1;
        return engineState(helper.seq, helper.configRevision, { enabled: helper.config.enabled });
      };
      switch (request.method) {
        case 'status':
          socket.receive(ok(request.id, statusResult(state())));
          return;
        case 'getConfig':
          socket.receive(ok(request.id, { config: helper.config }));
          return;
        case 'setConfig':
          helper.config = request['config'] as Config;
          helper.configRevision += 1;
          socket.receive(ok(request.id, { config: helper.config, state: state() }));
          return;
        case 'setEnabled':
          helper.config = { ...helper.config, enabled: request['enabled'] as boolean };
          helper.configRevision += 1;
          socket.receive(ok(request.id, { state: state() }));
          return;
        case 'apply':
          socket.receive(ok(request.id, { state: state() }));
          return;
        case 'test':
          socket.receive(
            ok(request.id, {
              target: request['target'],
              destination: '10.0.0.0',
              gateway: '10.0.0.1',
              device: 'en5',
              role: 'ethernet',
              ruleId: RULE_ID,
            }),
          );
          return;
        default:
          socket.receive(refused(request.id, 'not here', 'not-implemented'));
      }
    });
    return result;
  };
}

interface SetupOptions {
  readonly connect?: boolean;
  readonly config?: Config;
  readonly client?: Pick<HelperClient, 'request' | 'snapshot' | 'onStatus' | 'onState' | 'onLog'>;
  readonly recipients?: StateRecipient[];
  readonly logBuffer?: LogBuffer;
}

async function setup(options: SetupOptions = {}) {
  const scheduler = fakeScheduler();
  const { logger, entries } = memoryLogger(() => scheduler.now);
  const sockets: FakeSocket[] = [];
  const helper: FakeHelper = {
    config: options.config ?? oneRuleConfig(),
    configRevision: 1,
    seq: 0,
    answerOnce: new Map(),
    silent: new Set(),
  };
  const realClient = createHelperClient({
    socketPath: '/tmp/routeswitch-test/helper.sock',
    logger,
    connect: () => {
      const socket = new FakeSocket();
      attachHelper(socket, helper);
      sockets.push(socket);
      return socket;
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const ipcMain = fakeIpcMain();
  const recipients = options.recipients ?? [];
  const registration = registerIpcHandlers({
    ipcMain,
    helperClient: options.client ?? realClient,
    entryUrl: APP_ENTRY_URL,
    logger,
    listRecipients: () => recipients,
    ...(options.logBuffer === undefined ? {} : { logBuffer: options.logBuffer }),
  });

  if (options.client === undefined) {
    realClient.start();
    if (options.connect !== false) {
      sockets[0]?.emit('connect');
      // status, then getConfig.
      for (let i = 0; i < 6; i += 1) await flush();
      expect(realClient.snapshot().status.kind).toBe('connected');
    }
  }

  /** Every line written to the helper so far. */
  const sent = (): { method: string; [key: string]: unknown }[] => sockets.flatMap((socket) => socket.requests());
  const sentAfterHandshake = (): string[] => sent().slice(2).map((request) => request.method);

  const call = async (channel: string, ...args: unknown[]): Promise<RsResult<unknown>> =>
    callAs(TRUSTED, channel, ...args);
  const callAs = async (event: InvokeEvent, channel: string, ...args: unknown[]): Promise<RsResult<unknown>> => {
    const handler = ipcMain.handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    const pending = handler(event, ...args);
    for (let i = 0; i < 8; i += 1) await flush();
    return (await pending) as RsResult<unknown>;
  };

  return { ipcMain, helper, client: realClient, sockets, sent, sentAfterHandshake, call, callAs, entries, registration, scheduler };
}

const valueOf = (result: RsResult<unknown>): unknown => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result.value;
};

const NEW_ID = '7f0e9a52-3c1b-4d8e-9a6f-2b5c8d1e4f70';
const OTHER_ID = '3a9d2c41-8e7f-4b6a-a5d0-1c2b3e4f5a6b';

const newRule = (extra: Partial<RuleInput> = {}): RuleInput => ({
  id: NEW_ID,
  kind: 'ip',
  target: '172.16.12.40',
  iface: 'wifi',
  ...extra,
});

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('handles exactly the eleven invoke channels of the renderer API', async () => {
    const h = await setup({ connect: false });
    expect([...h.ipcMain.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(INVOKE_CHANNELS).toHaveLength(11);
  });

  it('dispose removes every handler and stops the state pushes; a second dispose does nothing', async () => {
    const sent: unknown[] = [];
    const recipient: StateRecipient = { isDestroyed: () => false, getURL: () => APP_ENTRY_URL, send: (_c, p) => sent.push(p) };
    const h = await setup({ connect: false, recipients: [recipient] });
    sent.length = 0;
    h.registration.dispose();
    h.registration.dispose();
    expect(h.ipcMain.handlers.size).toBe(0);
    expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(11);
    h.sockets[0]?.emit('connect');
    for (let i = 0; i < 6; i += 1) await flush();
    expect(sent).toEqual([]);
  });
});

describe('getState', () => {
  it('reports the connection and no state while the helper is not connected', async () => {
    const h = await setup({ connect: false });
    const snapshot = valueOf(await h.call('rs:getState')) as RsSnapshot;
    expect(snapshot).toEqual({ connection: { kind: 'connecting' }, state: null });
    expect(h.sent()).toEqual([]);
  });

  it('reports the connected helper and its state, from memory', async () => {
    const h = await setup();
    const before = h.sent().length;
    const snapshot = valueOf(await h.call('rs:getState')) as RsSnapshot;
    expect(snapshot.connection).toEqual({ kind: 'connected', helperVersion: '1.2.3' });
    expect(snapshot.state?.seq).toBe(1);
    expect(h.sent()).toHaveLength(before);
  });
});

describe('getConfig', () => {
  it('returns the config read from the helper', async () => {
    const h = await setup();
    expect(valueOf(await h.call('rs:getConfig'))).toEqual(oneRuleConfig());
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
  });

  it('answers not-connected without a connection, and sends nothing', async () => {
    const h = await setup({ connect: false });
    const result = await h.call('rs:getConfig');
    expect(result).toMatchObject({ ok: false, code: 'not-connected' });
    expect(h.sent()).toEqual([]);
  });
});

describe('rule edits: getConfig -> change -> setConfig', () => {
  it('saveRule appends a new rule, normalised, and returns the stored config and state', async () => {
    const h = await setup();
    const result = valueOf(await h.call('rs:saveRule', newRule({ kind: 'subnet', target: '192.168.7.9/24' }))) as {
      config: Config;
      state: EngineState;
    };
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
    const sentConfig = h.sent().at(-1)?.['config'] as Config;
    expect(sentConfig.rules.map((rule) => rule.id)).toEqual([RULE_ID, NEW_ID]);
    expect(sentConfig.rules[1]).toMatchObject({ target: '192.168.7.0/24', enabled: true, refreshSec: 600 });
    expect(result.config).toEqual(h.helper.config);
    expect(result.state.configRevision).toBe(2);
  });

  it('saveRule replaces the rule with the same id in place', async () => {
    const h = await setup({
      config: { ...oneRuleConfig(), rules: [...oneRuleConfig().rules, { ...newRule({ id: OTHER_ID }), enabled: true, refreshSec: 600 }] },
    });
    valueOf(await h.call('rs:saveRule', newRule({ id: RULE_ID, kind: 'domain', target: 'corp.local', dns: '10.0.0.53', note: 'ichki' })));
    expect(h.helper.config.rules.map((rule) => [rule.id, rule.target])).toEqual([
      [RULE_ID, 'corp.local'],
      [OTHER_ID, '172.16.12.40'],
    ]);
  });

  it('deleteRule removes the rule', async () => {
    const h = await setup();
    valueOf(await h.call('rs:deleteRule', RULE_ID));
    expect(h.helper.config.rules).toEqual([]);
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
  });

  it('toggleRule sets enabled on that rule only', async () => {
    const h = await setup({
      config: { ...oneRuleConfig(), rules: [...oneRuleConfig().rules, { ...newRule({ id: OTHER_ID }), enabled: true, refreshSec: 600 }] },
    });
    valueOf(await h.call('rs:toggleRule', RULE_ID, false));
    expect(h.helper.config.rules.map((rule) => rule.enabled)).toEqual([false, true]);
  });

  it.each([
    ['rs:deleteRule', [NEW_ID]],
    ['rs:toggleRule', [NEW_ID, true]],
  ])('%s of an unknown rule answers rule-not-found and sends no setConfig', async (channel, args) => {
    const h = await setup();
    const result = await h.call(channel, ...args);
    expect(result).toMatchObject({ ok: false, code: 'rule-not-found' });
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
  });

  it('a rule that would bind a target to a second interface is refused before setConfig is sent', async () => {
    const h = await setup();
    const result = await h.call('rs:saveRule', newRule({ kind: 'subnet', target: '10.0.0.0/8', iface: 'wifi' }));
    expect(result).toMatchObject({ ok: false, code: 'invalid-config' });
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
  });

  it('a 501st rule is refused before setConfig is sent', async () => {
    const rules = Array.from({ length: LIMITS.maxRules }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      enabled: true,
      kind: 'ip' as const,
      target: `10.1.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
      iface: 'ethernet' as const,
      refreshSec: 600,
    }));
    const h = await setup({ config: { version: 1, enabled: true, rules } });
    const result = await h.call('rs:saveRule', newRule());
    expect(result).toMatchObject({ ok: false, code: 'invalid-config' });
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
  });

  it('a getConfig failure ends the edit with that failure', async () => {
    const h = await setup();
    h.helper.answerOnce.set('getConfig', (request) => refused(request.id, 'boom', 'internal'));
    const result = await h.call('rs:saveRule', newRule());
    expect(result).toEqual({ ok: false, code: 'internal', error: 'boom' });
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
  });

  it('edits made at the same time are applied one after the other — none is lost', async () => {
    const h = await setup();
    const handler = (channel: string): Handler => {
      const found = h.ipcMain.handlers.get(channel);
      if (found === undefined) throw new Error(`no handler for ${channel}`);
      return found;
    };
    const calls = [
      handler('rs:saveRule')(TRUSTED, newRule()),
      handler('rs:setEnabled')(TRUSTED, false),
      handler('rs:toggleRule')(TRUSTED, RULE_ID, false),
      handler('rs:saveRule')(TRUSTED, newRule({ id: OTHER_ID, target: '172.16.12.41' })),
    ];
    for (let i = 0; i < 40; i += 1) await flush();
    const results = (await Promise.all(calls)) as RsResult<unknown>[];
    expect(results.every((result) => result.ok)).toBe(true);
    // The client itself fetches the config once more after `setEnabled` changed its revision.
    expect(h.sentAfterHandshake().filter((method) => method !== 'getConfig')).toEqual(['setConfig', 'setEnabled', 'setConfig', 'setConfig']);
    expect(h.helper.config.enabled).toBe(false);
    expect(h.helper.config.rules.map((rule) => [rule.id, rule.enabled])).toEqual([
      [RULE_ID, false],
      [NEW_ID, true],
      [OTHER_ID, true],
    ]);
  });
});

describe('setEnabled, apply, test', () => {
  it('setEnabled sends the flag and returns the state', async () => {
    const h = await setup();
    const result = valueOf(await h.call('rs:setEnabled', false)) as { state: EngineState };
    expect(h.sent().filter((request) => request.method === 'setEnabled')).toEqual([
      expect.objectContaining({ enabled: false }),
    ]);
    expect(result.state.enabled).toBe(false);
  });

  it('apply asks for a reconcile', async () => {
    const h = await setup();
    valueOf(await h.call('rs:apply'));
    expect(h.sentAfterHandshake()).toEqual(['apply']);
  });

  it('test sends the normalised address and returns the lookup', async () => {
    const h = await setup();
    const result = valueOf(await h.call('rs:test', '10.1.2.3'));
    expect(h.sent().at(-1)).toMatchObject({ method: 'test', target: '10.1.2.3' });
    expect(result).toMatchObject({ device: 'en5', target: '10.1.2.3' });
  });
});

describe('failures reach the renderer as values', () => {
  it('a helper refusal is passed on with its code and message', async () => {
    const h = await setup();
    h.helper.answerOnce.set('apply', (request) => refused(request.id, 'Reconcile failed', 'operation-failed'));
    expect(await h.call('rs:apply')).toEqual({ ok: false, code: 'operation-failed', error: 'Reconcile failed' });
  });

  it('a connection lost while waiting answers disconnected (outcome unknown)', async () => {
    const h = await setup();
    h.helper.silent.add('setEnabled');
    const handler = h.ipcMain.handlers.get('rs:setEnabled');
    const pending = handler?.(TRUSTED, true);
    await flush();
    h.sockets[0]?.emit('close');
    const result = (await pending) as RsResult<unknown>;
    expect(result).toMatchObject({ ok: false, code: 'disconnected' });
  });

  it('every method answers not-connected while there is no connection, and nothing is sent', async () => {
    const h = await setup({ connect: false });
    for (const [channel, args] of [
      ['rs:saveRule', [newRule()]],
      ['rs:deleteRule', [RULE_ID]],
      ['rs:toggleRule', [RULE_ID, true]],
      ['rs:setEnabled', [true]],
      ['rs:apply', []],
      ['rs:test', ['10.1.2.3']],
    ] as const) {
      expect(await h.call(channel, ...args)).toMatchObject({ ok: false, code: 'not-connected' });
    }
    expect(h.sent()).toEqual([]);
  });

  it('a call that throws inside the main process answers internal and is logged', async () => {
    const client: Pick<HelperClient, 'request' | 'snapshot' | 'onStatus' | 'onState' | 'onLog'> = {
      request: () => Promise.reject(new Error('unexpected')),
      snapshot: () => ({ status: { kind: 'stopped' }, state: null, config: null, configRevision: null }),
      onStatus: () => () => undefined,
      onState: () => () => undefined,
      onLog: () => () => undefined,
    };
    const h = await setup({ client });
    expect(await h.call('rs:apply')).toMatchObject({ ok: false, code: 'internal' });
    expect(await h.call('rs:saveRule', newRule())).toMatchObject({ ok: false, code: 'internal' });
    // The queue is not stuck after a failed call.
    expect(await h.call('rs:setEnabled', true)).toMatchObject({ ok: false, code: 'internal' });
    expect(h.entries.filter((entry) => entry.level === 'error' && entry.msg === 'A call failed unexpectedly')).toHaveLength(3);
  });

  it.each([['rs:import'], ['rs:export']])('%s is not implemented yet and says which task adds it', async (channel) => {
    const h = await setup();
    const result = await h.call(channel);
    expect(result).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(!result.ok && result.error).toContain('TASK-215');
    expect(h.sentAfterHandshake()).toEqual([]);
  });
});

describe('every argument is checked before anything reaches the helper', () => {
  const invalid: [string, string, unknown[]][] = [
    ['subnet with a prefix over 32', 'rs:saveRule', [newRule({ kind: 'subnet', target: '10.0.0.0/33' })]],
    ['the default route', 'rs:saveRule', [newRule({ kind: 'subnet', target: '0.0.0.0/0' })]],
    ['a prefix wider than /8 (ADR-001)', 'rs:saveRule', [newRule({ kind: 'subnet', target: '0.0.0.0/1' })]],
    ['loopback', 'rs:saveRule', [newRule({ target: '127.0.0.1' })]],
    ['a path as a domain', 'rs:saveRule', [newRule({ kind: 'domain', target: '../etc' })]],
    ['a forbidden DNS server', 'rs:saveRule', [newRule({ kind: 'domain', target: 'corp.local', dns: '127.0.0.1' })]],
    ['refreshSec under 60', 'rs:saveRule', [newRule({ refreshSec: 59 })]],
    ['an unknown interface', 'rs:saveRule', [{ ...newRule(), iface: 'utun3' }]],
    ['a rule without an id', 'rs:saveRule', [{ kind: 'ip', target: '10.1.2.3', iface: 'wifi' }]],
    ['a rule that is not an object', 'rs:saveRule', ['10.1.2.3']],
    ['no rule at all', 'rs:saveRule', []],
    ['an extra argument', 'rs:saveRule', [newRule(), 'extra']],
    ['an id that is not a UUID', 'rs:deleteRule', ['../../config.json']],
    ['a missing flag', 'rs:toggleRule', [RULE_ID]],
    ['undefined as the flag', 'rs:toggleRule', [RULE_ID, undefined]],
    ['a string as the flag', 'rs:toggleRule', [RULE_ID, 'false']],
    ['a number as the global toggle', 'rs:setEnabled', [0]],
    ['a subnet to test', 'rs:test', ['10.0.0.0/8']],
    ['a forbidden address to test', 'rs:test', ['0.0.0.0']],
    ['a domain to test', 'rs:test', ['corp.local']],
    ['a non-canonical address to test', 'rs:test', ['010.1.2.3']],
    ['arguments to a method that takes none', 'rs:apply', [true]],
    ['arguments to getState', 'rs:getState', [{}]],
    ['arguments to getConfig', 'rs:getConfig', ['x']],
    ['arguments to getLog', 'rs:getLog', [500]],
  ];

  it.each(invalid)('%s is refused as invalid-input', async (_name, channel, args) => {
    const h = await setup();
    const result = await h.call(channel, ...args);
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('neither the answer nor the log repeats what the page sent', async () => {
    const h = await setup();
    const marker = 'zz-page-text-zz';
    const result = await h.call('rs:saveRule', { ...newRule(), iface: marker, [marker]: marker });
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(h.entries)).not.toContain(marker);
    expect(h.entries.some((entry) => entry.msg === 'Refused invalid arguments' && entry['channel'] === 'rs:saveRule')).toBe(true);
  });

  it('an oversized argument is refused by the bounded walk before any schema runs', async () => {
    const h = await setup();
    const huge = { ...newRule(), note: Array.from({ length: 100_000 }, () => ({})) };
    const deep = JSON.parse(`${'['.repeat(50)}1${']'.repeat(50)}`) as unknown;
    expect(await h.call('rs:saveRule', huge)).toEqual({
      ok: false,
      code: 'invalid-input',
      error: 'The arguments are too large (array-too-long)',
    });
    expect(await h.call('rs:deleteRule', deep)).toEqual({
      ok: false,
      code: 'invalid-input',
      error: 'The arguments are too large (too-deep)',
    });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('invalid-input lines share one rate-limit budget', async () => {
    const h = await setup();
    for (let i = 0; i < 50; i += 1) await h.call('rs:deleteRule', 'nope');
    expect(h.entries.filter((entry) => entry.msg === 'Refused invalid arguments')).toHaveLength(5);
  });
});

describe('only the app page is answered', () => {
  const untrusted: [string, InvokeEvent][] = [
    ['a frame that is gone', { senderFrame: null }],
    ['another document', { senderFrame: { url: 'https://example.com/', parent: null } }],
    ['a file URL', { senderFrame: { url: 'file:///etc/passwd', parent: null } }],
    ['a sub-frame of the app page', { senderFrame: { url: APP_ENTRY_URL, parent: {} } }],
    [
      'a frame whose properties cannot be read',
      {
        get senderFrame(): never {
          throw new Error('Render frame was disposed');
        },
      },
    ],
  ];

  it.each(untrusted)('%s gets forbidden and nothing is sent', async (_name, event) => {
    const h = await setup();
    const result = await h.callAs(event, 'rs:setEnabled', false);
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(h.sentAfterHandshake()).toEqual([]);
    expect(h.entries.some((entry) => entry.msg === 'Refused a call that did not come from the app page')).toBe(true);
  });

  it('the journal is not read for another document', async () => {
    const h = await setup();
    h.sockets[0]?.receive({ event: 'log', level: 'info', msg: 'secret-ish', at: '2026-01-02T03:04:05.000Z' });
    const result = await h.callAs({ senderFrame: { url: 'https://example.com/', parent: null } }, 'rs:getLog');
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(result)).not.toContain('secret-ish');
  });

  it('the app page with a view in its query or fragment is answered', async () => {
    const h = await setup();
    const event: InvokeEvent = { senderFrame: { url: `${APP_ENTRY_URL}?view=rules#x`, parent: null } };
    expect((await h.callAs(event, 'rs:getState')).ok).toBe(true);
  });
});

describe('rs:state', () => {
  const recipient = (url: string = APP_ENTRY_URL) => {
    const received: RsSnapshot[] = [];
    const target: StateRecipient & { destroyed: boolean } = {
      destroyed: false,
      isDestroyed: () => target.destroyed,
      getURL: () => url,
      send: (channel, payload) => {
        expect(channel).toBe(STATE_CHANNEL);
        received.push(payload as RsSnapshot);
      },
    };
    return { target, received };
  };

  it('sends every status change and every new state to the app windows', async () => {
    const app = recipient();
    const h = await setup({ recipients: [app.target] });
    expect(app.received.map((snapshot) => snapshot.connection.kind)).toEqual(['connecting', 'connected']);
    expect(app.received.at(-1)?.state?.seq).toBe(1);
    await h.call('rs:apply');
    expect(app.received.at(-1)?.state?.seq).toBe(2);
    h.sockets[0]?.emit('close');
    expect(app.received.at(-1)).toEqual({ connection: { kind: 'disconnected', reason: 'connection-lost' }, state: null });
  });

  it('skips destroyed windows and windows not showing the app page; one failing window does not stop the others', async () => {
    const gone = recipient();
    gone.target.destroyed = true;
    const foreign = recipient('https://example.com/');
    const broken: StateRecipient = {
      isDestroyed: () => false,
      getURL: () => APP_ENTRY_URL,
      send: () => {
        throw new Error('Object has been destroyed');
      },
    };
    const app = recipient();
    const h = await setup({ recipients: [gone.target, foreign.target, broken, app.target] });
    expect(gone.received).toEqual([]);
    expect(foreign.received).toEqual([]);
    expect(app.received.length).toBeGreaterThan(0);
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not send the state to a window')).toBe(true);
  });

  it('a failure to list the windows is logged, not thrown into the helper client', () => {
    const scheduler = fakeScheduler();
    const { logger, entries } = memoryLogger(() => scheduler.now);
    let statusListener: (() => void) | null = null;
    registerIpcHandlers({
      ipcMain: fakeIpcMain(),
      helperClient: {
        request: () => Promise.reject(new Error('unused')),
        snapshot: () => ({ status: { kind: 'not-installed' }, state: null, config: null, configRevision: null }),
        onStatus: (listener) => {
          statusListener = () => {
            listener({ kind: 'not-installed' });
          };
          return () => undefined;
        },
        onState: () => () => undefined,
        onLog: () => () => undefined,
      },
      entryUrl: APP_ENTRY_URL,
      logger,
      listRecipients: () => {
        throw new Error('no windows');
      },
    });
    expect(statusListener).not.toBeNull();
    expect(() => statusListener?.()).not.toThrow();
    expect(entries.some((entry) => entry.msg === 'Could not list the windows to send the state to')).toBe(true);
  });
});

describe('journal: rs:getLog and rs:log', () => {
  const AT = '2026-01-02T03:04:05.000Z';
  const logLine = (msg: string, level: 'info' | 'warn' | 'error' = 'info') => ({ event: 'log', level, msg, at: AT });

  const logRecipient = (url: string = APP_ENTRY_URL) => {
    const entries: RsLogEntry[] = [];
    const target: StateRecipient & { destroyed: boolean } = {
      destroyed: false,
      isDestroyed: () => target.destroyed,
      getURL: () => url,
      send: (channel, payload) => {
        if (channel === LOG_CHANNEL) entries.push(payload as RsLogEntry);
      },
    };
    return { target, entries };
  };

  it('keeps every log event of the helper, numbered, oldest first', async () => {
    const h = await setup();
    h.sockets[0]?.receive(logLine('Reconcile finished'));
    h.sockets[0]?.receive(logLine('Route add failed', 'error'));
    h.sockets[0]?.receive(logLine('Interface down', 'warn'));
    expect(valueOf(await h.call('rs:getLog'))).toEqual([
      { seq: 1, level: 'info', msg: 'Reconcile finished', at: AT },
      { seq: 2, level: 'error', msg: 'Route add failed', at: AT },
      { seq: 3, level: 'warn', msg: 'Interface down', at: AT },
    ]);
  });

  it('answers from memory: the history stays readable while the helper is away', async () => {
    const h = await setup();
    h.sockets[0]?.receive(logLine('before the drop'));
    h.sockets[0]?.emit('close');
    await flush();
    expect(h.client.snapshot().status.kind).not.toBe('connected');
    expect(valueOf(await h.call('rs:getLog'))).toMatchObject([{ msg: 'before the drop' }]);
  });

  it('is empty before the first event', async () => {
    const h = await setup({ connect: false });
    expect(valueOf(await h.call('rs:getLog'))).toEqual([]);
  });

  it('keeps only the last 500 entries', async () => {
    const h = await setup();
    for (let i = 1; i <= 501; i += 1) h.sockets[0]?.receive(logLine(`line ${String(i)}`));
    const log = valueOf(await h.call('rs:getLog')) as RsLogEntry[];
    expect(log).toHaveLength(500);
    expect(log[0]).toMatchObject({ seq: 2, msg: 'line 2' });
    expect(log.at(-1)).toMatchObject({ seq: 501, msg: 'line 501' });
  });

  it('a log line the client refuses never reaches the journal', async () => {
    const h = await setup();
    h.sockets[0]?.receive({ event: 'log', level: 'fatal', msg: 'x', at: AT });
    h.sockets[0]?.receive({ event: 'log', level: 'info', msg: 'x', at: 'yesterday' });
    expect(valueOf(await h.call('rs:getLog'))).toEqual([]);
  });

  it('sends each new entry to the app windows only', async () => {
    const app = logRecipient();
    const foreign = logRecipient('https://example.com/');
    const gone = logRecipient();
    gone.target.destroyed = true;
    const h = await setup({ recipients: [app.target, foreign.target, gone.target] });
    h.sockets[0]?.receive(logLine('Reconcile finished'));
    expect(app.entries).toEqual([{ seq: 1, level: 'info', msg: 'Reconcile finished', at: AT }]);
    expect(foreign.entries).toEqual([]);
    expect(gone.entries).toEqual([]);
  });

  it('a window that fails to receive is logged and the others still get the entry', async () => {
    const app = logRecipient();
    const broken: StateRecipient = {
      isDestroyed: () => false,
      getURL: () => APP_ENTRY_URL,
      send: (channel) => {
        if (channel === LOG_CHANNEL) throw new Error('Object has been destroyed');
      },
    };
    const h = await setup({ recipients: [broken, app.target] });
    h.sockets[0]?.receive(logLine('x'));
    expect(app.entries).toHaveLength(1);
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not send a journal entry to a window')).toBe(
      true,
    );
  });

  it('uses the buffer it is given', async () => {
    const logBuffer = createLogBuffer({ capacity: 2, onListenerError: () => undefined });
    logBuffer.push({ level: 'warn', msg: 'from before', at: AT });
    const h = await setup({ logBuffer });
    h.sockets[0]?.receive(logLine('a'));
    h.sockets[0]?.receive(logLine('b'));
    expect((valueOf(await h.call('rs:getLog')) as RsLogEntry[]).map((entry) => entry.msg)).toEqual(['a', 'b']);
  });

  it('dispose stops filling and sending the journal', async () => {
    const app = logRecipient();
    const logBuffer = createLogBuffer({ onListenerError: () => undefined });
    const h = await setup({ recipients: [app.target], logBuffer });
    h.registration.dispose();
    h.sockets[0]?.receive(logLine('after dispose'));
    expect(logBuffer.entries()).toEqual([]);
    logBuffer.push({ level: 'info', msg: 'pushed directly', at: AT });
    expect(app.entries).toEqual([]);
  });
});

describe('the preload against the main process (window.rs)', () => {
  it('exposes exactly the thirteen methods of the renderer API, each wired to a handled channel', async () => {
    const h = await setup();
    bridge.setInvokeTarget((channel, ...args) => {
      const handler = h.ipcMain.handlers.get(channel);
      if (handler === undefined) return Promise.reject(new Error(`No handler registered for '${channel}'`));
      return handler(TRUSTED, ...args);
    });
    await import('../preload/index');
    const rs = bridge.exposed.get('rs') as RsApi;
    expect(Object.keys(rs).sort()).toEqual(
      [
        'apply',
        'deleteRule',
        'exportConfig',
        'getConfig',
        'getLog',
        'getState',
        'importConfig',
        'onLog',
        'onState',
        'saveRule',
        'setEnabled',
        'test',
        'toggleRule',
      ].sort(),
    );

    const settle = async <T>(promise: Promise<T>): Promise<T> => {
      for (let i = 0; i < 8; i += 1) await flush();
      return promise;
    };
    expect((await settle(rs.getState())).ok).toBe(true);
    expect((await settle(rs.getConfig())).ok).toBe(true);
    expect((await settle(rs.saveRule(newRule()))).ok).toBe(true);
    expect((await settle(rs.toggleRule(NEW_ID, false))).ok).toBe(true);
    expect((await settle(rs.deleteRule(NEW_ID))).ok).toBe(true);
    expect((await settle(rs.setEnabled(true))).ok).toBe(true);
    expect((await settle(rs.apply())).ok).toBe(true);
    expect((await settle(rs.test('10.1.2.3'))).ok).toBe(true);
    expect(await settle(rs.importConfig())).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await settle(rs.exportConfig())).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await settle(rs.getLog())).toEqual({ ok: true, value: [] });
    expect(h.sentAfterHandshake().filter((method) => method !== 'getConfig')).toEqual([
      'setConfig',
      'setConfig',
      'setConfig',
      'setEnabled',
      'apply',
      'test',
    ]);
    bridge.setInvokeTarget(null);
  });
});
