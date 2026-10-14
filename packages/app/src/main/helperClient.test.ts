import { MAX_LINE_BYTES, PROTOCOL_VERSION, type Config, type EngineState, type LogEvent } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import {
  createHelperClient,
  DEFAULT_TIMEOUTS,
  MAX_BUFFERED_BYTES,
  MAX_CONSECUTIVE_INVALID_LINES,
  MAX_PENDING_REQUESTS,
  RECONNECT_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_STEADY_ATTEMPTS,
  reconnectDelay,
  type HelperStatus,
} from './helperClient';
import {
  emptyConfig,
  engineState,
  FakeSocket,
  fakeScheduler,
  flush,
  memoryLogger,
  ok,
  oneRuleConfig,
  refused,
  RULE_ID,
  socketError,
  statusResult,
} from './helperClient.fixtures';

const SOCKET_PATH = '/tmp/routeswitch-test/helper.sock';

function setup() {
  const scheduler = fakeScheduler();
  const { logger, entries } = memoryLogger(() => scheduler.now);
  const sockets: FakeSocket[] = [];
  const paths: string[] = [];
  const connectFailures: Error[] = [];
  const client = createHelperClient({
    socketPath: SOCKET_PATH,
    logger,
    connect: (path) => {
      paths.push(path);
      const thrown = connectFailures.shift();
      if (thrown !== undefined) throw thrown;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const statuses: HelperStatus[] = [];
  const states: EngineState[] = [];
  const configs: Config[] = [];
  const logs: LogEvent[] = [];
  client.onStatus((status) => statuses.push(status));
  client.onState((state) => states.push(state));
  client.onConfig((config) => configs.push(config));
  client.onLog((event) => logs.push(event));
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (last === undefined) throw new Error('no socket was opened');
    return last;
  };
  const warnings = () => entries.filter((entry) => entry.level === 'warn' || entry.level === 'error');
  return { client, scheduler, sockets, socket, paths, connectFailures, statuses, states, configs, logs, entries, warnings };
}

type Harness = ReturnType<typeof setup>;

/** Opens the current socket and plays the helper's side of the handshake. */
async function handshake(h: Harness, state: EngineState = engineState(1), config: Config = emptyConfig()): Promise<FakeSocket> {
  const socket = h.socket();
  socket.emit('connect');
  await flush();
  socket.receive(ok(socket.lastRequest().id, statusResult(state)));
  await flush();
  socket.receive(ok(socket.lastRequest().id, { config, configRevision: state.configRevision }));
  await flush();
  return socket;
}

async function connected(state: EngineState = engineState(1), config: Config = emptyConfig()): Promise<Harness & { live: FakeSocket }> {
  const h = setup();
  h.client.start();
  const live = await handshake(h, state, config);
  return { ...h, live };
}

describe('connecting', () => {
  it('opens exactly the socket path it was given', () => {
    const h = setup();
    h.client.start();
    expect(h.paths).toEqual([SOCKET_PATH]);
    expect(h.client.snapshot()).toEqual({ status: { kind: 'connecting' }, state: null, config: null, configRevision: null });
  });

  it('handshakes with status, then getConfig, and only then is connected', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    expect(socket.written).toEqual([]);

    socket.emit('connect');
    await flush();
    expect(socket.requests()).toEqual([{ id: 0, method: 'status' }]);
    expect(h.client.snapshot().status).toEqual({ kind: 'connecting' });
    expect(await h.client.request('apply')).toEqual({ ok: false, code: 'not-connected', error: 'There is no connection to the helper' });

    socket.receive(ok(0, statusResult(engineState(7, 3))));
    await flush();
    expect(socket.requests()).toEqual([
      { id: 0, method: 'status' },
      { id: 1, method: 'getConfig' },
    ]);
    expect(h.client.snapshot().status).toEqual({ kind: 'connecting' });
    expect(h.states).toEqual([]);

    socket.receive(ok(1, { config: oneRuleConfig(), configRevision: 3 }));
    await flush();
    expect(h.client.snapshot()).toEqual({
      status: { kind: 'connected', helperVersion: '1.2.3' },
      state: engineState(7, 3),
      config: oneRuleConfig(),
      configRevision: 3,
    });
    expect(h.statuses).toEqual([{ kind: 'connecting' }, { kind: 'connected', helperVersion: '1.2.3' }]);
    expect(h.states).toEqual([engineState(7, 3)]);
    expect(h.configs).toEqual([oneRuleConfig()]);
    expect(h.warnings()).toEqual([]);
  });

  it('shows subscribers of the status a complete snapshot at the moment it turns connected', async () => {
    const h = setup();
    const seen: unknown[] = [];
    h.client.onStatus((status) => {
      if (status.kind === 'connected') seen.push(h.client.snapshot());
    });
    h.client.start();
    await handshake(h, engineState(4, 2), oneRuleConfig());
    expect(seen).toEqual([
      { status: { kind: 'connected', helperVersion: '1.2.3' }, state: engineState(4, 2), config: oneRuleConfig(), configRevision: 2 },
    ]);
  });

  it.each([
    ['ENOENT', { kind: 'not-installed' }, 'info'],
    ['ECONNREFUSED', { kind: 'disconnected', reason: 'not-running' }, 'info'],
    ['EACCES', { kind: 'disconnected', reason: 'permission-denied' }, 'warn'],
    ['EPERM', { kind: 'disconnected', reason: 'permission-denied' }, 'warn'],
    ['ENOTSOCK', { kind: 'disconnected', reason: 'error' }, 'warn'],
  ] as const)('reports %s as %j, at %s level', (code, status, level) => {
    const h = setup();
    h.client.start();
    h.socket().emit('error', socketError(code));
    h.socket().emit('close');
    expect(h.client.snapshot().status).toEqual(status);
    expect(h.statuses).toEqual([{ kind: 'connecting' }, status]);
    expect(h.socket().destroyed).toBe(true);
    const lines = h.entries.filter((entry) => entry.msg === 'Helper connection status changed');
    expect(lines.at(-1)).toMatchObject({ level, status: status.kind });
    expect(h.entries.some((entry) => entry.level === 'error')).toBe(false);
  });

  it('treats a connect() that throws like a failed attempt', () => {
    const h = setup();
    h.connectFailures.push(socketError('ENOENT'));
    h.client.start();
    expect(h.client.snapshot().status).toEqual({ kind: 'not-installed' });
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    h.scheduler.advance(RECONNECT_DELAY_MS);
    expect(h.sockets).toHaveLength(1);
  });

  it('gives up on a socket that never opens', () => {
    const h = setup();
    h.client.start();
    h.scheduler.advance(DEFAULT_TIMEOUTS.connectMs);
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'timeout' });
    expect(h.sockets[0]?.destroyed).toBe(true);
  });

  it('retries after two seconds, silently while nothing changes, then backs off to a cap', () => {
    const h = setup();
    h.client.start();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      h.socket().emit('error', socketError('ENOENT'));
      const [delay] = h.scheduler.pending();
      delays.push(delay ?? -1);
      h.scheduler.advance(delay ?? 0);
      expect(h.sockets).toHaveLength(attempt + 1);
    }
    expect(delays).toEqual([2000, 2000, 2000, 2000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    // One line for `connecting`, one for `not-installed` — not one per attempt.
    expect(h.entries.filter((entry) => entry.msg === 'Helper connection status changed')).toHaveLength(2);
    expect(h.statuses).toEqual([{ kind: 'connecting' }, { kind: 'not-installed' }]);
  });

  it('computes the reconnect delay', () => {
    expect(reconnectDelay(0)).toBe(RECONNECT_DELAY_MS);
    expect(reconnectDelay(RECONNECT_STEADY_ATTEMPTS)).toBe(RECONNECT_DELAY_MS);
    expect(reconnectDelay(RECONNECT_STEADY_ATTEMPTS + 1)).toBe(2 * RECONNECT_DELAY_MS);
    expect(reconnectDelay(1_000_000)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(RECONNECT_DELAY_MS).toBe(2000);
  });

  it('reconnectNow skips the wait, and does nothing while a connection exists', async () => {
    const h = setup();
    h.client.start();
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(1);
    h.socket().emit('error', socketError('ENOENT'));
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);
    expect(h.scheduler.pending()).toEqual([DEFAULT_TIMEOUTS.connectMs]);
    await handshake(h);
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);
  });
});

