import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config, EngineState, MAX_LINE_BYTES, PROTOCOL_LIMITS, type LogEvent, type Request } from '@routeswitch/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeScheduler, flush } from './dns-test-utils';
import type { AppliedRoute, ReconcileOutcome } from './engine';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import type { RouteGetResult } from './route';
import { DIAGNOSE_LIMITS } from './diagnose';
import type { CachedDomain, ProbeResult } from './dns';
import {
  MAX_CONCURRENT_TESTS,
  PEER_LOG_BUDGET,
  PEER_LOG_WINDOW_MS,
  SOCKET_MODE,
  createLogForwarder,
  createRequestHandler,
  createSocketServer,
  type HandlerOutcome,
  type RequestDispatcher,
  type RequestOrigin,
  type RequestHandlerDeps,
  type ServerLimits,
  type SocketFs,
} from './server';
import { connectTestClient, type TestClient } from './socket-test-client';
import { assertFsGuardInstalled } from './test-fs-guard-check';

// Touches the file system (socket files in a temporary directory): refuse to run without the guard.
assertFsGuardInstalled();

const NOW = new Date('2026-10-12T08:30:00.000Z');
const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-srv-'));
  dirs.push(dir);
  return dir;
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const okDispatch: RequestDispatcher = (request) =>
  Promise.resolve({ response: { id: request.id, ok: true, result: { echo: request.method } } });

const startServer = async (
  options: { dispatch?: RequestDispatcher; limits?: Partial<ServerLimits>; fs?: SocketFs; owner?: { uid: number; gid: number } | null } = {},
) => {
  const dir = newDir();
  const path = join(dir, 's.sock');
  const scheduler = createFakeScheduler(NOW);
  const memory = createMemorySink();
  const logger = createLogger({ sinks: [memory.sink] });
  const server = createSocketServer({
    path,
    logger,
    dispatch: options.dispatch ?? okDispatch,
    owner: options.owner ?? null,
    limits: options.limits,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    fs: options.fs,
  });
  const started = await server.start();
  expect(started).toEqual({ ok: true });
  cleanups.push(() => server.close());
  const clients: TestClient[] = [];
  const connect = async (): Promise<TestClient> => {
    const client = await connectTestClient(path);
    clients.push(client);
    cleanups.push(() => {
      client.close();
    });
    return client;
  };
  return { dir, path, server, scheduler, memory, connect, clients };
};

