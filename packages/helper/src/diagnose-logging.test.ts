import { Config, EngineState, type LogEvent } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { createFakeScheduler } from './dns-test-utils';
import { REDACTED_ARG, createCommandRunner, type ExecFileFn } from './exec';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import { createRouteOperations } from './route';
import { createLogForwarder, createRequestHandler } from './server';

/**
 * The addresses a user diagnoses are theirs: through the real route wrapper
 * and the real command runner (only `execFile` is fake) they reach the log at
 * `debug` only, and never a client as a `log` event. Every command is still
 * logged at `info`, with the address redacted. `test` is unchanged.
 */

const NOW = new Date('2026-10-15T08:00:00.000Z');
const RULE = '00000000-0000-4000-8000-000000000001';
const DOMAIN = '00000000-0000-4000-8000-000000000002';

const ADDRESS = '198.51.100.77';
const CACHED = ['198.51.100.78', '198.51.100.79'];
const MISSING = '198.51.100.80';
const BROKEN = '198.51.100.81';

const getOutput = (address: string): string => `   route to: ${address}
destination: 198.51.100.0
       mask: 255.255.255.0
    gateway: 10.20.4.1
  interface: en5
      flags: <UP,GATEWAY,DONE,STATIC>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`;

const execFile: ExecFileFn = (_file, args, _options, callback) => {
  const address = args[3] ?? '';
  if (address === MISSING) {
    callback({ message: `Command failed: /sbin/route -n get -host ${address}`, code: 1 }, '', `route: writing to routing socket: not in table\n`);
  } else if (address === BROKEN) {
    callback({ message: `Command failed: /sbin/route -n get -host ${address}`, code: 77 }, `odd output about ${address}`, `route: ${address}: something odd\n`);
  } else {
    queueMicrotask(() => {
      callback(null, getOutput(address), '');
    });
  }
};

const setup = () => {
  const memory = createMemorySink();
  const events: LogEvent[] = [];
  const forwarder = createLogForwarder({ send: (event) => events.push(event), monotonicNow: () => 0 });
  // The daemon's level: debug is written to the file only when asked for; here every line is kept to look at.
  const logger = createLogger({ sinks: [memory.sink, forwarder] });
  const runner = createCommandRunner({ logger, execFile });
  const routes = createRouteOperations({ runner, logger });
  const scheduler = createFakeScheduler(NOW);
  const config = Config.parse({
    version: 1,
    rules: [
      { id: RULE, kind: 'subnet', target: '198.51.100.0/24', iface: 'ethernet' },
      { id: DOMAIN, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' },
    ],
  });
  const state = EngineState.parse({
    helperVersion: '0.0.0',
    seq: 1,
    configRevision: 1,
    enabled: true,
    interfaces: {
      ethernet: { device: 'en5', ip: '10.20.4.23', gateway: '10.20.4.1', up: true },
      wifi: { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', up: true },
    },
    adapters: [],
    rules: [],
    lastApplyAt: null,
    lastReconcileReason: null,
  });
  const handler = createRequestHandler({
    engine: {
      getState: () => state,
      getConfig: () => config,
      getConfigRevision: () => 1,
      getApplied: () => [{ dst: '198.51.100.0/24', gateway: '10.20.4.1', ruleIds: [RULE] }],
      setConfig: () => true,
      setEnabled: () => true,
      reconcile: () => Promise.reject(new Error('no pass expected')),
    },
    helperVersion: '0.0.0',
    logger,
    // As main.ts wires it.
    routeGet: (target, options) => routes.routeGet(target, options),
    peekDomain: (ruleId) => (ruleId === DOMAIN ? { addresses: [...CACHED, MISSING, BROKEN], truncated: false, servers: ['10.20.0.10'], source: 'rule' } : null),
    probeDns: () => Promise.resolve({ outcome: 'ok', ms: 3, addresses: [], truncated: false }),
    saveConfig: () => Promise.resolve({ ok: true }),
    started: Promise.resolve(),
    storedConfigProblem: null,
    disableAll: () => Promise.resolve({ failed: 0, resolverFilesFailed: 0 }),
    uninstall: () => Promise.resolve({ failed: 0, resolverFilesFailed: 0 }),
    afterUninstall: () => undefined,
    monotonicNow: () => scheduler.now().getTime(),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  return { handler, memory, events };
};

const PRIVATE = [ADDRESS, ...CACHED, MISSING, BROKEN, 'corp.local'];
const mentions = (value: unknown, needles: readonly string[]): string[] => {
  const text = JSON.stringify(value);
  return needles.filter((needle) => text.includes(needle));
};
const loud = (entries: readonly LogEntry[]): LogEntry[] => entries.filter((entry) => entry.level !== 'debug');

describe('diagnose: what reaches the log', () => {
  it('a diagnosed address and name appear at debug only, never in a log event, and every command is still logged at info', async () => {
    const h = setup();
    const byAddress = await h.handler.dispatch({ id: 1, method: 'diagnose', target: ADDRESS }, { connection: 1 });
    const byName = await h.handler.dispatch({ id: 2, method: 'diagnose', target: 'corp.local' }, { connection: 2 });
    expect(byAddress.response).toMatchObject({ ok: true });
    expect(byName.response).toMatchObject({ ok: true, result: { addresses: [{}, {}, { route: null }, { route: null }] } });

    expect(loud(h.memory.entries).flatMap((entry) => mentions(entry, PRIVATE))).toEqual([]);
    expect(h.events.flatMap((event) => mentions(event, PRIVATE))).toEqual([]);

    // Five lookups, each one logged as a command at info with the address redacted.
    const commands = h.memory.entries.filter((entry) => entry.context?.['component'] === 'exec' && entry.level !== 'debug');
    expect(commands).toHaveLength(5);
    for (const command of commands) expect(command.context?.['args']).toEqual(['-n', 'get', '-host', REDACTED_ARG]);
    expect(commands.filter((entry) => entry.msg === 'command finished' && entry.level === 'info')).toHaveLength(3);
    // The failed ones are still reported, without the address or the output.
    expect(commands.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    expect(h.memory.entries.some((entry) => entry.level === 'error' && entry.msg === 'route command failed')).toBe(true);

    // The full detail is there at debug for whoever turns it on.
    const debug = h.memory.entries.filter((entry) => entry.level === 'debug');
    for (const address of [ADDRESS, ...CACHED, MISSING, BROKEN]) {
      expect(debug.some((entry) => JSON.stringify(entry).includes(address))).toBe(true);
    }
  });

  it('test logs its target as before', async () => {
    const h = setup();
    const outcome = await h.handler.dispatch({ id: 1, method: 'test', target: ADDRESS }, { connection: 1 });
    expect(outcome.response).toMatchObject({ ok: true });
    const finished = h.memory.entries.find((entry) => entry.msg === 'command finished');
    expect(finished).toMatchObject({ level: 'info', context: { args: ['-n', 'get', '-host', ADDRESS] } });
    expect(h.memory.entries.find((entry) => entry.msg === 'route looked up')).toMatchObject({ level: 'info', context: { dst: ADDRESS } });
  });
});