describe('handshake failures', () => {
  it('recognises a helper of another protocol version, whatever else its status says', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, { protocolVersion: PROTOCOL_VERSION + 1, helperVersion: '9.0.0', state: { entirely: 'different' } }));
    await flush();
    const incompatible = {
      kind: 'incompatible',
      helperVersion: '9.0.0',
      protocolVersion: PROTOCOL_VERSION + 1,
      expectedProtocolVersion: PROTOCOL_VERSION,
    };
    expect(h.client.snapshot()).toEqual({ status: incompatible, state: null, config: null, configRevision: null });
    expect(socket.destroyed).toBe(true);
    expect(socket.requests().map((request) => request.method)).toEqual(['status']);
    expect(await h.client.request('apply')).toMatchObject({ ok: false, code: 'not-connected' });
    expect(h.states).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ level: 'warn', status: 'incompatible', helperVersion: '9.0.0' });
    // It keeps looking: the helper may be reinstalled.
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
  });

  it.each([
    ['a status without version fields', ok(0, { state: engineState(1) })],
    ['a helperVersion that is not a version', ok(0, { protocolVersion: PROTOCOL_VERSION, helperVersion: '<script>', state: engineState(1) })],
    ['an over-long helperVersion', ok(0, { protocolVersion: PROTOCOL_VERSION, helperVersion: `1.0.0-${'a'.repeat(200)}`, state: engineState(1) })],
    ['the right version but a malformed state', ok(0, { protocolVersion: PROTOCOL_VERSION, helperVersion: '1.2.3', state: { seq: -1 } })],
    ['an error answer to status', refused(0, 'nope', 'internal')],
  ])('drops the connection as a protocol error for %s', async (_name, answer) => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(answer);
    await flush();
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'protocol-error' });
    expect(socket.destroyed).toBe(true);
    expect(h.states).toEqual([]);
  });

  it('drops the connection when getConfig fails or is malformed', async () => {
    for (const answer of [refused(1, 'no', 'internal'), ok(1, { config: { version: 2 } })]) {
      const h = setup();
      h.client.start();
      const socket = h.socket();
      socket.emit('connect');
      await flush();
      socket.receive(ok(0, statusResult(engineState(1))));
      await flush();
      socket.receive(answer);
      await flush();
      expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'protocol-error' });
      expect(h.states).toEqual([]);
      expect(h.configs).toEqual([]);
    }
  });

  describe('a stored config the helper cannot load (TASK-300)', () => {
    /** Handshake whose getConfig the helper refuses as `operation-failed` (TASK-114: broken config.json). */
    async function unreadable(state: EngineState = engineState(4, 2)) {
      const h = setup();
      h.client.start();
      const socket = h.socket();
      socket.emit('connect');
      await flush();
      socket.receive(ok(0, statusResult(state)));
      await flush();
      socket.receive(refused(1, 'The stored config could not be loaded (invalid-json)', 'operation-failed'));
      await flush();
      return { ...h, live: socket };
    }

    it('stays connected as config-unreadable: no state or config, requests allowed, no retry loop', async () => {
      const h = await unreadable();
      expect(h.live.destroyed).toBe(false);
      expect(h.client.snapshot()).toEqual({
        status: { kind: 'config-unreadable', helperVersion: '1.2.3' },
        state: null,
        config: null,
        configRevision: null,
      });
      expect(h.statuses).toEqual([{ kind: 'connecting' }, { kind: 'config-unreadable', helperVersion: '1.2.3' }]);
      expect(h.states).toEqual([]);
      expect(h.configs).toEqual([]);
      expect(h.scheduler.pending()).toEqual([]);
      expect(h.warnings().some((entry) => entry['status'] === 'config-unreadable')).toBe(true);
      // A request goes out (the user may apply or test); getConfig is not asked again by itself.
      void h.client.request('apply');
      await flush();
      expect(h.live.requests().map((request) => request.method)).toEqual(['status', 'getConfig', 'apply']);
    });

    it('states of the same config revision ask for nothing; a newer revision tries once, and a refusal does not retry', async () => {
      const h = await unreadable(engineState(4, 2));
      for (let seq = 5; seq < 25; seq += 1) h.live.receive({ event: 'state', state: engineState(seq, 2) });
      await flush();
      expect(h.live.requests().map((request) => request.method)).toEqual(['status', 'getConfig']);
      // Kept, not published: to subscribers `state` stays null while the config is unreadable.
      expect(h.states).toEqual([]);
      expect(h.scheduler.pending()).toEqual([]);
      // Another client stored a config: one getConfig …
      h.live.receive({ event: 'state', state: engineState(30, 3) });
      await flush();
      expect(h.live.lastRequest().method).toBe('getConfig');
      // … still unreadable (say, refused again): no timer, and revision 3 is not asked again.
      h.live.receive(refused(h.live.lastRequest().id, 'still broken', 'operation-failed'));
      await flush();
      h.live.receive({ event: 'state', state: engineState(31, 3) });
      await flush();
      expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(2);
      expect(h.scheduler.pending()).toEqual([]);
      expect(h.client.snapshot().status.kind).toBe('config-unreadable');
      expect(h.states).toEqual([]);
    });

    it('a getConfig that succeeds after a newer revision makes the connection connected, with its state and config', async () => {
      const h = await unreadable(engineState(4, 2));
      h.live.receive({ event: 'state', state: engineState(5, 3) });
      await flush();
      h.live.receive(ok(h.live.lastRequest().id, { config: oneRuleConfig(), configRevision: 3 }));
      await flush();
      expect(h.client.snapshot()).toEqual({
        status: { kind: 'connected', helperVersion: '1.2.3' },
        state: engineState(5, 3),
        config: oneRuleConfig(),
        configRevision: 3,
      });
      expect(h.statuses.at(-1)).toEqual({ kind: 'connected', helperVersion: '1.2.3' });
      expect(h.configs).toEqual([oneRuleConfig()]);
      // The state that arrived while unreadable is published once, on recovery.
      expect(h.states).toEqual([engineState(5, 3)]);
    });

    it('a setConfig repairs it: connected with the stored config and the state of the result, without another getConfig', async () => {
      const h = await unreadable(engineState(4, 2));
      const seen: unknown[] = [];
      h.client.onStatus((status) => {
        if (status.kind === 'connected') seen.push(h.client.snapshot());
      });
      const result = h.client.request('setConfig', { config: emptyConfig() });
      await flush();
      expect(h.live.lastRequest().method).toBe('setConfig');
      h.live.receive({ event: 'state', state: engineState(5, 2) });
      expect(h.states).toEqual([]);
      h.live.receive(ok(h.live.lastRequest().id, { config: emptyConfig(), state: engineState(6, 3) }));
      expect((await result).ok).toBe(true);
      await flush();
      // Nothing while unreadable; the repaired state exactly once (`leaveUnreadable` is the one publish point).
      expect(h.states).toEqual([engineState(6, 3)]);
      const repaired = { status: { kind: 'connected', helperVersion: '1.2.3' }, state: engineState(6, 3), config: emptyConfig(), configRevision: 3 };
      expect(h.client.snapshot()).toEqual(repaired);
      // Subscribers of the status see the complete snapshot when it turns connected.
      expect(seen).toEqual([repaired]);
      expect(h.configs).toEqual([emptyConfig()]);
      expect(h.live.requests().map((request) => request.method)).toEqual(['status', 'getConfig', 'setConfig']);
      // From now on the usual rules: a newer state fetches the config.
      h.live.receive({ event: 'state', state: engineState(7, 4) });
      await flush();
      expect(h.live.lastRequest().method).toBe('getConfig');
    });

    it('a refused setConfig leaves it config-unreadable', async () => {
      const h = await unreadable();
      const result = h.client.request('setConfig', { config: emptyConfig() });
      await flush();
      h.live.receive(refused(h.live.lastRequest().id, 'The config could not be saved (EACCES)', 'operation-failed'));
      expect(await result).toMatchObject({ ok: false, code: 'operation-failed' });
      expect(h.client.snapshot().status.kind).toBe('config-unreadable');
    });

    it('other getConfig failures still drop the connection; a reconnect starts over', async () => {
      const h = await unreadable();
      h.live.emit('close');
      expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'connection-lost' });
      h.scheduler.advance(RECONNECT_DELAY_MS);
      const next = await handshake(h, engineState(1, 1), oneRuleConfig());
      expect(next).not.toBe(h.live);
      expect(h.client.snapshot().status).toEqual({ kind: 'connected', helperVersion: '1.2.3' });
      expect(h.client.snapshot().config).toEqual(oneRuleConfig());
    });
  });

  it('reconnectNow() shows the attempt as connecting; it does nothing while connected or already connecting', async () => {
    const h = setup();
    h.client.start();
    h.socket().emit('error', socketError('ECONNREFUSED'));
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'not-running' });
    h.client.reconnectNow();
    expect(h.statuses.at(-1)).toEqual({ kind: 'connecting' });
    expect(h.sockets).toHaveLength(2);
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);
    // The same failure again is a change again, so the user sees it.
    h.socket().emit('error', socketError('ECONNREFUSED'));
    expect(h.statuses.slice(-3)).toEqual([
      { kind: 'disconnected', reason: 'not-running' },
      { kind: 'connecting' },
      { kind: 'disconnected', reason: 'not-running' },
    ]);
    h.scheduler.advance(RECONNECT_DELAY_MS);
    await handshake(h);
    expect(h.client.snapshot().status.kind).toBe('connected');
    const before = h.statuses.length;
    h.client.reconnectNow();
    expect(h.statuses).toHaveLength(before);
    expect(h.sockets).toHaveLength(3);
  });

  it('times out a handshake the helper never answers', async () => {
    const h = setup();
    h.client.start();
    h.socket().emit('connect');
    await flush();
    h.scheduler.advance(DEFAULT_TIMEOUTS.readMs);
    await flush();
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'timeout' });
    expect(h.socket().destroyed).toBe(true);
  });
});

