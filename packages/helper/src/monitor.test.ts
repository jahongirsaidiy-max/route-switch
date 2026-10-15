import { Config, type EngineState, type ReconcileReason, type Rule } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { LOOKUP_TIMEOUT_MS, STALE_FLOOR_MS, createDomainResolver } from './dns';
import { createFakeDns, createFakeScheduler, flush, type FakeScheduler } from './dns-test-utils';
import {
  createEngine,
  type AppliedRoute,
  type DriftedRoute,
  type Engine,
  type ReconcileOptions,
  type ReconcileOutcome,
  type RetryNeeds,
  type SubscribeOptions,
  type StateListener,
} from './engine';
import { CommandRejectedError, type ProcessExit, type ProcessHandlers, type ProcessSpawner } from './exec';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import {
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MS,
  DEFERRED_RETRY_MAX_CHECKS,
  DNS_REFRESH_MIN_INTERVAL_MS,
  DRIFT_INTERVAL_MS,
  RESTART_MAX_DELAY_MS,
  RESTART_MIN_DELAY_MS,
  RESTART_RESET_AFTER_MS,
  RETRY_EVERY_DRIFT_CHECKS,
  ROUTE_EVENT_QUIET_MS,
  createMonitorParser,
  createNetworkMonitor,
  driftOf,
  parseTableRoutes,
  type NetworkMonitor,
} from './monitor';
import type { DetectedInterfaces, InterfaceInfo, NetInfo } from './netinfo';
import type { RouteAddRequest, RouteAddResult, RouteDeleteRequest, RouteDeleteResult } from './route';
import { createFakeCommandRunner, type FakeCommandResponse, type FakeCommandRunner } from './test-utils';

// Nothing here starts a process: `route -n monitor` is a fake spawner, `netstat` a fake runner,
// and every timer and the clock belong to a fake scheduler.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-14T08:00:00.000Z');
/** Where the fake monotonic clock starts (milliseconds since the process started, as `performance.now()`). */
const MONOTONIC_START = 5_000;
const ETH_GW = '10.20.4.1';
const WIFI_GW = '192.168.1.1';

const IFINFO = 'got message of size 112 on Wed Oct 14 08:00:00 2026\nRTM_IFINFO: iface status change: len 112, if# 15, flags:<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST>\n';
const NEWADDR =
  'got message of size 144 on Wed Oct 14 08:00:00 2026\nRTM_NEWADDR: address being added to iface: len 144, metric 0, flags:<UP,BROADCAST,RUNNING>\nsockaddrs: <NETMASK,IFP,IFA,BRD>\n 255.255.255.0 en5 10.20.4.23 10.20.4.255\n';
const DELADDR =
  'RTM_DELADDR: address being removed from iface: len 144, metric 0, flags:<UP,BROADCAST,RUNNING>\nsockaddrs: <NETMASK,IFP,IFA,BRD>\n 255.255.255.0 en5 10.20.4.23 10.20.4.255\n';
const routeMessage = (type: string, dst: string, gateway: string, addrs = '<DST,GATEWAY,NETMASK>'): string =>
  `got message of size 140 on Wed Oct 14 08:00:00 2026\n${type}: Route: len 140, pid: 0, seq 0, errno 0, flags:<UP,GATEWAY,DONE,STATIC>\nlocks:  inits: \nsockaddrs: ${addrs}\n ${dst} ${gateway} default\n`;
const ADD_DEFAULT = routeMessage('RTM_ADD', 'default', WIFI_GW);
const addHost = (dst: string, gateway: string): string => routeMessage('RTM_ADD', dst, gateway, '<DST,GATEWAY>');

const NETSTAT_HEADER = 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n';
const table = (...rows: string[]): string =>
  `${NETSTAT_HEADER}default            ${WIFI_GW}        UGScg                 en0\n${rows.join('\n')}\n`;
const ROW_HOST = `172.16.12.40       ${ETH_GW}          UGHS                  en5`;
const ROW_NET = `172.16/12          ${ETH_GW}          UGSc                  en5`;

const ruleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rule = (n: number, kind: Rule['kind'], target: string, extra: Partial<Rule> = {}): Rule => ({
  id: ruleId(n),
  enabled: true,
  kind,
  target,
  iface: 'ethernet',
  refreshSec: 600,
  ...extra,
});
const HOST = rule(1, 'ip', '172.16.12.40');
const NET = rule(2, 'subnet', '172.16.0.0/12');
const config = (rules: readonly Rule[]): Config => Config.parse({ version: 1, enabled: true, rules });

