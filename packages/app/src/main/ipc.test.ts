import { LIMITS, type Config, type EngineState, type Language, type RuleInput, type RulesBackupFile } from '@routeswitch/shared';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RsApi, RsDiagnosis, RsLogEntry, RsResult, RsSnapshot } from '../renderer/src/rs';
import { createHelperClient, DEFAULT_TIMEOUTS, type HelperClient } from './helperClient';
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
import type { ConfigFileSystem } from './configFile';
import type { NameLookup } from './diagnose';
import {
  EMPTY_CONFIG,
  IMPORT_TTL_MS,
  INVOKE_CHANNELS,
  LANGUAGE_CHANNEL,
  LOG_CHANNEL,
  registerIpcHandlers,
  RULES_INTENT_CHANNEL,
  RULES_INTENT_TTL_MS,
  STATE_CHANNEL,
  viewOf,
  type ConfigDialogs,
  type InvokeEvent,
  type StateRecipient,
} from './ipc';
import type { HelperSetupResult, Installer } from './installer';
import { createLogBuffer, type LogBuffer } from './logBuffer';
import type { PreferencesStore } from './preferences';
import type { RulesBackupStore } from './rulesBackup';
import { APP_ENTRY_URL } from './runtime';
import { createSettings, type Settings } from './settings';
import { viewUrl } from './windows';

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
  /** The stored config cannot be loaded (TASK-114): getConfig / setEnabled fail until a setConfig. */
  broken?: boolean;
  /** The answer to every `diagnose` request (TASK-DELTA-20); `not-implemented` when unset. */
  diagnose?: (request: { id: number; target: string }) => unknown;
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
          if (helper.broken === true) {
            socket.receive(refused(request.id, 'The stored config could not be loaded (invalid-json)', 'operation-failed'));
            return;
          }
          socket.receive(ok(request.id, { config: helper.config, configRevision: helper.configRevision }));
          return;
        case 'setConfig':
          helper.broken = false;
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
        case 'diagnose':
          if (helper.diagnose !== undefined) {
            socket.receive(helper.diagnose({ id: request.id, target: request['target'] as string }));
            return;
          }
          socket.receive(refused(request.id, 'not here', 'not-implemented'));
          return;
        default:
          socket.receive(refused(request.id, 'not here', 'not-implemented'));
      }
    });
    return result;
  };
}

/** Settings whose system side is never reached in a test that does not exercise it. */
const unusedSettings = (logger: Parameters<typeof createSettings>[0]['logger']): Settings =>
  createSettings({
    loginItem: { get: () => false, set: () => undefined },
    listServiceOrder: () => Promise.reject(new Error('not used')),
    writeClipboard: () => Promise.resolve(),
    logger,
  });

/** An in-memory language store, like `createPreferences` without the file. */
function memoryPreferences(initial: Language = 'uz') {
  let current = initial;
  let dismissed: string | null = null;
  const listeners = new Set<(language: Language) => void>();
  const store = {
    language: vi.fn(() => Promise.resolve(current)),
    setLanguage: vi.fn((language: Language) => {
      const changed = language !== current;
      current = language;
      if (changed) for (const listener of [...listeners]) listener(language);
      return Promise.resolve(language);
    }),
    onLanguage: (listener: (language: Language) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismissedBackupAt: vi.fn(() => Promise.resolve(dismissed)),
    setDismissedBackupAt: vi.fn((savedAt: string) => {
      dismissed = savedAt;
      return Promise.resolve();
    }),
  } satisfies PreferencesStore;
  return { store, listeners };
}

interface SetupOptions {
  readonly connect?: boolean;
  readonly config?: Config;
  readonly client?: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'>;
  readonly recipients?: StateRecipient[];
  readonly logBuffer?: LogBuffer;
  readonly settings?: Settings;
  readonly openRulesWindow?: () => void;
  readonly configDialogs?: ConfigDialogs;
  readonly configFs?: ConfigFileSystem;
  readonly now?: () => number;
  /** The helper's stored config cannot be loaded: the handshake ends `config-unreadable`. */
  readonly brokenConfig?: boolean;
  readonly installer?: Installer;
  readonly preferences?: PreferencesStore;
  readonly backup?: Pick<RulesBackupStore, 'read' | 'remove'>;
  readonly lookupName?: NameLookup;
  readonly diagnose?: FakeHelper['diagnose'];
}

/** A backup store in memory (TASK-DELTA-16). */
function memoryBackup(initial: RulesBackupFile | null = null, removable = true) {
  let current = initial;
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
    remove: vi.fn(() => {
      if (removable) current = null;
      return Promise.resolve(removable);
    }),
  } satisfies Pick<RulesBackupStore, 'read' | 'remove'>;
  return store;
}

/** An installer that must not be reached. */
const UNUSED_INSTALLER: Installer = {
  install: () => Promise.reject(new Error('install not expected')),
  uninstall: () => Promise.reject(new Error('uninstall not expected')),
};