describe('requests', () => {
  it('answers each of the seven methods with its typed result', async () => {
    const h = await connected(engineState(1, 1));
    const { client, live } = h;

    const status = client.request('status');
    expect(live.lastRequest()).toEqual({ id: 2, method: 'status' });
    live.receive(ok(2, statusResult(engineState(2, 1))));
    const statusValue = await status;
    expect(statusValue).toEqual({ ok: true, value: statusResult(engineState(2, 1)) });
    if (statusValue.ok) expect(statusValue.value.state.seq).toBe(2);

    const getConfig = client.request('getConfig');
    expect(live.lastRequest()).toEqual({ id: 3, method: 'getConfig' });
    live.receive(ok(3, { config: oneRuleConfig(), configRevision: 1 }));
    expect(await getConfig).toEqual({ ok: true, value: { config: oneRuleConfig(), configRevision: 1 } });

    const setConfig = client.request('setConfig', { config: { version: 1, rules: [{ id: RULE_ID, kind: 'subnet', target: '10.1.2.3/8', iface: 'ethernet' }] } });
    // Sent normalised and with defaults filled in — built from the parsed request.
    expect(live.lastRequest()).toEqual({ id: 4, method: 'setConfig', config: oneRuleConfig() });
    live.receive(ok(4, { config: oneRuleConfig(), state: engineState(3, 2) }));
    expect(await setConfig).toEqual({ ok: true, value: { config: oneRuleConfig(), state: engineState(3, 2) } });

    const apply = client.request('apply');
    expect(live.lastRequest()).toEqual({ id: 5, method: 'apply' });
    live.receive(ok(5, { state: engineState(4, 2) }));
    expect(await apply).toEqual({ ok: true, value: { state: engineState(4, 2) } });

    const setEnabled = client.request('setEnabled', { enabled: false });
    expect(live.lastRequest()).toEqual({ id: 6, method: 'setEnabled', enabled: false });
    live.receive(ok(6, { state: engineState(5, 3, { enabled: false }) }));
    expect(await setEnabled).toEqual({ ok: true, value: { state: engineState(5, 3, { enabled: false }) } });

    // The revision moved (2 → 3) without a config in the result: the client fetches it itself.
    expect(live.lastRequest()).toEqual({ id: 7, method: 'getConfig' });
    live.receive(ok(7, { config: { ...oneRuleConfig(), enabled: false }, configRevision: 3 }));
    await flush();
    expect(client.snapshot()).toMatchObject({ configRevision: 3, config: { enabled: false } });

    const testResult = { target: '10.1.2.3', destination: '10.0.0.0/8', gateway: '10.0.0.1', device: 'en5', role: 'ethernet', ruleId: RULE_ID };
    const test = client.request('test', { target: '10.1.2.3' });
    expect(live.lastRequest()).toEqual({ id: 8, method: 'test', target: '10.1.2.3' });
    live.receive(ok(8, testResult));
    expect(await test).toEqual({ ok: true, value: testResult });

    const uninstall = client.request('uninstall');
    expect(live.lastRequest()).toEqual({ id: 9, method: 'uninstall' });
    live.receive(ok(9, {}));
    expect(await uninstall).toEqual({ ok: true, value: {} });

    expect(h.warnings()).toEqual([]);
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('surfaces an error response with its text and code, and never rejects', async () => {
    const { client, live } = await connected();
    const withCode = client.request('apply');
    live.receive(refused(2, 'Reconcile failed: route exited with 1', 'operation-failed'));
    expect(await withCode).toEqual({ ok: false, code: 'operation-failed', error: 'Reconcile failed: route exited with 1' });

    const withoutCode = client.request('apply');
    live.receive(refused(3, 'Something went wrong'));
    expect(await withoutCode).toEqual({ ok: false, code: 'unspecified', error: 'Something went wrong' });
  });

  it('refuses a request the contract would refuse, without sending it', async () => {
    const { client, live } = await connected();
    const before = live.written.length;
    expect(await client.request('test', { target: '0.0.0.0' })).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(await client.request('setConfig', { config: { version: 1, rules: [{ id: 'x', kind: 'ip', target: '10.0.0.1', iface: 'ethernet' }] } })).toMatchObject({
      ok: false,
      code: 'invalid-config',
    });
    expect(live.written).toHaveLength(before);
    // The id was not consumed either.
    void client.request('apply');
    expect(live.lastRequest()).toEqual({ id: 2, method: 'apply' });
  });

  it('turns a result that does not match the method into invalid-response', async () => {
    const { client, live, warnings } = await connected();
    const apply = client.request('apply');
    live.receive(ok(2, { config: emptyConfig() })); // a getConfig result
    expect(await apply).toMatchObject({ ok: false, code: 'invalid-response' });

    const test = client.request('test', { target: '10.1.2.3' });
    live.receive(ok(3, { target: '10.1.2.3', destination: 'x'.repeat(100), gateway: null, device: 'en5', role: null, ruleId: null }));
    expect(await test).toMatchObject({ ok: false, code: 'invalid-response' });
    expect(warnings().map((entry) => entry.msg)).toEqual([
      'Dropped a line from the helper that is not a valid message',
      'Dropped a line from the helper that is not a valid message',
    ]);
  });

  it('validates a result against the method that was asked when two are pending', async () => {
    const { client, live } = await connected();
    const apply = client.request('apply'); // id 2
    const test = client.request('test', { target: '10.1.2.3' }); // id 3
    // The helper (or an impostor) answers id 3 with what would be a fine `apply` result.
    live.receive(ok(3, { state: engineState(9) }));
    expect(await test).toMatchObject({ ok: false, code: 'invalid-response' });
    live.receive(ok(2, { state: engineState(9) }));
    expect(await apply).toEqual({ ok: true, value: { state: engineState(9) } });
  });

  it('resolves parallel requests by id, whatever order the answers come in', async () => {
    const { client, live } = await connected();
    const first = client.request('apply');
    const second = client.request('test', { target: '10.1.2.3' });
    const third = client.request('getConfig');
    expect(live.requests().slice(2).map((request) => request.id)).toEqual([2, 3, 4]);
    live.receive(ok(4, { config: oneRuleConfig(), configRevision: 1 }));
    live.receive(refused(3, 'No route', 'operation-failed'));
    live.receive(ok(2, { state: engineState(2) }));
    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true, value: { state: engineState(2) } },
      { ok: false, code: 'operation-failed', error: 'No route' },
      { ok: true, value: { config: oneRuleConfig(), configRevision: 1 } },
    ]);
  });

  it('ignores a response with an unknown id or a null id, and says so', async () => {
    const { client, live, entries, scheduler } = await connected();
    const pending = client.request('apply');
    live.receive(ok(999, { state: engineState(50) }));
    live.receive(refused(null, 'Line is not valid JSON', 'invalid-json'));
    await flush();
    expect(client.snapshot().state?.seq).toBe(1); // the stray response's state was not taken
    expect(entries.filter((entry) => entry.msg === 'Ignored a response that matches no pending request')).toMatchObject([
      { level: 'warn', id: 999, ok: true },
      { level: 'warn', id: null, ok: false, code: 'invalid-json' },
    ]);
    live.receive(ok(2, { state: engineState(2) }));
    expect(await pending).toMatchObject({ ok: true });
    expect(scheduler.pending()).toEqual([]);
  });

  it.each([
    ['status', {}, DEFAULT_TIMEOUTS.readMs],
    ['getConfig', {}, DEFAULT_TIMEOUTS.readMs],
    ['test', { target: '10.1.2.3' }, DEFAULT_TIMEOUTS.testMs],
    ['apply', {}, DEFAULT_TIMEOUTS.mutateMs],
    ['setEnabled', { enabled: true }, DEFAULT_TIMEOUTS.mutateMs],
    ['setConfig', { config: { version: 1, rules: [] } }, DEFAULT_TIMEOUTS.mutateMs],
    ['uninstall', {}, DEFAULT_TIMEOUTS.uninstallMs],
  ] as const)('times %s out after its own limit, and keeps the connection', async (method, params, limit) => {
    const { client, live, scheduler } = await connected();
    let settled: unknown = null;
    void (client.request as (method: string, params: unknown) => Promise<unknown>)(method, params).then((result) => {
      settled = result;
    });
    scheduler.advance(limit - 1);
    await flush();
    expect(settled).toBeNull();
    scheduler.advance(1);
    await flush();
    expect(settled).toEqual({ ok: false, code: 'timeout', error: 'The helper did not answer in time' });
    expect(client.snapshot().status.kind).toBe('connected');
    expect(live.destroyed).toBe(false);
    // The late answer is a stray response now, not a crash.
    live.receive(ok(2, { state: engineState(1) }));
    expect(client.snapshot().status.kind).toBe('connected');
  });

  it('refuses new requests beyond the pending limit instead of queueing them', async () => {
    const { client, live } = await connected();
    const pending = Array.from({ length: MAX_PENDING_REQUESTS }, () => client.request('apply'));
    expect(await client.request('apply')).toEqual({ ok: false, code: 'busy', error: 'Too many requests are waiting for the helper' });
    expect(live.written).toHaveLength(2 + MAX_PENDING_REQUESTS);
    live.receive(ok(2, { state: engineState(2) }));
    expect(await pending[0]).toMatchObject({ ok: true });
    void client.request('apply');
    expect(live.written).toHaveLength(3 + MAX_PENDING_REQUESTS);
  });

  it('refuses requests while the socket is not draining', async () => {
    const { client, live } = await connected();
    live.writableLength = MAX_BUFFERED_BYTES + 1;
    expect(await client.request('apply')).toEqual({ ok: false, code: 'busy', error: 'The helper is not reading requests' });
    expect(live.written).toHaveLength(2);
    live.writableLength = MAX_BUFFERED_BYTES;
    void client.request('apply');
    expect(live.written).toHaveLength(3);
    expect(MAX_BUFFERED_BYTES).toBe(2 * MAX_LINE_BYTES);
  });

  it('settles a request whose write throws', async () => {
    const { client, live, scheduler } = await connected();
    live.writeError = new Error('write after end');
    expect(await client.request('apply')).toEqual({ ok: false, code: 'disconnected', error: 'The connection to the helper is closed' });
    expect(scheduler.pending()).toEqual([]);
  });
});