const iface = (role: InterfaceInfo['role']): InterfaceInfo => {
  const wifi = role === 'wifi';
  return {
    role,
    device: wifi ? 'en0' : 'en5',
    port: wifi ? 'Wi-Fi' : 'USB 10/100/1000 LAN',
    ip: wifi ? '192.168.1.23' : '10.20.4.23',
    gateway: wifi ? WIFI_GW : ETH_GW,
    netmask: '255.255.255.0',
    subnet: wifi ? '192.168.1.0/24' : '10.20.4.0/24',
    up: true,
    routable: true,
    reason: null,
    overridden: false,
  };
};
const NETWORK: DetectedInterfaces = {
  ethernet: iface('ethernet'),
  wifi: iface('wifi'),
  adapters: [
    { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.23' },
    { device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' },
  ],
  degraded: false,
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeProcess {
  readonly bin: string;
  readonly args: readonly string[];
  stopped: boolean;
  /** Feeds output to the monitor, split into lines. */
  print(text: string): void;
  exit(exit?: Partial<ProcessExit>): void;
}

interface FakeSpawner extends ProcessSpawner {
  readonly processes: FakeProcess[];
  /** The process started last. */
  current(): FakeProcess;
  /** When set, the next spawn throws this. */
  throwNext: Error | null;
}

const createFakeSpawner = (): FakeSpawner => {
  const processes: FakeProcess[] = [];
  const fake: FakeSpawner = {
    processes,
    throwNext: null,
    current: () => {
      const last = processes.at(-1);
      if (last === undefined) throw new Error('no process was started');
      return last;
    },
    spawn: (bin, args, handlers: ProcessHandlers) => {
      if (fake.throwNext !== null) {
        const error = fake.throwNext;
        fake.throwNext = null;
        throw error;
      }
      let ended = false;
      const process: FakeProcess = {
        bin,
        args: [...args],
        stopped: false,
        print: (text) => {
          if (ended) return;
          const lines = text.split('\n');
          if (lines.at(-1) === '') lines.pop();
          for (const line of lines) handlers.onLine(line);
        },
        exit: (exit = {}) => {
          if (ended) return;
          ended = true;
          handlers.onExit({ exitCode: 1, signal: null, error: null, stopped: process.stopped, ...exit });
        },
      };
      processes.push(process);
      return {
        stop: () => {
          process.stopped = true;
        },
      };
    },
  };
  return fake;
};

interface FakeEngine extends Pick<
  Engine,
  'reconcile' | 'getApplied' | 'forgetApplied' | 'isReconciling' | 'getRetryNeeds' | 'subscribe' | 'getState'
> {
  readonly calls: { reason: ReconcileReason; options: ReconcileOptions | undefined }[];
  readonly forgotten: DriftedRoute[][];
  applied: AppliedRoute[];
  needs: RetryNeeds;
  /** The options of every `subscribe` call. */
  readonly subscriptions: (SubscribeOptions | undefined)[];
  reconciling: boolean;
  seq: number;
  /** Tells the subscribers that a pass ended. */
  passEnded(): void;
  /** Run inside `reconcile`, before it resolves. */
  onReconcile: ((reason: ReconcileReason) => void) | null;
}

/** A valid `EngineState` to hand out, taken from a real engine that never runs. */
const BASE_STATE: EngineState = createEngine({
  netinfo: { detectInterfaces: () => Promise.resolve(NETWORK), invalidate: () => undefined },
  routes: { routeAdd: () => Promise.reject(new Error('unused')), routeDelete: () => Promise.reject(new Error('unused')) },
  logger: createLogger({ sinks: [] }),
  helperVersion: '0.0.0',
  initialConfig: config([]),
}).getState();

const createFakeEngine = (order: string[]): FakeEngine => {
  const listeners = new Set<StateListener>();
  const fake: FakeEngine = {
    calls: [],
    forgotten: [],
    applied: [],
    needs: { deferred: 0, refused: 0, failing: 0, learnedExpired: 0 },
    subscriptions: [],
    reconciling: false,
    seq: 0,
    onReconcile: null,
    reconcile: (reason, options) => {
      fake.calls.push({ reason, options });
      order.push(`reconcile:${reason}`);
      fake.onReconcile?.(reason);
      fake.seq += 1;
      const outcome: ReconcileOutcome = {
        state: { ...BASE_STATE, seq: fake.seq },
        retryRequested: false,
        summary: { added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 },
      };
      return Promise.resolve(outcome);
    },
    getApplied: () => fake.applied,
    forgetApplied: (routes) => {
      fake.forgotten.push([...routes]);
      return routes.length;
    },
    isReconciling: () => fake.reconciling,
    getRetryNeeds: () => fake.needs,
    subscribe: (listener, options) => {
      fake.subscriptions.push(options);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => ({ ...BASE_STATE, seq: fake.seq }),
    passEnded: () => {
      for (const listener of listeners) listener({ ...BASE_STATE, seq: fake.seq });
    },
  };
  return fake;
};

interface Harness {
  readonly monitor: NetworkMonitor;
  readonly engine: FakeEngine;
  readonly spawner: FakeSpawner;
  readonly runner: FakeCommandRunner;
  readonly scheduler: FakeScheduler;
  readonly entries: readonly LogEntry[];
  /** `invalidate`, `refreshAll` and `reconcile:<reason>`, in the order they happened. */
  readonly order: string[];
  /** Added to the scheduler's clock: a jump of the wall clock (sleep). */
  readonly clock: { jump: number; monotonicJump: number };
  /** Moves time forward in small steps, letting promises settle in between. */
  pass(ms: number, step?: number): Promise<void>;
  netstatCalls(): number;
  logs(level: LogEntry['level'], msg: string): LogEntry[];
}

const setup = (options: { dns?: boolean } = {}): Harness => {
  const scheduler = createFakeScheduler(NOW);
  const clock = { jump: 0, monotonicJump: 0 };
  const order: string[] = [];
  const engine = createFakeEngine(order);
  const spawner = createFakeSpawner();
  const runner = createFakeCommandRunner();
  const memory = createMemorySink();
  const netinfo: Pick<NetInfo, 'invalidate'> = { invalidate: () => void order.push('invalidate') };
  const monitor = createNetworkMonitor({
    engine,
    netinfo,
    dns: options.dns === false ? undefined : { refreshAll: () => void order.push('refreshAll') },
    runner,
    spawner,
    logger: createLogger({ sinks: [memory.sink], now: scheduler.now }),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    now: () => scheduler.now().getTime() + clock.jump,
    // A real monotonic clock never jumps; `monotonicJump` exists to prove a backward step is harmless anyway.
    // It starts near zero like `performance.now()`, far from the wall clock: mixing the two up shows.
    monotonicNow: () => scheduler.now().getTime() - NOW.getTime() + MONOTONIC_START + clock.monotonicJump,
  });
  return {
    monitor,
    engine,
    spawner,
    runner,
    scheduler,
    entries: memory.entries,
    order,
    clock,
    pass: async (ms, step = 250) => {
      for (let done = 0; done < ms; done += step) {
        scheduler.advance(Math.min(step, ms - done));
        await flush();
      }
    },
    netstatCalls: () => runner.calls.filter((call) => call.bin === '/usr/sbin/netstat').length,
    logs: (level, msg) =>
      memory.entries.filter((entry) => entry.level === level && entry.msg === msg && entry.context?.['component'] === 'monitor'),
  };
};

const reasons = (h: Harness): ReconcileReason[] => h.engine.calls.map((call) => call.reason);
const stubNetstat = (h: Harness, response: FakeCommandResponse): void => {
  h.runner.when('/usr/sbin/netstat', ['-rn', '-f', 'inet'], response);
};
const APPLIED: AppliedRoute[] = [
  { dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] },
  { dst: '172.16.0.0/12', gateway: ETH_GW, ruleIds: [ruleId(2)] },
];

// ---------------------------------------------------------------------------
// Parsing `route -n monitor`
// ---------------------------------------------------------------------------

describe('createMonitorParser', () => {
  const events = (text: string) => {
    const parser = createMonitorParser();
    return text.split('\n').flatMap((line) => {
      const event = parser.push(line);
      return event === null ? [] : [event];
    });
  };

  it('takes interface messages as network changes', () => {
    expect(events(IFINFO + NEWADDR + DELADDR)).toEqual([
      { type: 'RTM_IFINFO', route: false },
      { type: 'RTM_NEWADDR', route: false },
      { type: 'RTM_DELADDR', route: false },
    ]);
  });

  it('takes adding, deleting and changing a default route, and nothing else of route messages', () => {
    const text = [
      ADD_DEFAULT,
      routeMessage('RTM_DELETE', 'default', WIFI_GW),
      routeMessage('RTM_CHANGE', '0.0.0.0', WIFI_GW),
      addHost('172.16.12.40', ETH_GW),
      routeMessage('RTM_ADD', '172.16.0.0', ETH_GW),
      routeMessage('RTM_GET', 'default', WIFI_GW),
      routeMessage('RTM_LOSING', 'default', WIFI_GW),
      routeMessage('RTM_MISS', 'default', WIFI_GW),
      routeMessage('RTM_NEWMADDR', 'default', WIFI_GW),
      // No destination among the addresses: the first one is not a destination.
      routeMessage('RTM_ADD', 'default', WIFI_GW, '<GATEWAY,NETMASK>'),
    ].join('');
    expect(events(text)).toEqual([
      { type: 'RTM_ADD', route: true },
      { type: 'RTM_DELETE', route: true },
      { type: 'RTM_CHANGE', route: true },
    ]);
  });

  it('ignores garbage, a route message without addresses, CR line ends and a message cut short', () => {
    const cut = 'RTM_ADD: Add Route: len 140\nlocks:  inits:\nRTM_IFINFO: iface status change: len 112\n';
    expect(events(cut)).toEqual([{ type: 'RTM_IFINFO', route: false }]);
    expect(events(ADD_DEFAULT.replaceAll('\n', '\r\n'))).toEqual([{ type: 'RTM_ADD', route: true }]);
    expect(events('RTM_IFINFO\nRTM_\nRTM_ADD default\nsockaddrs: <DST>\nfoo: bar\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

describe('parseTableRoutes and driftOf', () => {
  it('keys host rows by the address and network rows by canonical CIDR, without scoped rows', () => {
    const routes = parseTableRoutes(
      table(
        ROW_HOST,
        ROW_NET,
        `10                 ${ETH_GW}          UGSc                  en5`,
        `198.51.100.7      ${WIFI_GW}          UGHSI                 en0`,
        '10.20.4/24         link#15            UCS                   en5      !',
        '10.20.4.9          0:e0:4c:8:34:8     UHLWIi                en5   1184',
      ),
    );
    expect(routes?.get('172.16.12.40')).toEqual([{ gateway: ETH_GW, flags: 'UGHS' }]);
    expect(routes?.get('172.16.0.0/12')).toEqual([{ gateway: ETH_GW, flags: 'UGSc' }]);
    expect(routes?.get('10.0.0.0/8')).toEqual([{ gateway: ETH_GW, flags: 'UGSc' }]);
    expect(routes?.get('10.20.4.0/24')).toEqual([{ gateway: 'link#15', flags: 'UCS' }]);
    expect(routes?.has('198.51.100.7')).toBe(false);
    expect(routes?.has('10.20.4.9')).toBe(false);
  });

  it('does not trust output without the IPv4 header or with too many lines', () => {
    expect(parseTableRoutes('')).toBeNull();
    expect(parseTableRoutes('Internet:\n172.16.12.40 10.20.4.1 UGHS en5\n')).toBeNull();
    expect(parseTableRoutes(`${'\n'.repeat(40_001)}${table(ROW_HOST)}`)).toBeNull();
    expect(parseTableRoutes(table())?.size).toBe(0);
  });

  it('tells missing, other-gateway and connected apart', () => {
    const routes = parseTableRoutes(
      table(
        ROW_HOST,
        `172.16.12.41       ${WIFI_GW}          UGHS                  en0`,
        '172.16.12.42       link#15            UHS                   en5',
        `172.16.12.43       ${ETH_GW}          UGHSR                 en5`,
      ),
    );
    if (routes === null) throw new Error('table not parsed');
    expect(driftOf({ dst: '172.16.12.40', gateway: ETH_GW }, routes)).toBeNull();
    expect(driftOf({ dst: '172.16.12.41', gateway: ETH_GW }, routes)).toBe('other-gateway');
    expect(driftOf({ dst: '172.16.12.42', gateway: ETH_GW }, routes)).toBe('connected');
    expect(driftOf({ dst: '172.16.12.43', gateway: ETH_GW }, routes)).toBe('other-gateway');
    expect(driftOf({ dst: '172.16.12.44', gateway: ETH_GW }, routes)).toBe('missing');
    // A host route is not the network of the same address, and the other way round.
    expect(driftOf({ dst: '172.16.12.40/32', gateway: ETH_GW }, routes)).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// The monitor process
// ---------------------------------------------------------------------------

describe('network monitor: the monitor process', () => {
  it('starts `route -n monitor` by absolute path, with an argument array, and does not reconcile by itself', () => {
    const h = setup();
    h.monitor.start();
    h.monitor.start();
    expect(h.spawner.processes.map(({ bin, args }) => ({ bin, args }))).toEqual([{ bin: '/sbin/route', args: ['-n', 'monitor'] }]);
    expect(h.engine.calls).toEqual([]);
  });

  it('restarts a process that died with a doubling delay, and reconciles after each restart', async () => {
    const h = setup();
    h.monitor.start();
    const delays: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const before = h.scheduler.now().getTime();
      h.spawner.current().exit({ exitCode: 1 });
      const started = h.spawner.processes.length;
      while (h.spawner.processes.length === started) await h.pass(250);
      delays.push(h.scheduler.now().getTime() - before);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(RESTART_MIN_DELAY_MS).toBe(1000);
    expect(RESTART_MAX_DELAY_MS).toBe(60_000);
    expect(h.logs('warn', 'monitor process ended; restarting')).toHaveLength(9);
    // Messages may have been missed meanwhile: every restart is a network change.
    expect(reasons(h)).toEqual(Array.from({ length: 9 }, () => 'network-change'));

    // A process that ran for a while starts from the shortest delay again.
    await h.pass(RESTART_RESET_AFTER_MS);
    h.spawner.current().exit();
    const count = h.spawner.processes.length;
    await h.pass(RESTART_MIN_DELAY_MS);
    expect(h.spawner.processes).toHaveLength(count + 1);
  });

  it('retries a spawn that throws like a process that died', async () => {
    const h = setup();
    h.spawner.throwNext = new CommandRejectedError('binary-not-allowed', 'refused');
    h.monitor.start();
    expect(h.spawner.processes).toHaveLength(0);
    expect(h.logs('error', 'monitor process could not be started')).toHaveLength(1);
    await h.pass(RESTART_MIN_DELAY_MS);
    expect(h.spawner.processes).toHaveLength(1);
  });

  it('stop() ends the process and clears every timer; nothing happens afterwards', async () => {
    const h = setup();
    h.monitor.start();
    stubNetstat(h, { stdout: table(ROW_HOST, ROW_NET) });
    h.engine.applied = APPLIED;
    const process = h.spawner.current();
    process.print(IFINFO);
    h.order.length = 0;
    h.monitor.stop();
    h.monitor.stop();

    expect(process.stopped).toBe(true);
    expect(h.scheduler.pending()).toBe(0);
    process.print(IFINFO);
    process.exit({ stopped: true });
    await h.pass(10 * DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toEqual([]);
    expect(h.spawner.processes).toHaveLength(1);
    expect(h.netstatCalls()).toBe(0);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('start() after stop() starts nothing and subscribes to nothing', async () => {
    const h = setup();
    let subscriptions = 0;
    const subscribe = h.engine.subscribe;
    h.engine.subscribe = (listener) => {
      subscriptions += 1;
      return subscribe(listener);
    };
    h.monitor.stop();
    h.monitor.start();
    await h.pass(2 * DRIFT_INTERVAL_MS, 5000);
    expect(subscriptions).toBe(0);
    expect(h.spawner.processes).toHaveLength(0);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('stop() while a restart and a DNS refresh are pending clears them too', async () => {
    const h = setup();
    h.monitor.start();
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    h.spawner.current().exit();
    expect(h.scheduler.pending()).toBeGreaterThanOrEqual(3);
    h.monitor.stop();
    expect(h.scheduler.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Network changes
// ---------------------------------------------------------------------------

describe('network monitor: network changes', () => {
  it('debounces a burst into one reconcile 1.5 s after the last message: invalidate, refreshAll, reconcile', async () => {
    const h = setup();
    h.monitor.start();
    const process = h.spawner.current();
    process.print(IFINFO);
    await h.pass(500);
    process.print(NEWADDR);
    await h.pass(500);
    process.print(DELADDR + ADD_DEFAULT);
    await h.pass(DEBOUNCE_MS - 250);
    expect(h.engine.calls).toEqual([]);
    await h.pass(250);

    expect(h.order).toEqual(['invalidate', 'refreshAll', 'reconcile:network-change']);
    expect(h.engine.calls).toEqual([{ reason: 'network-change', options: {} }]);
    expect(h.logs('info', 'network changed; reconciling')[0]?.context).toMatchObject({
      trigger: 'network-change',
      events: ['RTM_ADD', 'RTM_DELADDR', 'RTM_IFINFO', 'RTM_NEWADDR'],
    });
    await h.pass(10_000);
    expect(h.engine.calls).toHaveLength(1);
  });

  it('debounces on the monotonic clock: a wall clock jump between two messages changes nothing', async () => {
    const h = setup();
    h.monitor.start();
    h.spawner.current().print(IFINFO);
    await h.pass(500);
    h.clock.jump += 3_600_000;
    h.spawner.current().print(NEWADDR);
    await h.pass(DEBOUNCE_MS - 250);
    expect(h.engine.calls).toEqual([]);
    await h.pass(250);
    expect(reasons(h)).toEqual(['network-change']);
  });

  it('reconciles a stream that never pauses at the latest 10 s after its first message', async () => {
    const h = setup();
    h.monitor.start();
    for (let elapsed = 0; elapsed < 30_000; elapsed += 1000) {
      h.spawner.current().print(IFINFO);
      await h.pass(1000);
    }
    expect(DEBOUNCE_MAX_MS).toBe(10_000);
    expect(reasons(h)).toEqual(['network-change', 'network-change', 'network-change']);
  });

  it('ignores route messages that are not about a default route', async () => {
    const h = setup();
    h.monitor.start();
    h.spawner.current().print(addHost('172.16.12.40', ETH_GW) + routeMessage('RTM_DELETE', '172.16.0.0', ETH_GW));
    await h.pass(5000);
    expect(h.engine.calls).toEqual([]);
  });

  it('blocks route messages while a pass runs and shortly after it, but never interface messages', async () => {
    const h = setup();
    h.monitor.start();
    const process = h.spawner.current();
    h.engine.reconciling = true;
    process.print(ADD_DEFAULT);
    await h.pass(5000);
    expect(h.engine.calls).toEqual([]);
    expect(
      h.entries.filter((entry) => entry.msg === 'route message ignored while the engine is reconciling'),
    ).toHaveLength(1);

    h.engine.reconciling = false;
    h.engine.passEnded();
    await h.pass(ROUTE_EVENT_QUIET_MS - 250);
    process.print(ADD_DEFAULT);
    await h.pass(5000);
    expect(h.engine.calls).toEqual([]);

    process.print(ADD_DEFAULT);
    await h.pass(DEBOUNCE_MS);
    expect(reasons(h)).toEqual(['network-change']);

    // A cable pulled during a pass is not lost.
    h.engine.reconciling = true;
    process.print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    expect(reasons(h)).toEqual(['network-change', 'network-change']);
  });

  it('does not loop on the route messages of its own reconcile (real engine)', async () => {
    const scheduler = createFakeScheduler(NOW);
    const spawner = createFakeSpawner();
    const memory = createMemorySink();
    const logger = createLogger({ sinks: [memory.sink], now: scheduler.now });
    let detections = 0;
    const netinfo: NetInfo = {
      detectInterfaces: () => {
        detections += 1;
        return Promise.resolve(NETWORK);
      },
      invalidate: () => undefined,
    };
    const routeCalls: string[] = [];
    // The kernel reports every change, also the engine's own ones and, to be sure, a default
    // route appearing in the middle of the pass.
    const routes = {
      routeAdd: (request: RouteAddRequest): Promise<RouteAddResult> => {
        routeCalls.push(`add ${request.dst}`);
        spawner.current().print(addHost(request.dst, request.gateway) + ADD_DEFAULT);
        return Promise.resolve({ ok: true, outcome: 'added', dst: request.dst, kind: request.dst.includes('/') ? 'net' : 'host', gateway: request.gateway });
      },
      routeDelete: (request: RouteDeleteRequest): Promise<RouteDeleteResult> => {
        routeCalls.push(`delete ${request.dst}`);
        return Promise.resolve({ ok: true, outcome: 'deleted', dst: request.dst, kind: 'host' });
      },
    };
    const engine = createEngine({ netinfo, routes, logger, helperVersion: '0.0.0', initialConfig: config([HOST, NET]), now: scheduler.now });
    const reconciled: ReconcileReason[] = [];
    engine.subscribe((state) => {
      if (state.lastReconcileReason !== null) reconciled.push(state.lastReconcileReason);
    });
    const monitor = createNetworkMonitor({
      engine,
      netinfo,
      runner: createFakeCommandRunner(),
      spawner,
      logger,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      now: () => scheduler.now().getTime(),
      monotonicNow: () => scheduler.now().getTime() - NOW.getTime() + MONOTONIC_START,
    });
    monitor.start();
    spawner.current().print(IFINFO);
    for (let step = 0; step < 40; step += 1) {
      scheduler.advance(250);
      await flush();
    }

    expect(reconciled).toEqual(['network-change']);
    expect(routeCalls).toEqual(['add 172.16.12.40', 'add 172.16.0.0/12']);
    expect(detections).toBe(1);
    monitor.stop();
  });

  it('runs the same sequence after a wake from sleep, seen as a gap between drift checks', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, { stdout: table(ROW_HOST, ROW_NET) });
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.netstatCalls()).toBe(1);
    expect(h.engine.calls).toEqual([]);

    // Nine hours asleep: the wall clock jumps, the timer fires once the machine is awake.
    h.clock.jump += 9 * 3_600_000;
    await h.pass(DRIFT_INTERVAL_MS, 1000);

    expect(h.order).toEqual(['invalidate', 'refreshAll', 'reconcile:network-change']);
    expect(h.logs('info', 'network changed; reconciling')[0]?.context).toMatchObject({ trigger: 'wake' });
    // That tick does not run the drift check; the next one does, normally.
    expect(h.netstatCalls()).toBe(1);
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.netstatCalls()).toBe(2);
    expect(h.engine.calls).toHaveLength(1);
  });

  it.each([
    ['91 s', 31_000, true],
    ['89 s', 29_000, false],
    ['a negative gap', -2 * DRIFT_INTERVAL_MS, true],
  ])('takes %s between two drift checks as a wake: %s', async (_name, extra, wake) => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, { stdout: table(ROW_HOST, ROW_NET) });
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.netstatCalls()).toBe(1);

    h.clock.jump += extra;
    await h.pass(DRIFT_INTERVAL_MS, 1000);

    if (wake) {
      expect(h.order).toEqual(['invalidate', 'refreshAll', 'reconcile:network-change']);
      expect(h.logs('info', 'network changed; reconciling')[0]?.context).toMatchObject({ trigger: 'wake', gapMs: DRIFT_INTERVAL_MS + extra });
      expect(h.netstatCalls()).toBe(1);
    } else {
      expect(h.order).toEqual([]);
      expect(h.netstatCalls()).toBe(2);
    }
  });

  it.each(['wall', 'monotonic'] as const)(
    'accepts a default-route message 1 s after a pass although the %s clock went back an hour',
    async (which) => {
      const h = setup();
      h.monitor.start();
      h.engine.passEnded();
      if (which === 'wall') h.clock.jump -= 3_600_000;
      else h.clock.monotonicJump -= 3_600_000;
      await h.pass(ROUTE_EVENT_QUIET_MS);
      h.spawner.current().print(ADD_DEFAULT);
      await h.pass(DEBOUNCE_MS);
      expect(reasons(h)).toEqual(['network-change']);
    },
  );

  it('works without a DNS module', async () => {
    const h = setup({ dns: false });
    h.monitor.start();
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    expect(h.order).toEqual(['invalidate', 'reconcile:network-change']);
  });
});

// ---------------------------------------------------------------------------
// DNS refresh rate
// ---------------------------------------------------------------------------

describe('network monitor: dns.refreshAll() at most every LOOKUP_TIMEOUT_MS', () => {
  it('postpones a refresh within 5 s of the last one to the 5 s mark, once for every change until then', async () => {
    expect(DNS_REFRESH_MIN_INTERVAL_MS).toBe(LOOKUP_TIMEOUT_MS);
    const h = setup();
    h.monitor.start();
    const refreshes = (): number => h.order.filter((entry) => entry === 'refreshAll').length;
    const startedAt = h.scheduler.now().getTime();
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    expect(refreshes()).toBe(1);
    const firstAt = h.scheduler.now().getTime();
    expect(firstAt - startedAt).toBe(DEBOUNCE_MS);

    // Two more changes, 1.75 s apart: each reconciles at once, the DNS refresh waits.
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS + 250);
    h.spawner.current().print(IFINFO);
    await h.pass(DEBOUNCE_MS);
    expect(reasons(h)).toEqual(['network-change', 'network-change', 'network-change']);
    expect(refreshes()).toBe(1);

    await h.pass(firstAt + LOOKUP_TIMEOUT_MS - h.scheduler.now().getTime() - 250);
    expect(refreshes()).toBe(1);
    await h.pass(250);
    expect(refreshes()).toBe(2);
    await h.pass(30_000);
    expect(refreshes()).toBe(2);
  });

  it.each(['wall', 'monotonic'] as const)(
    'refreshes on the next change within 5 s although the %s clock went back an hour',
    async (which) => {
      const h = setup();
      h.monitor.start();
      const refreshes = (): number => h.order.filter((entry) => entry === 'refreshAll').length;
      h.spawner.current().print(IFINFO);
      await h.pass(DEBOUNCE_MS);
      expect(refreshes()).toBe(1);

      if (which === 'wall') h.clock.jump -= 3_600_000;
      else h.clock.monotonicJump -= 3_600_000;
      await h.pass(1000);
      h.spawner.current().print(IFINFO);
      await h.pass(DEBOUNCE_MS);
      // Within the 5 s window of the monotonic clock it waits for the window, never for an hour.
      await h.pass(LOOKUP_TIMEOUT_MS);
      expect(refreshes()).toBe(2);
      expect(Math.max(0, ...h.scheduler.delays())).toBeLessThanOrEqual(DRIFT_INTERVAL_MS);
    },
  );

  const domain = rule(5, 'domain', 'corp.local', { refreshSec: 60 });

  /** The real DNS module with a server that answers once and then hangs; the engine only asks it, like a pass does. */
  const dnsSetup = () => {
    const scheduler = createFakeScheduler(NOW);
    const fakeDns = createFakeDns();
    const memory = createMemorySink();
    const logger = createLogger({ sinks: [memory.sink], now: scheduler.now });
    const service = createDomainResolver({
      logger,
      now: scheduler.now,
      createResolver: fakeDns.factory,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      systemServers: () => [],
    });
    service.syncConfig(config([domain]));
    return { scheduler, fakeDns, service, memory };
  };

  it('lets the last known addresses expire although the network changes every 2 s for 70 minutes while DNS hangs', async () => {
    const { scheduler, fakeDns, service, memory } = dnsSetup();
    fakeDns.auto = () => ['172.16.12.40'];
    service.resolveDomain(domain);
    await flush();
    expect(service.resolveDomain(domain).destinations).toEqual(['172.16.12.40']);
    fakeDns.auto = null;

    const order: string[] = [];
    const engine = createFakeEngine(order);
    // A pass asks the resolver, as the real engine does.
    engine.onReconcile = () => {
      service.resolveDomain(domain);
    };
    let refreshes = 0;
    const spawner = createFakeSpawner();
    const monitor = createNetworkMonitor({
      engine,
      netinfo: { invalidate: () => undefined },
      dns: {
        refreshAll: () => {
          refreshes += 1;
          service.refreshAll();
        },
      },
      runner: createFakeCommandRunner(),
      spawner,
      logger: createLogger({ sinks: [memory.sink], now: scheduler.now }),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      now: () => scheduler.now().getTime(),
      monotonicNow: () => scheduler.now().getTime() - NOW.getTime() + MONOTONIC_START,
    });
    monitor.start();

    const dropped = (): LogEntry[] => memory.entries.filter((entry) => entry.msg === 'no answer for too long; the last known addresses are dropped');
    let droppedAt: number | null = null;
    const seventyMinutes = 70 * 60_000;
    for (let elapsed = 0; elapsed < seventyMinutes; elapsed += 1000) {
      if (elapsed % 2000 === 0) spawner.current().print(IFINFO);
      scheduler.advance(1000);
      await flush();
      if (droppedAt === null && dropped().length > 0) droppedAt = elapsed + 1000;
    }

    expect(engine.calls.length).toBeGreaterThan(2000);
    // Never more often than once per lookup timeout.
    expect(refreshes).toBeLessThanOrEqual(seventyMinutes / LOOKUP_TIMEOUT_MS + 1);
    expect(dropped()).toHaveLength(1);
    expect(droppedAt).not.toBeNull();
    expect(droppedAt ?? Infinity).toBeLessThanOrEqual(STALE_FLOOR_MS + 2 * LOOKUP_TIMEOUT_MS);
    expect(service.resolveDomain(domain).destinations).toEqual([]);
    monitor.stop();
    service.stop();
  });

  it('control: refreshAll() on every 2-second change would keep the addresses forever', async () => {
    const { scheduler, fakeDns, service, memory } = dnsSetup();
    fakeDns.auto = () => ['172.16.12.40'];
    service.resolveDomain(domain);
    await flush();
    fakeDns.auto = null;
    for (let elapsed = 0; elapsed < 70 * 60_000; elapsed += 2000) {
      service.refreshAll();
      scheduler.advance(2000);
      await flush();
    }
    expect(memory.entries.filter((entry) => entry.msg === 'no answer for too long; the last known addresses are dropped')).toEqual([]);
    expect(service.resolveDomain(domain).destinations).toEqual(['172.16.12.40']);
    service.stop();
  });
});

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

describe('network monitor: drift check', () => {
  it('runs netstat every 60 s and nothing else while every applied route is in the table', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, { stdout: table(ROW_HOST, ROW_NET) });
    await h.pass(DRIFT_INTERVAL_MS - 1000, 1000);
    expect(h.netstatCalls()).toBe(0);
    await h.pass(1000);
    expect(h.netstatCalls()).toBe(1);
    await h.pass(4 * DRIFT_INTERVAL_MS, 1000);

    expect(h.netstatCalls()).toBe(5);
    expect(h.runner.calls.map((call) => [call.bin, call.args, call.options])).toEqual(
      Array.from({ length: 5 }, () => ['/usr/sbin/netstat', ['-rn', '-f', 'inet'], { timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 }]),
    );
    expect(h.engine.calls).toEqual([]);
    expect(h.engine.forgotten).toEqual([]);
    // No interface detection was asked for: neither invalidate nor a reconcile.
    expect(h.order).toEqual([]);
  });

  it('runs no command at all while nothing is applied', async () => {
    const h = setup();
    h.monitor.start();
    await h.pass(5 * DRIFT_INTERVAL_MS, 1000);
    expect(h.runner.calls).toEqual([]);
    expect(h.engine.calls).toEqual([]);
  });

  it.each([
    ['missing', table(ROW_NET)],
    ['other-gateway', table(`172.16.12.40       ${WIFI_GW}          UGHS                  en0`, ROW_NET)],
    ['connected', table('172.16.12.40       link#15            UHS                   en5', ROW_NET)],
  ])('reports a route that is %s to the engine and reconciles drift-check', async (found, stdout) => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, { stdout });
    await h.pass(DRIFT_INTERVAL_MS, 1000);

    expect(h.engine.forgotten).toEqual([[{ dst: '172.16.12.40', gateway: ETH_GW, found }]]);
    expect(h.engine.calls).toEqual([{ reason: 'drift-check', options: {} }]);
    expect(h.logs('warn', 'route drift detected')[0]?.context).toMatchObject({ drifted: 1, forgotten: 1 });
    // Not a network change: the interface cache stays.
    expect(h.order).toEqual(['reconcile:drift-check']);
  });

  it.each([
    ['netstat fails', { exitCode: 1 }],
    ['netstat times out', { failure: 'timeout', exitCode: null }],
    ['the output is not a table', { stdout: 'garbage\n' }],
  ] as const)('decides nothing when %s', async (_name, response) => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, response);
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.netstatCalls()).toBe(1);
    expect(h.engine.forgotten).toEqual([]);
    expect(h.engine.calls).toEqual([]);
    expect(h.entries.filter((entry) => entry.level === 'warn' && entry.msg.startsWith('drift check skipped'))).toHaveLength(1);
  });

  it('decides nothing when a pass ran or runs while netstat was reading', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    h.runner.whenMatching(() => {
      h.engine.seq += 1;
      return { stdout: table(ROW_NET) };
    });
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.engine.forgotten).toEqual([]);

    h.runner.whenMatching(() => {
      h.engine.reconciling = true;
      return { stdout: table(ROW_NET) };
    });
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.engine.forgotten).toEqual([]);
    // And a check that comes while a pass runs does not even start netstat.
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.netstatCalls()).toBe(2);
    expect(h.engine.calls).toEqual([]);
  });

  it('re-adds a route deleted from the table, through the real engine, without detecting interfaces on clean checks', async () => {
    const scheduler = createFakeScheduler(NOW);
    const spawner = createFakeSpawner();
    const runner = createFakeCommandRunner();
    const logger = createLogger({ sinks: [], now: scheduler.now });
    let detections = 0;
    const netinfo: NetInfo = {
      detectInterfaces: () => {
        detections += 1;
        return Promise.resolve(NETWORK);
      },
      invalidate: () => undefined,
    };
    const adds: string[] = [];
    const engine = createEngine({
      netinfo,
      routes: {
        routeAdd: (request) => {
          adds.push(request.dst);
          return Promise.resolve({ ok: true, outcome: 'added', dst: request.dst, kind: request.dst.includes('/') ? 'net' : 'host', gateway: request.gateway });
        },
        routeDelete: () => Promise.reject(new Error('no delete expected')),
      },
      logger,
      helperVersion: '0.0.0',
      initialConfig: config([HOST, NET]),
      now: scheduler.now,
    });
    await engine.reconcile('startup');
    expect(adds).toEqual(['172.16.12.40', '172.16.0.0/12']);
    const monitor = createNetworkMonitor({
      engine,
      netinfo,
      runner,
      spawner,
      logger,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      now: () => scheduler.now().getTime(),
      monotonicNow: () => scheduler.now().getTime() - NOW.getTime() + MONOTONIC_START,
    });
    monitor.start();
    const advance = async (ms: number): Promise<void> => {
      for (let done = 0; done < ms; done += 1000) {
        scheduler.advance(1000);
        await flush();
      }
    };

    runner.when('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { stdout: table(ROW_HOST, ROW_NET) });
    await advance(5 * DRIFT_INTERVAL_MS);
    expect(detections).toBe(1);
    expect(adds).toHaveLength(2);

    // Someone deletes the host route.
    runner.when('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { stdout: table(ROW_NET) });
    await advance(DRIFT_INTERVAL_MS);
    expect(adds).toEqual(['172.16.12.40', '172.16.0.0/12', '172.16.12.40']);
    expect(engine.getApplied().map((route) => route.dst).sort()).toEqual(['172.16.0.0/12', '172.16.12.40']);
    expect(engine.getState().lastReconcileReason).toBe('drift-check');
    expect(detections).toBe(2);
    monitor.stop();
  });

  it('retries refused or failing routes every 10th check only', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.needs = { deferred: 0, refused: 1, failing: 0, learnedExpired: 0 };
    await h.pass((RETRY_EVERY_DRIFT_CHECKS - 1) * DRIFT_INTERVAL_MS, 1000);
    expect(h.engine.calls).toEqual([]);
    await h.pass(DRIFT_INTERVAL_MS, 1000);
    expect(h.engine.calls).toEqual([{ reason: 'drift-check', options: { retryRefused: true } }]);

    h.engine.needs = { deferred: 0, refused: 0, failing: 2, learnedExpired: 0 };
    await h.pass(RETRY_EVERY_DRIFT_CHECKS * DRIFT_INTERVAL_MS, 1000);
    expect(h.engine.calls).toHaveLength(2);

    h.engine.needs = { deferred: 0, refused: 0, failing: 0, learnedExpired: 0 };
    await h.pass(2 * RETRY_EVERY_DRIFT_CHECKS * DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toHaveLength(2);
  });

  it('reconciles with a fresh detection while routes are deferred, less and less often', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.needs = { deferred: 3, refused: 0, failing: 0, learnedExpired: 0 };
    const at: number[] = [];
    for (let check = 1; check <= 40; check += 1) {
      const before = h.engine.calls.length;
      await h.pass(DRIFT_INTERVAL_MS, 5000);
      if (h.engine.calls.length > before) at.push(check);
    }
    expect(DEFERRED_RETRY_MAX_CHECKS).toBe(10);
    expect(at).toEqual([1, 3, 7, 15, 25, 35]);
    expect(h.engine.calls.every((call) => call.reason === 'drift-check' && call.options?.force === true)).toBe(true);

    // Nothing deferred any more: back to nothing, and the next deferral starts from every check.
    h.engine.needs = { deferred: 0, refused: 0, failing: 0, learnedExpired: 0 };
    await h.pass(DRIFT_INTERVAL_MS, 5000);
    const count = h.engine.calls.length;
    h.engine.needs = { deferred: 1, refused: 0, failing: 0, learnedExpired: 0 };
    await h.pass(DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toHaveLength(count + 1);
  });

  it('runs one pass for drift, refusals and deferrals found by the same check', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.applied = APPLIED;
    stubNetstat(h, { stdout: table(ROW_HOST, ROW_NET) });
    await h.pass((RETRY_EVERY_DRIFT_CHECKS - 1) * DRIFT_INTERVAL_MS, 5000);
    stubNetstat(h, { stdout: table(ROW_HOST) });
    h.engine.needs = { deferred: 1, refused: 1, failing: 0, learnedExpired: 0 };
    await h.pass(DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toEqual([{ reason: 'drift-check', options: { retryRefused: true, force: true } }]);
  });

  it('reconciles on every check while learned addresses have expired (wildcard rules)', async () => {
    const h = setup();
    h.monitor.start();
    h.engine.needs = { deferred: 0, refused: 0, failing: 0, learnedExpired: 2 };
    await h.pass(DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toEqual([{ reason: 'drift-check', options: {} }]);
    expect(h.logs('debug', 'reconcile requested by the monitor finished')[0]?.context).toMatchObject({ why: ['learned-expired'] });

    h.engine.needs = { deferred: 0, refused: 0, failing: 0, learnedExpired: 0 };
    await h.pass(3 * DRIFT_INTERVAL_MS, 5000);
    expect(h.engine.calls).toHaveLength(1);
  });

  it('hears of every pass end, also of the dns-learned passes the engine announces coalesced', () => {
    const h = setup();
    h.monitor.start();
    expect(h.engine.subscriptions).toEqual([{ everyPass: true }]);
  });

  it('removes an expired learned route through the real engine on the drift timer', async () => {
    const scheduler = createFakeScheduler(NOW);
    const runner = createFakeCommandRunner();
    const logger = createLogger({ sinks: [], now: scheduler.now });
    const netinfo: NetInfo = { detectInterfaces: () => Promise.resolve(NETWORK), invalidate: () => undefined };
    const calls: string[] = [];
    const wildcard: Rule = { id: ruleId(40), enabled: true, kind: 'domain', target: '*.corp.local', iface: 'ethernet', refreshSec: 600 };
    const engine = createEngine({
      netinfo,
      routes: {
        routeAdd: (request) => {
          calls.push(`add ${request.dst}`);
          return Promise.resolve({ ok: true, outcome: 'added', dst: request.dst, kind: 'host', gateway: request.gateway });
        },
        routeDelete: (request) => {
          calls.push(`delete ${request.dst}`);
          return Promise.resolve({ ok: true, outcome: 'deleted', dst: request.dst, kind: 'host' });
        },
      },
      logger,
      helperVersion: '0.0.0',
      initialConfig: config([wildcard]),
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    await engine.reconcile('startup');
    const monitor = createNetworkMonitor({
      engine,
      netinfo,
      runner,
      spawner: createFakeSpawner(),
      logger,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      now: () => scheduler.now().getTime(),
      monotonicNow: () => scheduler.now().getTime() - NOW.getTime() + MONOTONIC_START,
    });
    monitor.start();
    const learned = engine.learn(ruleId(40), ['172.16.20.1'], 60);
    await flush();
    expect((await learned).outcome).toBe('applied');
    expect(calls).toEqual(['add 172.16.20.1']);
    runner.when('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { stdout: table('172.16.20.1        10.20.4.1          UGHS           en5') });

    for (let done = 0; done < 14 * DRIFT_INTERVAL_MS; done += 5000) {
      scheduler.advance(5000);
      await flush();
    }
    expect(calls).toEqual(['add 172.16.20.1']);
    for (let done = 0; done < 2 * DRIFT_INTERVAL_MS; done += 5000) {
      scheduler.advance(5000);
      await flush();
    }
    expect(calls).toEqual(['add 172.16.20.1', 'delete 172.16.20.1']);
    expect(engine.getApplied()).toEqual([]);
    monitor.stop();
  });
});