describe('socket server: transport', () => {
  it('tells the handler which connection a request came from', async () => {
    const origins: (number | undefined)[] = [];
    const dispatch: RequestDispatcher = (request, origin) => {
      origins.push(origin?.connection);
      return okDispatch(request);
    };
    const { connect } = await startServer({ dispatch });
    const first = await connect();
    const second = await connect();
    await first.request({ id: 1, method: 'status' });
    await second.request({ id: 1, method: 'status' });
    await first.request({ id: 2, method: 'status' });
    expect(origins).toHaveLength(3);
    expect(origins[0]).toBe(origins[2]);
    expect(origins[0]).not.toBe(origins[1]);
    expect(origins.every((connection) => typeof connection === 'number')).toBe(true);
  });

  it('creates the socket with mode 0660 under a name of its own, then renames it into place', async () => {
    const calls: string[] = [];
    const fs: SocketFs = {
      lstat: (path) => nodeFs.lstat(path),
      unlink: (path) => nodeFs.unlink(path),
      rename: (from, to) => {
        calls.push(`rename ${from.endsWith('.tmp') ? 'tmp' : from} -> ${to.endsWith('s.sock') ? 'sock' : to}`);
        return nodeFs.rename(from, to);
      },
      chmod: (path, mode) => {
        calls.push(`chmod ${path.endsWith('.tmp') ? 'tmp' : path} ${mode.toString(8)}`);
        return nodeFs.chmod(path, mode);
      },
      chown: (path, uid, gid) => {
        calls.push(`chown ${path.endsWith('.tmp') ? 'tmp' : path} ${String(uid)}:${String(gid)}`);
        // Not root in tests: the call is recorded, the owner stays.
        return Promise.resolve();
      },
    };
    const { path } = await startServer({ fs, owner: { uid: 0, gid: 20 } });
    expect(calls).toEqual(['chmod tmp 660', 'chown tmp 0:20', 'rename tmp -> sock']);
    expect(statSync(path).mode & 0o777).toBe(SOCKET_MODE);
    expect(statSync(path).isSocket()).toBe(true);
  });

  it('under umask 0: the socket is bound 0600 and a connection made before it is in place is never served', async () => {
    const dispatched: Request[] = [];
    const early: { client: TestClient | null; modeAtChmod: number | null } = { client: null, modeAtChmod: null };
    const fs: SocketFs = {
      lstat: (path) => nodeFs.lstat(path),
      unlink: (path) => nodeFs.unlink(path),
      rename: (from, to) => nodeFs.rename(from, to),
      chmod: async (path, mode) => {
        // The window before the mode is set: look at the file and connect to it.
        early.modeAtChmod = (await nodeFs.lstat(path)).mode & 0o777;
        early.client = await connectTestClient(path);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return nodeFs.chmod(path, mode);
      },
      chown: () => Promise.resolve(),
    };
    const previous = process.umask(0);
    let started: Awaited<ReturnType<typeof startServer>>;
    try {
      started = await startServer({
        fs,
        dispatch: (request) => {
          dispatched.push(request);
          return okDispatch(request);
        },
      });
    } finally {
      process.umask(previous);
    }
    expect(early.modeAtChmod).toBe(0o600);
    const { client } = early;
    if (client === null) throw new Error('no early client');
    cleanups.push(() => {
      client.close();
    });
    await client.closed;
    client.raw(`${JSON.stringify({ id: 1, method: 'status' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toEqual([]);
    expect(client.responses).toEqual([]);
    expect(started.memory.entries.some((entry) => entry.msg.startsWith('connection made before the socket was ready'))).toBe(true);
    // A connection after the setup is served.
    const later = await started.connect();
    expect(await later.request({ id: 2, method: 'status' })).toMatchObject({ ok: true });
  });

  it('starts the peer log budget again in a new window and says how many lines were left out', async () => {
    let now = 0;
    const dir = newDir();
    const scheduler = createFakeScheduler(NOW);
    const memory = createMemorySink();
    const server = createSocketServer({
      path: join(dir, 's.sock'),
      logger: createLogger({ sinks: [memory.sink] }),
      dispatch: okDispatch,
      owner: null,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      monotonicNow: () => now,
    });
    expect(await server.start()).toEqual({ ok: true });
    cleanups.push(() => server.close());
    const refused = (): number => memory.entries.filter((entry) => entry.msg.startsWith('request refused')).length;
    const client = await connectTestClient(join(dir, 's.sock'));
    cleanups.push(() => {
      client.close();
    });
    const badLines = async (count: number): Promise<void> => {
      const before = client.responses.length;
      for (let index = 0; index < count; index += 1) {
        client.raw('x\n');
        // A valid line in between keeps the connection open.
        client.raw(`${JSON.stringify({ id: index, method: 'status' })}\n`);
      }
      await client.waitFor(() => client.responses.length === before + 2 * count);
    };
    await badLines(25);
    expect(refused()).toBe(PEER_LOG_BUDGET);
    now += PEER_LOG_WINDOW_MS;
    await badLines(1);
    expect(refused()).toBe(PEER_LOG_BUDGET + 1);
    expect(memory.entries.find((entry) => entry.msg === 'client problems were left out of the log')?.context).toMatchObject({ skipped: 5 });
  });

  it('fails to start, without listening, when the owner cannot be set', async () => {
    const dir = newDir();
    const path = join(dir, 's.sock');
    const scheduler = createFakeScheduler(NOW);
    const server = createSocketServer({
      path,
      logger: createLogger({ sinks: [] }),
      dispatch: okDispatch,
      // Not root: chown to root fails with EPERM.
      owner: { uid: 0, gid: 20 },
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    const result = await server.start();
    expect(result).toMatchObject({ ok: false, reason: 'failed', detail: 'EPERM' });
    expect(existsSync(path)).toBe(false);
    await server.close();
  });

  it('answers each request with its id, to several clients in parallel', async () => {
    const { connect } = await startServer({
      dispatch: async (request) => {
        // The first answered last: responses are matched by id, not by order.
        await new Promise((resolve) => setTimeout(resolve, request.id === 1 ? 30 : 1));
        return { response: { id: request.id, ok: true, result: { echo: request.method } } };
      },
    });
    const [a, b] = [await connect(), await connect()];
    const answers = await Promise.all([
      a.request({ id: 1, method: 'status' }),
      a.request({ id: 2, method: 'getConfig' }),
      b.request({ id: 1, method: 'apply' }),
    ]);
    expect(answers).toEqual([
      { id: 1, ok: true, result: { echo: 'status' } },
      { id: 2, ok: true, result: { echo: 'getConfig' } },
      { id: 1, ok: true, result: { echo: 'apply' } },
    ]);
    expect(a.responses.map((response) => response.id)).toEqual([2, 1]);
  });

  it('refuses bad lines with an error, logs them and keeps serving', async () => {
    const seen: Request[] = [];
    const { connect, memory } = await startServer({
      // Eight bad lines in a row would close the connection (next test); here the server must keep serving.
      limits: { maxConsecutiveInvalidLines: 20 },
      dispatch: (request) => {
        seen.push(request);
        return okDispatch(request);
      },
    });
    const client = await connect();
    client.raw('{not json\n');
    client.raw('[1,2]\n');
    client.raw(`${JSON.stringify({ id: 3, method: 'runCommand', cmd: 'rm -rf /' })}\n`);
    client.raw(`${JSON.stringify({ id: 4, method: 'status', extra: 1 })}\n`);
    for (const [id, target] of [
      [5, '10.0.0.0/33'],
      [6, '0.0.0.0/0'],
    ] as const) {
      client.raw(`${JSON.stringify({ id, method: 'setConfig', config: { version: 1, rules: [{ id: ID_A, kind: 'subnet', target, iface: 'ethernet' }] } })}\n`);
    }
    client.raw(`${JSON.stringify({ id: 7, method: 'setConfig', config: { version: 1, rules: [{ id: ID_A, kind: 'domain', target: '../etc', iface: 'ethernet' }] } })}\n`);
    client.raw(`${JSON.stringify({ id: 8, method: 'test', target: '127.0.0.1' })}\n`);
    await client.waitFor(() => client.responses.length === 8);
    expect(client.responses.map((response) => [response.id, response.ok ? 'ok' : response.code])).toEqual([
      [null, 'invalid-json'],
      [null, 'invalid-request'],
      [3, 'unknown-method'],
      [4, 'invalid-request'],
      [5, 'invalid-config'],
      [6, 'invalid-config'],
      [7, 'invalid-config'],
      [8, 'invalid-request'],
    ]);
    expect(seen).toEqual([]);
    // The peer's text is never echoed.
    expect(JSON.stringify(client.responses)).not.toContain('rm -rf');
    expect(memory.entries.filter((entry) => entry.msg === 'request refused')).toHaveLength(8);
    expect(await client.request({ id: 9, method: 'status' })).toEqual({ id: 9, ok: true, result: { echo: 'status' } });
  });

  it('answers a line over the limit with line-too-long and keeps the connection', async () => {
    const { connect } = await startServer();
    const client = await connect();
    client.raw(`${'x'.repeat(MAX_LINE_BYTES + 10)}\n`);
    expect(await client.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
    expect(client.responses[0]).toMatchObject({ id: null, ok: false, code: 'line-too-long' });
  });

  it('closes a connection after too many invalid lines in a row; a valid line resets the count', async () => {
    const { connect } = await startServer({ limits: { maxConsecutiveInvalidLines: 3 } });
    const client = await connect();
    client.raw('x\nx\n');
    expect(await client.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
    client.raw('x\nx\n');
    await client.waitFor(() => client.responses.length === 5);
    expect(client.socket.destroyed).toBe(false);
    client.raw('x\n');
    await client.closed;
  });

  it('limits the connections; a closed client frees its slot', async () => {
    const { connect, server } = await startServer({ limits: { maxConnections: 2 } });
    const a = await connect();
    await a.request({ id: 1, method: 'status' });
    const b = await connect();
    await b.request({ id: 1, method: 'status' });
    const c = await connect();
    await c.closed;
    expect(server.connectionCount()).toBe(2);
    a.close();
    await a.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const d = await connect();
    expect(await d.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
  });

  it('limits the requests in flight per connection', async () => {
    const waiting: ((outcome: HandlerOutcome) => void)[] = [];
    const { connect } = await startServer({
      limits: { maxPendingPerConnection: 2 },
      dispatch: () =>
        new Promise((resolve) => {
          waiting.push(resolve);
        }),
    });
    const client = await connect();
    client.raw(`${JSON.stringify({ id: 1, method: 'status' })}\n${JSON.stringify({ id: 2, method: 'status' })}\n`);
    const third = await client.request({ id: 3, method: 'status' });
    expect(third).toMatchObject({ id: 3, ok: false, code: 'operation-failed' });
    expect(waiting).toHaveLength(2);
    waiting[0]?.({ response: { id: 1, ok: true, result: {} } });
    await client.waitFor(() => client.responses.some((response) => response.id === 1));
    expect(await new Promise((resolve) => {
      client.raw(`${JSON.stringify({ id: 4, method: 'status' })}\n`);
      setTimeout(() => {
        resolve(waiting.length);
      }, 30);
    })).toBe(3);
  });

  it('closes a connection that sends no request in time, and one that leaves a line unfinished', async () => {
    const { connect, scheduler } = await startServer({ limits: { handshakeTimeoutMs: 1000, partialLineTimeoutMs: 5000 } });
    const silent = await connect();
    const talker = await connect();
    await talker.request({ id: 1, method: 'status' });
    scheduler.advance(1000);
    await silent.closed;
    expect(talker.socket.destroyed).toBe(false);

    talker.raw('{"id":2,');
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.advance(4999);
    expect(talker.socket.destroyed).toBe(false);
    scheduler.advance(1);
    await talker.closed;
  });

  it('a finished line clears the timer of the unfinished one', async () => {
    const { connect, scheduler } = await startServer({ limits: { partialLineTimeoutMs: 5000 } });
    const client = await connect();
    client.raw('{"id":1,');
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.raw('"method":"status"}\n');
    await client.waitFor(() => client.responses.length === 1);
    scheduler.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.socket.destroyed).toBe(false);
  });

  it('sends events only to connections that made a valid request', async () => {
    const { connect, server } = await startServer();
    const listener = await connect();
    const silent = await connect();
    await listener.request({ id: 1, method: 'status' });
    server.broadcast({ event: 'log', level: 'info', msg: 'hello', at: NOW.toISOString() });
    await listener.waitFor(() => listener.events.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(silent.events).toEqual([]);
  });

  it('disconnects a client that does not read instead of queueing without bound', async () => {
    const { connect, server, memory } = await startServer({ limits: { maxBufferedWriteBytes: 64 * 1024 } });
    const client = await connect();
    await client.request({ id: 1, method: 'status' });
    client.socket.pause();
    const big = 'x'.repeat(PROTOCOL_LIMITS.logMessageMaxLength);
    for (let index = 0; index < 2000 && server.connectionCount() > 0; index += 1) {
      server.broadcast({ event: 'log', level: 'info', msg: big, at: NOW.toISOString() });
    }
    expect(server.connectionCount()).toBe(0);
    expect(memory.entries.some((entry) => entry.msg.startsWith('client does not read'))).toBe(true);
  });

  it('a client disconnecting does not affect the server or the other clients', async () => {
    const { connect } = await startServer({
      dispatch: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return okDispatch(request);
      },
    });
    const leaving = await connect();
    const staying = await connect();
    leaving.raw(`${JSON.stringify({ id: 1, method: 'status' })}\n`);
    leaving.close();
    expect(await staying.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
  });

  it('an exception in the handler is an internal error, not a crash', async () => {
    const { connect } = await startServer({ dispatch: () => Promise.reject(new Error('boom')) });
    const client = await connect();
    expect(await client.request({ id: 1, method: 'status' })).toEqual({ id: 1, ok: false, error: 'Internal error', code: 'internal' });
  });

  it('runs afterWrite once the response is written', async () => {
    const order: string[] = [];
    const { connect } = await startServer({
      dispatch: (request) =>
        Promise.resolve({
          response: { id: request.id, ok: true, result: {} },
          afterWrite: () => {
            order.push('after');
          },
        }),
    });
    const client = await connect();
    await client.request({ id: 1, method: 'uninstall' });
    order.push('received');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toContain('after');
  });

  it('close: stops listening, closes the connections, removes its own socket file only', async () => {
    const first = await startServer();
    const client = await first.connect();
    await client.request({ id: 1, method: 'status' });
    await first.server.close();
    await client.closed;
    expect(existsSync(first.path)).toBe(false);
    await first.server.close();

    const second = await startServer();
    // Someone replaced the file: it is not ours any more and stays.
    unlinkSync(second.path);
    writeFileSync(second.path, 'other');
    await second.server.close();
    expect(existsSync(second.path)).toBe(true);
  });

  it('never starts on top of a live socket or a path that is not a socket', async () => {
    const live = await startServer();
    const scheduler = createFakeScheduler(NOW);
    const make = (path: string) =>
      createSocketServer({ path, logger: createLogger({ sinks: [] }), dispatch: okDispatch, owner: null, setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });
    expect(await make(live.path).start()).toMatchObject({ ok: false, reason: 'in-use' });
    const other = join(newDir(), 'file');
    writeFileSync(other, 'x');
    expect(await make(other).start()).toMatchObject({ ok: false, reason: 'not-a-socket' });
    const client = await live.connect();
    expect(await client.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const CONFIG = Config.parse({
  version: 1,
  rules: [
    { id: ID_A, kind: 'subnet', target: '198.51.100.0/24', iface: 'ethernet' },
    { id: ID_B, kind: 'ip', target: '203.0.113.7', iface: 'wifi' },
  ],
});

const stateWith = (seq: number, configRevision: number, enabled = true): EngineState =>
  EngineState.parse({
    helperVersion: '0.0.0',
    seq,
    configRevision,
    enabled,
    interfaces: {
      ethernet: { device: 'en5', ip: '10.20.4.23', gateway: '10.20.4.1', up: true },
      wifi: { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', up: true },
    },
    adapters: [],
    rules: [],
    lastApplyAt: null,
    lastReconcileReason: null,
  });

const fakeEngine = () => {
  let config: Config = CONFIG;
  let revision = 0;
  let seq = 0;
  let applied: AppliedRoute[] = [{ dst: '198.51.100.0/24', gateway: '10.20.4.1', ruleIds: [ID_A] }];
  const passes: string[] = [];
  let hold: Promise<void> | null = null;
  const engine: RequestHandlerDeps['engine'] = {
    getState: () => stateWith(seq, revision, config.enabled),
    getConfig: () => config,
    getConfigRevision: () => revision,
    getApplied: () => applied,
    setConfig: (next) => {
      config = next;
      revision += 1;
      return true;
    },
    setEnabled: (enabled) => {
      config = { ...config, enabled };
      revision += 1;
      return true;
    },
    reconcile: async (reason): Promise<ReconcileOutcome> => {
      passes.push(reason);
      if (hold !== null) await hold;
      seq += 1;
      return { state: stateWith(seq, revision, config.enabled), retryRequested: false, summary: { added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 } };
    },
  };
  return {
    engine,
    passes,
    setApplied: (next: AppliedRoute[]) => {
      applied = next;
    },
    hold: (gate: Promise<void> | null) => {
      hold = gate;
    },
  };
};

const handlerHarness = (overrides: Partial<RequestHandlerDeps> = {}) => {
  const fake = fakeEngine();
  const scheduler = createFakeScheduler(NOW);
  const saved: Config[] = [];
  const events: string[] = [];
  const routeGet: RequestHandlerDeps['routeGet'] = () =>
    Promise.resolve({
      ok: true,
      outcome: 'found',
      route: { target: '198.51.100.9', destination: '198.51.100.0', mask: '255.255.255.0', gateway: '10.20.4.1', iface: 'en5', flags: ['UP'] },
    });
  const handler = createRequestHandler({
    engine: fake.engine,
    helperVersion: '0.0.0',
    logger: createLogger({ sinks: [] }),
    routeGet,
    saveConfig: (config) => {
      saved.push(config);
      return Promise.resolve({ ok: true });
    },
    started: Promise.resolve(),
    storedConfigProblem: null,
    disableAll: () => {
      events.push('disableAll');
      return Promise.resolve({ failed: 0, resolverFilesFailed: 0 });
    },
    uninstall: () => {
      events.push('uninstall');
      return Promise.resolve({ failed: 0, resolverFilesFailed: 0 });
    },
    afterUninstall: () => {
      events.push('afterUninstall');
    },
    peekDomain: () => null,
    probeDns: () => {
      events.push('probeDns');
      return Promise.resolve({ outcome: 'ok', ms: 1, addresses: [], truncated: false });
    },
    monotonicNow: () => scheduler.now().getTime(),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    ...overrides,
  });
  return { ...fake, handler, scheduler, saved, events };
};

const send = (dispatch: RequestDispatcher, request: Request, origin: RequestOrigin = { connection: 1 }) => dispatch(request, origin);

describe('request handler', () => {
  it('status: protocol and helper version with the current state', async () => {
    const h = handlerHarness();
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'status' });
    expect(response).toMatchObject({ id: 1, ok: true, result: { protocolVersion: 3, helperVersion: '0.0.0', state: { seq: 0 } } });
  });

  it('getConfig: the config together with its own revision', async () => {
    const h = handlerHarness();
    await send(h.handler.dispatch, { id: 1, method: 'setConfig', config: { ...CONFIG, rules: [] } });
    const { response } = await send(h.handler.dispatch, { id: 2, method: 'getConfig' });
    expect(response).toEqual({ id: 2, ok: true, result: { config: { ...CONFIG, rules: [] }, configRevision: 1 } });
  });

  it('setConfig: saves, then replaces the config, then answers with the state of the pass it caused', async () => {
    const h = handlerHarness();
    const next = { ...CONFIG, rules: CONFIG.rules.slice(0, 1) };
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'setConfig', config: next });
    expect(h.saved).toEqual([next]);
    expect(h.passes).toEqual(['config-change']);
    expect(response).toMatchObject({ ok: true, result: { config: next, state: { configRevision: 1, seq: 1 } } });
  });

  it('setConfig: a config that cannot be saved changes nothing', async () => {
    const h = handlerHarness({ saveConfig: () => Promise.resolve({ ok: false, code: 'EACCES' }) });
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'setConfig', config: { ...CONFIG, rules: [] } });
    expect(response).toMatchObject({ ok: false, code: 'operation-failed', error: 'The config could not be saved (EACCES)' });
    expect(h.engine.getConfig()).toEqual(CONFIG);
    expect(h.passes).toEqual([]);
  });

  it('serialises the changes: the second save starts after the first is in place', async () => {
    let releaseSave: () => void = () => undefined;
    const order: string[] = [];
    const h = handlerHarness({
      saveConfig: async (config) => {
        order.push(`save ${String(config.rules.length)}`);
        if (config.rules.length === 0) await new Promise<void>((resolve) => (releaseSave = resolve));
        order.push(`saved ${String(config.rules.length)}`);
        return { ok: true };
      },
    });
    const first = send(h.handler.dispatch, { id: 1, method: 'setConfig', config: { ...CONFIG, rules: [] } });
    const second = send(h.handler.dispatch, { id: 2, method: 'setConfig', config: CONFIG });
    const third = send(h.handler.dispatch, { id: 3, method: 'setEnabled', enabled: false });
    await flush();
    expect(order).toEqual(['save 0']);
    releaseSave();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['save 0', 'saved 0', 'save 2', 'saved 2', 'save 2', 'saved 2']);
    expect(h.passes).toEqual(['config-change', 'config-change', 'enabled-change']);
    expect(h.engine.getConfig()).toEqual({ ...CONFIG, enabled: false });
  });

  it('setEnabled(false): saves, cleans everything up without a detection, then reconciles', async () => {
    const h = handlerHarness();
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'setEnabled', enabled: false });
    expect(h.events).toEqual(['disableAll']);
    expect(h.saved).toEqual([{ ...CONFIG, enabled: false }]);
    expect(response).toMatchObject({ ok: true, result: { state: { enabled: false } } });
    // On again: no cleanup.
    await send(h.handler.dispatch, { id: 2, method: 'setEnabled', enabled: true });
    expect(h.events).toEqual(['disableAll']);
  });

  it('apply: a forced manual pass', async () => {
    const h = handlerHarness();
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'apply' });
    expect(h.passes).toEqual(['manual']);
    expect(response).toMatchObject({ ok: true, result: { state: { seq: 1 } } });
  });

  it('answers with the current state when the pass takes longer than a reply may wait', async () => {
    const h = handlerHarness({ limits: { mutationReplyMs: 1000 } });
    let release: () => void = () => undefined;
    h.hold(new Promise<void>((resolve) => (release = resolve)));
    const pending = send(h.handler.dispatch, { id: 1, method: 'apply' });
    await flush();
    h.scheduler.advance(1000);
    const { response } = await pending;
    expect(response).toMatchObject({ ok: true, result: { state: { seq: 0 } } });
    release();
  });

  it('changes wait for the startup; reads do not', async () => {
    let finishStartup: () => void = () => undefined;
    const h = handlerHarness({ started: new Promise<void>((resolve) => (finishStartup = resolve)) });
    const change = send(h.handler.dispatch, { id: 1, method: 'apply' });
    expect((await send(h.handler.dispatch, { id: 2, method: 'status' })).response.ok).toBe(true);
    await flush();
    expect(h.passes).toEqual([]);
    finishStartup();
    await change;
    expect(h.passes).toEqual(['manual']);
  });

  it.each<[string, Request, readonly string[]]>([
    ['setConfig', { id: 1, method: 'setConfig', config: { ...CONFIG, rules: [] } }, ['save', 'pass:config-change']],
    ['setEnabled(false)', { id: 1, method: 'setEnabled', enabled: false }, ['save', 'disableAll', 'pass:enabled-change']],
    ['uninstall', { id: 1, method: 'uninstall' }, ['uninstall']],
    ['apply', { id: 1, method: 'apply' }, ['pass:manual']],
  ])('%s does nothing before the startup is done, then does its work', async (_name, request, effects) => {
    let finishStartup: () => void = () => undefined;
    const h = handlerHarness({ started: new Promise<void>((resolve) => (finishStartup = resolve)) });
    const seen = (): string[] => [...h.saved.map(() => 'save'), ...h.events, ...h.passes.map((reason) => `pass:${reason}`)];
    const change = send(h.handler.dispatch, request);
    await flush();
    expect(seen()).toEqual([]);
    expect(h.engine.getConfigRevision()).toBe(0);
    finishStartup();
    const { response } = await change;
    expect(response.ok).toBe(true);
    expect(seen().sort()).toEqual([...effects].sort());
  });

  it('a stored config that could not be loaded: getConfig and setEnabled fail, setConfig repairs it', async () => {
    const h = handlerHarness({ storedConfigProblem: 'invalid-json' });
    expect((await send(h.handler.dispatch, { id: 1, method: 'getConfig' })).response).toMatchObject({ ok: false, code: 'operation-failed' });
    expect((await send(h.handler.dispatch, { id: 2, method: 'setEnabled', enabled: true })).response).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(h.saved).toEqual([]);
    // Even the same config as the one in memory is written, to replace the broken file.
    await send(h.handler.dispatch, { id: 3, method: 'setConfig', config: CONFIG });
    expect(h.saved).toEqual([CONFIG]);
    expect((await send(h.handler.dispatch, { id: 4, method: 'getConfig' })).response.ok).toBe(true);
  });

  it('uninstall: cleans up, answers, then closes; every later request is refused', async () => {
    const h = handlerHarness();
    const outcome = await send(h.handler.dispatch, { id: 1, method: 'uninstall' });
    expect(outcome.response).toEqual({ id: 1, ok: true, result: {} });
    expect(h.events).toEqual(['uninstall']);
    outcome.afterWrite?.();
    expect(h.events).toEqual(['uninstall', 'afterUninstall']);
    expect(h.handler.isUninstalled()).toBe(true);
    for (const request of [{ id: 2, method: 'status' }, { id: 3, method: 'uninstall' }, { id: 4, method: 'apply' }] as Request[]) {
      expect((await send(h.handler.dispatch, request)).response).toMatchObject({ ok: false, code: 'operation-failed' });
    }
  });

  it('uninstall: reports what the cleanup left behind', async () => {
    const h = handlerHarness({ uninstall: () => Promise.resolve({ failed: 2, resolverFilesFailed: 1 }) });
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'uninstall' });
    expect(response).toMatchObject({ ok: false, code: 'operation-failed', error: 'The cleanup left 2 route(s) and 1 resolver file(s) behind' });
  });

  it('test: the route the kernel picks, the role of its device and the rule that owns it', async () => {
    const h = handlerHarness();
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'test', target: '198.51.100.9' });
    expect(response).toEqual({
      id: 1,
      ok: true,
      result: { target: '198.51.100.9', destination: '198.51.100.0', gateway: '10.20.4.1', device: 'en5', role: 'ethernet', ruleId: ID_A },
    });
  });

  it('test: no rule when the route the kernel picks is not ours (other gateway)', async () => {
    const h = handlerHarness();
    h.setApplied([{ dst: '198.51.100.0/24', gateway: '10.20.4.99', ruleIds: [ID_A] }]);
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'test', target: '198.51.100.9' });
    expect(response).toMatchObject({ ok: true, result: { ruleId: null } });
  });

  it.each<[string, RouteGetResult, string]>([
    ['no route at all', { ok: false, outcome: 'not-found', target: '198.51.100.9' }, 'No route to the target'],
    [
      'a device name that does not fit the protocol',
      { ok: true, outcome: 'found', route: { target: '198.51.100.9', destination: 'default', mask: null, gateway: null, iface: 'en0; rm', flags: [] } },
      'The route lookup gave an answer that cannot be reported',
    ],
  ])('test: %s is operation-failed', async (_name, found, error) => {
    const h = handlerHarness({ routeGet: () => Promise.resolve(found) });
    const { response } = await send(h.handler.dispatch, { id: 1, method: 'test', target: '198.51.100.9' });
    expect(response).toEqual({ id: 1, ok: false, code: 'operation-failed', error });
  });

  it(`test: at most ${String(MAX_CONCURRENT_TESTS)} lookups at a time`, async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const h = handlerHarness({
      routeGet: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return { ok: false, outcome: 'not-found', target: '198.51.100.9' };
      },
    });
    const all = Array.from({ length: 10 }, (_, index) => send(h.handler.dispatch, { id: index, method: 'test', target: '198.51.100.9' }));
    for (let round = 0; round < 10; round += 1) {
      await flush();
      releases.shift()?.();
    }
    await Promise.all(all);
    expect(most).toBe(MAX_CONCURRENT_TESTS);
  });
});

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

const ROUTE_INFO = { target: '198.51.100.9', destination: '198.51.100.0', mask: '255.255.255.0', gateway: '10.20.4.1', iface: 'en5', flags: ['UP'] };
const ROUTE_FOUND: RouteGetResult = { ok: true, outcome: 'found', route: ROUTE_INFO };

/**
 * A `routeGet` whose answers are released by hand, counting the lookups running at once.
 * After `releaseAll` it answers at once.
 */
const heldRouteGet = () => {
  const releases: (() => void)[] = [];
  const counts = { calls: 0, running: 0, most: 0 };
  let open = false;
  const routeGet = async (): Promise<RouteGetResult> => {
    counts.calls += 1;
    counts.running += 1;
    counts.most = Math.max(counts.most, counts.running);
    if (!open) await new Promise<void>((resolve) => releases.push(resolve));
    counts.running -= 1;
    return ROUTE_FOUND;
  };
  const releaseAll = async (): Promise<void> => {
    open = true;
    for (let round = 0; round < 64 && (releases.length > 0 || counts.running > 0); round += 1) {
      for (const release of releases.splice(0)) release();
      await flush();
    }
  };
  return { routeGet, releases, counts, releaseAll };
};

const diagnoseRequest = (id: number, target = '198.51.100.9'): Request => ({ id, method: 'diagnose', target });

describe('request handler: diagnose', () => {
  it('explains an address: the matching rule, the route the kernel picks, nothing changed', async () => {
    const h = handlerHarness();
    const { response } = await send(h.handler.dispatch, diagnoseRequest(1));
    expect(response).toEqual({
      id: 1,
      ok: true,
      result: {
        target: '198.51.100.9',
        targetKind: 'ip',
        match: { ruleId: ID_A, via: 'subnet', precedence: 'only-match' },
        addresses: [
          {
            address: '198.51.100.9',
            source: 'query',
            route: { device: 'en5', gateway: '10.20.4.1', role: 'ethernet' },
            expectedRole: 'ethernet',
            matchesExpected: true,
          },
        ],
        dns: null,
        notes: [],
      },
    });
    expect(h.passes).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('never resolves a name no enabled domain rule covers: no query, no lookup', async () => {
    let lookups = 0;
    const h = handlerHarness({
      routeGet: () => {
        lookups += 1;
        return Promise.resolve(ROUTE_FOUND);
      },
    });
    const { response } = await send(h.handler.dispatch, diagnoseRequest(1, 'example.com'));
    expect(response).toMatchObject({ ok: true, result: { target: 'example.com', match: null, addresses: [], dns: null, notes: ['name-not-covered'] } });
    expect(lookups).toBe(0);
    expect(h.events).not.toContain('probeDns');
  });

  it('resolves a covered name with the one probe query when nothing is cached', async () => {
    const ID_D = '00000000-0000-4000-8000-00000000000d';
    const probes: string[] = [];
    const h = handlerHarness({
      probeDns: (server, name) => {
        probes.push(`${server} ${name}`);
        return Promise.resolve({ outcome: 'ok', ms: 7, addresses: ['198.51.100.20'], truncated: false });
      },
    });
    h.engine.setConfig(Config.parse({ version: 1, rules: [...CONFIG.rules, { id: ID_D, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' }] }));
    const { response } = await send(h.handler.dispatch, diagnoseRequest(1, 'corp.local'));
    expect(probes).toEqual(['10.20.0.10 corp.local']);
    expect(response).toMatchObject({
      ok: true,
      result: {
        match: { ruleId: ID_D, via: 'domain', precedence: 'only-match' },
        // The address is inside the ethernet subnet rule, which owns it while the domain has not routed it.
        addresses: [{ address: '198.51.100.20', source: 'query', expectedRole: 'ethernet', matchesExpected: true }],
        dns: { server: '10.20.0.10', role: 'ethernet', resolverFile: '/etc/resolver/corp.local', outcome: 'ok', ms: 7 },
      },
    });
  });

  it(`refuses a second diagnosis on the same connection while one runs (${String(DIAGNOSE_LIMITS.perConnectionParallel)} at a time)`, async () => {
    const held = heldRouteGet();
    const h = handlerHarness({ routeGet: held.routeGet });
    const first = send(h.handler.dispatch, diagnoseRequest(1), { connection: 1 });
    await flush();
    const second = await send(h.handler.dispatch, diagnoseRequest(2), { connection: 1 });
    expect(second.response).toEqual({ id: 2, ok: false, code: 'busy', error: 'A diagnosis is already running on this connection' });
    await held.releaseAll();
    expect((await first).response).toMatchObject({ ok: true });
    expect((await send(h.handler.dispatch, diagnoseRequest(3), { connection: 1 })).response).toMatchObject({ ok: true });
  });

  it(`runs at most ${String(DIAGNOSE_LIMITS.totalParallel)} diagnoses at once over all connections`, async () => {
    const held = heldRouteGet();
    const h = handlerHarness({ routeGet: held.routeGet });
    const running = [send(h.handler.dispatch, diagnoseRequest(1), { connection: 1 }), send(h.handler.dispatch, diagnoseRequest(2), { connection: 2 })];
    await flush();
    const third = await send(h.handler.dispatch, diagnoseRequest(3), { connection: 3 });
    expect(third.response).toEqual({ id: 3, ok: false, code: 'busy', error: 'Too many diagnoses are running; try again shortly' });
    await held.releaseAll();
    for (const outcome of await Promise.all(running)) expect(outcome.response).toMatchObject({ ok: true });
  });

  it(`allows ${String(DIAGNOSE_LIMITS.perConnectionPerWindow)} diagnoses per minute and connection`, async () => {
    const h = handlerHarness();
    for (let id = 1; id <= DIAGNOSE_LIMITS.perConnectionPerWindow; id += 1) {
      expect((await send(h.handler.dispatch, diagnoseRequest(id), { connection: 1 })).response).toMatchObject({ ok: true });
    }
    const refused = await send(h.handler.dispatch, diagnoseRequest(99), { connection: 1 });
    expect(refused.response).toEqual({ id: 99, ok: false, code: 'rate-limited', error: 'Too many diagnoses on this connection; try again in a minute' });
    // Another connection has its own budget.
    expect((await send(h.handler.dispatch, diagnoseRequest(100), { connection: 2 })).response).toMatchObject({ ok: true });
    h.scheduler.advance(DIAGNOSE_LIMITS.windowMs);
    expect((await send(h.handler.dispatch, diagnoseRequest(101), { connection: 1 })).response).toMatchObject({ ok: true });
  });

  it('a limit refusal is an expected answer: no warning in the log (TASK-DELTA-21)', async () => {
    const entries: LogEntry[] = [];
    const h = handlerHarness({ logger: createLogger({ sinks: [(entry) => entries.push(entry)] }) });
    for (let id = 1; id <= DIAGNOSE_LIMITS.perConnectionPerWindow + 1; id += 1) await send(h.handler.dispatch, diagnoseRequest(id), { connection: 1 });
    expect(entries.filter((entry) => entry.level === 'warn' && entry.msg === 'request failed')).toEqual([]);
  });

  it('a request without an origin shares one budget instead of escaping the limits', async () => {
    const held = heldRouteGet();
    const h = handlerHarness({ routeGet: held.routeGet });
    const first = h.handler.dispatch(diagnoseRequest(1));
    await flush();
    expect((await h.handler.dispatch(diagnoseRequest(2))).response).toMatchObject({ ok: false, code: 'busy' });
    await held.releaseAll();
    expect((await first).response).toMatchObject({ ok: true });
  });

  it(`answers operation-failed after ${String(DIAGNOSE_LIMITS.deadlineMs)} ms and keeps the slot until the work is over`, async () => {
    const held = heldRouteGet();
    const h = handlerHarness({ routeGet: held.routeGet });
    const first = send(h.handler.dispatch, diagnoseRequest(1), { connection: 1 });
    await flush();
    h.scheduler.advance(DIAGNOSE_LIMITS.deadlineMs - 1);
    await flush();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    h.scheduler.advance(1);
    expect((await first).response).toEqual({ id: 1, ok: false, code: 'operation-failed', error: 'The diagnosis did not finish in time or failed' });
    // The lookup still runs: the connection's one slot is still taken.
    expect((await send(h.handler.dispatch, diagnoseRequest(2), { connection: 1 })).response).toMatchObject({
      ok: false,
      code: 'busy',
      error: 'A diagnosis is already running on this connection',
    });
    await held.releaseAll();
    expect((await send(h.handler.dispatch, diagnoseRequest(3), { connection: 1 })).response).toMatchObject({ ok: true });
  });

  it(`shares the ${String(MAX_CONCURRENT_TESTS)} route lookups with test`, async () => {
    const ID_D = '00000000-0000-4000-8000-00000000000d';
    const held = heldRouteGet();
    const cached: CachedDomain = {
      addresses: Array.from({ length: 8 }, (_, index) => `198.51.100.${String(index + 1)}`),
      truncated: false,
      servers: ['10.20.0.10'],
      source: 'rule',
    };
    const h = handlerHarness({ routeGet: held.routeGet, peekDomain: (ruleId) => (ruleId === ID_D ? cached : null) });
    h.engine.setConfig(Config.parse({ version: 1, rules: [...CONFIG.rules, { id: ID_D, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' }] }));
    const all = [
      send(h.handler.dispatch, diagnoseRequest(1, 'corp.local'), { connection: 1 }),
      send(h.handler.dispatch, { id: 2, method: 'test', target: '198.51.100.9' }, { connection: 2 }),
      send(h.handler.dispatch, { id: 3, method: 'test', target: '198.51.100.9' }, { connection: 2 }),
    ];
    for (let round = 0; round < 20; round += 1) {
      await flush();
      held.releases.shift()?.();
    }
    await held.releaseAll();
    await Promise.all(all);
    expect(held.counts.calls).toBe(10);
    expect(held.counts.most).toBe(MAX_CONCURRENT_TESTS);
  });

  it('does not send a result that does not fit the protocol', async () => {
    const h = handlerHarness({
      routeGet: () =>
        Promise.resolve({ ok: true, outcome: 'found', route: { ...ROUTE_INFO, iface: 'en0; rm' } }),
    });
    const { response } = await send(h.handler.dispatch, diagnoseRequest(1));
    expect(response).toEqual({ id: 1, ok: false, code: 'operation-failed', error: 'The diagnosis gave an answer that cannot be reported' });
  });

  it('is refused after uninstall like every other request', async () => {
    const h = handlerHarness();
    await send(h.handler.dispatch, { id: 1, method: 'uninstall' });
    expect((await send(h.handler.dispatch, diagnoseRequest(2))).response).toMatchObject({ ok: false, code: 'operation-failed' });
  });

  it('a probe that fails makes a covered name resolve-failed, not a failed request', async () => {
    const ID_D = '00000000-0000-4000-8000-00000000000d';
    const probe: ProbeResult = { outcome: 'timeout', ms: 3000, addresses: [], truncated: false };
    const h = handlerHarness({ probeDns: () => Promise.resolve(probe) });
    h.engine.setConfig(Config.parse({ version: 1, rules: [{ id: ID_D, kind: 'domain', target: 'corp.local', iface: 'wifi', dns: '10.20.0.10' }] }));
    const { response } = await send(h.handler.dispatch, diagnoseRequest(1, 'corp.local'));
    expect(response).toMatchObject({
      ok: true,
      result: { addresses: [], dns: { outcome: 'timeout', ms: 3000 }, notes: ['resolve-failed'] },
    });
  });
});

// ---------------------------------------------------------------------------
// Log events
// ---------------------------------------------------------------------------

const entry = (level: LogEntry['level'], msg: string, context: Record<string, unknown> = {}): LogEntry => ({
  level,
  at: NOW.toISOString(),
  msg,
  context: { component: 'engine', ...context },
});

describe('log forwarder', () => {
  const forwarder = () => {
    const sent: LogEvent[] = [];
    let now = 0;
    const sink = createLogForwarder({
      send: (event) => {
        sent.push(event);
      },
      monotonicNow: () => now,
    });
    return {
      sink,
      sent,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('drops debug, and info of the command and connection components; keeps their warnings', () => {
    const f = forwarder();
    f.sink(entry('debug', 'detail'));
    f.sink(entry('info', 'command ran', { component: 'exec' }));
    f.sink(entry('info', 'client connected', { component: 'server' }));
    f.sink(entry('warn', 'command failed', { component: 'exec', code: 'E1' }));
    f.sink(entry('info', 'reconcile finished', { reason: 'startup' }));
    expect(f.sent).toEqual([
      { event: 'log', level: 'warn', msg: 'exec: command failed (code=E1)', at: NOW.toISOString() },
      { event: 'log', level: 'info', msg: 'engine: reconcile finished (reason=startup)', at: NOW.toISOString() },
    ]);
  });

  it('forwards a repeating warning once per window, then says how many were held back', () => {
    const f = forwarder();
    const refused = entry('warn', 'route add refused: connected route', { component: 'route', dst: '10.20.4.0/24' });
    for (let pass = 0; pass < 50; pass += 1) f.sink(refused);
    // Another destination is another warning.
    f.sink(entry('warn', 'route add refused: connected route', { component: 'route', dst: '10.20.5.0/24' }));
    expect(f.sent.map((event) => event.msg)).toEqual([
      'route: route add refused: connected route (dst=10.20.4.0/24)',
      'route: route add refused: connected route (dst=10.20.5.0/24)',
    ]);
    f.advance(10 * 60_000);
    f.sink(refused);
    expect(f.sent.at(-1)?.msg).toBe('route: route add refused: connected route (dst=10.20.4.0/24) [49 similar held back]');
  });

  it('keeps a persistent degraded detection visible once per window', () => {
    const f = forwarder();
    const degraded = entry('warn', 'interface detection is degraded');
    for (let minute = 0; minute < 30; minute += 1) {
      f.sink(degraded);
      f.advance(60_000);
    }
    expect(f.sent).toHaveLength(3);
  });

  it('limits info lines of one kind and all lines together', () => {
    const f = forwarder();
    for (let index = 0; index < 20; index += 1) f.sink(entry('info', 'reconcile finished'));
    expect(f.sent).toHaveLength(5);
    for (let index = 0; index < 100; index += 1) f.sink(entry('error', `failure ${String(index)}`));
    expect(f.sent).toHaveLength(60);
    f.advance(60_000);
    f.sink(entry('error', 'later'));
    expect(f.sent.at(-1)?.msg).toContain('log lines dropped while the journal was busy');
  });

  it('keeps every message within the protocol limit and never fails the logger', () => {
    const sent: LogEvent[] = [];
    const sink = createLogForwarder({
      send: (event) => {
        sent.push(event);
        throw new Error('client gone');
      },
      monotonicNow: () => 0,
    });
    expect(() => {
      sink(entry('error', 'x'.repeat(5000), { error: 'y'.repeat(5000) }));
    }).not.toThrow();
    expect(sent[0]?.msg.length).toBe(PROTOCOL_LIMITS.logMessageMaxLength);
  });

  it('does not forward what is logged while an event is being sent', () => {
    const sent: LogEvent[] = [];
    const logger = createLogger({ sinks: [] });
    logger.addSink(
      createLogForwarder({
        send: (event) => {
          sent.push(event);
          logger.warn('writing to a client failed');
        },
        monotonicNow: () => 0,
      }),
    );
    logger.warn('first');
    expect(sent.map((event) => event.msg)).toEqual(['first']);
  });
});