describe('losing the connection', () => {
  it('settles every pending request, forgets the state and reconnects after two seconds', async () => {
    const h = await connected(engineState(40, 9), oneRuleConfig());
    const pending = [h.client.request('apply'), h.client.request('test', { target: '10.1.2.3' }), h.client.request('uninstall')];
    h.live.emit('close');
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 3 }, () => ({ ok: false, code: 'disconnected', error: 'The connection to the helper was lost' })),
    );
    expect(h.client.snapshot()).toEqual({
      status: { kind: 'disconnected', reason: 'connection-lost' },
      state: null,
      config: null,
      configRevision: null,
    });
    expect(h.live.destroyed).toBe(true);
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);

    h.scheduler.advance(RECONNECT_DELAY_MS - 1);
    expect(h.sockets).toHaveLength(1);
    h.scheduler.advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  it('handshakes again on the new connection, with ids from zero, and accepts a lower seq than before', async () => {
    const h = await connected(engineState(40, 9), oneRuleConfig());
    h.live.emit('error', socketError('ECONNRESET'));
    h.live.emit('close');
    h.scheduler.advance(RECONNECT_DELAY_MS);

    const next = h.socket();
    next.emit('connect');
    await flush();
    expect(next.requests()).toEqual([{ id: 0, method: 'status' }]);
    // A restarted helper: its counters start over.
    next.receive(ok(0, statusResult(engineState(1, 1))));
    await flush();
    expect(next.requests()).toEqual([
      { id: 0, method: 'status' },
      { id: 1, method: 'getConfig' },
    ]);
    next.receive(ok(1, { config: emptyConfig(), configRevision: 1 }));
    await flush();

    expect(h.client.snapshot()).toEqual({
      status: { kind: 'connected', helperVersion: '1.2.3' },
      state: engineState(1, 1),
      config: emptyConfig(),
      configRevision: 1,
    });
    expect(h.states).toEqual([engineState(40, 9), engineState(1, 1)]);
    expect(h.configs).toEqual([oneRuleConfig(), emptyConfig()]);
    expect(h.statuses.map((status) => status.kind)).toEqual(['connecting', 'connected', 'disconnected', 'connected']);
  });

  it('fetches the config again even when the restarted helper reports the revision it had before', async () => {
    const h = await connected(engineState(40, 9), oneRuleConfig());
    h.live.emit('close');
    h.scheduler.advance(RECONNECT_DELAY_MS);
    const next = await handshake(h, engineState(1, 9), emptyConfig());
    expect(next.requests().map((request) => request.method)).toEqual(['status', 'getConfig']);
    expect(h.client.snapshot().config).toEqual(emptyConfig());
  });

  it('ignores whatever the old socket does after it was replaced', async () => {
    const h = await connected();
    const old = h.live;
    old.emit('close');
    h.scheduler.advance(RECONNECT_DELAY_MS);
    await handshake(h, engineState(1, 1));
    old.receive({ event: 'state', state: engineState(99, 1) });
    old.emit('error', socketError('EPIPE'));
    old.emit('close');
    old.emit('connect');
    await flush();
    expect(h.client.snapshot().state).toEqual(engineState(1, 1));
    expect(h.client.snapshot().status.kind).toBe('connected');
    expect(h.sockets).toHaveLength(2);
  });
});

describe('untrusted input', () => {
  const garbage: [string, (socket: FakeSocket) => void][] = [
    ['invalid JSON', (socket) => { socket.emit('data', '{not json}\n'); }],
    ['bytes that are not UTF-8', (socket) => { socket.emit('data', new Uint8Array([0xff, 0xfe, 0x0a])); }],
    ['a JSON array', (socket) => { socket.emit('data', '[1,2,3]\n'); }],
    ['a JSON string', (socket) => { socket.emit('data', '"hello"\n'); }],
    ['null', (socket) => { socket.emit('data', 'null\n'); }],
    ['an object that is neither response nor event', (socket) => { socket.receive({ hello: 'world' }); }],
    ['an unknown event', (socket) => { socket.receive({ event: 'exec', command: 'rm -rf /' }); }],
    ['a state event with a malformed state', (socket) => { socket.receive({ event: 'state', state: { seq: 'x' } }); }],
    ['a log event with an unknown level', (socket) => { socket.receive({ event: 'log', level: 'fatal', msg: 'x', at: '2026-01-02T03:04:05.000Z' }); }],
    ['a response with a negative id', (socket) => { socket.receive({ id: -1, ok: true, result: {} }); }],
    ['a response whose result is not an object', (socket) => { socket.receive({ id: 2, ok: true, result: 'x' }); }],
    ['a deeply nested value', (socket) => { socket.emit('data', `${'['.repeat(5000)}${']'.repeat(5000)}\n`); }],
    ['a prototype-pollution attempt', (socket) => { socket.emit('data', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}\n'); }],
  ];

  it.each(garbage)('drops %s, logs it without echoing it, and stays connected', async (_name, send) => {
    const h = await connected();
    send(h.live);
    await flush();
    expect(h.client.snapshot().status.kind).toBe('connected');
    expect(h.client.snapshot().state).toEqual(engineState(1));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const lines = h.warnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'Dropped a line from the helper that is not a valid message' });
    expect(JSON.stringify(lines)).not.toMatch(/rm -rf|hello|polluted/);
    // Still working.
    const apply = h.client.request('apply');
    h.live.receive(ok(h.live.lastRequest().id, { state: engineState(2) }));
    expect(await apply).toMatchObject({ ok: true });
  });

  it('handles a structurally hostile line just under the size limit quickly and without parsing it as a message', async () => {
    const h = await connected();
    const hostile = `{"id":2,"ok":true,"result":{"rules":[${'{},'.repeat(1_300_000)}{}]}}\n`;
    expect(hostile.length).toBeGreaterThan(3.5 * 1024 * 1024);
    expect(hostile.length).toBeLessThan(MAX_LINE_BYTES);
    const pending = h.client.request('apply');
    const started = performance.now();
    h.live.emit('data', hostile);
    expect(await pending).toMatchObject({ ok: false, code: 'invalid-response' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('drops a message that is valid by its schema but breaks the structural limits', async () => {
    // Unknown keys are ignored by the schemas, so only the structural guard of
    // `parseServerMessage` stands between these lines and the subscribers.
    const h = await connected();
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 40; depth += 1) nested = { nested };
    h.live.receive({ event: 'log', level: 'info', msg: 'fine', at: '2026-01-02T03:04:05.000Z', extra: 'x'.repeat(5000) });
    h.live.receive({ event: 'state', state: engineState(2), extra: nested });
    h.live.receive({ event: 'state', state: engineState(3), extra: Array.from({ length: 501 }, () => 0) });
    expect(h.logs).toEqual([]);
    expect(h.states).toEqual([engineState(1)]);
    expect(h.warnings()).toHaveLength(3);
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('answers the pending request when a malformed line carries its id', async () => {
    const h = await connected();
    const pending = h.client.request('apply');
    h.live.receive({ id: 2, ok: 'yes', result: {} });
    expect(await pending).toMatchObject({ ok: false, code: 'invalid-response' });
  });

  it('drops the connection at once on an oversized line', async () => {
    const h = await connected();
    const pending = h.client.request('apply');
    h.live.emit('data', 'x'.repeat(MAX_LINE_BYTES + 1));
    expect(await pending).toMatchObject({ ok: false, code: 'disconnected' });
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'protocol-error' });
    expect(h.live.destroyed).toBe(true);
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
  });

  it('drops the connection after too many invalid lines in a row — but a valid one in between resets the count', async () => {
    const h = await connected();
    for (let i = 0; i < MAX_CONSECUTIVE_INVALID_LINES - 1; i += 1) h.live.emit('data', 'garbage\n');
    h.live.receive({ event: 'state', state: engineState(2) });
    for (let i = 0; i < MAX_CONSECUTIVE_INVALID_LINES - 1; i += 1) h.live.emit('data', 'garbage\n');
    expect(h.client.snapshot().status.kind).toBe('connected');

    h.live.emit('data', 'garbage\n');
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'protocol-error' });
    expect(h.live.destroyed).toBe(true);
  });

  it('stops reading a chunk once the connection was dropped', async () => {
    const h = await connected();
    h.live.emit('data', `${'garbage\n'.repeat(MAX_CONSECUTIVE_INVALID_LINES)}${JSON.stringify({ event: 'state', state: engineState(77) })}\n`);
    expect(h.client.snapshot().status.kind).toBe('disconnected');
    expect(h.states).toEqual([engineState(1)]);
  });

  it('keeps the log bounded under a flood of garbage across reconnects', async () => {
    const h = await connected();
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < MAX_CONSECUTIVE_INVALID_LINES; i += 1) h.socket().emit('data', 'garbage\n');
      h.scheduler.advance(30_000);
      h.socket().emit('connect');
      await flush();
    }
    const dropped = h.entries.filter((entry) => entry.msg === 'Dropped a line from the helper that is not a valid message');
    expect(dropped.length).toBeLessThan(80); // 160 lines were sent
  });

  it('counts a peer that floods garbage during the handshake as a failed attempt and backs off', async () => {
    const h = setup();
    h.client.start();
    for (let attempt = 0; attempt < RECONNECT_STEADY_ATTEMPTS + 2; attempt += 1) {
      h.socket().emit('connect');
      for (let i = 0; i < MAX_CONSECUTIVE_INVALID_LINES; i += 1) h.socket().emit('data', '!\n');
      await flush();
      expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'protocol-error' });
      const [delay] = h.scheduler.pending();
      if (attempt === RECONNECT_STEADY_ATTEMPTS + 1) expect(delay).toBe(8000);
      h.scheduler.advance(delay ?? 0);
    }
  });
});