/** File dialogs the user always cancels. */
const CANCELLED_DIALOGS: ConfigDialogs = { chooseImportFile: () => Promise.resolve(null), chooseExportFile: () => Promise.resolve(null) };

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
    broken: options.brokenConfig === true,
    ...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
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
    settings: options.settings ?? unusedSettings(logger),
    preferences: options.preferences ?? memoryPreferences().store,
    backup: options.backup ?? memoryBackup(),
    openRulesWindow: options.openRulesWindow ?? (() => undefined),
    configDialogs: options.configDialogs ?? CANCELLED_DIALOGS,
    installer: options.installer ?? UNUSED_INSTALLER,
    ...(options.configFs === undefined ? {} : { configFs: options.configFs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.lookupName === undefined ? {} : { lookupName: options.lookupName }),
  });

  if (options.client === undefined) {
    realClient.start();
    if (options.connect !== false) {
      sockets[0]?.emit('connect');
      // status, then getConfig.
      for (let i = 0; i < 6; i += 1) await flush();
      expect(realClient.snapshot().status.kind).toBe(options.brokenConfig === true ? 'config-unreadable' : 'connected');
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
  it('handles exactly the thirty invoke channels of the renderer API', async () => {
    const h = await setup({ connect: false });
    expect([...h.ipcMain.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(INVOKE_CHANNELS).toHaveLength(31);
  });

  it('dispose removes every handler and stops the state pushes; a second dispose does nothing', async () => {
    const sent: unknown[] = [];
    const recipient: StateRecipient = { isDestroyed: () => false, getURL: () => APP_ENTRY_URL, send: (_c, p) => sent.push(p) };
    const h = await setup({ connect: false, recipients: [recipient] });
    sent.length = 0;
    h.registration.dispose();
    h.registration.dispose();
    expect(h.ipcMain.handlers.size).toBe(0);
    expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(31);
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
    const client: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'> = {
      reconnectNow: () => undefined,
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

});

describe('config import / export (main-process dialogs and files only)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'routeswitch-ipc-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const importedConfig = (): Config => ({
    version: 1,
    enabled: false,
    rules: [
      { id: NEW_ID, enabled: true, kind: 'domain', target: 'corp.local', iface: 'ethernet', refreshSec: 900, dns: '10.20.0.10' },
      { id: OTHER_ID, enabled: true, kind: 'ip', target: '172.16.12.40', iface: 'wifi', refreshSec: 600 },
    ],
  });
  const dialogsFor = (importFile: string | null, exportFile: string | null = null): ConfigDialogs => ({
    chooseImportFile: vi.fn(() => Promise.resolve(importFile)),
    chooseExportFile: vi.fn(() => Promise.resolve(exportFile)),
  });
  const fileWith = async (content: string) => {
    const file = path.join(dir, 'in.json');
    await writeFile(file, content);
    return file;
  };

  it('resetConfig queued behind an import that repairs the config is refused there: the unreadable check runs in the queue (TASK-300)', async () => {
    const file = await fileWith(JSON.stringify(importedConfig()));
    const h = await setup({ brokenConfig: true, configDialogs: dialogsFor(file) });
    const preview = valueOf(await h.call('rs:import')) as { token: string };
    // The import's setConfig is held by the helper; the reset is asked for meanwhile, while the status is still unreadable.
    h.helper.silent.add('setConfig');
    const applying = h.ipcMain.handlers.get('rs:applyImport')?.(TRUSTED, preview.token);
    for (let i = 0; i < 8; i += 1) await flush();
    const resetting = h.ipcMain.handlers.get('rs:resetConfig')?.(TRUSTED);
    for (let i = 0; i < 8; i += 1) await flush();
    expect(h.client.snapshot().status.kind).toBe('config-unreadable');
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);

    // The helper stores the imported config and answers: the connection is repaired before the reset's turn.
    const request = h.sockets[0]?.requests().find((sent) => sent.method === 'setConfig');
    if (request === undefined) throw new Error('no setConfig was sent');
    h.helper.broken = false;
    h.helper.config = importedConfig();
    h.helper.configRevision += 1;
    h.helper.seq += 1;
    h.sockets[0]?.receive(ok(request['id'], { config: importedConfig(), state: engineState(h.helper.seq, h.helper.configRevision, { enabled: false }) }));
    for (let i = 0; i < 8; i += 1) await flush();

    expect(await applying).toMatchObject({ ok: true });
    expect(await resetting).toMatchObject({ ok: false, code: 'operation-failed' });
    // Exactly one setConfig, the import's: the empty config was never sent.
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);
    expect(h.sent().filter((sent) => sent.method === 'setConfig').map((sent) => sent['config'])).toEqual([importedConfig()]);
    expect(h.helper.config).toEqual(importedConfig());
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('import reads, checks and returns the config with a token; nothing reaches the helper until it is applied', async () => {
    const file = await fileWith(JSON.stringify(importedConfig()));
    const h = await setup({ configDialogs: dialogsFor(file) });
    const preview = valueOf(await h.call('rs:import')) as { token: string; config: Config };
    expect(preview.config).toEqual(importedConfig());
    expect(JSON.stringify(preview)).not.toContain(dir);
    expect(h.sentAfterHandshake()).toEqual([]);

    const applied = valueOf(await h.call('rs:applyImport', preview.token)) as { config: Config };
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);
    // Replaced as a whole: the stored rule is gone.
    expect(h.helper.config).toEqual(importedConfig());
    expect(applied.config).toEqual(importedConfig());
    expect(h.entries.some((entry) => entry.msg === 'Config imported')).toBe(true);
    // One use.
    expect(await h.call('rs:applyImport', preview.token)).toMatchObject({ ok: false, code: 'import-expired' });
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);
  });

  it.each([
    ['broken JSON', '{"version":1,', 'file-not-json', undefined],
    ['a schema refusal', JSON.stringify({ version: 1, rules: [{ id: NEW_ID, kind: 'subnet', target: '0.0.0.0/0', iface: 'wifi' }] }), 'invalid-config', { path: ['rules', 0, 'target'], code: 'default-route' }],
    ['an old version', JSON.stringify({ version: 0, rules: [] }), 'invalid-config', { path: ['version'], code: 'invalid_value' }],
  ])('a file with %s is refused with its code and never reaches the helper', async (_name, content, code, issue) => {
    const h = await setup({ configDialogs: dialogsFor(await fileWith(content)) });
    const result = await h.call('rs:import');
    expect(result).toMatchObject({ ok: false, code });
    if (issue !== undefined) expect(!result.ok && result.issue).toEqual(issue);
    expect(h.sentAfterHandshake()).toEqual([]);
    expect(h.helper.config).toEqual(oneRuleConfig());
    expect(h.entries.some((entry) => entry.level === 'warn' && entry.msg === 'Refused a config file')).toBe(true);
  });

  it('applyImport runs in the edit queue: a saveRule already under way finishes first, then the import replaces the config', async () => {
    const file = await fileWith(JSON.stringify(importedConfig()));
    const h = await setup({ configDialogs: dialogsFor(file) });
    const preview = valueOf(await h.call('rs:import')) as { token: string };
    const saveRule = h.ipcMain.handlers.get('rs:saveRule');
    const applyImport = h.ipcMain.handlers.get('rs:applyImport');
    if (saveRule === undefined || applyImport === undefined) throw new Error('handlers');
    // Both arrive before either is answered.
    const saving = saveRule(TRUSTED, newRule({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: '10.77.0.1' }));
    const importing = applyImport(TRUSTED, preview.token);
    for (let i = 0; i < 16; i += 1) await flush();
    expect((await saving) as RsResult<unknown>).toMatchObject({ ok: true });
    expect((await importing) as RsResult<unknown>).toMatchObject({ ok: true });
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig', 'setConfig']);
    expect(h.helper.config).toEqual(importedConfig());
  });

  it('a refused file also cancels the import that was waiting', async () => {
    const good = await fileWith(JSON.stringify(importedConfig()));
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{"version":1,');
    const files = [good, bad];
    const dialogs: ConfigDialogs = { chooseImportFile: () => Promise.resolve(files.shift() ?? null), chooseExportFile: () => Promise.resolve(null) };
    const h = await setup({ configDialogs: dialogs });
    const preview = valueOf(await h.call('rs:import')) as { token: string };
    expect(await h.call('rs:import')).toMatchObject({ ok: false, code: 'file-not-json' });
    expect(await h.call('rs:applyImport', preview.token)).toMatchObject({ ok: false, code: 'import-expired' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('a cancelled dialog is null; a second import while a dialog is open is busy', async () => {
    let choose: (file: string | null) => void = () => undefined;
    const dialogs: ConfigDialogs = {
      chooseImportFile: () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
      chooseExportFile: () => Promise.resolve(null),
    };
    const h = await setup({ configDialogs: dialogs });
    const first = h.ipcMain.handlers.get('rs:import')?.(TRUSTED);
    await flush();
    expect(await h.call('rs:import')).toMatchObject({ ok: false, code: 'busy' });
    expect(await h.call('rs:export')).toMatchObject({ ok: false, code: 'busy' });
    choose(null);
    expect(await first).toEqual({ ok: true, value: null });
  });

  it('an import token expires after ten minutes, and a newer import replaces the older one', async () => {
    let clock = 1_000_000;
    const file = await fileWith(JSON.stringify(importedConfig()));
    const h = await setup({ configDialogs: dialogsFor(file), now: () => clock });
    const old = valueOf(await h.call('rs:import')) as { token: string };
    const fresh = valueOf(await h.call('rs:import')) as { token: string };
    expect(fresh.token).not.toBe(old.token);
    expect(await h.call('rs:applyImport', old.token)).toMatchObject({ ok: false, code: 'import-expired' });
    clock += IMPORT_TTL_MS + 1;
    expect(await h.call('rs:applyImport', fresh.token)).toMatchObject({ ok: false, code: 'import-expired' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('applyImport takes exactly one UUID token', async () => {
    const h = await setup();
    expect(await h.call('rs:applyImport', '../config.json')).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await h.call('rs:applyImport')).toMatchObject({ ok: false, code: 'invalid-input' });
  });

  it('import and export answer only the app page', async () => {
    const dialogs = dialogsFor(null, null);
    const h = await setup({ configDialogs: dialogs });
    const foreign: InvokeEvent = { senderFrame: { url: 'https://example.com/', parent: null } };
    expect(await h.callAs(foreign, 'rs:import')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await h.callAs(foreign, 'rs:export')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(dialogs.chooseImportFile).not.toHaveBeenCalled();
    expect(dialogs.chooseExportFile).not.toHaveBeenCalled();
  });

  it('export reads the stored config and writes it to the chosen path only', async () => {
    const file = path.join(dir, 'out.json');
    const h = await setup({ configDialogs: dialogsFor(null, file) });
    const result = valueOf(await h.call('rs:export')) as { rules: number; bytes: number };
    expect(result.rules).toBe(1);
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(oneRuleConfig());
    expect(await readdir(dir)).toEqual(['out.json']);
    expect(result.bytes).toBe((await readFile(file)).length);
  });

  it('export without a helper opens no dialog; a cancelled dialog writes nothing; a failed write says so', async () => {
    const offline = dialogsFor(null, path.join(dir, 'x.json'));
    const h = await setup({ connect: false, configDialogs: offline });
    expect(await h.call('rs:export')).toMatchObject({ ok: false, code: 'not-connected' });
    expect(offline.chooseExportFile).not.toHaveBeenCalled();

    const cancelled = await setup({ configDialogs: dialogsFor(null, null) });
    expect(await cancelled.call('rs:export')).toEqual({ ok: true, value: null });

    const failing = await setup({ configDialogs: dialogsFor(null, path.join(dir, 'missing', 'x.json')) });
    expect(await failing.call('rs:export')).toMatchObject({ ok: false, code: 'write-failed' });
    expect(await readdir(dir)).toEqual([]);
    expect(failing.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not write the exported config')).toBe(true);
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
    ['a URL to diagnose (the page strips it)', 'rs:diagnose', ['https://corp.local/x']],
    ['a wildcard to diagnose', 'rs:diagnose', ['*.corp.local']],
    ['an upper-case name to diagnose', 'rs:diagnose', ['Corp.Local']],
    ['loopback to diagnose', 'rs:diagnose', ['127.0.0.1']],
    ['a subnet to diagnose', 'rs:diagnose', ['10.0.0.0/8']],
    ['IPv6 to diagnose', 'rs:diagnose', ['::1']],
    ['a path to diagnose', 'rs:diagnose', ['../etc']],
    ['a number to diagnose', 'rs:diagnose', [1]],
    ['no target to diagnose', 'rs:diagnose', []],
    ['arguments to a method that takes none', 'rs:apply', [true]],
    ['arguments to getState', 'rs:getState', [{}]],
    ['arguments to getConfig', 'rs:getConfig', ['x']],
    ['arguments to getLog', 'rs:getLog', [500]],
    ['a path to installHelper', 'rs:installHelper', ['/tmp/evil']],
    ['undefined to installHelper', 'rs:installHelper', [undefined]],
    ['a flag to removeHelper', 'rs:removeHelper', ['--force']],
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
    const statusListeners: ((status: { kind: 'not-installed' }) => void)[] = [];
    registerIpcHandlers({
      installer: UNUSED_INSTALLER,
      ipcMain: fakeIpcMain(),
      helperClient: {
        request: () => Promise.reject(new Error('unused')),
        snapshot: () => ({ status: { kind: 'not-installed' }, state: null, config: null, configRevision: null }),
        reconnectNow: () => undefined,
        onStatus: (listener) => {
          // The push and the app's journal line (TASK-300) both subscribe.
          statusListeners.push(listener);
          statusListener = () => {
            for (const each of statusListeners) each({ kind: 'not-installed' });
          };
          return () => undefined;
        },
        onState: () => () => undefined,
        onLog: () => () => undefined,
      },
      entryUrl: APP_ENTRY_URL,
      logger,
      settings: unusedSettings(logger),
      preferences: memoryPreferences().store,
      backup: memoryBackup(),
      openRulesWindow: () => undefined,
      configDialogs: CANCELLED_DIALOGS,
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
  /** The app's own line for the handshake of `setup()` (TASK-300): always the first entry. */
  const CONNECTED_LINE = { seq: 1, level: 'info', msg: "Helper bilan aloqa o'rnatildi (v1.2.3)", at: expect.any(String) as string, source: 'app' };
  const helperEntries = (log: unknown) => (log as RsLogEntry[]).filter((entry) => entry.source === undefined);

  it('keeps every log event of the helper, numbered, oldest first', async () => {
    const h = await setup();
    h.sockets[0]?.receive(logLine('Reconcile finished'));
    h.sockets[0]?.receive(logLine('Route add failed', 'error'));
    h.sockets[0]?.receive(logLine('Interface down', 'warn'));
    expect(valueOf(await h.call('rs:getLog'))).toEqual([
      CONNECTED_LINE,
      { seq: 2, level: 'info', msg: 'Reconcile finished', at: AT },
      { seq: 3, level: 'error', msg: 'Route add failed', at: AT },
      { seq: 4, level: 'warn', msg: 'Interface down', at: AT },
    ]);
  });

  it('answers from memory: the history stays readable while the helper is away', async () => {
    const h = await setup();
    h.sockets[0]?.receive(logLine('before the drop'));
    h.sockets[0]?.emit('close');
    await flush();
    expect(h.client.snapshot().status.kind).not.toBe('connected');
    expect(valueOf(await h.call('rs:getLog'))).toMatchObject([
      { source: 'app', msg: "Helper bilan aloqa o'rnatildi (v1.2.3)" },
      { msg: 'before the drop' },
      // The app's own line: the helper cannot say that it is gone.
      { source: 'app', level: 'warn', msg: "Helper bilan aloqa yo'q: aloqa uzildi" },
    ]);
  });

  it('is empty before the first event', async () => {
    const h = await setup({ connect: false });
    expect(valueOf(await h.call('rs:getLog'))).toEqual([]);
  });

  it('keeps only the last 500 entries', async () => {
    const h = await setup();
    for (let i = 1; i <= 501; i += 1) h.sockets[0]?.receive(logLine(`line ${String(i)}`));
    const log = valueOf(await h.call('rs:getLog')) as RsLogEntry[];
    // 502 entries with the app's connected line (seq 1): the first two are gone.
    expect(log).toHaveLength(500);
    expect(log[0]).toMatchObject({ seq: 3, msg: 'line 2' });
    expect(log.at(-1)).toMatchObject({ seq: 502, msg: 'line 501' });
  });

  it('a log line the client refuses never reaches the journal', async () => {
    const h = await setup();
    h.sockets[0]?.receive({ event: 'log', level: 'fatal', msg: 'x', at: AT });
    h.sockets[0]?.receive({ event: 'log', level: 'info', msg: 'x', at: 'yesterday' });
    expect(helperEntries(valueOf(await h.call('rs:getLog')))).toEqual([]);
  });

  it('sends each new entry to the app windows only', async () => {
    const app = logRecipient();
    const foreign = logRecipient('https://example.com/');
    const gone = logRecipient();
    gone.target.destroyed = true;
    const h = await setup({ recipients: [app.target, foreign.target, gone.target] });
    h.sockets[0]?.receive(logLine('Reconcile finished'));
    expect(app.entries).toEqual([CONNECTED_LINE, { seq: 2, level: 'info', msg: 'Reconcile finished', at: AT }]);
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
    // The app's connected line and the helper's.
    expect(app.entries).toHaveLength(2);
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
    h.sockets[0]?.emit('close');
    // Only the app's connected line from before the dispose; neither the helper's line nor the drop after it.
    expect(logBuffer.entries()).toEqual([CONNECTED_LINE]);
    logBuffer.push({ level: 'info', msg: 'pushed directly', at: AT });
    expect(app.entries).toEqual([CONNECTED_LINE]);
  });
});

describe('helper away and a broken stored config (TASK-300)', () => {
  it('rs:reconnect asks the client to connect now; it takes no arguments and is answered null', async () => {
    const reconnectNow = vi.fn();
    const client: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'> = {
      request: () => Promise.reject(new Error('not used')),
      snapshot: () => ({ status: { kind: 'disconnected', reason: 'not-running' }, state: null, config: null, configRevision: null }),
      reconnectNow,
      onStatus: () => () => undefined,
      onState: () => () => undefined,
      onLog: () => () => undefined,
    };
    const h = await setup({ client });
    expect(await h.call('rs:reconnect')).toEqual({ ok: true, value: null });
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    expect(await h.call('rs:reconnect', true)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    const foreign: InvokeEvent = { senderFrame: { url: 'https://example.com/', parent: null } };
    expect(await h.callAs(foreign, 'rs:reconnect')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it('rs:reconnect on a lost connection opens a new socket at once, and the state comes back', async () => {
    const h = await setup();
    h.sockets[0]?.emit('close');
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'connection-lost' });
    expect(await h.call('rs:reconnect')).toEqual({ ok: true, value: null });
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.emit('connect');
    for (let i = 0; i < 6; i += 1) await flush();
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('a broken stored config: the snapshot says config-unreadable; edits fail; resetConfig stores an empty config and connects', async () => {
    const h = await setup({ brokenConfig: true });
    expect(valueOf(await h.call('rs:getState'))).toEqual({ connection: { kind: 'config-unreadable', helperVersion: '1.2.3' }, state: null });
    expect(await h.call('rs:saveRule', newRule())).toMatchObject({ ok: false, code: 'operation-failed' });
    const reset = await h.call('rs:resetConfig');
    expect(reset).toMatchObject({ ok: true, value: { config: EMPTY_CONFIG } });
    expect(h.helper.config).toEqual({ version: 1, enabled: true, rules: [] });
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
    expect(h.client.snapshot().status.kind).toBe('connected');
    // Readable now: a second reset is refused and sends nothing.
    expect(await h.call('rs:resetConfig')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
    expect(h.entries.some((entry) => entry.msg === 'Unreadable config replaced with an empty one' && entry['ok'] === true)).toBe(true);
  });

  it('resetConfig is refused without a connection and while connected; nothing is sent', async () => {
    const away = await setup({ connect: false });
    expect(await away.call('rs:resetConfig')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(away.sent()).toEqual([]);
    const fine = await setup();
    expect(await fine.call('rs:resetConfig')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(fine.sentAfterHandshake()).toEqual([]);
    expect(fine.helper.config).toEqual(oneRuleConfig());
  });

  it('resetConfig waits in the queue of changes, behind a running edit', async () => {
    const h = await setup({ brokenConfig: true });
    h.helper.silent.add('getConfig');
    const edit = h.ipcMain.handlers.get('rs:saveRule')?.(TRUSTED, newRule());
    const reset = h.ipcMain.handlers.get('rs:resetConfig')?.(TRUSTED);
    for (let i = 0; i < 8; i += 1) await flush();
    // The edit's getConfig is unanswered: the reset has not been sent.
    expect(h.sentAfterHandshake()).toEqual(['getConfig']);
    h.scheduler.advance(DEFAULT_TIMEOUTS.readMs);
    for (let i = 0; i < 8; i += 1) await flush();
    expect(await edit).toMatchObject({ ok: false, code: 'timeout' });
    expect(await reset).toMatchObject({ ok: true });
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
  });

  it("the journal holds the app's own lines about the connection, in the UI's words", async () => {
    const h = await setup({ brokenConfig: true });
    await h.call('rs:resetConfig');
    h.sockets[0]?.emit('close');
    // The app's lines go into the journal once the language is known (TASK-DELTA-12).
    for (let i = 0; i < 6; i += 1) await flush();
    const log = valueOf(await h.call('rs:getLog')) as RsLogEntry[];
    expect(log.map((entry) => [entry.level, entry.msg, entry.source])).toEqual([
      ['error', "Helper saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmaydi. Import yoki bo'sh config bilan tiklang", 'app'],
      ['info', "Helper bilan aloqa o'rnatildi (v1.2.3)", 'app'],
      ['warn', "Helper bilan aloqa yo'q: aloqa uzildi", 'app'],
    ]);
  });
});

const SERVICE_ORDER = [
  'An asterisk (*) denotes that a network service is disabled.',
  '(1) USB 10/100/1000 LAN',
  '(Hardware Port: USB 10/100/1000 LAN, Device: en5)',
  '',
  '(2) Wi-Fi',
  '(Hardware Port: Wi-Fi, Device: en0)',
  '',
  '(*) Thunderbolt Bridge',
  '(Hardware Port: Thunderbolt Bridge, Device: bridge0)',
  '',
].join('\n');

function fakeSettings(options: { order?: () => Promise<string>; setThrows?: Error } = {}) {
  let openAtLogin = false;
  const clipboard: string[] = [];
  const set = vi.fn((value: boolean) => {
    if (options.setThrows !== undefined) throw options.setThrows;
    openAtLogin = value;
  });
  const listServiceOrder = vi.fn(options.order ?? (() => Promise.resolve(SERVICE_ORDER)));
  const { logger } = memoryLogger();
  const settings = createSettings({
    loginItem: { get: () => openAtLogin, set },
    listServiceOrder,
    writeClipboard: (text) => {
      clipboard.push(text);
      return Promise.resolve();
    },
    logger,
  });
  return { settings, set, clipboard, listServiceOrder };
}

const WIFI_FIRST = "sudo networksetup -ordernetworkservices 'Wi-Fi' 'USB 10/100/1000 LAN' 'Thunderbolt Bridge'";

describe('settings: login item', () => {
  it('reads and sets the login item, answering the value read back', async () => {
    const fake = fakeSettings();
    const h = await setup({ settings: fake.settings });
    expect(await h.call('rs:getSettings')).toEqual({ ok: true, value: { openAtLogin: false } });
    expect(await h.call('rs:setOpenAtLogin', true)).toEqual({ ok: true, value: { openAtLogin: true } });
    expect(fake.set).toHaveBeenCalledWith(true);
    expect(await h.call('rs:getSettings')).toEqual({ ok: true, value: { openAtLogin: true } });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it.each([[[]], [['true']], [[1]], [[undefined]], [[true, true]]])('refuses %j', async (args) => {
    const fake = fakeSettings();
    const h = await setup({ settings: fake.settings });
    expect(await h.call('rs:setOpenAtLogin', ...args)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('a failing system call answers internal and is logged', async () => {
    const h = await setup({ settings: fakeSettings({ setThrows: new Error('no login items') }).settings });
    expect(await h.call('rs:setOpenAtLogin', true)).toMatchObject({ ok: false, code: 'internal' });
    expect(h.entries.some((entry) => entry.msg === 'A call failed unexpectedly' && entry['channel'] === 'rs:setOpenAtLogin')).toBe(
      true,
    );
  });
});

describe('settings: interface overrides', () => {
  it('stores the overrides with getConfig -> setConfig, keeping the rules', async () => {
    const h = await setup();
    const rules = h.helper.config.rules;
    const result = await h.call('rs:setIfaceOverrides', { ethernet: 'en7' });
    expect(result.ok).toBe(true);
    expect(h.helper.config.ifaceOverrides).toEqual({ ethernet: 'en7' });
    expect(h.helper.config.rules).toEqual(rules);
    expect(h.sentAfterHandshake()).toEqual(['getConfig', 'setConfig']);
  });

  it('an empty object removes every override', async () => {
    const h = await setup({ config: { ...oneRuleConfig(), ifaceOverrides: { ethernet: 'en7', wifi: 'en0' } } });
    expect((await h.call('rs:setIfaceOverrides', {})).ok).toBe(true);
    expect(h.helper.config).not.toHaveProperty('ifaceOverrides');
  });

  it.each([
    ['a device that is not en*', [{ ethernet: 'eth0' }]],
    ['a path as a device', [{ ethernet: '../en0' }]],
    ['an unknown role', [{ vpn: 'en1' }]],
    ['undefined', [undefined]],
    ['null', [null]],
    ['a string', ['en5']],
    ['no argument', []],
    ['an extra argument', [{ ethernet: 'en5' }, 'x']],
  ])('refuses %s with nothing sent', async (_name, args) => {
    const h = await setup();
    expect(await h.call('rs:setIfaceOverrides', ...args)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('is not-connected without a helper', async () => {
    const h = await setup({ connect: false });
    expect(await h.call('rs:setIfaceOverrides', { ethernet: 'en5' })).toMatchObject({ ok: false, code: 'not-connected' });
  });

  it('runs in the edit queue: overrides and rule edits made at the same time are all kept', async () => {
    const h = await setup();
    const handler = (channel: string): Handler => {
      const found = h.ipcMain.handlers.get(channel);
      if (found === undefined) throw new Error(`no handler for ${channel}`);
      return found;
    };
    const calls = [
      handler('rs:saveRule')(TRUSTED, newRule()),
      handler('rs:setIfaceOverrides')(TRUSTED, { ethernet: 'en7' }),
      handler('rs:saveRule')(TRUSTED, newRule({ id: OTHER_ID, target: '172.16.12.41' })),
    ];
    for (let i = 0; i < 40; i += 1) await flush();
    const results = (await Promise.all(calls)) as RsResult<unknown>[];
    expect(results.every((result) => result.ok)).toBe(true);
    expect(h.sentAfterHandshake().filter((method) => method !== 'getConfig')).toEqual(['setConfig', 'setConfig', 'setConfig']);
    expect(h.helper.config.ifaceOverrides).toEqual({ ethernet: 'en7' });
    expect(h.helper.config.rules.map((rule) => rule.id)).toEqual([RULE_ID, NEW_ID, OTHER_ID]);
  });
});

describe('settings: Wi-Fi first (shown, never run)', () => {
  it('reads the order and builds the command with Wi-Fi first', async () => {
    const fake = fakeSettings();
    const h = await setup({ settings: fake.settings });
    const result = await h.call('rs:getServiceOrder');
    expect(result).toMatchObject({
      ok: true,
      value: { wifiService: 'Wi-Fi', wifiFirst: false, command: WIFI_FIRST },
    });
    expect(fake.clipboard).toEqual([]);
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it("puts the service on the engine's Wi-Fi device first, whatever its port is called", async () => {
    const order = [
      '(1) LAN',
      '(Hardware Port: USB 10/100/1000 LAN, Device: en5)',
      '(2) Wi-Fi',
      '(Hardware Port: Wi-Fi, Device: en0)',
      '(3) Travel adapter',
      '(Hardware Port: USB LAN, Device: en8)',
    ].join('\n');
    const base = engineState(1);
    const state: EngineState = {
      ...base,
      interfaces: { ...base.interfaces, wifi: { device: 'en8', ip: '192.168.8.2', gateway: '192.168.8.1', up: true } },
    };
    const client: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'> = {
      reconnectNow: () => undefined,
      request: () => Promise.reject(new Error('not used')),
      snapshot: () => ({ status: { kind: 'connected', helperVersion: '0.1.0' }, state, config: null, configRevision: null }),
      onStatus: () => () => undefined,
      onState: () => () => undefined,
      onLog: () => () => undefined,
    };
    const fake = fakeSettings({ order: () => Promise.resolve(order) });
    const h = await setup({ client, settings: fake.settings });
    expect(await h.call('rs:getServiceOrder')).toMatchObject({
      ok: true,
      value: { wifiService: 'Travel adapter', command: "sudo networksetup -ordernetworkservices 'Travel adapter' 'LAN' 'Wi-Fi'" },
    });
    expect((await h.call('rs:copyServiceOrderCommand')).ok).toBe(true);
    expect(fake.clipboard).toEqual(["sudo networksetup -ordernetworkservices 'Travel adapter' 'LAN' 'Wi-Fi'"]);
  });

  it('copies the command it builds itself; the page sends no text', async () => {
    const fake = fakeSettings();
    const h = await setup({ settings: fake.settings });
    expect((await h.call('rs:copyServiceOrderCommand')).ok).toBe(true);
    expect(fake.clipboard).toEqual([WIFI_FIRST]);
    expect(await h.call('rs:copyServiceOrderCommand', 'rm -rf ~')).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(fake.clipboard).toHaveLength(1);
  });

  it('an order that cannot be read is operation-failed and nothing is copied', async () => {
    const fake = fakeSettings({ order: () => Promise.reject(new Error('ENOENT')) });
    const h = await setup({ settings: fake.settings });
    expect(await h.call('rs:getServiceOrder')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(await h.call('rs:copyServiceOrderCommand')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(fake.clipboard).toEqual([]);
  });

  it('is refused for another document', async () => {
    const fake = fakeSettings();
    const h = await setup({ settings: fake.settings });
    const foreign: InvokeEvent = { senderFrame: { url: 'https://example.com/', parent: null } };
    expect(await h.callAs(foreign, 'rs:copyServiceOrderCommand')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await h.callAs(foreign, 'rs:uninstall')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(fake.listServiceOrder).not.toHaveBeenCalled();
    expect(h.sentAfterHandshake()).toEqual([]);
  });
});

describe('settings: uninstall the helper', () => {
  it('sends uninstall and passes the success through', async () => {
    const h = await setup();
    h.helper.answerOnce.set('uninstall', (request) => ok(request.id, {}));
    expect(await h.call('rs:uninstall')).toEqual({ ok: true, value: {} });
    expect(h.sentAfterHandshake()).toEqual(['uninstall']);
  });

  it('a helper that cannot uninstall yet answers a normal error', async () => {
    const h = await setup();
    expect(await h.call('rs:uninstall')).toMatchObject({ ok: false, code: 'not-implemented' });
  });

  it('refuses arguments and needs a connection', async () => {
    const h = await setup();
    expect(await h.call('rs:uninstall', true)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(h.sentAfterHandshake()).toEqual([]);
    const offline = await setup({ connect: false });
    expect(await offline.call('rs:uninstall')).toMatchObject({ ok: false, code: 'not-connected' });
  });
});

describe('rs:diagnose (TASK-DELTA-20)', () => {
  const ADDRESS_ROUTE = { device: 'en0', gateway: '192.168.1.1', role: 'wifi' } as const;
  /** The helper's answer for one IPv4 target: no rule, the default route through Wi‑Fi. */
  const ipAnswer = (id: number, target: string) =>
    ok(id, {
      target,
      targetKind: 'ip',
      match: null,
      addresses: [{ address: target, source: 'query', route: ADDRESS_ROUTE, expectedRole: null, matchesExpected: null }],
      dns: null,
      notes: ['no-matching-rule'],
    });
  const notCovered = (id: number, target: string) =>
    ok(id, { target, targetKind: 'domain', match: null, addresses: [], dns: null, notes: ['name-not-covered'] });
  /** A helper that does not resolve names and answers every address. */
  const answering = (request: { id: number; target: string }) =>
    /^[\d.]+$/.test(request.target) ? ipAnswer(request.id, request.target) : notCovered(request.id, request.target);
  const lookupOf = (...addresses: string[]): NameLookup => vi.fn(() => Promise.resolve(addresses.map((address) => ({ address, family: 4 }))));
  const diagnoseTargets = (h: Awaited<ReturnType<typeof setup>>) =>
    h.sent().filter((request) => request.method === 'diagnose').map((request) => request['target']);

  it('an address: one helper diagnose, no lookup', async () => {
    const lookupName = lookupOf('10.9.9.9');
    const h = await setup({ diagnose: answering, lookupName });
    const value = valueOf(await h.call('rs:diagnose', '172.16.12.40')) as RsDiagnosis;
    expect(diagnoseTargets(h)).toEqual(['172.16.12.40']);
    expect(lookupName).not.toHaveBeenCalled();
    expect(value.lookup).toBeNull();
    expect(value.result).toMatchObject({ target: '172.16.12.40', targetKind: 'ip', notes: ['no-matching-rule'] });
  });

  it('a name the helper resolves (a rule covers it): no lookup in the app', async () => {
    const lookupName = lookupOf('10.9.9.9');
    const h = await setup({
      lookupName,
      diagnose: (request) =>
        ok(request.id, { target: request.target, targetKind: 'domain', match: { ruleId: RULE_ID, via: 'domain', precedence: 'only-match' }, addresses: [], dns: null, notes: [] }),
    });
    const value = valueOf(await h.call('rs:diagnose', 'corp.local')) as RsDiagnosis;
    expect(value.lookup).toBeNull();
    expect(lookupName).not.toHaveBeenCalled();
    expect(diagnoseTargets(h)).toEqual(['corp.local']);
  });

  it('name-not-covered: the app resolves the name and diagnoses each address, one after the other', async () => {
    const lookupName = lookupOf('203.0.113.7', '127.0.0.1', '203.0.113.7', '198.51.100.2');
    const h = await setup({ diagnose: answering, lookupName });
    const value = valueOf(await h.call('rs:diagnose', 'example.com')) as RsDiagnosis;
    expect(lookupName).toHaveBeenCalledWith('example.com');
    expect(diagnoseTargets(h)).toEqual(['example.com', '203.0.113.7', '198.51.100.2']);
    expect(value.result.notes).toEqual(['name-not-covered']);
    expect(value.lookup).toMatchObject({ outcome: 'ok', truncated: false, excluded: 1 });
    expect(value.lookup?.addresses.map((entry) => [entry.address, entry.ok])).toEqual([
      ['203.0.113.7', true],
      ['198.51.100.2', true],
    ]);
  });

  it('at most 8 addresses are diagnosed; more are reported as truncated', async () => {
    const many = Array.from({ length: 12 }, (_, index) => `203.0.113.${String(index + 1)}`);
    const h = await setup({ diagnose: answering, lookupName: lookupOf(...many) });
    const value = valueOf(await h.call('rs:diagnose', 'example.com')) as RsDiagnosis;
    expect(diagnoseTargets(h)).toEqual(['example.com', ...many.slice(0, 8)]);
    expect(value.lookup).toMatchObject({ truncated: true });
    expect(value.lookup?.addresses).toHaveLength(8);
  });

  it('a refused address is a row with its code; the others are still diagnosed', async () => {
    let calls = 0;
    const h = await setup({
      lookupName: lookupOf('203.0.113.7', '198.51.100.2'),
      diagnose: (request) => {
        calls += 1;
        if (calls === 2) return refused(request.id, 'Too many diagnoses on this connection; try again in a minute', 'operation-failed');
        return answering(request);
      },
    });
    const value = valueOf(await h.call('rs:diagnose', 'example.com')) as RsDiagnosis;
    expect(value.lookup?.addresses).toEqual([
      { address: '203.0.113.7', ok: false, code: 'operation-failed' },
      expect.objectContaining({ address: '198.51.100.2', ok: true }),
    ]);
  });

  it('a lookup that finds nothing: no address request', async () => {
    const lookupName: NameLookup = () => Promise.reject(Object.assign(new Error('queryA ENOTFOUND nope.example'), { code: 'ENOTFOUND' }));
    const h = await setup({ diagnose: answering, lookupName });
    const value = valueOf(await h.call('rs:diagnose', 'nope.example')) as RsDiagnosis;
    expect(value.lookup).toEqual({ outcome: 'not-found', addresses: [], truncated: false, excluded: 0 });
    expect(diagnoseTargets(h)).toEqual(['nope.example']);
  });

  it('a helper refusal is passed on; nothing is resolved', async () => {
    const lookupName = lookupOf('203.0.113.7');
    const h = await setup({ lookupName, diagnose: (request) => refused(request.id, 'Too many diagnoses are running; try again shortly', 'operation-failed') });
    expect(await h.call('rs:diagnose', 'example.com')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(lookupName).not.toHaveBeenCalled();
  });

  it('without a helper: not-connected, nothing resolved', async () => {
    const lookupName = lookupOf('203.0.113.7');
    const h = await setup({ connect: false, lookupName });
    expect(await h.call('rs:diagnose', 'example.com')).toMatchObject({ ok: false, code: 'not-connected' });
    expect(lookupName).not.toHaveBeenCalled();
  });

  it('one diagnosis at a time: a second call while one runs is busy and sends nothing', async () => {
    let finish: (addresses: { address: string; family: number }[]) => void = () => undefined;
    const lookupName: NameLookup = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const h = await setup({ diagnose: answering, lookupName });
    const handler = h.ipcMain.handlers.get('rs:diagnose');
    const first = handler?.(TRUSTED, 'example.com');
    for (let i = 0; i < 8; i += 1) await flush();
    expect(await h.call('rs:diagnose', '172.16.12.40')).toMatchObject({ ok: false, code: 'busy' });
    expect(diagnoseTargets(h)).toEqual(['example.com']);
    finish([{ address: '203.0.113.7', family: 4 }]);
    expect(await first).toMatchObject({ ok: true });
    expect((await h.call('rs:diagnose', '172.16.12.40')).ok).toBe(true);
  });

  it('the name and its addresses are logged at debug only', async () => {
    const h = await setup({ diagnose: answering, lookupName: lookupOf('203.0.113.7') });
    valueOf(await h.call('rs:diagnose', 'secret-host.example'));
    const above = h.entries.filter((entry) => entry.level !== 'debug');
    expect(JSON.stringify(above)).not.toContain('secret-host');
    expect(JSON.stringify(above)).not.toContain('203.0.113.7');
    expect(above.some((entry) => entry.msg === 'Diagnostics made')).toBe(true);
    expect(JSON.stringify(h.entries.filter((entry) => entry.level === 'debug'))).toContain('secret-host.example');
  });
});

describe('rs:openRulesWindow (main process only)', () => {
  it('opens the rules window and sends nothing to the helper', async () => {
    const openRulesWindow = vi.fn();
    const h = await setup({ openRulesWindow });
    expect(await h.call('rs:openRulesWindow')).toEqual({ ok: true, value: null });
    expect(openRulesWindow).toHaveBeenCalledTimes(1);
    expect(openRulesWindow).toHaveBeenCalledWith();
    expect(h.sentAfterHandshake()).toEqual([]);
    expect(h.entries.some((entry) => entry.level === 'info' && entry.msg === 'Rules window requested')).toBe(true);
  });

  it('works without a helper connection', async () => {
    const openRulesWindow = vi.fn();
    const h = await setup({ connect: false, openRulesWindow });
    expect(await h.call('rs:openRulesWindow')).toEqual({ ok: true, value: null });
    expect(openRulesWindow).toHaveBeenCalledTimes(1);
    expect(h.sent()).toEqual([]);
  });

  it('refuses arguments, and opens nothing', async () => {
    const openRulesWindow = vi.fn();
    const h = await setup({ openRulesWindow });
    expect(await h.call('rs:openRulesWindow', 'https://example.com/')).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(openRulesWindow).not.toHaveBeenCalled();
  });

  // TASK-DELTA-21: what the rules window is opened for.
  const RULES_EVENT: InvokeEvent = { senderFrame: { url: viewUrl(APP_ENTRY_URL, 'rules'), parent: null } };
  const POPOVER_EVENT: InvokeEvent = { senderFrame: { url: viewUrl(APP_ENTRY_URL, 'popover'), parent: null } };
  const windowRecipient = (url: string) => {
    const sent: [string, unknown][] = [];
    const target: StateRecipient = { isDestroyed: () => false, getURL: () => url, send: (channel, payload) => sent.push([channel, payload]) };
    return { target, intents: () => sent.filter(([channel]) => channel === RULES_INTENT_CHANNEL) };
  };

  it.each([
    ['junk', 'rules'],
    ['null', null],
    ['an unknown kind', { kind: 'navigate', url: 'https://example.com/' }],
    ['an unknown section', { kind: 'section', section: 'admin' }],
    ['an extra key', { kind: 'section', section: 'log', extra: 1 }],
    ['a rule instead of a warning', { kind: 'dns-offer', server: '10.0.0.53', role: 'ethernet', rule: { target: '0.0.0.0/0' } }],
    ['a forbidden server', { kind: 'dns-offer', server: '127.0.0.1', role: 'ethernet' }],
    ['a name as server', { kind: 'dns-offer', server: 'corp.local', role: 'wifi' }],
    ['another role', { kind: 'dns-offer', server: '10.0.0.53', role: 'utun0' }],
    ['two arguments', { kind: 'section', section: 'log' }, { kind: 'section', section: 'log' }],
  ] as [string, ...unknown[]][])('refuses %s as an intent: nothing opens, nothing waits, nothing is pushed', async (_name, ...args) => {
    const openRulesWindow = vi.fn();
    const rules = windowRecipient(viewUrl(APP_ENTRY_URL, 'rules'));
    const h = await setup({ openRulesWindow, recipients: [rules.target] });
    expect(await h.call('rs:openRulesWindow', ...args)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(openRulesWindow).not.toHaveBeenCalled();
    expect(rules.intents()).toEqual([]);
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: null });
  });

  it('keeps a valid intent for the rules window, tells the rules window only, and hands it out once', async () => {
    const openRulesWindow = vi.fn();
    const rules = windowRecipient(viewUrl(APP_ENTRY_URL, 'rules'));
    const popover = windowRecipient(viewUrl(APP_ENTRY_URL, 'popover'));
    const foreign = windowRecipient(viewUrl('https://example.com/', 'rules'));
    const h = await setup({ openRulesWindow, recipients: [rules.target, popover.target, foreign.target] });
    const intent = { kind: 'dns-offer', server: '10.0.0.53', role: 'ethernet' };
    expect(await h.callAs(POPOVER_EVENT, 'rs:openRulesWindow', intent)).toEqual({ ok: true, value: null });
    expect(openRulesWindow).toHaveBeenCalledTimes(1);
    expect(rules.intents()).toEqual([[RULES_INTENT_CHANNEL, null]]);
    expect(popover.intents()).toEqual([]);
    expect(foreign.intents()).toEqual([]);
    // Only the rules window may take it; the popover is refused and the intent stays.
    expect(await h.callAs(POPOVER_EVENT, 'rs:takeRulesIntent')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: intent });
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: null });
    // The server is not logged above debug.
    expect(JSON.stringify(h.entries.filter((entry) => entry.level !== 'debug'))).not.toContain('10.0.0.53');
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('without an intent nothing waits and nothing is pushed; the last intent wins; a minute later it is gone', async () => {
    let clock = 1_000_000;
    const rules = windowRecipient(viewUrl(APP_ENTRY_URL, 'rules'));
    const h = await setup({ recipients: [rules.target], now: () => clock });
    await h.call('rs:openRulesWindow');
    expect(rules.intents()).toEqual([]);
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: null });
    await h.call('rs:openRulesWindow', { kind: 'section', section: 'log' });
    await h.call('rs:openRulesWindow', { kind: 'section', section: 'diagnostics' });
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: { kind: 'section', section: 'diagnostics' } });
    await h.call('rs:openRulesWindow', { kind: 'section', section: 'settings' });
    clock += RULES_INTENT_TTL_MS;
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: { kind: 'section', section: 'settings' } });
    await h.call('rs:openRulesWindow', { kind: 'section', section: 'settings' });
    clock += RULES_INTENT_TTL_MS + 1;
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: null });
  });

  it('a window that cannot be told is logged; the intent still waits for it', async () => {
    const broken: StateRecipient = {
      isDestroyed: () => false,
      getURL: () => viewUrl(APP_ENTRY_URL, 'rules'),
      send: () => {
        throw new Error('Object has been destroyed');
      },
    };
    const h = await setup({ recipients: [broken] });
    expect(await h.call('rs:openRulesWindow', { kind: 'section', section: 'log' })).toEqual({ ok: true, value: null });
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'Could not tell the rules window of a waiting intent')).toBe(true);
    expect(await h.callAs(RULES_EVENT, 'rs:takeRulesIntent')).toEqual({ ok: true, value: { kind: 'section', section: 'log' } });
  });

  it('viewOf reads the view of a page URL', () => {
    expect(viewOf(viewUrl(APP_ENTRY_URL, 'rules'))).toBe('rules');
    expect(viewOf(APP_ENTRY_URL)).toBeNull();
    expect(viewOf('not a url')).toBeNull();
  });

  it.each([
    ['another document', { senderFrame: { url: 'https://example.com/', parent: null } }],
    ['a sub-frame of the app page', { senderFrame: { url: APP_ENTRY_URL, parent: {} } }],
    ['a frame that is gone', { senderFrame: null }],
  ] as [string, InvokeEvent][])('%s gets forbidden, and nothing is opened', async (_name, event) => {
    const openRulesWindow = vi.fn();
    const h = await setup({ openRulesWindow });
    expect(await h.callAs(event, 'rs:openRulesWindow')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(openRulesWindow).not.toHaveBeenCalled();
  });

  it('a failure to open the window is answered internal and logged, not thrown into the page', async () => {
    const h = await setup({
      openRulesWindow: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(await h.call('rs:openRulesWindow')).toMatchObject({ ok: false, code: 'internal' });
    expect(h.entries.some((entry) => entry.level === 'error' && entry.msg === 'A call failed unexpectedly')).toBe(true);
  });
});

describe('the preload against the main process (window.rs)', () => {
  it('exposes exactly the thirty-five methods of the renderer API (thirty-one calls, four subscriptions), each wired to a handled channel', async () => {
    const openRulesWindow = vi.fn();
    const h = await setup({ settings: fakeSettings().settings, openRulesWindow });
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
        'applyImport',
        'copyServiceOrderCommand',
        'deleteBackup',
        'deleteRule',
        'diagnose',
        'dismissBackup',
        'exportConfig',
        'getBackup',
        'getConfig',
        'getLanguage',
        'getLog',
        'getServiceOrder',
        'getSettings',
        'getState',
        'importConfig',
        'installHelper',
        'onLanguage',
        'onLog',
        'onRulesIntent',
        'onState',
        'openRulesWindow',
        'reconnectHelper',
        'removeHelper',
        'resetConfig',
        'restoreBackup',
        'saveRule',
        'setEnabled',
        'setIfaceOverrides',
        'setLanguage',
        'setOpenAtLogin',
        'takeRulesIntent',
        'test',
        'toggleRule',
        'uninstallHelper',
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
    // The fake helper does not know `diagnose`: its refusal comes back as a value.
    expect(await settle(rs.diagnose('10.1.2.3'))).toMatchObject({ ok: false, code: 'not-implemented' });
    // The test's file dialogs are cancelled: nothing is read or written.
    expect(await settle(rs.importConfig())).toEqual({ ok: true, value: null });
    expect(await settle(rs.applyImport(NEW_ID))).toMatchObject({ ok: false, code: 'import-expired' });
    expect(await settle(rs.exportConfig())).toEqual({ ok: true, value: null });
    // Only the app's own line about the connection (TASK-300).
    expect(await settle(rs.getLog())).toMatchObject({ ok: true, value: [{ seq: 1, source: 'app' }] });
    expect(await settle(rs.getSettings())).toEqual({ ok: true, value: { openAtLogin: false } });
    expect(await settle(rs.setOpenAtLogin(true))).toEqual({ ok: true, value: { openAtLogin: true } });
    expect((await settle(rs.setIfaceOverrides({ ethernet: 'en7' }))).ok).toBe(true);
    expect((await settle(rs.getServiceOrder())).ok).toBe(true);
    expect((await settle(rs.copyServiceOrderCommand())).ok).toBe(true);
    expect(await settle(rs.uninstallHelper())).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await settle(rs.openRulesWindow())).toEqual({ ok: true, value: null });
    expect(openRulesWindow).toHaveBeenCalledTimes(1);
    expect(await settle(rs.openRulesWindow({ kind: 'section', section: 'log' }))).toEqual({ ok: true, value: null });
    expect(openRulesWindow).toHaveBeenCalledTimes(2);
    // This page is not the rules window (no `?view=rules`): the intent is not its to take.
    expect(await settle(rs.takeRulesIntent())).toMatchObject({ ok: false, code: 'forbidden' });
    // Connected: nothing to reconnect, and a readable config is never reset.
    expect(await settle(rs.reconnectHelper())).toEqual({ ok: true, value: null });
    expect(await settle(rs.resetConfig())).toMatchObject({ ok: false, code: 'operation-failed' });
    // The language is the app's own: no helper round trip.
    expect(await settle(rs.getLanguage())).toEqual({ ok: true, value: 'uz' });
    expect(await settle(rs.setLanguage('en'))).toEqual({ ok: true, value: 'en' });
    expect(await settle(rs.getLanguage())).toEqual({ ok: true, value: 'en' });
    expect(h.sentAfterHandshake().filter((method) => method !== 'getConfig')).toEqual([
      'setConfig',
      'setConfig',
      'setConfig',
      'setEnabled',
      'apply',
      'test',
      'diagnose',
      'setConfig',
      'uninstall',
    ]);
    bridge.setInvokeTarget(null);
  });
});

describe('installHelper / removeHelper', () => {
  const fakeInstaller = (install: HelperSetupResult, uninstall: HelperSetupResult = install) => ({
    install: vi.fn(() => Promise.resolve(install)),
    uninstall: vi.fn(() => Promise.resolve(uninstall)),
  });

  it('install runs the installer with no argument and reconnects at once on success', async () => {
    const installer = fakeInstaller({ ok: true, value: null });
    const h = await setup({ connect: false, installer });
    const reconnect = vi.spyOn(h.client, 'reconnectNow');
    expect(await h.call('rs:installHelper')).toEqual({ ok: true, value: null });
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(installer.install).toHaveBeenCalledWith();
    expect(installer.uninstall).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(h.entries.some((entry) => entry.msg === 'Helper setup ended' && entry['ok'] === true)).toBe(true);
  });

  it('removeHelper runs the uninstaller and reconnects (the status becomes not-installed)', async () => {
    const installer = fakeInstaller({ ok: true, value: null });
    const h = await setup({ installer });
    const reconnect = vi.spyOn(h.client, 'reconnectNow');
    expect(await h.call('rs:removeHelper')).toEqual({ ok: true, value: null });
    expect(installer.uninstall).toHaveBeenCalledTimes(1);
    expect(installer.install).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['install-cancelled', 'install-denied', 'install-unavailable', 'busy'] as const)(
    '%s is passed on and no reconnect is forced',
    async (code) => {
      const installer = fakeInstaller({ ok: false, code, error: 'x' });
      const h = await setup({ connect: false, installer });
      const reconnect = vi.spyOn(h.client, 'reconnectNow');
      expect(await h.call('rs:installHelper')).toEqual({ ok: false, code, error: 'x' });
      expect(reconnect).not.toHaveBeenCalled();
    },
  );

  it('a failed script keeps its detail line for the page', async () => {
    const failed: HelperSetupResult = { ok: false, code: 'install-failed', error: 'exit 1', detail: 'install-helper: error: x' };
    const h = await setup({ connect: false, installer: fakeInstaller(failed) });
    expect(await h.call('rs:installHelper')).toEqual(failed);
  });

  it('an installer that throws is answered internal', async () => {
    const h = await setup({ connect: false, installer: UNUSED_INSTALLER });
    expect(await h.call('rs:installHelper')).toMatchObject({ ok: false, code: 'internal' });
  });

  it('another document or a sub-frame cannot start an install', async () => {
    const installer = fakeInstaller({ ok: true, value: null });
    const h = await setup({ connect: false, installer });
    for (const event of [
      { senderFrame: { url: 'https://example.com/', parent: null } },
      { senderFrame: { url: APP_ENTRY_URL, parent: {} } },
      { senderFrame: null },
    ]) {
      expect(await h.callAs(event, 'rs:installHelper')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await h.callAs(event, 'rs:removeHelper')).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.uninstall).not.toHaveBeenCalled();
  });

  it('any argument is refused before the installer runs', async () => {
    const installer = fakeInstaller({ ok: true, value: null });
    const h = await setup({ connect: false, installer });
    expect(await h.call('rs:installHelper', '/Applications/Evil.app/Contents/Resources/helper')).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(await h.call('rs:removeHelper', '--force')).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.uninstall).not.toHaveBeenCalled();
  });
});

describe('language: rs:getLanguage, rs:setLanguage and the rs:language push', () => {
  const languageRecipient = (url: string = APP_ENTRY_URL) => {
    const received: unknown[] = [];
    const target: StateRecipient = {
      isDestroyed: () => false,
      getURL: () => url,
      send: (channel, payload) => {
        if (channel === LANGUAGE_CHANNEL) received.push(payload);
      },
    };
    return { target, received };
  };

  it('reads the stored language from the main process, with or without a helper', async () => {
    const { store } = memoryPreferences('ru');
    const h = await setup({ connect: false, preferences: store });
    expect(await h.call('rs:getLanguage')).toEqual({ ok: true, value: 'ru' });
    expect(h.sent()).toEqual([]);
  });

  it('stores a new language and pushes it to every window of the app page, not to another document', async () => {
    const { store } = memoryPreferences('uz');
    const popover = languageRecipient();
    const rules = languageRecipient();
    const foreign = languageRecipient('https://example.com/');
    const h = await setup({ connect: false, preferences: store, recipients: [popover.target, rules.target, foreign.target] });
    expect(await h.call('rs:setLanguage', 'ru')).toEqual({ ok: true, value: 'ru' });
    expect(store.setLanguage).toHaveBeenCalledWith('ru');
    expect(popover.received).toEqual(['ru']);
    expect(rules.received).toEqual(['ru']);
    expect(foreign.received).toEqual([]);
    expect(await h.call('rs:getLanguage')).toEqual({ ok: true, value: 'ru' });
    // The same language again: stored, nothing pushed.
    expect(await h.call('rs:setLanguage', 'ru')).toEqual({ ok: true, value: 'ru' });
    expect(popover.received).toEqual(['ru']);
    expect(h.sent()).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ['an unknown language', ['de']],
    ['another spelling', ['RU']],
    ['a locale tag', ['ru-RU']],
    ['padding', ['ru ']],
    ['an empty string', ['']],
    ['a number', [1]],
    ['null', [null]],
    ['an object', [{ language: 'ru' }]],
    ['an array', [['ru']]],
    ['no argument', []],
    ['a second argument', ['ru', 'en']],
    ['a prototype key', ['toString']],
  ])('refuses %s before the store is touched', async (_name, args) => {
    const { store } = memoryPreferences('uz');
    const recipient = languageRecipient();
    const h = await setup({ connect: false, preferences: store, recipients: [recipient.target] });
    expect(await h.call('rs:setLanguage', ...args)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(store.setLanguage).not.toHaveBeenCalled();
    expect(recipient.received).toEqual([]);
  });

  it('getLanguage takes no argument', async () => {
    const h = await setup({ connect: false });
    expect(await h.call('rs:getLanguage', 'ru')).toMatchObject({ ok: false, code: 'invalid-input' });
  });

  it('another document or a sub-frame can neither read nor change the language', async () => {
    const { store } = memoryPreferences('uz');
    const h = await setup({ connect: false, preferences: store });
    for (const event of [
      { senderFrame: { url: 'https://example.com/', parent: null } },
      { senderFrame: { url: APP_ENTRY_URL, parent: {} } },
      { senderFrame: null },
    ]) {
      expect(await h.callAs(event, 'rs:getLanguage')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await h.callAs(event, 'rs:setLanguage', 'en')).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(store.language).not.toHaveBeenCalled();
    expect(store.setLanguage).not.toHaveBeenCalled();
  });

  it('a store that throws is answered internal, never thrown into the page', async () => {
    const { store } = memoryPreferences('uz');
    store.setLanguage.mockImplementationOnce(() => Promise.reject(new Error('disk gone')));
    const h = await setup({ connect: false, preferences: store });
    expect(await h.call('rs:setLanguage', 'en')).toMatchObject({ ok: false, code: 'internal' });
  });

  it('dispose stops the language pushes', async () => {
    const { store, listeners } = memoryPreferences('uz');
    const recipient = languageRecipient();
    const h = await setup({ connect: false, preferences: store, recipients: [recipient.target] });
    expect(listeners.size).toBe(1);
    h.registration.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('rules backup: rs:getBackup, rs:restoreBackup, rs:deleteBackup, rs:dismissBackup (TASK-DELTA-16)', () => {
  const EMPTY: Config = { version: 1, enabled: true, rules: [] };
  const SAVED_AT = '2026-10-15T08:30:00.000Z';
  const backupOf = (config: Config = oneRuleConfig()): RulesBackupFile => ({ version: 1, savedAt: SAVED_AT, configRevision: 3, config });

  it('getBackup tells when and how many rules — not which — and works without the helper', async () => {
    const h = await setup({ connect: false, backup: memoryBackup(backupOf()) });
    expect(valueOf(await h.call('rs:getBackup'))).toEqual({ savedAt: SAVED_AT, ruleCount: 1, dismissed: false });
    const none = await setup({ connect: false });
    expect(valueOf(await none.call('rs:getBackup'))).toBeNull();
  });

  it('restore returns the backup as an import preview; nothing reaches the helper until applyImport (no setConfig without consent)', async () => {
    const h = await setup({ config: EMPTY, backup: memoryBackup(backupOf()) });
    const preview = valueOf(await h.call('rs:restoreBackup')) as { token: string; config: Config };
    expect(preview.config).toEqual(oneRuleConfig());
    // Asked, read and shown: still no setConfig.
    await h.call('rs:getBackup');
    expect(h.sentAfterHandshake()).toEqual([]);
    expect(h.helper.config).toEqual(EMPTY);

    expect(valueOf(await h.call('rs:applyImport', preview.token))).toMatchObject({ config: oneRuleConfig() });
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);
    expect(h.helper.config).toEqual(oneRuleConfig());
    // One use, like an import.
    expect(await h.call('rs:applyImport', preview.token)).toMatchObject({ ok: false, code: 'import-expired' });
    expect(h.sentAfterHandshake()).toEqual(['setConfig']);
  });

  it('a restore token expires after 10 minutes like an import', async () => {
    let clock = 1_000_000;
    const h = await setup({ config: EMPTY, backup: memoryBackup(backupOf()), now: () => clock });
    const preview = valueOf(await h.call('rs:restoreBackup')) as { token: string };
    clock += IMPORT_TTL_MS + 1;
    expect(await h.call('rs:applyImport', preview.token)).toMatchObject({ ok: false, code: 'import-expired' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('without a backup the restore is refused no-backup; a backup that fails the schema is refused invalid-config', async () => {
    const none = await setup({ config: EMPTY });
    expect(await none.call('rs:restoreBackup')).toMatchObject({ ok: false, code: 'no-backup' });
    const broken = { ...backupOf(), config: { version: 1, enabled: true, rules: [{ ...oneRuleConfig().rules[0], target: '0.0.0.0/0' }] } } as unknown as RulesBackupFile;
    const h = await setup({ config: EMPTY, backup: memoryBackup(broken) });
    expect(await h.call('rs:restoreBackup')).toMatchObject({ ok: false, code: 'invalid-config' });
    expect(h.sentAfterHandshake()).toEqual([]);
  });

  it('dismissBackup turns down exactly the backup on disk; deleteBackup removes it', async () => {
    const preferences = memoryPreferences();
    const backup = memoryBackup(backupOf());
    const h = await setup({ connect: false, preferences: preferences.store, backup });
    expect(valueOf(await h.call('rs:dismissBackup'))).toBeNull();
    expect(preferences.store.setDismissedBackupAt).toHaveBeenCalledWith(SAVED_AT);
    expect(valueOf(await h.call('rs:getBackup'))).toEqual({ savedAt: SAVED_AT, ruleCount: 1, dismissed: true });
    expect(valueOf(await h.call('rs:deleteBackup'))).toBeNull();
    expect(valueOf(await h.call('rs:getBackup'))).toBeNull();
    // Nothing on disk: nothing to turn down.
    expect(valueOf(await h.call('rs:dismissBackup'))).toBeNull();
    expect(preferences.store.setDismissedBackupAt).toHaveBeenCalledTimes(1);
  });

  it('a backup that cannot be removed is answered write-failed', async () => {
    const h = await setup({ connect: false, backup: memoryBackup(backupOf(), false) });
    expect(await h.call('rs:deleteBackup')).toMatchObject({ ok: false, code: 'write-failed' });
  });

  it.each(['rs:getBackup', 'rs:restoreBackup', 'rs:deleteBackup', 'rs:dismissBackup'])('%s takes no arguments and answers only the app page', async (channel) => {
    const backup = memoryBackup(backupOf());
    const h = await setup({ connect: false, backup });
    expect(await h.call(channel, '../etc/passwd')).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await h.callAs({ senderFrame: { url: 'https://example.com/', parent: null } }, channel)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(backup.read).not.toHaveBeenCalled();
    expect(backup.remove).not.toHaveBeenCalled();
  });
});