describe('state and config', () => {
  it('keeps the highest seq of the connection and drops lower or equal ones, from events and results alike', async () => {
    const h = await connected(engineState(5, 1));
    h.live.receive({ event: 'state', state: engineState(4, 1, { enabled: false }) });
    h.live.receive({ event: 'state', state: engineState(5, 1, { enabled: false }) });
    expect(h.states).toEqual([engineState(5, 1)]);

    h.live.receive({ event: 'state', state: engineState(8, 1) });
    expect(h.states).toEqual([engineState(5, 1), engineState(8, 1)]);

    // A result that is older than an event already seen: the caller still gets
    // it, the store does not go back.
    const apply = h.client.request('apply');
    h.live.receive(ok(2, { state: engineState(7, 1) }));
    expect(await apply).toEqual({ ok: true, value: { state: engineState(7, 1) } });
    expect(h.client.snapshot().state).toEqual(engineState(8, 1));

    // A result that is newer: taken, and published once.
    const again = h.client.request('apply');
    h.live.receive(ok(3, { state: engineState(9, 1) }));
    await again;
    h.live.receive({ event: 'state', state: engineState(9, 1) });
    expect(h.states.map((state) => state.seq)).toEqual([5, 8, 9]);
  });

  it('fetches the config once when the revision changes, however many states name it', async () => {
    const h = await connected(engineState(1, 1));
    for (let seq = 2; seq <= 30; seq += 1) h.live.receive({ event: 'state', state: engineState(seq, 2) });
    expect(h.live.requests().slice(2)).toEqual([{ id: 2, method: 'getConfig' }]);
    expect(h.client.snapshot()).toMatchObject({ config: emptyConfig(), configRevision: 1 });

    h.live.receive(ok(2, { config: oneRuleConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ config: oneRuleConfig(), configRevision: 2 });
    expect(h.configs).toEqual([emptyConfig(), oneRuleConfig()]);
    expect(h.live.requests()).toHaveLength(3);
  });

  it('fetches once more — and only once more — when the revision moved on during a fetch', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) });
    h.live.receive({ event: 'state', state: engineState(3, 3) });
    h.live.receive({ event: 'state', state: engineState(4, 4) });
    h.live.receive({ event: 'state', state: engineState(5, 5) });
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(2); // handshake + one

    // The helper read the config while the revision was still 2.
    h.live.receive(ok(2, { config: oneRuleConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot().configRevision).toBe(2);
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(3);

    h.live.receive(ok(3, { config: emptyConfig(), configRevision: 5 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ state: engineState(5, 5), config: emptyConfig(), configRevision: 5 });
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(3);
  });

  it('takes the config of a setConfig result together with its revision, without a second round trip', async () => {
    const h = await connected(engineState(1, 1));
    const setConfig = h.client.request('setConfig', { config: oneRuleConfig() });
    h.live.receive(ok(2, { config: oneRuleConfig(), state: engineState(2, 2) }));
    await setConfig;
    await flush();
    expect(h.client.snapshot()).toMatchObject({ state: engineState(2, 2), config: oneRuleConfig(), configRevision: 2 });
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(1);
  });

  it('notices a revision that moved on while the handshake was fetching the config', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, statusResult(engineState(1, 1))));
    await flush();
    socket.receive({ event: 'state', state: engineState(2, 2) });
    // Read before the change: revision 1.
    socket.receive(ok(1, { config: emptyConfig(), configRevision: 1 }));
    await flush();
    expect(h.states).toEqual([engineState(2, 2)]);
    expect(socket.lastRequest()).toEqual({ id: 2, method: 'getConfig' });
    socket.receive(ok(2, { config: oneRuleConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ config: oneRuleConfig(), configRevision: 2 });
  });

  it('takes the revision the helper read with the config: a config newer than the status state needs no second fetch', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, statusResult(engineState(1, 1))));
    await flush();
    socket.receive({ event: 'state', state: engineState(2, 2) });
    // Read after the change: the config of revision 2.
    socket.receive(ok(1, { config: oneRuleConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ status: { kind: 'connected' }, state: engineState(2, 2), config: oneRuleConfig(), configRevision: 2 });
    expect(socket.requests().filter((request) => request.method === 'getConfig')).toHaveLength(1);
  });

  it('does not apply a fetched config older than one a setConfig result already gave', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) }); // fetch #2 starts
    const setConfig = h.client.request('setConfig', { config: oneRuleConfig() });
    h.live.receive(ok(3, { config: oneRuleConfig(), state: engineState(3, 3) }));
    await setConfig;
    // The late answer to the fetch: revision 2, older than the 3 already held.
    h.live.receive(ok(2, { config: emptyConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ config: oneRuleConfig(), configRevision: 3 });
    expect(h.configs.at(-1)).toEqual(oneRuleConfig());
  });

  it('a config read ahead of the states is current: the states that catch up start no fetch (bounded fetches)', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) });
    expect(h.live.lastRequest()).toEqual({ id: 2, method: 'getConfig' });
    // Two more changes happened before the helper read the config.
    h.live.receive(ok(2, { config: oneRuleConfig(), configRevision: 4 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ config: oneRuleConfig(), configRevision: 4 });
    for (let seq = 3; seq <= 20; seq += 1) h.live.receive({ event: 'state', state: engineState(seq, seq <= 10 ? 3 : 4) });
    await flush();
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(2); // handshake + one
    // A revision past the one held fetches again, once.
    h.live.receive({ event: 'state', state: engineState(21, 5) });
    h.live.receive({ event: 'state', state: engineState(22, 5) });
    expect(h.live.requests().filter((request) => request.method === 'getConfig')).toHaveLength(3);
  });

  it('a handshake config read ahead of the first state starts no fetch either', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, statusResult(engineState(1, 1))));
    await flush();
    socket.receive(ok(1, { config: oneRuleConfig(), configRevision: 3 }));
    await flush();
    socket.receive({ event: 'state', state: engineState(2, 2) });
    socket.receive({ event: 'state', state: engineState(3, 3) });
    await flush();
    expect(h.client.snapshot()).toMatchObject({ status: { kind: 'connected' }, configRevision: 3 });
    expect(socket.requests().filter((request) => request.method === 'getConfig')).toHaveLength(1);
  });

  it('tries again after two seconds when fetching the changed config fails', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) });
    h.live.receive(refused(2, 'busy', 'internal'));
    await flush();
    expect(h.client.snapshot().configRevision).toBe(1);
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    h.scheduler.advance(RECONNECT_DELAY_MS);
    expect(h.live.lastRequest()).toEqual({ id: 3, method: 'getConfig' });
    h.live.receive(ok(3, { config: oneRuleConfig(), configRevision: 2 }));
    await flush();
    expect(h.client.snapshot().configRevision).toBe(2);
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('forwards log events in order', async () => {
    const h = await connected();
    const first = { event: 'log', level: 'info', msg: 'Reconcile finished', at: '2026-01-02T03:04:05.000Z' };
    const second = { event: 'log', level: 'error', msg: 'route add failed', at: '2026-01-02T03:04:06.000Z' };
    h.live.receive(first);
    h.live.receive(second);
    expect(h.logs).toEqual([first, second]);
  });

  it('isolates a subscriber that throws, on every channel', async () => {
    const h = setup();
    const boom = (): never => {
      throw new Error('subscriber bug');
    };
    h.client.onStatus(boom);
    h.client.onState(boom);
    h.client.onConfig(boom);
    h.client.onLog(boom);
    const late: EngineState[] = [];
    h.client.onState((state) => late.push(state));
    h.client.start();
    const live = await handshake(h);
    live.receive({ event: 'log', level: 'info', msg: 'x', at: '2026-01-02T03:04:05.000Z' });
    live.receive({ event: 'state', state: engineState(2) });
    expect(h.client.snapshot().status.kind).toBe('connected');
    expect(late.map((state) => state.seq)).toEqual([1, 2]);
    expect(h.states.map((state) => state.seq)).toEqual([1, 2]);
    expect(h.logs).toHaveLength(1);
    expect(h.entries.filter((entry) => entry.msg === 'A helper-client listener threw').length).toBeGreaterThan(0);
  });

  it('stops calling a listener once it unsubscribed', async () => {
    const h = setup();
    const seen: number[] = [];
    const unsubscribe = h.client.onState((state) => seen.push(state.seq));
    h.client.start();
    const live = await handshake(h);
    unsubscribe();
    unsubscribe();
    live.receive({ event: 'state', state: engineState(2) });
    expect(seen).toEqual([1]);
  });
});

describe('start and stop', () => {
  it('start is idempotent', () => {
    const h = setup();
    h.client.start();
    h.client.start();
    expect(h.sockets).toHaveLength(1);
  });

  it('stop settles pending requests, destroys the socket and leaves no timer behind', async () => {
    const h = await connected();
    h.live.receive({ event: 'state', state: engineState(2, 2) }); // a config fetch in flight
    const pending = [h.client.request('apply'), h.client.request('uninstall')];
    h.client.stop();
    expect(await Promise.all(pending)).toMatchObject([
      { ok: false, code: 'disconnected' },
      { ok: false, code: 'disconnected' },
    ]);
    await flush();
    expect(h.live.destroyed).toBe(true);
    expect(h.scheduler.pending()).toEqual([]);
    expect(h.client.snapshot()).toEqual({ status: { kind: 'stopped' }, state: null, config: null, configRevision: null });
    expect(await h.client.request('apply')).toMatchObject({ ok: false, code: 'not-connected' });

    h.client.stop();
    h.client.stop();
    expect(h.statuses.at(-1)).toEqual({ kind: 'stopped' });
    expect(h.statuses.filter((status) => status.kind === 'stopped')).toHaveLength(1);
  });

  it.each([
    ['while connecting', (h: Harness) => h],
    [
      'while waiting to reconnect',
      (h: Harness) => {
        h.socket().emit('error', socketError('ENOENT'));
        return h;
      },
    ],
    [
      'during the handshake',
      (h: Harness) => {
        h.socket().emit('connect');
        return h;
      },
    ],
  ])('stop cancels everything %s', async (_name, arrange) => {
    const h = arrange(startedSetup());
    await flush();
    h.client.stop();
    await flush();
    expect(h.scheduler.pending()).toEqual([]);
    h.scheduler.advance(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.client.snapshot().status).toEqual({ kind: 'stopped' });
  });

  it('ignores every socket event that arrives after stop', async () => {
    const h = await connected();
    h.client.stop();
    const before = h.entries.length;
    h.live.receive({ event: 'state', state: engineState(99) });
    h.live.receive(ok(5, { state: engineState(99) }));
    h.live.emit('error', socketError('EPIPE'));
    h.live.emit('close');
    h.live.emit('connect');
    await flush();
    h.scheduler.advance(120_000);
    expect(h.client.snapshot()).toEqual({ status: { kind: 'stopped' }, state: null, config: null, configRevision: null });
    expect(h.sockets).toHaveLength(1);
    expect(h.entries).toHaveLength(before);
    expect(h.states.map((state) => state.seq)).toEqual([1]);
  });

  it('can be started again after a stop', async () => {
    const h = await connected();
    h.client.stop();
    h.client.start();
    expect(h.sockets).toHaveLength(2);
    await handshake(h, engineState(1, 1));
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('does nothing before start: no socket, no timer, requests refused', async () => {
    const h = setup();
    h.client.stop();
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(0);
    expect(h.scheduler.pending()).toEqual([]);
    expect(await h.client.request('status')).toMatchObject({ ok: false, code: 'not-connected' });
    expect(h.client.snapshot().status).toEqual({ kind: 'stopped' });
  });
});

describe('timers and bookkeeping', () => {
  it('frees the slot of a timed-out request; its late answer is a stray and changes nothing', async () => {
    const h = await connected(engineState(1, 1));
    const requests = Array.from({ length: MAX_PENDING_REQUESTS }, () => h.client.request('apply'));
    expect(await h.client.request('apply')).toMatchObject({ ok: false, code: 'busy' });
    h.scheduler.advance(DEFAULT_TIMEOUTS.mutateMs);
    expect(await Promise.all(requests)).toEqual(
      Array.from({ length: MAX_PENDING_REQUESTS }, () => ({ ok: false, code: 'timeout', error: 'The helper did not answer in time' })),
    );
    // Every slot is free again.
    const next = h.client.request('apply');
    expect(h.live.lastRequest()).toEqual({ id: 2 + MAX_PENDING_REQUESTS, method: 'apply' });

    // The late answer to a timed-out request: ignored, its state not taken.
    h.live.receive(ok(2, { state: engineState(50, 1) }));
    await flush();
    expect(h.client.snapshot().state).toEqual(engineState(1, 1));
    expect(h.states).toEqual([engineState(1, 1)]);
    expect(h.entries.filter((entry) => entry.msg === 'Ignored a response that matches no pending request')).toHaveLength(1);

    h.live.receive(ok(2 + MAX_PENDING_REQUESTS, { state: engineState(2, 1) }));
    expect(await next).toMatchObject({ ok: true });
  });

  it('shows no state or config in the snapshot until the handshake is complete', async () => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, statusResult(engineState(7, 3))));
    await flush();
    socket.receive({ event: 'state', state: engineState(8, 3) });
    expect(h.client.snapshot()).toEqual({ status: { kind: 'connecting' }, state: null, config: null, configRevision: null });
    expect(h.states).toEqual([]);
    socket.receive(ok(1, { config: emptyConfig(), configRevision: 3 }));
    await flush();
    expect(h.client.snapshot()).toMatchObject({ status: { kind: 'connected' }, state: engineState(8, 3), config: emptyConfig() });
  });

  it.each([
    ['stop()', (h: Harness) => { h.client.stop(); }, { kind: 'stopped' }],
    ['a dropped connection', (h: Harness) => { h.socket().emit('close'); }, { kind: 'disconnected', reason: 'connection-lost' }],
    [
      'stop() then start()',
      (h: Harness) => {
        h.client.stop();
        h.client.start();
      },
      { kind: 'connecting' },
    ],
  ] as const)('does not turn connected when the last handshake answer arrives in the same tick as %s', async (_name, end, status) => {
    const h = setup();
    h.client.start();
    const socket = h.socket();
    socket.emit('connect');
    await flush();
    socket.receive(ok(0, statusResult(engineState(7, 3))));
    await flush();
    socket.receive(ok(1, { config: oneRuleConfig(), configRevision: 3 })); // the answer is in …
    end(h); // … but the connection ends before the handshake reads it
    await flush();
    expect(h.client.snapshot()).toEqual({ status, state: null, config: null, configRevision: null });
    expect(h.statuses.some((seen) => seen.kind === 'connected')).toBe(false);
    expect(h.states).toEqual([]);
    expect(h.configs).toEqual([]);
    expect(socket.writesAfterDestroy).toBe(0);
  });

  it('ignores a late connect event on a connection it already dropped', async () => {
    const h = setup();
    h.client.start();
    const dropped = h.socket();
    h.scheduler.advance(DEFAULT_TIMEOUTS.connectMs); // gave up on it
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    dropped.emit('connect');
    await flush();
    expect(dropped.written).toEqual([]);
    expect(dropped.writesAfterDestroy).toBe(0);
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    expect(h.client.snapshot().status).toEqual({ kind: 'disconnected', reason: 'timeout' });
  });

  it('resets the backoff once a handshake succeeds', async () => {
    const h = setup();
    h.client.start();
    for (let attempt = 0; attempt < RECONNECT_STEADY_ATTEMPTS + 3; attempt += 1) {
      h.socket().emit('error', socketError('ECONNREFUSED'));
      h.scheduler.advance(h.scheduler.pending()[0] ?? 0);
    }
    expect(reconnectDelay(RECONNECT_STEADY_ATTEMPTS + 3)).toBe(16_000);
    const live = await handshake(h);
    live.emit('close');
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    // And failures after that start from the beginning again.
    h.scheduler.advance(RECONNECT_DELAY_MS);
    h.socket().emit('error', socketError('ECONNREFUSED'));
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
  });

  it('clears the config-retry timer when the connection drops', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) });
    h.live.receive(refused(2, 'no', 'internal'));
    await flush();
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]); // the retry
    h.live.emit('close');
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]); // only the reconnect now
    h.scheduler.advance(RECONNECT_DELAY_MS);
    expect(h.sockets).toHaveLength(2);
    expect(h.live.written).toHaveLength(3);
    expect(h.live.writesAfterDestroy).toBe(0);
    expect(h.scheduler.pending()).toEqual([DEFAULT_TIMEOUTS.connectMs]);
  });

  it('never holds more than one config-retry timer, and none after stop', async () => {
    const h = await connected(engineState(1, 1));
    h.live.receive({ event: 'state', state: engineState(2, 2) });
    h.live.receive(refused(2, 'no', 'internal'));
    await flush();
    h.live.receive({ event: 'state', state: engineState(3, 3) });
    h.live.receive(refused(3, 'no', 'internal'));
    await flush();
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    h.client.stop();
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('holds exactly one retry timer through many failed fetches, and retries once', async () => {
    const h = await connected(engineState(1, 1));
    for (let round = 0; round < 6; round += 1) {
      h.live.receive({ event: 'state', state: engineState(2 + round, 2 + round) });
      h.live.receive(refused(h.live.lastRequest().id, 'no', 'internal'));
      await flush();
      expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    }
    const before = h.live.written.length;
    h.scheduler.advance(RECONNECT_DELAY_MS);
    expect(h.live.written).toHaveLength(before + 1);
    expect(h.live.lastRequest().method).toBe('getConfig');
  });

  it('keeps status and config-fetch lines under a budget when a peer makes them flap', async () => {
    const h = setup();
    h.client.start();
    for (let round = 0; round < 40; round += 1) {
      const live = await handshake(h);
      for (let i = 0; i < MAX_CONSECUTIVE_INVALID_LINES; i += 1) live.emit('data', 'garbage\n');
      h.scheduler.advance(1); // well within one log interval in total
      h.client.reconnectNow();
    }
    const statusLines = h.entries.filter((entry) => entry.msg === 'Helper connection status changed');
    expect(statusLines.length).toBe(5);
    // `reconnectNow()` shows its attempt as `connecting` (TASK-300).
    expect(statusLines.map((entry) => entry['status'])).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
    expect(h.entries.filter((entry) => entry['kind'] === 'helper-status')).toHaveLength(1);
    expect(h.statuses.length).toBeGreaterThan(60); // subscribers still hear every change

    const quiet = await connected(engineState(1, 1));
    for (let round = 0; round < 40; round += 1) {
      quiet.live.receive({ event: 'state', state: engineState(2 + round, 2 + round) });
      quiet.live.receive(refused(quiet.live.lastRequest().id, 'no', 'internal'));
      await flush();
    }
    expect(quiet.entries.filter((entry) => entry.msg === 'Could not fetch the config after it changed')).toHaveLength(5);
  });
});

describe('subscribers that call back into the client', () => {
  type Channel = 'status' | 'state' | 'config' | 'log';
  interface Seen {
    readonly channel: Channel;
    readonly value: unknown;
    readonly sockets: number;
  }

  /** A harness whose subscribers record everything, plus one that acts — once — when `when` matches. */
  function reentrant(channel: Channel, when: (value: unknown, h: Harness) => boolean, act: (h: Harness) => void) {
    const h = setup();
    const seen: Seen[] = [];
    let acted = -1;
    const record = (name: Channel) => (value: unknown) => {
      seen.push({ channel: name, value, sockets: h.sockets.length });
    };
    const trigger = (name: Channel) => (value: unknown) => {
      if (name !== channel || acted !== -1 || !when(value, h)) return;
      acted = seen.length;
      act(h);
    };
    // The acting subscriber sits between two recording ones on every channel.
    for (const name of ['status', 'state', 'config', 'log'] as const) {
      const subscribe = { status: h.client.onStatus, state: h.client.onState, config: h.client.onConfig, log: h.client.onLog }[name] as (
        listener: (value: unknown) => void,
      ) => () => void;
      subscribe(record(name));
      subscribe(trigger(name));
      subscribe(record(name));
    }
    const outstanding: { settled: number }[] = [];
    const track = (promise: Promise<unknown>): void => {
      const entry = { settled: 0 };
      outstanding.push(entry);
      void promise.then(() => {
        entry.settled += 1;
      });
    };
    return { h, seen, track, outstanding, after: () => (acted === -1 ? null : seen.slice(acted)) };
  }

  type Scenario = [name: string, channel: Channel, when: (value: unknown, h: Harness) => boolean, drive: (r: ReturnType<typeof reentrant>) => Promise<void>];
  const statusIs = (kind: string) => (value: unknown) => (value as HelperStatus).kind === kind;
  const seqIs = (seq: number) => (value: unknown) => (value as EngineState).seq === seq;
  const always = (): boolean => true;

  const scenarios: Scenario[] = [
    ['onStatus(connecting), at start', 'status', statusIs('connecting'), ({ h }) => {
      h.client.start();
      return Promise.resolve();
    }],
    ['onStatus(connected), at the end of the handshake', 'status', statusIs('connected'), async ({ h }) => {
      h.client.start();
      await handshake(h);
    }],
    ['onStatus(not-installed)', 'status', statusIs('not-installed'), ({ h }) => {
      h.client.start();
      h.socket().emit('error', socketError('ENOENT'));
      return Promise.resolve();
    }],
    ['onStatus(not-installed), when connect() itself throws', 'status', statusIs('not-installed'), ({ h }) => {
      h.connectFailures.push(socketError('ENOENT'));
      h.client.start();
      return Promise.resolve();
    }],
    ['onStatus(disconnected), on losing a connection with requests pending', 'status', statusIs('disconnected'), async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('apply'));
      track(h.client.request('uninstall'));
      live.emit('close');
    }],
    ['onStatus(disconnected), on a garbage flood', 'status', statusIs('disconnected'), async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('apply'));
      live.emit('data', `${'garbage\n'.repeat(MAX_CONSECUTIVE_INVALID_LINES)}${JSON.stringify({ event: 'state', state: engineState(60) })}\n`);
    }],
    ['onStatus(incompatible)', 'status', statusIs('incompatible'), async ({ h }) => {
      h.client.start();
      h.socket().emit('connect');
      await flush();
      h.socket().receive(ok(0, { protocolVersion: PROTOCOL_VERSION + 1, helperVersion: '9.0.0' }));
      await flush();
    }],
    ['onState, the first state at the end of the handshake', 'state', always, async ({ h }) => {
      h.client.start();
      await handshake(h, engineState(1, 1), oneRuleConfig());
    }],
    ['onState, on a state event (with more lines in the same chunk)', 'state', seqIs(2), async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('apply'));
      live.emit(
        'data',
        [{ event: 'state', state: engineState(2, 2) }, { event: 'log', level: 'info', msg: 'x', at: '2026-01-02T03:04:05.000Z' }, { event: 'state', state: engineState(3, 2) }]
          .map((message) => `${JSON.stringify(message)}\n`)
          .join(''),
      );
    }],
    ['onState, on the state inside a response', 'state', seqIs(2), async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('apply'));
      track(h.client.request('setEnabled', { enabled: false }));
      live.receive(ok(2, { state: engineState(2, 2) }));
    }],
    ['onConfig, the first config at the end of the handshake', 'config', always, async ({ h }) => {
      h.client.start();
      await handshake(h, engineState(1, 1), oneRuleConfig());
    }],
    ['onConfig, on a setConfig response', 'config', (_value, h) => h.states.length > 0 && h.configs.length === 2, async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('setConfig', { config: oneRuleConfig() }));
      track(h.client.request('apply'));
      live.receive(ok(2, { config: oneRuleConfig(), state: engineState(2, 2) }));
    }],
    ['onConfig, on a re-fetched config', 'config', (_value, h) => h.configs.length === 2, async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      live.receive({ event: 'state', state: engineState(2, 2) });
      live.receive({ event: 'state', state: engineState(3, 3) });
      track(h.client.request('apply'));
      live.receive(ok(2, { config: oneRuleConfig(), configRevision: 3 }));
      await flush();
    }],
    ['onLog, on a log event (with a state after it in the same chunk)', 'log', always, async ({ h, track }) => {
      h.client.start();
      const live = await handshake(h);
      track(h.client.request('test', { target: '10.1.2.3' }));
      live.emit(
        'data',
        [{ event: 'log', level: 'warn', msg: 'x', at: '2026-01-02T03:04:05.000Z' }, { event: 'state', state: engineState(2, 2) }]
          .map((message) => `${JSON.stringify(message)}\n`)
          .join(''),
      );
    }],
  ];

  /** Whatever the old sockets do from here on must reach nobody. */
  const pokeOldSockets = async (h: Harness, upTo: number): Promise<void> => {
    for (const old of h.sockets.slice(0, upTo)) {
      old.receive({ event: 'state', state: engineState(900, 9) });
      old.receive({ event: 'log', level: 'error', msg: 'late', at: '2026-01-02T03:04:05.000Z' });
      old.receive(ok(2, { state: engineState(901, 9), config: emptyConfig() }));
      old.receive(ok(3, { config: oneRuleConfig(), configRevision: 9 }));
      old.emit('connect');
      old.emit('error', socketError('EPIPE'));
      old.emit('close');
    }
    await flush();
  };

  it.each(scenarios)('stop() from %s ends everything at once', async (_name, channel, when, drive) => {
    const r = reentrant(channel, when, (h) => {
      h.client.stop();
    });
    await drive(r);
    await flush();
    const { h } = r;
    // Checked before the clock moves: a timer that would fire as a no-op is still a timer.
    expect(h.scheduler.pending()).toEqual([]);
    await pokeOldSockets(h, h.sockets.length);
    expect(h.scheduler.pending()).toEqual([]);
    h.scheduler.advance(120_000);
    await flush();

    const after = r.after();
    expect(after).not.toBeNull();
    // After stop() only the `stopped` status is announced — to both recording subscribers — and nothing else, ever.
    expect(after).toEqual([
      { channel: 'status', value: { kind: 'stopped' }, sockets: h.sockets.length },
      { channel: 'status', value: { kind: 'stopped' }, sockets: h.sockets.length },
    ]);
    expect(h.scheduler.pending()).toEqual([]);
    expect(h.sockets.map((socket) => socket.writesAfterDestroy)).toEqual(h.sockets.map(() => 0));
    expect(h.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(h.client.snapshot()).toEqual({ status: { kind: 'stopped' }, state: null, config: null, configRevision: null });
    expect(r.outstanding.map((entry) => entry.settled)).toEqual(r.outstanding.map(() => 1));
    expect(h.entries.filter((entry) => entry.msg === 'A helper-client listener threw')).toEqual([]);
  });

  it.each(scenarios)('stop() + start() from %s leaves nothing of the old connection in the new one', async (_name, channel, when, drive) => {
    let socketsAtRestart = -1;
    const r = reentrant(channel, when, (h) => {
      h.client.stop();
      socketsAtRestart = h.sockets.length;
      h.client.start();
    });
    await drive(r);
    await flush();
    const { h } = r;
    expect(socketsAtRestart).toBeGreaterThanOrEqual(0);
    await pokeOldSockets(h, socketsAtRestart);

    // Announced after the restart: `stopped`, then `connecting`, each to both recording subscribers; no state, config or log.
    expect(r.after()?.map((entry) => [entry.channel, (entry.value as HelperStatus).kind])).toEqual([
      ['status', 'stopped'],
      ['status', 'stopped'],
      ['status', 'connecting'],
      ['status', 'connecting'],
    ]);
    expect(h.sockets).toHaveLength(socketsAtRestart + 1);
    expect(h.scheduler.pending()).toEqual([DEFAULT_TIMEOUTS.connectMs]);
    expect(h.sockets.map((socket) => socket.writesAfterDestroy)).toEqual(h.sockets.map(() => 0));
    expect(h.sockets.slice(0, -1).every((socket) => socket.destroyed)).toBe(true);
    expect(h.socket().written).toEqual([]);
    expect(h.client.snapshot()).toEqual({ status: { kind: 'connecting' }, state: null, config: null, configRevision: null });
    expect(r.outstanding.map((entry) => entry.settled)).toEqual(r.outstanding.map(() => 1));

    // The new connection works, and only its own values are published.
    const before = r.seen.length;
    const live = await handshake(h, engineState(1, 1), emptyConfig());
    expect(live.requests()).toEqual([
      { id: 0, method: 'status' },
      { id: 1, method: 'getConfig' },
    ]);
    expect(h.client.snapshot()).toEqual({
      status: { kind: 'connected', helperVersion: '1.2.3' },
      state: engineState(1, 1),
      config: emptyConfig(),
      configRevision: 1,
    });
    expect(r.seen.slice(before).map((entry) => [entry.channel, entry.channel === 'state' ? (entry.value as EngineState).seq : null])).toEqual([
      ['status', null],
      ['status', null],
      ['state', 1],
      ['state', 1],
      ['config', null],
      ['config', null],
    ]);
    await pokeOldSockets(h, socketsAtRestart);
    expect(r.seen).toHaveLength(before + 6);
    h.client.stop();
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('keeps the answer of the request whose result made a subscriber stop the client', async () => {
    const h = await connected();
    let stopped = false;
    h.client.onConfig(() => {
      if (h.configs.length < 2 || stopped) return;
      stopped = true;
      h.client.stop();
    });
    const setConfig = h.client.request('setConfig', { config: oneRuleConfig() });
    const other = h.client.request('apply');
    h.live.receive(ok(2, { config: oneRuleConfig(), state: engineState(2, 2) }));
    expect(await setConfig).toEqual({ ok: true, value: { config: oneRuleConfig(), state: engineState(2, 2) } });
    expect(await other).toMatchObject({ ok: false, code: 'disconnected' });
    expect(h.states).toEqual([engineState(1)]); // the state of that result was never announced
    expect(h.live.writesAfterDestroy).toBe(0);
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('arms one reconnect timer when a restart from a subscriber fails at once', () => {
    const h = setup();
    let restarted = false;
    h.client.onStatus((status) => {
      if (status.kind !== 'not-installed' || restarted) return;
      restarted = true;
      h.client.stop();
      h.connectFailures.push(socketError('ENOENT'));
      h.client.start(); // fails synchronously and schedules its own retry
    });
    h.connectFailures.push(socketError('ENOENT'));
    h.client.start();
    expect(h.scheduler.pending()).toEqual([RECONNECT_DELAY_MS]);
    expect(h.client.snapshot().status).toEqual({ kind: 'not-installed' });
    h.client.stop();
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('start() inside the `stopped` announcement restarts cleanly', async () => {
    const h = await connected();
    let restarted = false;
    h.client.onStatus((status) => {
      if (status.kind !== 'stopped' || restarted) return;
      restarted = true;
      h.client.start();
      h.client.start();
    });
    h.client.stop();
    expect(h.sockets).toHaveLength(2);
    expect(h.statuses.map((status) => status.kind)).toEqual(['connecting', 'connected', 'stopped', 'connecting']);
    expect(h.scheduler.pending()).toEqual([DEFAULT_TIMEOUTS.connectMs]);
    await handshake(h);
    expect(h.client.snapshot().status.kind).toBe('connected');
  });

  it('reconnectNow() from a `disconnected` subscriber opens one socket and arms no second timer', async () => {
    const h = await connected();
    h.client.onStatus((status) => {
      if (status.kind === 'disconnected') {
        h.client.reconnectNow();
        h.client.reconnectNow();
      }
    });
    const late: HelperStatus[] = [];
    h.client.onStatus((status) => late.push(status));
    h.live.emit('close');
    expect(h.sockets).toHaveLength(2);
    expect(h.scheduler.pending()).toEqual([DEFAULT_TIMEOUTS.connectMs]);
    // The reconnect made the status `connecting` (TASK-300) before the later
    // subscriber's turn: it hears that, the current status, not the stale one.
    expect(late).toEqual([{ kind: 'connecting' }]);
    expect(h.client.snapshot().status).toEqual({ kind: 'connecting' });
  });

  it('request() from a subscriber is sent after the current line, in order, and answered', async () => {
    const h = await connected();
    const results: unknown[] = [];
    let asked = false;
    h.client.onState(() => {
      if (asked) return;
      asked = true;
      void h.client.request('test', { target: '10.1.2.3' }).then((result) => results.push(result));
      void h.client.request('apply').then((result) => results.push(result));
    });
    h.live.receive({ event: 'state', state: engineState(2, 1) });
    expect(h.live.requests().slice(2)).toEqual([
      { id: 2, method: 'test', target: '10.1.2.3' },
      { id: 3, method: 'apply' },
    ]);
    h.live.receive(refused(2, 'no route', 'operation-failed'));
    h.live.receive(ok(3, { state: engineState(3, 1) }));
    await flush();
    expect(results).toMatchObject([{ ok: false, code: 'operation-failed' }, { ok: true }]);
    expect(h.states.map((state) => state.seq)).toEqual([1, 2, 3]);
  });

  it('a request made from the `connected` subscriber goes out before any other, on the ready connection', async () => {
    const h = setup();
    h.client.onStatus((status) => {
      if (status.kind === 'connected') void h.client.request('apply');
    });
    h.client.start();
    const live = await handshake(h);
    expect(live.requests().map((request) => `${String(request.id)}:${request.method}`)).toEqual(['0:status', '1:getConfig', '2:apply']);
  });

  it('unsubscribing during a dispatch: the one removed is not called, the rest are called exactly once', async () => {
    const h = setup();
    const calls: string[] = [];
    const unsubscribe: Record<string, () => void> = {};
    unsubscribe['a'] = h.client.onState(() => {
      calls.push('a');
      unsubscribe['a']?.(); // itself
      unsubscribe['c']?.(); // one that has not run yet
    });
    unsubscribe['b'] = h.client.onState(() => calls.push('b'));
    unsubscribe['c'] = h.client.onState(() => calls.push('c'));
    unsubscribe['d'] = h.client.onState(() => {
      calls.push('d');
      unsubscribe['b']?.(); // one that already ran
      h.client.onState(() => calls.push('added')); // joins from the next value on
    });
    h.client.start();
    const live = await handshake(h);
    expect(calls).toEqual(['a', 'b', 'd']);
    live.receive({ event: 'state', state: engineState(2) });
    expect(calls).toEqual(['a', 'b', 'd', 'd', 'added']);
  });

  it('subscribing the same function twice gives two independent subscriptions', async () => {
    const h = setup();
    let count = 0;
    const listener = (): void => {
      count += 1;
    };
    const first = h.client.onState(listener);
    h.client.onState(listener);
    h.client.start();
    const live = await handshake(h);
    expect(count).toBe(2);
    first();
    first();
    live.receive({ event: 'state', state: engineState(2) });
    expect(count).toBe(3);
  });
});

function startedSetup(): Harness {
  const h = setup();
  h.client.start();
  return h;
}
