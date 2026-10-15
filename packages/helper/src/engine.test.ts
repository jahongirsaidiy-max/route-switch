import {
  Config,
  EngineState,
  LEARNED_ROUTE_LIMITS,
  RECONCILE_REASONS,
  parseIpv4Destination,
  type ReconcileReason,
  type Rule,
} from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  CLEAR_CONCURRENCY,
  DEGRADED_ACCEPT_AFTER,
  DNS_LOOKUP_CONCURRENCY,
  DNS_LOSS_GRACE,
  FAILURE_BACKOFF_AFTER,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_MAX_MS,
  LEARN_WAIT_MAX_MS,
  MAX_APPLIED_ROUTES,
  MAX_EXCLUDED_DNS_PER_ROLE,
  MAX_EXCLUDED_DNS_SERVERS,
  MAX_EXCLUDED_OTHER_DNS,
  REFUSAL_RETRY_REASONS,
  STATE_ANNOUNCE_MIN_INTERVAL_MS,
  buildEngineState,
  createEngine,
  findConnectedConflict,
  guardCoversEveryRole,
  unresolvedDomain,
  type AppliedRoute,
  type DomainContext,
  type DomainResolver,
  type DomainTargets,
  type Engine,
  type EngineDeps,
  type GuardFacts,
  type ReconcileOutcome,
  type ResolverSync,
  type RetryRequest,
} from './engine';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import { createNetInfo, type DetectOptions, type DetectedInterfaces, type InterfaceInfo, type NetInfo } from './netinfo';
import {
  createRouteOperations,
  type RouteAddRequest,
  type RouteAddResult,
  type RouteDeleteRequest,
  type RouteDeleteResult,
  type RouteGetResult,
} from './route';
import { createFakeCommandRunner, type FakeCommandResponse } from './test-utils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ETH_GW = '10.20.4.1';
const WIFI_GW = '192.168.1.1';
const NOW = new Date('2026-10-12T08:30:00.000Z');

const ruleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rule = (n: number, kind: Rule['kind'], target: string, iface: Rule['iface'], extra: Partial<Rule> = {}): Rule => ({
  id: ruleId(n),
  enabled: true,
  kind,
  target,
  iface,
  refreshSec: 600,
  ...extra,
});

/** A config that went through the schema, as the engine normally receives it. */
const config = (rules: readonly Rule[], extra: Partial<Config> = {}): Config =>
  Config.parse({ version: 1, enabled: true, rules, ...extra });

/** A config that skips the schema, to prove the engine does not rely on it. */
const rawConfig = (rules: readonly Rule[]): Config => ({ version: 1, enabled: true, rules: [...rules] });

const iface = (role: InterfaceInfo['role'], extra: Partial<InterfaceInfo> = {}): InterfaceInfo => {
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
    ...extra,
  };
};

const down = (role: InterfaceInfo['role'], reason: InterfaceInfo['reason'] = 'no-address'): InterfaceInfo =>
  iface(role, { ip: null, gateway: null, netmask: null, subnet: null, up: false, routable: false, reason });

const noGateway = (role: InterfaceInfo['role']): InterfaceInfo =>
  iface(role, { gateway: null, routable: false, reason: 'no-gateway' });

const network = (extra: Partial<DetectedInterfaces> = {}): DetectedInterfaces => {
  const ethernet = extra.ethernet ?? iface('ethernet');
  const wifi = extra.wifi ?? iface('wifi');
  return {
    ethernet,
    wifi,
    adapters: [ethernet, wifi].flatMap((info) =>
      info.device === null ? [] : [{ device: info.device, port: info.port ?? 'Port', ip: info.ip }],
    ),
    degraded: extra.degraded ?? false,
  };
};

interface Deferred {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

const deferred = (): Deferred => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

interface FakeNetInfo extends NetInfo {
  /** What the next detections return; the last entry repeats. A function is called (and may throw). */
  results: (DetectedInterfaces | (() => DetectedInterfaces))[];
  readonly calls: DetectOptions[];
  /** When set, a detection waits for it. */
  gate: Deferred | null;
}

const createFakeNetInfo = (...results: FakeNetInfo['results']): FakeNetInfo => {
  const fake: FakeNetInfo = {
    results: results.length === 0 ? [network()] : results,
    calls: [],
    gate: null,
    detectInterfaces: async (options = {}) => {
      fake.calls.push(options);
      if (fake.gate !== null) await fake.gate.promise;
      const next = fake.results.length > 1 ? fake.results.shift() : fake.results[0];
      if (next === undefined) throw new Error('no detection result configured');
      return typeof next === 'function' ? next() : next;
    },
    invalidate: () => undefined,
  };
  return fake;
};

interface RouteCall {
  readonly op: 'add' | 'delete';
  readonly dst: string;
  readonly gateway: string | undefined;
}

interface FakeRoutes {
  readonly calls: RouteCall[];
  onAdd: (request: RouteAddRequest) => RouteAddResult | Promise<RouteAddResult>;
  onDelete: (request: RouteDeleteRequest) => RouteDeleteResult | Promise<RouteDeleteResult>;
  routeAdd(request: RouteAddRequest): Promise<RouteAddResult>;
  routeDelete(request: RouteDeleteRequest): Promise<RouteDeleteResult>;
}

const kindOf = (dst: string): 'host' | 'net' => (dst.includes('/') ? 'net' : 'host');

const added = (request: RouteAddRequest, outcome: 'added' | 'replaced' | 'exists' = 'added'): RouteAddResult => ({
  ok: true,
  outcome,
  dst: request.dst,
  kind: kindOf(request.dst),
  gateway: request.gateway,
});

const addFailed = (step: 'add' | 'delete' | 're-add', message = 'Network is unreachable'): RouteAddResult => ({
  ok: false,
  outcome: 'failed',
  step,
  failure: 'nonzero-exit',
  exitCode: 1,
  stdout: '',
  stderr: `route: writing to routing socket: ${message}\n`,
  message,
});

/** What the wrapper returns when "File exists" turned out to be something it must not delete. */
const inspectFailed = (failure: 'connected-route' | 'existing-route-unknown', message: string): RouteAddResult => ({
  ok: false,
  outcome: 'failed',
  step: 'inspect',
  failure,
  exitCode: 0,
  stdout: '',
  stderr: '',
  message,
});

const deleted = (request: RouteDeleteRequest, outcome: 'deleted' | 'not-found' = 'deleted'): RouteDeleteResult => ({
  ok: true,
  outcome,
  dst: request.dst,
  kind: kindOf(request.dst),
});

/** The wrapper found something else at the destination and deleted nothing. */
const notOurs = (request: RouteDeleteRequest, reason: 'connected' | 'other-gateway'): RouteDeleteResult => ({
  ok: true,
  outcome: 'not-ours',
  dst: request.dst,
  kind: kindOf(request.dst),
  reason,
  message: `the entry for ${request.dst} is not the expected route and was left in place`,
});

/** The wrapper could not tell what is at the destination and deleted nothing. */
const deleteUnidentified = (dst: string): RouteDeleteResult => ({
  ok: false,
  outcome: 'failed',
  step: 'inspect',
  failure: 'existing-route-unknown',
  exitCode: null,
  stdout: '',
  stderr: '',
  message: `the route for ${dst} could not be identified and was left in place: route get failed: timeout`,
});

const deleteFailed = (message = 'Operation not permitted'): RouteDeleteResult => ({
  ok: false,
  outcome: 'failed',
  step: 'delete',
  failure: 'nonzero-exit',
  exitCode: 1,
  stdout: '',
  stderr: `route: writing to routing socket: ${message}\n`,
  message,
});

const createFakeRoutes = (): FakeRoutes => {
  const fake: FakeRoutes = {
    calls: [],
    onAdd: (request) => added(request),
    onDelete: (request) => deleted(request),
    routeAdd: async (request) => {
      fake.calls.push({ op: 'add', dst: request.dst, gateway: request.gateway });
      return fake.onAdd(request);
    },
    routeDelete: async (request) => {
      fake.calls.push({ op: 'delete', dst: request.dst, gateway: request.gateway });
      return fake.onDelete(request);
    },
  };
  return fake;
};

interface Harness {
  readonly engine: Engine;
  readonly netinfo: FakeNetInfo;
  readonly routes: FakeRoutes;
  readonly entries: readonly LogEntry[];
  readonly retries: RetryRequest[];
  /** Reconciles and checks the resulting state against the wire schema. */
  run(reason?: ReconcileReason): Promise<ReconcileOutcome>;
  /** Route calls made since the previous `take()`. */
  take(): RouteCall[];
}

const expectValid = (state: EngineState): void => {
  const parsed = EngineState.safeParse(state);
  expect(parsed.success).toBe(true);
  // Parsing changes nothing: every value is already in its canonical form.
  expect(parsed.data).toEqual(state);
};

const setup = (
  initialConfig: Config,
  options: { netinfo?: FakeNetInfo; deps?: Partial<EngineDeps> } = {},
): Harness => {
  const memory = createMemorySink();
  const netinfo = options.netinfo ?? createFakeNetInfo();
  const routes = createFakeRoutes();
  const retries: RetryRequest[] = [];
  const engine = createEngine({
    netinfo,
    routes,
    logger: createLogger({ sinks: [memory.sink] }),
    helperVersion: '1.2.3',
    initialConfig,
    now: () => NOW,
    scheduleRetry: (request) => retries.push(request),
    ...options.deps,
  });
  let taken = 0;
  return {
    engine,
    netinfo,
    routes,
    entries: memory.entries,
    retries,
    run: async (reason = 'manual') => {
      const outcome = await engine.reconcile(reason);
      expectValid(outcome.state);
      expect(engine.getState()).toBe(outcome.state);
      return outcome;
    },
    take: () => {
      const fresh = routes.calls.slice(taken);
      taken = routes.calls.length;
      return fresh;
    },
  };
};

const add = (dst: string, gateway: string): RouteCall => ({ op: 'add', dst, gateway });
const del = (dst: string, gateway: string): RouteCall => ({ op: 'delete', dst, gateway });

const engineLogs = (entries: readonly LogEntry[], level: LogEntry['level'], msg?: string): LogEntry[] =>
  entries.filter(
    (entry) =>
      entry.level === level && entry.context?.['component'] === 'engine' && (msg === undefined || entry.msg === msg),
  );

const ruleState = (outcome: ReconcileOutcome, n: number) => {
  const found = outcome.state.rules.find((entry) => entry.ruleId === ruleId(n));
  if (found === undefined) throw new Error(`no state for rule ${String(n)}`);
  return found;
};

const HOST = rule(1, 'ip', '172.16.12.40', 'ethernet');
const NET = rule(2, 'subnet', '172.16.0.0/12', 'ethernet');
const WIFI_HOST = rule(3, 'ip', '203.0.113.7', 'wifi');
/** The same destination as `HOST` under an id that never collides with a rule numbered 1..6. */
const OTHER = rule(7, 'ip', '172.16.12.40', 'ethernet');
const HOST_B = rule(9, 'ip', '172.16.12.41', 'ethernet');
/** Fails a test that reaches for an outcome that was never produced. */
const clean = (): never => {
  throw new Error('expected outcome is missing');
};

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe('reconcile: desired vs applied', () => {
  it('adds every route on the first apply and reports the rules as active', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.0.0/12', ETH_GW), add('203.0.113.7', WIFI_GW)]);
    expect(outcome.summary).toEqual({ added: 3, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(outcome.retryRequested).toBe(false);
    expect(outcome.state).toEqual({
      helperVersion: '1.2.3',
      seq: 1,
      configRevision: 0,
      enabled: true,
      interfaces: {
        ethernet: { device: 'en5', ip: '10.20.4.23', gateway: ETH_GW, up: true },
        wifi: { device: 'en0', ip: '192.168.1.23', gateway: WIFI_GW, up: true },
      },
      adapters: [
        { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.23' },
        { device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' },
      ],
      rules: [
        { ruleId: ruleId(1), status: 'active', reasonCode: null, reason: null, appliedDestinations: ['172.16.12.40'], lastResolvedAt: null },
        { ruleId: ruleId(2), status: 'active', reasonCode: null, reason: null, appliedDestinations: ['172.16.0.0/12'], lastResolvedAt: null },
        { ruleId: ruleId(3), status: 'active', reasonCode: null, reason: null, appliedDestinations: ['203.0.113.7'], lastResolvedAt: null },
      ],
      lastApplyAt: NOW.toISOString(),
      lastReconcileReason: 'startup',
    });
  });

  it('runs no route command when nothing changed', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();

    const outcome = await h.run('drift-check');

    expect(h.take()).toEqual([]);
    expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(outcome.state.lastReconcileReason).toBe('drift-check');
    expect(ruleState(outcome, 1).status).toBe('active');
  });

  it('deletes only the route of a rule that was removed', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();

    h.engine.setConfig(config([NET]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => entry.ruleId)).toEqual([ruleId(2)]);
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.0.0/12', gateway: ETH_GW, ruleIds: [ruleId(2)] }]);
  });

  it('adds only the route of a rule that is new', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    h.engine.setConfig(config([HOST, NET]));
    await h.run('config-change');

    expect(h.take()).toEqual([add('172.16.0.0/12', ETH_GW)]);
  });

  it('replaces a route whose gateway changed: every delete before any add', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));
    await h.run();
    h.take();

    h.netinfo.results = [network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }) })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([
      del('172.16.12.40', ETH_GW),
      del('172.16.0.0/12', ETH_GW),
      add('172.16.12.40', '10.20.4.254'),
      add('172.16.0.0/12', '10.20.4.254'),
    ]);
    expect(outcome.summary).toEqual({ added: 2, removed: 2, failed: 0, kept: 0, deferred: 0 });
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    expect(engineLogs(h.entries, 'warn')).toEqual([]);
  });

  it('removes what is no longer wanted before adding what is new', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    h.engine.setConfig(config([NET]));
    await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.0.0/12', ETH_GW)]);
  });

  it('moves a rule to the other interface with a delete and an add', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    h.engine.setConfig(config([{ ...HOST, iface: 'wifi' }]));
    await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.40', WIFI_GW)]);
  });

  it('passes the interface overrides of the config to every detection', async () => {
    const h = setup(config([HOST], { ifaceOverrides: { ethernet: 'en7' } }));

    await h.run();

    expect(h.netinfo.calls).toEqual([{ overrides: { ethernet: 'en7' }, force: false }]);
  });
});

describe('reconcile: rules that cannot be applied now', () => {
  it('marks the rules of an unplugged interface pending and removes their routes', async () => {
    const h = setup(config([HOST, WIFI_HOST]));
    await h.run();
    h.take();

    h.netinfo.results = [network({ ethernet: down('ethernet') })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'pending',
      reasonCode: 'interface-down',
      reason: 'The ethernet interface is not connected',
      appliedDestinations: [],
      lastResolvedAt: null,
    });
    expect(ruleState(outcome, 3).status).toBe('active');
    expect(outcome.state.interfaces.ethernet).toEqual({ device: 'en5', ip: null, gateway: null, up: false });
  });

  it('marks the rules of an interface without a gateway pending and removes their routes', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    h.netinfo.results = [network({ ethernet: noGateway('ethernet') })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'pending', reasonCode: 'no-gateway', appliedDestinations: [] });
    expect(outcome.state.interfaces.ethernet.up).toBe(true);
  });

  it('applies the routes again when the interface comes back', async () => {
    const h = setup(config([HOST]), { netinfo: createFakeNetInfo(network({ ethernet: down('ethernet', 'no-device') })) });
    const first = await h.run();
    expect(h.take()).toEqual([]);
    expect(ruleState(first, 1).reasonCode).toBe('interface-down');

    h.netinfo.results = [network()];
    const second = await h.run('network-change');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(second, 1).status).toBe('active');
  });

  it('judges an interface by `routable`, whatever its `reason` says', async () => {
    // A detection that is not degraded is trusted even with a failure-like reason.
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    h.netinfo.results = [network({ ethernet: down('ethernet', 'address-lookup-failed') })];
    const outcome = await h.run();

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(outcome.retryRequested).toBe(false);
  });

  it('removes the route of a disabled rule', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();

    h.engine.setConfig(config([{ ...HOST, enabled: false }, NET]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'disabled',
      reasonCode: 'rule-disabled',
      reason: null,
      appliedDestinations: [],
      lastResolvedAt: null,
    });
    expect(ruleState(outcome, 2).status).toBe('active');
  });

  it('removes every route when the global toggle goes off and restores them when it comes back', async () => {
    const h = setup(config([HOST, NET, { ...WIFI_HOST, enabled: false }]));
    await h.run();
    h.take();

    expect(h.engine.setEnabled(false)).toBe(true);
    const off = await h.run('enabled-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW)]);
    expect(off.state.enabled).toBe(false);
    expect(off.state.rules.map((entry) => [entry.status, entry.reasonCode, entry.appliedDestinations])).toEqual([
      ['disabled', 'globally-disabled', []],
      ['disabled', 'globally-disabled', []],
      ['disabled', 'rule-disabled', []],
    ]);
    expect(h.engine.getApplied()).toEqual([]);

    h.engine.setEnabled(true);
    await h.run('enabled-change');
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.0.0/12', ETH_GW)]);
  });

  it('never adds a route for a config that starts disabled', async () => {
    const h = setup(config([HOST], { enabled: false }));

    const outcome = await h.run('startup');

    expect(h.routes.calls).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'disabled', reasonCode: 'globally-disabled' });
  });
});

// ---------------------------------------------------------------------------
// Safety rules
// ---------------------------------------------------------------------------

describe('reconcile: only its own routes', () => {
  it('runs no command at all for an empty config', async () => {
    const h = setup(config([]));

    const outcome = await h.run('startup');

    expect(h.routes.calls).toEqual([]);
    expect(outcome.state.rules).toEqual([]);
  });

  it('never deletes a route it failed to add', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () => addFailed('add');
    await h.run();
    h.take();

    h.engine.setConfig(config([]));
    await h.run('config-change');

    expect(h.take()).toEqual([]);
  });

  it('deletes exactly the applied routes, each once, when everything is switched off', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));
    h.routes.onAdd = (request) => (request.dst === '172.16.0.0/12' ? addFailed('add') : added(request));
    await h.run();
    h.take();

    h.engine.setEnabled(false);
    await h.run('enabled-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('203.0.113.7', WIFI_GW)]);
  });
});

describe('reconcile: forbidden destinations', () => {
  it.each([
    ['ip', '127.0.0.1', 'loopback'],
    ['ip', '0.0.0.0', 'default-route'],
    ['subnet', '0.0.0.0/0', 'default-route'],
    ['subnet', '224.0.0.0/4', 'multicast'],
    ['subnet', '169.254.0.0/16', 'link-local'],
    ['ip', '255.255.255.255', 'broadcast'],
    ['subnet', '64.0.0.0/2', 'prefix-too-wide'],
    ['ip', 'default', 'default-route'],
    ['ip', 'not-an-address', 'invalid-destination'],
    ['ip', '::1', 'invalid-destination'],
  ] as const)('refuses %s %s before any route command (%s)', async (kind, target, code) => {
    const h = setup(rawConfig([rule(1, kind, target, 'ethernet'), OTHER]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason: `Destination must never be routed (${code})`,
      appliedDestinations: [],
    });
  });

  it('reports a forbidden target as an error even while its interface is down', async () => {
    const h = setup(rawConfig([rule(1, 'ip', '127.0.0.1', 'ethernet')]), {
      netinfo: createFakeNetInfo(network({ ethernet: down('ethernet') })),
    });

    const outcome = await h.run();

    expect(ruleState(outcome, 1).reasonCode).toBe('forbidden-destination');
  });
});

describe('connected-subnet guard', () => {
  const destination = (text: string) => {
    const parsed = parseIpv4Destination(text);
    if (parsed === null) throw new Error(`bad fixture ${text}`);
    return parsed;
  };
  const interfaces = [iface('ethernet'), iface('wifi')];

  it.each([
    ['192.168.1.0/24', 'wifi', 'equals-subnet'],
    ['192.168.1.77/24', 'wifi', 'equals-subnet'],
    ['10.20.4.0/24', 'ethernet', 'equals-subnet'],
    ['10.20.4.1', 'ethernet', 'gateway'],
    ['192.168.1.1', 'wifi', 'gateway'],
    ['10.20.4.23', 'ethernet', 'own-address'],
    ['192.168.1.0/25', 'wifi', 'gateway'],
    ['10.20.4.16/28', 'ethernet', 'own-address'],
  ] as const)('%s conflicts with %s (%s)', (text, role, kind) => {
    expect(findConnectedConflict(destination(text), interfaces)).toEqual({ role, kind });
  });

  it.each(['10.0.0.0/8', '10.20.0.0/16', '10.20.4.0/23', '192.168.0.0/16', '192.0.0.0/8'])(
    '%s is allowed: a block wider than a connected subnet is a separate table entry',
    (text) => {
      expect(findConnectedConflict(destination(text), interfaces)).toBeNull();
    },
  );

  it.each(['192.168.1.50', '192.168.1.128/25', '10.20.4.200', '172.16.0.0/12', '192.168.2.0/24', '10.20.5.0/24', '10.0.0.0'])(
    '%s is allowed',
    (text) => {
      expect(findConnectedConflict(destination(text), interfaces)).toBeNull();
    },
  );

  it('checks only the address and the gateway of an interface whose subnet is unknown', () => {
    const unknown = [iface('ethernet', { subnet: null, netmask: null })];

    expect(findConnectedConflict(destination('10.0.0.0/8'), unknown)).toBeNull();
    expect(findConnectedConflict(destination('10.20.4.0/24'), unknown)).toBeNull();
    expect(findConnectedConflict(destination('10.20.4.1'), unknown)).toEqual({ role: 'ethernet', kind: 'gateway' });
    expect(findConnectedConflict(destination('10.20.4.23'), unknown)).toEqual({ role: 'ethernet', kind: 'own-address' });
  });

  it('ignores an interface that is down', () => {
    expect(findConnectedConflict(destination('10.0.0.0/8'), [down('ethernet'), iface('wifi')])).toBeNull();
  });

  it.each([
    ['its own interface', rule(1, 'subnet', '10.20.4.0/24', 'ethernet'), 'ethernet'],
    ['the other interface', rule(1, 'subnet', '192.168.1.0/24', 'ethernet'), 'wifi'],
  ])('never calls routeAdd for a destination equal to the connected subnet of %s', async (_name, guarded, role) => {
    const h = setup(config([guarded, OTHER]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'error',
      reasonCode: 'connected-network',
      reason: `${guarded.target} is the subnet the interface is directly connected to (${role})`,
      appliedDestinations: [],
      lastResolvedAt: null,
    });
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
  });

  it('flagship case: routes 10.0.0.0/8 through ethernet while the Mac itself sits in 10.20.4.0/24', async () => {
    const h = setup(config([rule(1, 'subnet', '10.0.0.0/8', 'ethernet')]));

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([add('10.0.0.0/8', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'active',
      reasonCode: null,
      reason: null,
      appliedDestinations: ['10.0.0.0/8'],
      lastResolvedAt: null,
    });
    expect(engineLogs(h.entries, 'warn')).toEqual([]);
  });

  it.each([
    ['the Wi-Fi subnet, through wifi', rule(1, 'subnet', '192.168.0.0/16', 'wifi'), WIFI_GW],
    ['the subnet of the other role (10.0.0.0/8 through wifi)', rule(1, 'subnet', '10.0.0.0/8', 'wifi'), WIFI_GW],
    ['the Wi-Fi subnet, through ethernet', rule(1, 'subnet', '192.168.0.0/16', 'ethernet'), ETH_GW],
  ])('applies a wider block that contains %s', async (_name, wide, gateway) => {
    const h = setup(config([wide]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add(wide.target, gateway)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: [wide.target] });
  });

  it('routes a host that lies strictly inside a connected subnet through the other interface', async () => {
    const h = setup(config([rule(1, 'ip', '192.168.1.50', 'ethernet'), rule(2, 'subnet', '192.168.1.128/25', 'ethernet')]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('192.168.1.50', ETH_GW), add('192.168.1.128/25', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => entry.status)).toEqual(['active', 'active']);
  });

  it('refuses a block inside a connected subnet that holds the gateway of that interface', async () => {
    const h = setup(config([rule(1, 'subnet', '192.168.1.0/25', 'ethernet')]));

    const outcome = await h.run();

    expect(h.routes.calls).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'connected-network',
      reason: '192.168.1.0/25 holds the gateway of the interface (wifi)',
    });
  });

  it.each([
    ['its own gateway', rule(1, 'ip', ETH_GW, 'ethernet'), `${ETH_GW} holds the gateway of the interface (ethernet)`],
    ['the gateway of the other interface', rule(1, 'ip', WIFI_GW, 'ethernet'), `${WIFI_GW} holds the gateway of the interface (wifi)`],
    ['the address of an interface', rule(1, 'ip', '192.168.1.23', 'ethernet'), '192.168.1.23 holds the address of the interface itself (wifi)'],
  ])('skips a destination that is %s, with a warning', async (_name, guarded, reason) => {
    const h = setup(config([guarded]));

    const outcome = await h.run();

    expect(h.routes.calls).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network', reason });
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied').map((entry) => entry.context?.['detail'])).toEqual([reason]);
  });

  it('skips the guard, with a warning, for an interface whose subnet is unknown', async () => {
    const unknown = network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) });
    // Equal to the subnet the interface is really in; nobody can tell without the mask.
    const h = setup(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet'), rule(2, 'ip', ETH_GW, 'ethernet')]), {
      netinfo: createFakeNetInfo(unknown),
    });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1).status).toBe('active');
    expect(ruleState(outcome, 2)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    const skipped = 'connected subnet unknown; connected-subnet guard skipped';
    expect(engineLogs(h.entries, 'warn', skipped).map((entry) => entry.context?.['role'])).toEqual(['ethernet']);

    // The condition is permanent on a static-IP network: it is not repeated at `warn`.
    await h.run('drift-check');
    expect(engineLogs(h.entries, 'warn', skipped)).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', skipped)).toHaveLength(1);
  });

  it('removes an applied route once the network it points into becomes directly connected', async () => {
    const h = setup(config([rule(1, 'subnet', '192.168.50.0/24', 'ethernet')]));
    await h.run();
    h.take();

    h.netinfo.results = [network({ wifi: iface('wifi', { ip: '192.168.50.9', gateway: '192.168.50.1', subnet: '192.168.50.0/24' }) })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('192.168.50.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
  });

  it('logs a standing rule error at warn once, then at debug', async () => {
    const h = setup(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet')]));

    await h.run();
    await h.run();

    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', 'rule cannot be applied')).toHaveLength(1);
  });
});

describe('reconcile: routeAdd results', () => {
  it('reports a rejected destination as forbidden and does not record the route', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () => ({ ok: false, outcome: 'rejected', field: 'dst', reason: 'loopback', message: 'Destination refused (loopback)' });

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason: 'Destination must never be routed (loopback)',
      appliedDestinations: [],
    });
    expect(h.engine.getApplied()).toEqual([]);
    expect(outcome.summary.failed).toBe(1);
  });

  it('reports a rejected gateway as a failed route', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () => ({ ok: false, outcome: 'rejected', field: 'gateway', reason: 'invalid-ipv4', message: 'Gateway refused' });

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: `Gateway ${ETH_GW} was refused (invalid-ipv4)`,
    });
    expect(h.engine.getApplied()).toEqual([]);
  });

  it('reports a failed add, keeps it out of applied and tries again on the next reconcile', async () => {
    const h = setup(config([HOST, NET]));
    h.routes.onAdd = (request) => (request.dst === '172.16.12.40' ? addFailed('add', 'must be root to alter routing table') : added(request));

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: 'Could not add the route for 172.16.12.40: must be root to alter routing table',
      appliedDestinations: [],
    });
    expect(ruleState(outcome, 2).status).toBe('active');
    expect(outcome.summary).toEqual({ added: 1, removed: 0, failed: 1, kept: 0, deferred: 0 });
    h.take();

    h.routes.onAdd = (request) => added(request);
    const retried = await h.run();
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(retried, 1).status).toBe('active');
  });

  it('treats a failed re-add as "the route is gone": it leaves applied even though it was there before', async () => {
    const h = setup(config([HOST]));
    await h.run();
    expect(h.engine.getApplied()).toHaveLength(1);
    h.take();

    h.netinfo.results = [network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }) })];
    h.routes.onAdd = () => addFailed('re-add');
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.40', '10.20.4.254')]);
    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: 'Replacing the route for 172.16.12.40 failed, the route is now absent: Network is unreachable',
      appliedDestinations: [],
    });
    expect(h.engine.getApplied()).toEqual([]);

    // Nothing of ours is left to delete.
    h.engine.setConfig(config([]));
    await h.run('config-change');
    expect(h.take()).toEqual([]);
  });

  it('warns when a route that was not ours got replaced', async () => {
    const h = setup(config([HOST, NET]));
    h.routes.onAdd = (request) => added(request, request.dst === '172.16.12.40' ? 'replaced' : 'added');

    const outcome = await h.run('startup');

    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    const warnings = engineLogs(h.entries, 'warn', 'existing foreign route replaced');
    expect(warnings.map((entry) => entry.context)).toEqual([
      { component: 'engine', reason: 'startup', dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] },
    ]);
  });

  it('reports a connected route the wrapper refused to delete as connected-network: not applied, one warn, then debug', async () => {
    const lan = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    // A static-IP interface: the guard does not know the subnet, so the rule reaches the wrapper.
    const h = setup(config([lan, HOST_B]), {
      netinfo: createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) })),
    });
    h.routes.onAdd = (request) =>
      request.dst === '10.20.4.0/24'
        ? inspectFailed('connected-route', 'a connected route for 10.20.4.0/24 already exists on en5 and was left in place')
        : added(request);

    const first = await h.run('startup');

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(ruleState(first, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'error',
      reasonCode: 'connected-network',
      reason: '10.20.4.0/24 is a network an interface is directly connected to; its route was left in place',
      appliedDestinations: [],
      lastResolvedAt: null,
    });
    expect(ruleState(first, 9).status).toBe('active');
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.41']);
    expect(first.summary).toEqual({ added: 1, removed: 0, failed: 1, kept: 0, deferred: 0 });
    const warnings = engineLogs(h.entries, 'warn', 'rule cannot be applied');
    expect(warnings.map((entry) => entry.context)).toEqual([
      {
        component: 'engine',
        reason: 'startup',
        ruleId: ruleId(1),
        target: '10.20.4.0/24',
        iface: 'ethernet',
        reasonCode: 'connected-network',
        detail: '10.20.4.0/24 is a network an interface is directly connected to; its route was left in place',
      },
    ]);

    // While it lasts: asked again (read-only for the wrapper), reported at debug, never deleted.
    const second = await h.run();
    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(second, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', 'rule cannot be applied')).toHaveLength(1);

    // Never ours, so removing the rule deletes nothing.
    h.engine.setConfig(config([HOST_B]));
    await h.run('config-change');
    expect(h.take()).toEqual([]);
  });

  it('reports an existing route the wrapper could not identify as route-failed and does not record it', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () =>
      inspectFailed('existing-route-unknown', 'a route for 172.16.12.40 already exists and was left in place: route get failed: timeout');

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason:
        'Could not add the route for 172.16.12.40: a route for 172.16.12.40 already exists and was left in place: route get failed: timeout',
      appliedDestinations: [],
    });
    expect(h.engine.getApplied()).toEqual([]);
    expect(outcome.summary.failed).toBe(1);

    h.engine.setConfig(config([]));
    await h.run('config-change');
    expect(h.routes.calls.filter((call) => call.op === 'delete')).toEqual([]);
  });

  it('adopts a route that was already there with the right gateway: active, applied, warned about, removed with the rule', async () => {
    const h = setup(config([HOST, NET]));
    h.routes.onAdd = (request) => added(request, request.dst === '172.16.12.40' ? 'exists' : 'added');

    const outcome = await h.run('startup');

    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: ['172.16.12.40'] });
    expect(outcome.summary).toEqual({ added: 2, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(h.engine.getApplied()).toContainEqual({ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] });
    expect(engineLogs(h.entries, 'warn').map((entry) => [entry.msg, entry.context])).toEqual([
      [
        'existing foreign route adopted',
        { component: 'engine', reason: 'startup', dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] },
      ],
    ]);
    h.take();

    // Adopted means owned: nothing on the next pass, and it goes when the rule goes.
    await h.run();
    expect(h.take()).toEqual([]);
    h.engine.setConfig(config([NET]));
    await h.run('config-change');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
  });

  it('does not warn when the replaced route was one of its own', async () => {
    const h = setup(config([HOST]));
    await h.run();

    h.netinfo.results = [network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }) })];
    h.routes.onAdd = (request) => added(request, 'replaced');
    await h.run('network-change');

    expect(engineLogs(h.entries, 'warn')).toEqual([]);
  });
});

describe('reconcile: routeDelete results', () => {
  it('counts a route that was not in the table as removed', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.routes.onDelete = (request) => deleted(request, 'not-found');

    h.engine.setConfig(config([]));
    const outcome = await h.run('config-change');

    expect(outcome.summary).toEqual({ added: 0, removed: 1, failed: 0, kept: 0, deferred: 0 });
    expect(h.engine.getApplied()).toEqual([]);
  });

  it('keeps a route whose delete failed, shows it on the rule and retries on the next reconcile', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();
    h.routes.onDelete = () => deleteFailed();

    h.engine.setConfig(config([{ ...HOST, enabled: false }, NET]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'error',
      reasonCode: 'route-failed',
      reason: 'Could not remove the route for 172.16.12.40: Operation not permitted',
      appliedDestinations: ['172.16.12.40'],
      lastResolvedAt: null,
    });
    expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 1, kept: 0, deferred: 0 });
    expect(engineLogs(h.entries, 'error').map((entry) => entry.msg)).toEqual([
      'route delete failed; the route stays applied and is retried on the next reconcile',
    ]);

    h.routes.onDelete = (request) => deleted(request);
    const retried = await h.run();
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(retried, 1)).toMatchObject({ status: 'disabled', reasonCode: 'rule-disabled', appliedDestinations: [] });
  });

  it('keeps retrying the delete for a rule that is gone from the config', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.routes.onDelete = () => deleteFailed();

    h.engine.setConfig(config([]));
    const outcome = await h.run('config-change');

    expect(outcome.state.rules).toEqual([]);
    expect(outcome.summary.failed).toBe(1);
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] }]);

    await h.run();
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.12.40', ETH_GW)]);
  });

  it('does not add the new route when the old one could not be deleted', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.routes.onDelete = () => deleteFailed();

    h.netinfo.results = [network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }) })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      appliedDestinations: ['172.16.12.40'],
    });
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] }]);
  });

  it('forgets a route the wrapper refuses to delete instead of retrying forever', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.routes.onDelete = () => ({ ok: false, outcome: 'rejected', field: 'dst', reason: 'loopback', message: 'refused' });

    h.engine.setConfig(config([]));
    await h.run('config-change');
    await h.run();

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(engineLogs(h.entries, 'error')).toHaveLength(1);
  });
});

describe('reconcile: a delete the wrapper did not carry out', () => {
  it.each(['connected', 'other-gateway'] as const)(
    'forgets a route whose entry is not ours any more (%s): out of applied, one warn, not counted as removed',
    async (found) => {
      const h = setup(config([HOST, NET]));
      await h.run('startup');
      h.take();
      h.routes.onDelete = (request) => notOurs(request, found);

      h.engine.setConfig(config([NET]));
      const outcome = await h.run('config-change');

      expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
      expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.0.0/12']);
      expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
      expect(engineLogs(h.entries, 'warn').map((entry) => [entry.msg, entry.context])).toEqual([
        [
          'applied route is no longer ours; forgotten, nothing was deleted',
          {
            component: 'engine',
            reason: 'config-change',
            dst: '172.16.12.40',
            gateway: ETH_GW,
            ruleIds: [ruleId(1)],
            found,
            detail: 'the entry for 172.16.12.40 is not the expected route and was left in place',
          },
        ],
      ]);

      // Forgotten for good: no further command, no further warning.
      await h.run();
      await h.run('drift-check');
      expect(h.take()).toEqual([]);
      expect(engineLogs(h.entries, 'warn')).toHaveLength(1);
    },
  );

  it('tells the applied-routes listener about a forgotten route', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = setup(config([HOST]), { deps: { onApplied: (routes) => void snapshots.push(routes) } });
    await h.run('startup');
    h.routes.onDelete = (request) => notOurs(request, 'connected');

    h.engine.setConfig(config([]));
    await h.run('config-change');

    expect(snapshots.map((routes) => routes.map((route) => route.dst))).toEqual([['172.16.12.40'], []]);
  });

  it('a forgotten route whose rule still wants it through a new gateway is asked for again, and a connected route refuses that', async () => {
    const h = setup(config([HOST]));
    await h.run('startup');
    h.take();
    h.routes.onDelete = (request) => notOurs(request, 'connected');
    h.routes.onAdd = () => inspectFailed('connected-route', 'a connected route already exists and was left in place');

    h.netinfo.results = [network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }) })];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.40', '10.20.4.254')]);
    expect(h.engine.getApplied()).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
  });

  it('keeps a route it could not identify: still applied, shown on its rule, looked up again on every pass until it is settled', async () => {
    const h = setup(config([HOST, NET]));
    await h.run('startup');
    h.take();
    h.routes.onDelete = (request) => deleteUnidentified(request.dst);

    h.engine.setConfig(config([{ ...HOST, enabled: false }, NET]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toEqual({
      ruleId: ruleId(1),
      status: 'error',
      reasonCode: 'route-failed',
      reason:
        'Could not remove the route for 172.16.12.40: the route for 172.16.12.40 could not be identified and was left in place: route get failed: timeout',
      appliedDestinations: ['172.16.12.40'],
      lastResolvedAt: null,
    });
    expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 1, kept: 0, deferred: 0 });
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.40', '172.16.0.0/12']);

    // Not throttled at first: a pending delete is retried on periodic passes too (after
    // FAILURE_BACKOFF_AFTER failures in a row they back off; see the backoff tests).
    await h.run('drift-check');
    await h.run('dns-refresh');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.12.40', ETH_GW)]);
    expect(h.engine.getApplied()).toHaveLength(2);

    h.routes.onDelete = (request) => deleted(request);
    const settled = await h.run('manual');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(settled.summary.removed).toBe(1);
    expect(ruleState(settled, 1)).toMatchObject({ status: 'disabled', appliedDestinations: [] });
  });

  it('goes through the same path for config-driven deletes while the detection is held or throws', async () => {
    const throwing = (): DetectedInterfaces => {
      throw new Error('boom');
    };
    for (const detection of [network({ degraded: true }), throwing]) {
      const h = setup(config([HOST, NET, HOST_B]));
      await h.run('startup');
      h.take();
      h.netinfo.results = [detection];
      h.routes.onDelete = (request) =>
        request.dst === '172.16.12.40' ? notOurs(request, 'connected') : request.dst === '172.16.0.0/12' ? deleteUnidentified(request.dst) : deleted(request);

      h.engine.setConfig(config([]));
      const outcome = await h.run('config-change');

      expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW), del('172.16.12.41', ETH_GW)]);
      // Forgotten, kept for a retry, removed.
      expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.0.0/12']);
      expect(outcome.summary).toMatchObject({ removed: 1, failed: 1, kept: 0 });
      expect(engineLogs(h.entries, 'warn', 'applied route is no longer ours; forgotten, nothing was deleted')).toHaveLength(1);
    }
  });

  it('cleans up restored routes through the same path: one deleted, one forgotten, one kept for a retry', async () => {
    const h = setup(config([]));
    h.engine.restoreApplied([
      { dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] },
      { dst: '192.168.1.0/24', gateway: ETH_GW, ruleIds: [ruleId(2)] },
      { dst: '172.16.0.0/12', gateway: ETH_GW, ruleIds: [ruleId(3)] },
    ]);
    h.routes.onDelete = (request) =>
      request.dst === '192.168.1.0/24' ? notOurs(request, 'connected') : request.dst === '172.16.0.0/12' ? deleteUnidentified(request.dst) : deleted(request);

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('192.168.1.0/24', ETH_GW), del('172.16.0.0/12', ETH_GW)]);
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.0.0/12', gateway: ETH_GW, ruleIds: [ruleId(3)] }]);
    expect(outcome.summary).toEqual({ added: 0, removed: 1, failed: 1, kept: 0, deferred: 0 });
  });
});

describe('reconcile: a rule refused because a connected route is in the way is not retried on every pass', () => {
  const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
  /** A static-IP interface: the guard does not know the subnet, so the rule reaches the wrapper. */
  const staticEthernet = (extra: Partial<InterfaceInfo> = {}): DetectedInterfaces =>
    network({ ethernet: iface('ethernet', { subnet: null, netmask: null, ...extra }) });
  const refusing = (h: Harness): void => {
    h.routes.onAdd = (request) =>
      request.dst === '10.20.4.0/24' ? inspectFailed('connected-route', 'a connected route already exists and was left in place') : added(request);
  };
  const refused = (h: Harness, reason: ReconcileReason = 'startup') => {
    refusing(h);
    return h.run(reason);
  };
  const PERIODIC = RECONCILE_REASONS.filter((reason) => !REFUSAL_RETRY_REASONS.has(reason));

  it('names exactly the event reasons; the periodic ones are the rest', () => {
    expect([...REFUSAL_RETRY_REASONS].sort()).toEqual(['config-change', 'enabled-change', 'manual', 'network-change', 'startup']);
    // `dns-learned` (ADR-002) fires on DNS traffic: frequent, so it must not retry refused adds either.
    expect(PERIODIC).toEqual(['dns-refresh', 'drift-check', 'dns-learned']);
  });

  it.each(PERIODIC)('runs no command on a %s pass and keeps showing the rule as connected-network', async (reason) => {
    const h = setup(config([LAN, HOST_B]), { netinfo: createFakeNetInfo(staticEthernet()) });
    const first = await refused(h);
    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(first.summary.failed).toBe(1);

    const outcomes = [await h.run(reason), await h.run(reason), await h.run(reason)];

    expect(h.take()).toEqual([]);
    for (const outcome of outcomes) {
      expect(ruleState(outcome, 1)).toEqual(ruleState(first, 1));
      expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
      // No command ran, so none failed.
      expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
    }
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', 'rule cannot be applied')).toHaveLength(3);
  });

  it.each([...REFUSAL_RETRY_REASONS])('asks again on a %s pass', async (reason) => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet()) });
    await refused(h);
    await h.run('drift-check');
    h.take();

    const outcome = await h.run(reason);

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    expect(outcome.summary.failed).toBe(1);
  });

  it('applies the rule on the event pass on which the connected route is gone', async () => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet()) });
    await refused(h);
    h.take();
    h.routes.onAdd = (request) => added(request);

    await h.run('drift-check');
    expect(h.take()).toEqual([]);
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: ['10.20.4.0/24'] });
    // Applied now: nothing left to throttle or to ask.
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
  });

  it.each<[string, DetectedInterfaces, string]>([
    ["the address of the rule's role", staticEthernet({ ip: '10.20.4.99' }), ETH_GW],
    ["the gateway of the rule's role", staticEthernet({ gateway: '10.20.4.254' }), '10.20.4.254'],
    ['the other role', network({ ethernet: iface('ethernet', { subnet: null, netmask: null }), wifi: down('wifi') }), ETH_GW],
  ])('asks again on a periodic pass once the interface facts changed: %s', async (_name, changed, gateway) => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet()) });
    await refused(h);
    h.take();

    h.netinfo.results = [changed];
    await h.run('drift-check');
    expect(h.take()).toEqual([add('10.20.4.0/24', gateway)]);

    // Refused again under the new facts: quiet again until the next change.
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
  });

  it('forgets the refusal with the rule: a rule that comes back is asked for again', async () => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet()) });
    await refused(h);
    h.engine.setConfig(config([]));
    await h.run('drift-check');
    h.take();

    h.engine.setConfig(config([LAN]));
    await h.run('drift-check');

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
  });

  it('keeps the refusal through held degraded passes, which add nothing anyway', async () => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet()) });
    await refused(h);
    h.take();

    h.netinfo.results = [{ ...staticEthernet(), degraded: true }];
    await h.run('drift-check');
    await h.run('drift-check');
    h.netinfo.results = [staticEthernet()];
    await h.run('drift-check');

    expect(h.take()).toEqual([]);
  });

  it('does not throttle a route the wrapper could not identify: it is asked for on periodic passes too', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () => inspectFailed('existing-route-unknown', 'a route already exists and was left in place: route get failed: timeout');
    await h.run('startup');
    await h.run('drift-check');
    await h.run('dns-refresh');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.12.40', ETH_GW), add('172.16.12.40', ETH_GW)]);
  });

  it('does not throttle an ordinary failed add either', async () => {
    const h = setup(config([HOST]));
    h.routes.onAdd = () => addFailed('add');
    await h.run('startup');
    await h.run('drift-check');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.12.40', ETH_GW)]);
  });
});

describe('reconcile: nothing thrown escapes', () => {
  it('survives a detection that throws: no route is touched and the rules report an internal error', async () => {
    const h = setup(config([HOST, { ...NET, enabled: false }]));
    await h.run();
    h.take();

    h.netinfo.results = [
      () => {
        throw new Error('boom');
      },
    ];
    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'internal',
      reason: 'Interface detection failed',
      appliedDestinations: ['172.16.12.40'],
    });
    expect(ruleState(outcome, 2).status).toBe('disabled');
    // The interfaces of the last good detection are still reported.
    expect(outcome.state.interfaces.ethernet.up).toBe(true);
    expect(engineLogs(h.entries, 'error', 'interface detection threw')).toHaveLength(1);

    h.netinfo.results = [network()];
    const recovered = await h.run();
    expect(ruleState(recovered, 1).status).toBe('active');
    expect(h.take()).toEqual([]);
  });

  it('asks for a bounded number of retries while the detection keeps throwing, and never deletes', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [
      () => {
        throw new Error('boom');
      },
    ];

    const outcomes = [await h.run(), await h.run(), await h.run(), await h.run()];

    expect(outcomes.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
    expect(h.take()).toEqual([]);
    expect(h.engine.getApplied()).toHaveLength(1);
  });

  it('survives a detection that rejects', async () => {
    const netinfo = createFakeNetInfo();
    netinfo.detectInterfaces = () => Promise.reject(new Error('rejected'));
    const h = setup(config([HOST]), { netinfo });

    const outcome = await h.run();

    expect(ruleState(outcome, 1).reasonCode).toBe('internal');
    expect(outcome.state.interfaces).toEqual({
      ethernet: { device: null, ip: null, gateway: null, up: false },
      wifi: { device: null, ip: null, gateway: null, up: false },
    });
  });

  it('survives a routeAdd that throws: that rule is an internal error, the others are applied', async () => {
    const h = setup(config([HOST, NET]));
    h.routes.onAdd = (request) => {
      if (request.dst === '172.16.12.40') throw new Error('runner refused');
      return added(request);
    };

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'internal',
      reason: 'Adding the route for 172.16.12.40 failed: runner refused',
      appliedDestinations: [],
    });
    expect(ruleState(outcome, 2).status).toBe('active');
    expect(engineLogs(h.entries, 'error', 'route add threw')).toHaveLength(1);
  });

  it('survives a routeDelete that rejects: the route stays applied and is retried', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.routes.onDelete = () => Promise.reject(new Error('runner refused'));

    h.engine.setConfig(config([{ ...HOST, enabled: false }]));
    const outcome = await h.run('config-change');

    expect(ruleState(outcome, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'internal',
      appliedDestinations: ['172.16.12.40'],
    });
    expect(h.engine.getApplied()).toHaveLength(1);
    expect(engineLogs(h.entries, 'error', 'route delete threw')).toHaveLength(1);
  });

  it('survives a bug inside the pass itself and stays usable', async () => {
    let broken = true;
    const resolveDomain: DomainResolver = (domainRule) =>
      broken ? ({ destinations: null } as unknown as DomainTargets) : unresolvedDomain(domainRule);
    const h = setup(config([rule(1, 'domain', 'corp.local', 'ethernet'), { ...NET, enabled: false }]), { deps: { resolveDomain } });

    const outcome = await h.run();

    expect(ruleState(outcome, 1)).toMatchObject({ status: 'error', reasonCode: 'internal' });
    expect(ruleState(outcome, 1).reason).toMatch(/^Reconcile failed: /);
    expect(ruleState(outcome, 2).status).toBe('disabled');
    expect(outcome.state.seq).toBe(1);
    expect(engineLogs(h.entries, 'error', 'reconcile failed unexpectedly')).toHaveLength(1);

    broken = false;
    const next = await h.run();
    expect(next.state.seq).toBe(2);
    expect(ruleState(next, 1)).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
  });
});

// ---------------------------------------------------------------------------
// Degraded detection
// ---------------------------------------------------------------------------

describe('reconcile: degraded interface detection', () => {
  const degradedDown = (): DetectedInterfaces =>
    network({ ethernet: down('ethernet', 'hardware-ports-unavailable'), wifi: down('wifi', 'hardware-ports-unavailable'), degraded: true });

  it('deletes nothing on the first and second degraded detection and asks for a forced retry', async () => {
    const h = setup(config([HOST, WIFI_HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [degradedDown()];

    const first = await h.run('network-change');
    const second = await h.run('network-change');

    expect(h.take()).toEqual([]);
    expect([first.retryRequested, second.retryRequested]).toEqual([true, true]);
    expect(first.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 2, deferred: 0 });
    expect(h.retries).toEqual([
      { reason: 'network-change', attempt: 1 },
      { reason: 'network-change', attempt: 2 },
    ]);
    // The routes stay, and the state says so next to the rule's pending status.
    expect(ruleState(second, 1)).toMatchObject({
      status: 'pending',
      reasonCode: 'interface-down',
      appliedDestinations: ['172.16.12.40'],
    });
    expect(h.engine.getApplied()).toHaveLength(2);
    expect(engineLogs(h.entries, 'warn', 'interface detection is degraded; no route is added, and none is removed because of interface state, in this reconcile')).toHaveLength(2);
    // The pass after an untrusted detection bypasses the interface cache.
    expect(h.netinfo.calls.map((call) => call.force)).toEqual([false, false, true]);
  });

  it('accepts the third degraded detection in a row and removes the routes', async () => {
    expect(DEGRADED_ACCEPT_AFTER).toBe(3);
    const h = setup(config([HOST, WIFI_HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [degradedDown()];
    await h.run();
    await h.run();

    const third = await h.run('network-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('203.0.113.7', WIFI_GW)]);
    expect(third.retryRequested).toBe(false);
    expect(h.retries).toHaveLength(2);
    expect(ruleState(third, 1)).toMatchObject({ status: 'pending', reasonCode: 'interface-down', appliedDestinations: [] });
    expect(engineLogs(h.entries, 'warn', 'interface detection is still degraded; accepting the result as it is')).toHaveLength(1);

    // A fourth degraded detection is still taken at face value.
    const fourth = await h.run();
    expect(fourth.retryRequested).toBe(false);
    expect(h.netinfo.calls.map((call) => call.force)).toEqual([false, false, true, true, false]);
  });

  it('starts counting again after one clean detection', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [degradedDown(), degradedDown(), network(), degradedDown(), degradedDown(), degradedDown()];

    const outcomes = [];
    for (let pass = 0; pass < 5; pass += 1) outcomes.push(await h.run());

    expect(outcomes.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, true, true]);
    expect(h.take()).toEqual([]);

    await h.run();
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
  });

  it('relies on `degraded`, not on the reason of an interface', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();

    // An ordinary reason, but the detection as a whole is flagged.
    h.netinfo.results = [network({ ethernet: down('ethernet', 'no-address'), degraded: true })];
    const outcome = await h.run();

    expect(h.take()).toEqual([]);
    expect(outcome.retryRequested).toBe(true);
  });

  it('still deletes the route of a rule that was removed from the config', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();
    h.netinfo.results = [network({ ethernet: down('ethernet'), degraded: true })];

    h.engine.setConfig(config([NET]));
    const outcome = await h.run('config-change');

    // HOST is gone from the config: deleted. NET only looks down: kept.
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(outcome.summary).toEqual({ added: 0, removed: 1, failed: 0, kept: 1, deferred: 0 });
    expect(ruleState(outcome, 2)).toMatchObject({ status: 'pending', appliedDestinations: ['172.16.0.0/12'] });
    expect(outcome.retryRequested).toBe(true);
  });

  it('still deletes the route of a rule that was disabled', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();
    h.netinfo.results = [network({ ethernet: down('ethernet'), degraded: true })];

    h.engine.setConfig(config([{ ...HOST, enabled: false }, NET]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'disabled', reasonCode: 'rule-disabled', appliedDestinations: [] });
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.0.0/12']);
  });

  it('still deletes every route when the global toggle goes off', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [
      network({ ethernet: down('ethernet', 'hardware-ports-unavailable'), wifi: down('wifi', 'hardware-ports-unavailable'), degraded: true }),
    ];

    h.engine.setEnabled(false);
    const outcome = await h.run('enabled-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW), del('203.0.113.7', WIFI_GW)]);
    expect(outcome.summary).toEqual({ added: 0, removed: 3, failed: 0, kept: 0, deferred: 0 });
    expect(h.engine.getApplied()).toEqual([]);
  });

  it('deletes the old route of a rule whose target was edited, and keeps the rest', async () => {
    const h = setup(config([HOST, NET]));
    await h.run();
    h.take();
    h.netinfo.results = [network({ degraded: true })];

    h.engine.setConfig(config([{ ...HOST, target: '172.16.12.99' }, NET]));
    const outcome = await h.run('config-change');

    // The old target goes at once; the new one waits for a detection that can be trusted.
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => [entry.status, entry.reasonCode, entry.appliedDestinations])).toEqual([
      ['pending', 'interface-down', []],
      ['active', null, ['172.16.0.0/12']],
    ]);

    h.netinfo.results = [network()];
    await h.run();
    expect(h.take()).toEqual([add('172.16.12.99', ETH_GW)]);
  });

  it('keeps the addresses of an enabled domain rule whose interface looks down', async () => {
    const domain = rule(5, 'domain', 'corp.local', 'ethernet');
    const h = setup(config([domain]), {
      deps: {
        resolveDomain: () => ({ destinations: ['172.16.12.40'], status: 'active', reasonCode: null, reason: null, lastResolvedAt: null }),
      },
    });
    await h.run();
    h.take();
    h.netinfo.results = [network({ ethernet: down('ethernet'), degraded: true })];

    const held = await h.run('network-change');
    expect(h.take()).toEqual([]);
    expect(held.summary.kept).toBe(1);

    h.engine.setConfig(config([{ ...domain, enabled: false }]));
    await h.run('config-change');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
  });

  it('judges restored routes the same way: wanted by an enabled rule is kept, anything else goes', async () => {
    const h = setup(config([HOST]), { netinfo: createFakeNetInfo(network({ ethernet: down('ethernet'), degraded: true })) });
    h.engine.restoreApplied([
      { dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [] },
      { dst: '172.16.99.0/24', gateway: ETH_GW, ruleIds: [ruleId(8)] },
    ]);

    await h.run('startup');

    expect(h.take()).toEqual([del('172.16.99.0/24', ETH_GW)]);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.40']);
  });

  it('adds nothing while a degraded detection is held, even through a role that looks routable', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [network({ degraded: true })];

    h.engine.setConfig(config([HOST, rule(8, 'subnet', '198.51.100.0/24', 'ethernet'), WIFI_HOST]));
    const first = await h.run('config-change');
    const second = await h.run('config-change');

    expect(h.take()).toEqual([]);
    expect([first.retryRequested, second.retryRequested]).toEqual([true, true]);
    // A rule that has its route keeps its status; one with nothing applied waits, without an error.
    expect(second.state.rules.map((entry) => [entry.status, entry.reasonCode, entry.appliedDestinations])).toEqual([
      ['active', null, ['172.16.12.40']],
      ['pending', 'interface-down', []],
      ['pending', 'interface-down', []],
    ]);
    expect(ruleState(second, 8).reason).toBe(
      'Interface detection is unreliable right now; the route is added once the interfaces are detected reliably',
    );
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toEqual([]);
    expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ mode: 'hold', deferred: 2 });

    // Accepted on the third degraded detection: there is a trusted snapshot and the guard clears both.
    const third = await h.run('config-change');
    expect(h.take()).toEqual([add('198.51.100.0/24', ETH_GW), add('203.0.113.7', WIFI_GW)]);
    expect(third.state.rules.map((entry) => entry.status)).toEqual(['active', 'active', 'active']);
    expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ mode: 'accepted', deferred: 0 });
  });

  it('adds a new rule at once on a clean detection that follows a degraded one', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [network({ degraded: true }), network()];

    h.engine.setConfig(config([HOST, rule(8, 'subnet', '198.51.100.0/24', 'ethernet')]));
    await h.run('config-change');
    expect(h.take()).toEqual([]);

    await h.run('config-change');
    expect(h.take()).toEqual([add('198.51.100.0/24', ETH_GW)]);
  });

  it('does not replace a route whose gateway changed while the detection is degraded', async () => {
    const h = setup(config([HOST]));
    await h.run();
    h.take();
    const moved = { ethernet: iface('ethernet', { gateway: '10.20.4.254' }) };
    h.netinfo.results = [network({ ...moved, degraded: true }), network(moved)];

    const held = await h.run('network-change');

    expect(h.take()).toEqual([]);
    expect(ruleState(held, 1)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: 'The route still uses its previous gateway; replacing it is postponed until the interfaces are detected reliably',
      appliedDestinations: ['172.16.12.40'],
    });

    const settled = await h.run('network-change');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.40', '10.20.4.254')]);
    expect(ruleState(settled, 1).status).toBe('active');
  });

  it('survives a retry scheduler that throws', async () => {
    const h = setup(config([HOST]), {
      netinfo: createFakeNetInfo(degradedDown()),
      deps: {
        scheduleRetry: () => {
          throw new Error('no timers');
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.retryRequested).toBe(true);
    expect(engineLogs(h.entries, 'error', 'retry scheduler failed')).toHaveLength(1);
  });
});

describe('reconcile: an untrusted detection never weakens the connected-subnet guard', () => {
  /** Wi-Fi did not answer: the role looks down and its subnet, gateway and address are unknown. */
  const wifiSilent = (): DetectedInterfaces => network({ wifi: down('wifi', 'address-lookup-failed'), degraded: true });
  const LAN_RULES = [
    rule(1, 'subnet', '192.168.1.0/24', 'ethernet'),
    rule(2, 'ip', WIFI_GW, 'ethernet'),
    rule(3, 'ip', '192.168.1.23', 'ethernet'),
    rule(4, 'subnet', '192.168.1.0/25', 'ethernet'),
  ];

  it('keeps refusing what the last trusted detection refused, through held and accepted degraded passes', async () => {
    const h = setup(config(LAN_RULES));
    const clean = await h.run('startup');
    expect(clean.state.rules.map((entry) => entry.reasonCode)).toEqual(Array(4).fill('connected-network'));

    h.netinfo.results = [wifiSilent()];
    const outcomes = [await h.run(), await h.run(), await h.run(), await h.run()];

    expect(h.routes.calls).toEqual([]);
    for (const outcome of outcomes) {
      expect(outcome.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual(
        Array(4).fill(['error', 'connected-network']),
      );
    }
    expect(outcomes.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);

    h.netinfo.results = [network()];
    await h.run();
    expect(h.routes.calls).toEqual([]);
  });

  it('uses the trusted subnet when a degraded detection lost only the mask', async () => {
    const h = setup(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet'), HOST_B]));
    await h.run('startup');
    h.take();

    h.netinfo.results = [network({ ethernet: iface('ethernet', { subnet: null, netmask: null }), degraded: true })];
    const outcomes = [await h.run(), await h.run(), await h.run()];

    expect(h.take()).toEqual([]);
    expect(ruleState(outcomes[2] ?? clean(), 1)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    // Nothing "skipped" is announced: only a clean detection can say a subnet is genuinely unknown.
    expect(engineLogs(h.entries, 'warn', 'connected subnet unknown; connected-subnet guard skipped')).toEqual([]);
  });

  it('replaces the snapshot only with a clean detection', async () => {
    // Wi-Fi moves to another network; only a clean detection may teach the guard that.
    const moved = iface('wifi', { ip: '192.168.50.9', gateway: '192.168.50.1', subnet: '192.168.50.0/24' });
    const oldLan = rule(1, 'subnet', '192.168.1.0/24', 'ethernet');
    const newLan = rule(2, 'subnet', '192.168.50.0/24', 'ethernet');
    const h = setup(config([oldLan, newLan]));
    h.netinfo.results = [network({ wifi: down('wifi') })];
    h.engine.setConfig(config([newLan]));
    await h.run('startup');
    expect(h.take()).toEqual([add('192.168.50.0/24', ETH_GW)]);

    // Clean: Wi-Fi is on 192.168.1.0/24. Then three degraded detections that claim it moved.
    h.engine.setConfig(config([oldLan, newLan]));
    h.netinfo.results = [network(), network({ wifi: moved, degraded: true })];
    await h.run();
    expect(h.take()).toEqual([]);
    const degraded = [await h.run(), await h.run(), await h.run()];

    // Union of both: the old LAN stays refused (snapshot) and the new one is refused too (current).
    expect(degraded[2]?.state.rules.map((entry) => entry.reasonCode)).toEqual(['connected-network', 'connected-network']);
    expect(h.take()).toEqual([del('192.168.50.0/24', ETH_GW)]);

    // The first clean detection replaces the snapshot: the old LAN is free again.
    h.netinfo.results = [network({ wifi: moved })];
    const settled = await h.run();
    expect(h.take()).toEqual([add('192.168.1.0/24', ETH_GW)]);
    expect(settled.state.rules.map((entry) => entry.reasonCode)).toEqual([null, 'connected-network']);
  });

  it('keeps the snapshot across a detection that throws', async () => {
    const h = setup(config(LAN_RULES.slice(0, 1)));
    await h.run('startup');

    h.netinfo.results = [
      () => {
        throw new Error('boom');
      },
      wifiSilent(),
    ];
    await h.run();
    for (let pass = 0; pass < 3; pass += 1) await h.run();

    expect(h.routes.calls).toEqual([]);
    expect(h.engine.getState().rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
  });

  it('keeps the facts of each role: a degraded detection that lost ethernet is checked against trusted ethernet', async () => {
    const h = setup(config([rule(1, 'ip', ETH_GW, 'wifi'), rule(2, 'subnet', '10.20.4.0/24', 'wifi')]));
    await h.run('startup');

    h.netinfo.results = [network({ ethernet: down('ethernet', 'address-lookup-failed'), degraded: true })];
    for (let pass = 0; pass < 4; pass += 1) await h.run();

    expect(h.routes.calls).toEqual([]);
  });

  it('a clean detection with an unknown subnet is still the genuine static-IP case: skip with a warning', async () => {
    const h = setup(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet')]), {
      netinfo: createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) })),
    });

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1).status).toBe('active');
    expect(engineLogs(h.entries, 'warn', 'connected subnet unknown; connected-subnet guard skipped')).toHaveLength(1);
  });

  describe('an accepted degraded pass needs every role covered (per role)', () => {
    const NEW_LAN = rule(4, 'subnet', '192.168.1.0/24', 'ethernet');
    const NEW_GW = rule(5, 'ip', WIFI_GW, 'ethernet');

    it('adds nothing when a role did not answer and the trusted snapshot saw that role down', async () => {
      // Clean detection while Wi-Fi is off: the snapshot knows nothing about the wifi role.
      const h = setup(config([HOST]), { netinfo: createFakeNetInfo(network({ wifi: down('wifi') })) });
      await h.run('startup');
      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);

      // Wi-Fi joins 192.168.1.0/24, but its lookups fail: nobody can tell the guard where it is.
      h.netinfo.results = [wifiSilent()];
      h.engine.setConfig(config([HOST, NEW_LAN, NEW_GW, HOST_B]));
      const outcomes = [await h.run(), await h.run(), await h.run(), await h.run()];

      expect(h.take()).toEqual([]);
      expect(outcomes.map((outcome) => outcome.summary.deferred)).toEqual([3, 3, 3, 3]);
      expect(outcomes.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
      expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ mode: 'accepted', deferred: 3 });
      // What was applied stays, and stays active; the new rules wait.
      expect(outcomes[3]?.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
        ['active', null],
        ['pending', 'interface-down'],
        ['pending', 'interface-down'],
        ['pending', 'interface-down'],
      ]);

      // The first clean detection settles it: the guard now knows the Wi-Fi LAN.
      h.netinfo.results = [network()];
      const settled = await h.run();
      expect(h.take()).toEqual([add('172.16.12.41', ETH_GW)]);
      expect(settled.summary.deferred).toBe(0);
      expect(settled.state.rules.map((entry) => entry.reasonCode)).toEqual([null, 'connected-network', 'connected-network', null]);
    });

    it.each<[string, InterfaceInfo]>([
      ['down', down('wifi')],
      ['up without a gateway', noGateway('wifi')],
      ['up without a known subnet', iface('wifi', { subnet: null, netmask: null })],
    ])('adds nothing when the snapshot saw the silent role %s', async (_name, trustedWifi) => {
      const h = setup(config([]), { netinfo: createFakeNetInfo(network({ wifi: trustedWifi })) });
      await h.run('startup');

      h.netinfo.results = [wifiSilent()];
      h.engine.setConfig(config([HOST]));
      for (let pass = 0; pass < 4; pass += 1) await h.run();

      expect(h.routes.calls).toEqual([]);
    });

    it('still adds on the accepted pass when the silent role is fully known in the snapshot', async () => {
      const h = setup(config([]));
      await h.run('startup');

      h.netinfo.results = [wifiSilent()];
      h.engine.setConfig(config([HOST, NEW_LAN]));
      const outcomes = [await h.run(), await h.run(), await h.run()];

      // Held twice, then added; the LAN rule is refused by the snapshot, not added.
      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
      expect(outcomes.map((outcome) => outcome.summary.deferred)).toEqual([1, 1, 0]);
      expect(ruleState(outcomes[2] ?? clean(), 4)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    });

    it('still adds on the accepted pass when the snapshot saw a role down but the degraded detection knows it in full', async () => {
      const h = setup(config([]), { netinfo: createFakeNetInfo(network({ wifi: down('wifi') })) });
      await h.run('startup');

      // Degraded for an unrelated reason; both roles answered in full, Wi-Fi has joined its LAN.
      h.netinfo.results = [network({ degraded: true })];
      h.engine.setConfig(config([HOST, NEW_LAN]));
      const outcomes = [await h.run(), await h.run(), await h.run()];

      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
      expect(ruleState(outcomes[2] ?? clean(), 4)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    });

    it('checks each role on its own: ethernet covered by the snapshot does not cover a silent wifi', async () => {
      const h = setup(config([]), { netinfo: createFakeNetInfo(network({ wifi: down('wifi') })) });
      await h.run('startup');

      h.netinfo.results = [network({ ethernet: down('ethernet', 'address-lookup-failed'), wifi: down('wifi', 'address-lookup-failed'), degraded: true })];
      h.engine.setConfig(config([WIFI_HOST]));
      for (let pass = 0; pass < 4; pass += 1) await h.run();

      expect(h.routes.calls).toEqual([]);
    });

    it('leaves clean passes alone: a role that is really down does not hold anything back', async () => {
      const h = setup(config([HOST, NEW_LAN]), { netinfo: createFakeNetInfo(network({ wifi: down('wifi') })) });

      const outcome = await h.run('startup');

      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('192.168.1.0/24', ETH_GW)]);
      expect(outcome.summary).toEqual({ added: 2, removed: 0, failed: 0, kept: 0, deferred: 0 });
    });

    it('still removes on the accepted pass what the interfaces no longer carry', async () => {
      const h = setup(config([HOST, WIFI_HOST]));
      await h.run('startup');
      h.take();
      // Wi-Fi goes; the next clean detection records it as down.
      h.netinfo.results = [network({ wifi: down('wifi') })];
      await h.run();
      expect(h.take()).toEqual([del('203.0.113.7', WIFI_GW)]);

      h.netinfo.results = [network({ ethernet: down('ethernet', 'address-lookup-failed'), wifi: down('wifi'), degraded: true })];
      const outcomes = [await h.run(), await h.run(), await h.run()];

      expect(outcomes.map((outcome) => outcome.summary.kept)).toEqual([1, 1, 0]);
      expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    });
  });

  describe('guardCoversEveryRole', () => {
    const facts = (info: InterfaceInfo): GuardFacts => ({ role: info.role, ip: info.ip, gateway: info.gateway, subnet: info.subnet });
    const FULL = [facts(iface('ethernet')), facts(iface('wifi'))];
    const silent = (role: InterfaceInfo['role']): InterfaceInfo => down(role, 'address-lookup-failed');

    it('is satisfied by a detection that knows both roles in full, with or without a snapshot', () => {
      expect(guardCoversEveryRole(network({ degraded: true }), null)).toBe(true);
      expect(guardCoversEveryRole(network({ degraded: true }), [facts(down('ethernet')), facts(down('wifi'))])).toBe(true);
    });

    it('is satisfied when the snapshot knows in full every role the detection does not', () => {
      expect(guardCoversEveryRole(network({ wifi: silent('wifi') }), FULL)).toBe(true);
      expect(guardCoversEveryRole(network({ ethernet: silent('ethernet'), wifi: silent('wifi') }), FULL)).toBe(true);
      expect(guardCoversEveryRole(network({ ethernet: silent('ethernet') }), [facts(iface('ethernet')), facts(down('wifi'))])).toBe(true);
    });

    it.each<[string, DetectedInterfaces, readonly GuardFacts[] | null]>([
      ['no snapshot at all', network({ wifi: silent('wifi') }), null],
      ['an empty snapshot', network({ wifi: silent('wifi') }), []],
      ['a snapshot in which that role was down', network({ wifi: silent('wifi') }), [facts(iface('ethernet')), facts(down('wifi'))]],
      ['a snapshot of the other role only', network({ wifi: silent('wifi') }), [facts(iface('ethernet'))]],
      ['a snapshot without that role\'s subnet', network({ wifi: silent('wifi') }), [facts(iface('ethernet')), facts(iface('wifi', { subnet: null }))]],
      ['a snapshot without that role\'s gateway', network({ wifi: silent('wifi') }), [facts(iface('ethernet')), facts(noGateway('wifi'))]],
      ['a snapshot without that role\'s address', network({ wifi: silent('wifi') }), [facts(iface('ethernet')), facts(iface('wifi', { ip: null }))]],
      ['ethernet unknown on both sides', network({ ethernet: silent('ethernet') }), [facts(down('ethernet')), facts(iface('wifi'))]],
      ['a detection that lost only the subnet', network({ wifi: iface('wifi', { subnet: null }) }), [facts(iface('ethernet')), facts(down('wifi'))]],
      ['a detection that lost only the gateway', network({ wifi: noGateway('wifi') }), [facts(iface('ethernet')), facts(down('wifi'))]],
      ['a detection that has the facts of a role it reports as not up', network({ wifi: iface('wifi', { up: false }) }), [facts(iface('ethernet')), facts(down('wifi'))]],
    ])('is not satisfied with %s for a role the detection does not know in full', (_name, detected, trusted) => {
      expect(guardCoversEveryRole(detected, trusted)).toBe(false);
    });
  });

  describe('when the process has never had a trusted detection', () => {
    it('adds nothing on any degraded pass while a role did not answer, and adds on the first clean one', async () => {
      const h = setup(config([HOST, rule(2, 'subnet', '192.168.1.0/24', 'ethernet')]), {
        netinfo: createFakeNetInfo(wifiSilent()),
      });

      const outcomes = [await h.run('startup'), await h.run('startup'), await h.run('startup'), await h.run('startup')];

      expect(h.routes.calls).toEqual([]);
      expect(outcomes.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
      expect(ruleState(outcomes[3] ?? clean(), 1)).toMatchObject({ status: 'pending', reasonCode: 'interface-down' });
      expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ mode: 'accepted', deferred: 2 });

      h.netinfo.results = [network()];
      const settled = await h.run();
      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
      expect(settled.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
        ['active', null],
        ['error', 'connected-network'],
      ]);
    });

    it('adds on the accepted pass when the degraded detection knows everything about both roles', async () => {
      // Degraded for an unrelated reason (another adapter timed out); both roles answered in full.
      const h = setup(config([HOST, rule(2, 'subnet', '192.168.1.0/24', 'ethernet')]), {
        netinfo: createFakeNetInfo(network({ degraded: true })),
      });

      await h.run('startup');
      await h.run('startup');
      expect(h.routes.calls).toEqual([]);

      const accepted = await h.run('startup');
      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
      expect(ruleState(accepted, 2)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
    });

    it.each([
      ['a role without a subnet', network({ ethernet: iface('ethernet', { subnet: null, netmask: null }), degraded: true })],
      ['a role without a gateway', network({ wifi: noGateway('wifi'), degraded: true })],
      ['a role that is down', network({ wifi: down('wifi'), degraded: true })],
    ])('adds nothing on the accepted pass with %s', async (_name, detection) => {
      const h = setup(config([HOST]), { netinfo: createFakeNetInfo(detection) });

      for (let pass = 0; pass < 4; pass += 1) await h.run('startup');

      expect(h.routes.calls).toEqual([]);
    });
  });
});

describe('reconcile: a detection that throws', () => {
  const throwing = (): DetectedInterfaces => {
    throw new Error('boom');
  };

  it('still removes every route when the global toggle goes off', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [throwing];

    h.engine.setEnabled(false);
    const outcome = await h.run('enabled-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW), del('203.0.113.7', WIFI_GW)]);
    expect(outcome.summary).toEqual({ added: 0, removed: 3, failed: 0, kept: 0, deferred: 0 });
    expect(outcome.state.rules.map((entry) => [entry.status, entry.appliedDestinations])).toEqual(Array(3).fill(['disabled', []]));
    expect(h.engine.getApplied()).toEqual([]);
  });

  it('still removes the route of a removed or disabled rule, keeps the rest and adds nothing', async () => {
    const h = setup(config([HOST, NET, WIFI_HOST]));
    await h.run();
    h.take();
    h.netinfo.results = [throwing];

    h.engine.setConfig(config([{ ...NET, enabled: false }, WIFI_HOST, rule(8, 'subnet', '198.51.100.0/24', 'ethernet')]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW)]);
    expect(outcome.summary).toEqual({ added: 0, removed: 2, failed: 0, kept: 1, deferred: 0 });
    expect(ruleState(outcome, 3)).toMatchObject({ status: 'error', reasonCode: 'internal', appliedDestinations: ['203.0.113.7'] });
    expect(ruleState(outcome, 8)).toMatchObject({ status: 'error', reasonCode: 'internal', appliedDestinations: [] });
  });
});

describe('reconcile: the pass loop cannot deadlock', () => {
  it('answers every caller and stays usable when even the failure report throws', async () => {
    let broken = false;
    const h = setup(config([HOST]), {
      deps: {
        now: () => {
          if (broken) throw new Error('clock is gone');
          return NOW;
        },
      },
    });
    const before = await h.run('startup');
    h.take();

    broken = true;
    const [first, second, third] = await Promise.all([
      h.engine.reconcile('manual'),
      h.engine.reconcile('network-change'),
      h.engine.reconcile('drift-check'),
    ]);

    // Nothing could be computed: every caller gets the last state instead of waiting forever.
    expect([first.state, second.state, third.state]).toEqual([before.state, before.state, before.state]);
    expect(first.retryRequested).toBe(false);
    expect(h.engine.getState()).toBe(before.state);

    broken = false;
    const after = await h.run('manual');
    expect(after.state.seq).toBeGreaterThan(before.state.seq);
    expect(ruleState(after, 1).status).toBe('active');
    expect(h.take()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

describe('reconcile: one pass at a time', () => {
  it('merges the calls that arrive during a pass into exactly one follow-up with the latest reason', async () => {
    const h = setup(config([HOST]));
    const gate = deferred();
    h.netinfo.gate = gate;

    const first = h.engine.reconcile('startup');
    const second = h.engine.reconcile('network-change');
    const third = h.engine.reconcile('config-change', { force: true });
    const fourth = h.engine.reconcile('manual');
    await Promise.resolve();
    expect(h.netinfo.calls).toHaveLength(1);
    expect(second).toBe(third);
    expect(third).toBe(fourth);

    h.netinfo.gate = null;
    gate.open();
    const outcomes = await Promise.all([first, second, third, fourth]);

    expect(h.netinfo.calls).toEqual([
      { overrides: undefined, force: false },
      { overrides: undefined, force: true },
    ]);
    expect(outcomes.map((outcome) => [outcome.state.seq, outcome.state.lastReconcileReason])).toEqual([
      [1, 'startup'],
      [2, 'manual'],
      [2, 'manual'],
      [2, 'manual'],
    ]);
    expect(h.routes.calls).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(engineLogs(h.entries, 'info', 'reconcile finished')).toHaveLength(2);
  });

  it('gives a caller that arrived mid-pass a pass that started after its call, with the config it set', async () => {
    const h = setup(config([HOST]));
    const gate = deferred();
    h.netinfo.gate = gate;
    const running = h.engine.reconcile('startup');
    await Promise.resolve();

    h.engine.setConfig(config([HOST, NET]));
    const queued = h.engine.reconcile('config-change');
    h.netinfo.gate = null;
    gate.open();
    const [first, second] = await Promise.all([running, queued]);

    // The pass that was already running keeps the config and revision it started with.
    expect(first.state.configRevision).toBe(0);
    expect(first.state.rules).toHaveLength(1);
    expect(second.state.configRevision).toBe(1);
    expect(second.state.rules.map((entry) => entry.status)).toEqual(['active', 'active']);
    expect(h.routes.calls).toEqual([add('172.16.12.40', ETH_GW), add('172.16.0.0/12', ETH_GW)]);
  });

  it('never runs two passes at once, however the calls interleave', async () => {
    const h = setup(config([HOST]));
    let active = 0;
    let peak = 0;
    const inner = createFakeNetInfo();
    h.netinfo.detectInterfaces = async (options) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      const result = await inner.detectInterfaces(options);
      active -= 1;
      return result;
    };

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => h.engine.reconcile(index % 2 === 0 ? 'manual' : 'network-change')),
    );

    expect(peak).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.state.seq))).toEqual(new Set([1, 2]));

    // Idle again: the next call starts a pass of its own.
    const later = await h.run('drift-check');
    expect(later.state.seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Shared destinations
// ---------------------------------------------------------------------------

describe('reconcile: destinations shared by rules', () => {
  it('adds one route for two rules with the same destination and keeps it while one of them remains', async () => {
    const twin = rule(4, 'ip', '172.16.12.40', 'ethernet');
    const h = setup(config([HOST, twin]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => [entry.status, entry.appliedDestinations])).toEqual([
      ['active', ['172.16.12.40']],
      ['active', ['172.16.12.40']],
    ]);
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1), ruleId(4)] }]);

    h.engine.setConfig(config([twin]));
    const kept = await h.run('config-change');
    expect(h.take()).toEqual([]);
    expect(ruleState(kept, 4)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(4)] }]);

    h.engine.setConfig(config([]));
    await h.run('config-change');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
  });

  it('keeps the shared route when one of its rules is disabled', async () => {
    const twin = rule(4, 'ip', '172.16.12.40', 'ethernet');
    const h = setup(config([HOST, twin]));
    await h.run();
    h.take();

    h.engine.setConfig(config([{ ...HOST, enabled: false }, twin]));
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'disabled', appliedDestinations: [] });
    expect(ruleState(outcome, 4)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
  });

  it('treats `ip X` and `subnet X/32` as one host route', async () => {
    const h = setup(config([HOST, rule(4, 'subnet', '172.16.12.40/32', 'ethernet')]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => entry.appliedDestinations)).toEqual([['172.16.12.40'], ['172.16.12.40']]);
  });

  it('fails both rules when their shared route cannot be added', async () => {
    const h = setup(config([HOST, rule(4, 'ip', '172.16.12.40', 'ethernet')]));
    h.routes.onAdd = () => addFailed('add');

    const outcome = await h.run();

    expect(h.routes.calls).toHaveLength(1);
    expect(outcome.state.rules.map((entry) => entry.reasonCode)).toEqual(['route-failed', 'route-failed']);
  });

  it('gives a destination claimed for two interfaces to the first rule only', async () => {
    // The schema refuses such a config; the engine must still not flap the route.
    const h = setup(rawConfig([HOST, rule(4, 'ip', '172.16.12.40', 'wifi')]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 1).status).toBe('active');
    expect(ruleState(outcome, 4)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: '172.16.12.40 is already routed through the ethernet interface by another rule',
      appliedDestinations: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Domain rules (resolver port)
// ---------------------------------------------------------------------------

describe('reconcile: domain rules', () => {
  const DOMAIN = rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.20.4.53' });
  const resolved = (extra: Partial<DomainTargets> = {}): DomainTargets => ({
    destinations: ['172.16.12.40', '172.16.12.41'],
    status: 'active',
    reasonCode: null,
    reason: null,
    lastResolvedAt: '2026-10-12T08:29:00.000Z',
    ...extra,
  });

  it('leaves a domain rule pending with `resolving` until a resolver is plugged in', async () => {
    const h = setup(config([DOMAIN, HOST]));

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 5)).toEqual({
      ruleId: ruleId(5),
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Domain rules are not resolved yet',
      appliedDestinations: [],
      lastResolvedAt: null,
    });
  });

  it('routes what the resolver returns and drops addresses that disappear', async () => {
    let answer = resolved();
    const h = setup(config([DOMAIN]), { deps: { resolveDomain: () => Promise.resolve(answer) } });

    const first = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(ruleState(first, 5)).toEqual({
      ruleId: ruleId(5),
      status: 'active',
      reasonCode: null,
      reason: null,
      appliedDestinations: ['172.16.12.40', '172.16.12.41'],
      lastResolvedAt: '2026-10-12T08:29:00.000Z',
    });

    answer = resolved({ destinations: ['172.16.12.41', '172.16.12.42'] });
    await h.run('dns-refresh');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.42', ETH_GW)]);
  });

  it('does not ask the resolver while the interface of the rule is down', async () => {
    let asked = 0;
    const h = setup(config([DOMAIN]), {
      netinfo: createFakeNetInfo(network({ ethernet: down('ethernet') })),
      deps: {
        resolveDomain: () => {
          asked += 1;
          return resolved();
        },
      },
    });

    const outcome = await h.run();

    expect(asked).toBe(0);
    expect(ruleState(outcome, 5).reasonCode).toBe('interface-down');
  });

  it('refuses a resolved address that must never be routed and still routes the others', async () => {
    const h = setup(config([DOMAIN]), {
      deps: { resolveDomain: () => resolved({ destinations: ['127.0.0.1', '172.16.12.41', '0.0.0.0'] }) },
    });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.41', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason: 'Destination must never be routed (loopback)',
      appliedDestinations: ['172.16.12.41'],
    });
  });

  it('applies the connected-subnet guard to resolved addresses', async () => {
    const h = setup(config([DOMAIN]), { deps: { resolveDomain: () => resolved({ destinations: [ETH_GW, '172.16.12.41'] }) } });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.41', ETH_GW)]);
    expect(ruleState(outcome, 5).reasonCode).toBe('connected-network');
  });

  it('keeps the last known addresses applied while the resolver reports an error', async () => {
    let answer = resolved();
    const h = setup(config([DOMAIN]), { deps: { resolveDomain: () => answer } });
    await h.run();
    h.take();

    answer = resolved({ status: 'error', reasonCode: 'resolve-failed', reason: 'DNS query timed out' });
    const outcome = await h.run('dns-refresh');

    expect(h.take()).toEqual([]);
    expect(ruleState(outcome, 5)).toMatchObject({
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'DNS query timed out',
      appliedDestinations: ['172.16.12.40', '172.16.12.41'],
    });
  });

  it('passes `addresses-truncated` through on an active rule', async () => {
    const h = setup(config([DOMAIN]), {
      deps: { resolveDomain: () => resolved({ reasonCode: 'addresses-truncated', reason: '40 addresses, 32 used' }) },
    });

    const outcome = await h.run();

    expect(ruleState(outcome, 5)).toMatchObject({ status: 'active', reasonCode: 'addresses-truncated' });
  });

  it('never applies more destinations for one rule than the protocol can report', async () => {
    const many = Array.from({ length: 60 }, (_unused, index) => `172.16.13.${String(index + 1)}`);
    const h = setup(config([DOMAIN]), { deps: { resolveDomain: () => resolved({ destinations: many }) } });

    const outcome = await h.run();

    // The rule's own server takes the 33rd place; on the interface's own link it needs no route.
    expect(h.routes.calls).toHaveLength(32);
    expect(ruleState(outcome, 5).appliedDestinations).toEqual(many.slice(0, 32));
  });

  it('turns a resolver that throws into an internal error of that rule only', async () => {
    const h = setup(config([DOMAIN, HOST]), {
      deps: {
        resolveDomain: () => {
          throw new Error('resolver bug');
        },
      },
    });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'error', reasonCode: 'internal', reason: 'Resolver failed: resolver bug' });
    expect(ruleState(outcome, 1).status).toBe('active');
  });

  it('repairs a resolver answer that carries no reason code for a non-active status', async () => {
    const h = setup(config([DOMAIN]), { deps: { resolveDomain: () => resolved({ destinations: [], status: 'pending' }) } });

    const outcome = await h.run();

    expect(ruleState(outcome, 5)).toMatchObject({ status: 'pending', reasonCode: 'internal' });
  });
});

// ---------------------------------------------------------------------------
// State, config, subscriptions, applied snapshot
// ---------------------------------------------------------------------------

describe('engine state', () => {
  it('starts with a valid state that has nothing applied', () => {
    const h = setup(config([HOST, { ...NET, enabled: false }]));

    const state = h.engine.getState();

    expectValid(state);
    expect(state).toMatchObject({ seq: 0, configRevision: 0, lastApplyAt: null, lastReconcileReason: null, adapters: [] });
    expect(state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
      ['pending', 'interface-down'],
      ['disabled', 'rule-disabled'],
    ]);
    expect(h.netinfo.calls).toEqual([]);
  });

  it('increments `seq` on every computed state, whatever the pass did', async () => {
    const h = setup(config([HOST]));
    h.netinfo.results = [network(), network({ degraded: true }), () => { throw new Error('boom'); }, network()];

    const seqs = [h.engine.getState().seq];
    for (let pass = 0; pass < 4; pass += 1) seqs.push((await h.run()).state.seq);

    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('increments `configRevision` exactly when the stored config changes', async () => {
    const h = setup(config([HOST]));
    expect((await h.run()).state.configRevision).toBe(0);

    expect(h.engine.setConfig(config([HOST]))).toBe(false);
    expect(h.engine.setEnabled(true)).toBe(false);
    expect((await h.run()).state.configRevision).toBe(0);

    expect(h.engine.setConfig(config([HOST, NET]))).toBe(true);
    // The state only changes with the reconcile that follows.
    expect(h.engine.getState().configRevision).toBe(0);
    expect((await h.run('config-change')).state.configRevision).toBe(1);

    expect(h.engine.setEnabled(false)).toBe(true);
    expect(h.engine.getConfig().enabled).toBe(false);
    expect(h.engine.getConfig().rules).toHaveLength(2);
    expect((await h.run('enabled-change')).state.configRevision).toBe(2);

    await h.run('drift-check');
    expect(h.engine.getState().configRevision).toBe(2);
  });

  it('reports one entry per rule, in config order', async () => {
    const rules = [WIFI_HOST, { ...NET, enabled: false }, HOST, rule(9, 'domain', 'corp.local', 'wifi')];
    const h = setup(config(rules));

    const outcome = await h.run();

    expect(outcome.state.rules.map((entry) => entry.ruleId)).toEqual(rules.map((entry) => entry.id));
  });

  it('notifies subscribers of every state until they unsubscribe, and survives one that throws', async () => {
    const h = setup(config([HOST]));
    const seen: number[] = [];
    h.engine.subscribe(() => {
      throw new Error('listener bug');
    });
    const unsubscribe = h.engine.subscribe((state) => seen.push(state.seq));

    await h.run();
    await h.run();
    unsubscribe();
    await h.run();

    expect(seen).toEqual([1, 2]);
    expect(engineLogs(h.entries, 'error', 'state listener failed')).toHaveLength(3);
  });

  it('clamps an overlong reason to the protocol limit', () => {
    const state = buildEngineState({
      helperVersion: '1.2.3',
      seq: 7,
      configRevision: 3,
      config: config([HOST, NET]),
      wire: { interfaces: { ethernet: { device: null, ip: null, gateway: null, up: false }, wifi: { device: null, ip: null, gateway: null, up: false } }, adapters: [] },
      verdicts: new Map([[ruleId(1), { status: 'error', reasonCode: 'route-failed', reason: 'x'.repeat(5000), lastResolvedAt: null }]]),
      applied: [{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1), 'gone'] }],
      lastApplyAt: null,
      lastReconcileReason: null,
    });

    expectValid(state);
    expect(state.rules[0]?.reason).toHaveLength(300);
    expect(state.rules[0]?.appliedDestinations).toEqual(['172.16.12.40']);
    // A rule nobody judged is reported as broken, never silently as active.
    expect(state.rules[1]).toMatchObject({ status: 'error', reasonCode: 'internal', appliedDestinations: [] });
  });

  it('writes one summary line per reconcile', async () => {
    const h = setup(config([HOST, NET]));
    h.routes.onAdd = (request) => (request.dst === '172.16.12.40' ? addFailed('add') : added(request));

    await h.run('startup');

    expect(engineLogs(h.entries, 'info', 'reconcile finished').map((entry) => entry.context)).toEqual([
      {
        component: 'engine',
        reason: 'startup',
        added: 1,
        removed: 0,
        failed: 1,
        kept: 0,
        deferred: 0,
        mode: 'normal',
        rules: 2,
        applied: 1,
        retryRequested: false,
        seq: 1,
        durationMs: 0,
      },
    ]);
  });
});

describe('applied routes: snapshot seam', () => {
  it('reports the applied set after every pass that changed it, and only then', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = setup(config([HOST]), { deps: { onApplied: (routes) => void snapshots.push(routes) } });

    await h.run();
    await h.run();
    h.engine.setConfig(config([]));
    await h.run('config-change');

    expect(snapshots).toEqual([[{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] }], []]);
  });

  it('survives an applied-routes listener that rejects', async () => {
    const h = setup(config([HOST]), { deps: { onApplied: () => Promise.reject(new Error('disk full')) } });

    const outcome = await h.run();

    expect(ruleState(outcome, 1).status).toBe('active');
    expect(engineLogs(h.entries, 'error', 'applied-routes listener failed')).toHaveLength(1);
  });

  it('hands out copies: changing a snapshot does not change the engine', async () => {
    const h = setup(config([HOST]));
    await h.run();

    const snapshot = h.engine.getApplied() as unknown as { ruleIds: string[] }[];
    snapshot[0]?.ruleIds.push('intruder');
    snapshot.length = 0;

    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] }]);
  });

  it('adopts restored routes that are still wanted and removes the rest', async () => {
    const h = setup(config([HOST]));

    const result = h.engine.restoreApplied([
      { dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)] },
      { dst: '172.16.99.0/24', gateway: ETH_GW, ruleIds: [ruleId(8)] },
      { dst: '172.16.77.7/32', gateway: '10.20.4.9', ruleIds: [] },
    ]);
    const outcome = await h.run('startup');

    expect(result).toEqual({ restored: 3, dropped: 0 });
    expect(h.take()).toEqual([del('172.16.99.0/24', ETH_GW), del('172.16.77.7', '10.20.4.9')]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
  });

  it('drops restored entries that are forbidden, malformed or duplicated, so they are never deleted', async () => {
    const h = setup(config([]));
    const hostile = [
      { dst: '0.0.0.0/0', gateway: ETH_GW, ruleIds: [] },
      { dst: 'default', gateway: ETH_GW, ruleIds: [] },
      { dst: '127.0.0.1', gateway: ETH_GW, ruleIds: [] },
      { dst: '172.16.12.40', gateway: 'not-a-gateway', ruleIds: [] },
      { dst: '172.16.12.40', gateway: '127.0.0.1', ruleIds: [] },
      { dst: 42, gateway: ETH_GW, ruleIds: [] },
      null,
      'route',
      { dst: '172.16.12.41', gateway: ETH_GW, ruleIds: 'x' },
      { dst: '172.16.12.41/32', gateway: ETH_GW, ruleIds: [1, ruleId(2)] },
    ] as unknown as AppliedRoute[];

    const result = h.engine.restoreApplied(hostile);

    expect(result).toEqual({ restored: 1, dropped: 9 });
    expect(h.engine.getApplied()).toEqual([{ dst: '172.16.12.41', gateway: ETH_GW, ruleIds: [] }]);
    await h.run('startup');
    expect(h.take()).toEqual([del('172.16.12.41', ETH_GW)]);
    expect(engineLogs(h.entries, 'warn', 'applied routes restored')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

describe('reconcile: 500 rules', () => {
  it('applies, re-checks and removes the largest allowed config quickly', async () => {
    const rules = Array.from({ length: 500 }, (_unused, index) =>
      index % 2 === 0
        ? rule(index + 1, 'ip', `172.20.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`, 'ethernet')
        : rule(index + 1, 'subnet', `172.${String(21 + Math.floor(index / 250))}.${String(index % 250)}.0/24`, 'wifi'),
    );
    const h = setup(config(rules));

    const startedAt = performance.now();
    const first = await h.run('startup');
    const second = await h.run('drift-check');
    h.engine.setEnabled(false);
    const third = await h.run('enabled-change');
    const elapsed = performance.now() - startedAt;

    expect(first.summary).toEqual({ added: 500, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(first.state.rules.every((entry) => entry.status === 'active' && entry.appliedDestinations.length === 1)).toBe(true);
    expect(second.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(third.summary).toEqual({ added: 0, removed: 500, failed: 0, kept: 0, deferred: 0 });
    expect(h.routes.calls).toHaveLength(1000);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Through the real route.ts and netinfo.ts (fake command runner only)
// ---------------------------------------------------------------------------

describe('engine with the real route and netinfo modules', () => {
  const ROUTE = '/sbin/route';
  const IPCONFIG = '/usr/sbin/ipconfig';
  const PORTS = `
Hardware Port: USB 10/100/1000 LAN
Device: en5
Ethernet Address: 00:00:5e:00:53:05

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 00:00:5e:00:53:00

VLAN Configurations
===================
`;
  const NO_VALUE: FakeCommandResponse = { exitCode: 1 };
  /** `route add` for a destination that is already in the table: exit code 0, the error only in the text (real). */
  const FILE_EXISTS: FakeCommandResponse = {
    exitCode: 0,
    stdout: 'add net 198.51.100.0: gateway 10.20.4.1: File exists\n',
    stderr: 'route: writing to routing socket: File exists\n',
  };
  /** One entry of the simulated kernel table; a null gateway is a connected (on-link) entry. */
  interface KernelEntry {
    readonly gateway: string | null;
    readonly device: string;
  }
  const maskOfCidr = (cidr: string): string => {
    const prefix = Number(cidr.split('/')[1]);
    const bits = 2 ** 32 - 2 ** (32 - prefix);
    return [24, 16, 8, 0].map((shift) => String(Math.floor(bits / 2 ** shift) % 256)).join('.');
  };
  /** A `route -n get` block for an exact entry, in the layout macOS prints. */
  const routeGetBlock = (entry: { address: string; mask?: string; gateway?: string; device: string; flags: string }): string =>
    [
      `   route to: ${entry.address}`,
      `destination: ${entry.address}`,
      ...(entry.mask === undefined ? [] : [`       mask: ${entry.mask}`]),
      ...(entry.gateway === undefined ? [] : [`    gateway: ${entry.gateway}`]),
      `  interface: ${entry.device}`,
      `      flags: <${entry.flags}>`,
      ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire',
      '       0         0         0         0         0         0      1500         0 ',
      '',
    ].join('\n');

  const real = (initialConfig: Config) => {
    const runner = createFakeCommandRunner();
    const memory = createMemorySink();
    const logger = createLogger({ sinks: [memory.sink] });
    let clock = 0;
    const lease = { en5: { ip: '10.20.4.23', router: ETH_GW as string | null }, en0: { ip: '192.168.1.23', router: WIFI_GW as string | null } };

    runner.whenMatching((bin, args) => {
      if (bin === '/usr/sbin/networksetup') return { stdout: PORTS };
      if (bin === '/usr/sbin/netstat') return { stdout: 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n' };
      if (bin !== IPCONFIG) return undefined;
      const device = args[1] === 'en5' || args[1] === 'en0' ? lease[args[1]] : undefined;
      if (device === undefined) return NO_VALUE;
      if (args[0] === 'getifaddr') return { stdout: `${device.ip}\n` };
      if (args[2] === 'router') return device.router === null ? NO_VALUE : { stdout: `${device.router}\n` };
      return { stdout: '255.255.255.0\n' };
    });
    // `/sbin/route` works on a simulated kernel table and answers the way the
    // real one does, unless a test stubs that exact command.
    const table = new Map<string, KernelEntry>();
    runner.whenMatching((bin, args) => {
      if (bin !== ROUTE) return undefined;
      const [, op, kind = '', dst = '', gateway] = args;
      const key = `${kind} ${dst}`;
      const address = dst.split('/')[0] ?? '';
      const label = `${kind.slice(1)} ${address}`;
      const entry = table.get(key);
      if (op === 'add') {
        if (gateway === undefined) return { exitCode: 64 };
        if (entry !== undefined) return { ...FILE_EXISTS, stdout: `add ${label}: gateway ${gateway}: File exists\n` };
        table.set(key, { gateway, device: gateway === WIFI_GW ? 'en0' : 'en5' });
        return { stdout: `add ${label}: gateway ${gateway}\n` };
      }
      if (op === 'delete') {
        if (entry === undefined) return { exitCode: 1, stdout: `delete ${label}: not in table\n`, stderr: 'route: writing to routing socket: not in table\n' };
        table.delete(key);
        return { stdout: `delete ${label}\n` };
      }
      if (op !== 'get') return { exitCode: 64 };
      // No exact entry: the lookup falls through to the default route.
      if (entry === undefined) return { stdout: routeGetBlock({ address, device: 'en0', flags: 'UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL' }).replace(`destination: ${address}`, `destination: default\n       mask: default\n    gateway: ${WIFI_GW}`) };
      const mask = kind === '-net' ? { mask: maskOfCidr(dst) } : {};
      return {
        stdout:
          entry.gateway === null
            ? routeGetBlock({ address, ...mask, device: entry.device, flags: kind === '-net' ? 'UP,DONE,CLONING,STATIC' : 'UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE,IFREF' })
            : routeGetBlock({ address, ...mask, gateway: entry.gateway, device: entry.device, flags: kind === '-net' ? 'UP,GATEWAY,DONE,STATIC,PRCLONING' : 'UP,GATEWAY,HOST,DONE,STATIC' }),
      };
    });

    const engine = createEngine({
      netinfo: createNetInfo({ runner, logger, now: () => clock }),
      routes: createRouteOperations({ runner, logger }),
      logger,
      helperVersion: '1.2.3',
      initialConfig,
      now: () => NOW,
    });
    let taken = 0;
    return {
      engine,
      runner,
      /** The simulated kernel routing table, keyed `-host <address>` / `-net <cidr>`. */
      table,
      lease,
      entries: memory.entries,
      /** Moves past the interface cache. */
      expireCache: () => {
        clock += 60_000;
      },
      run: async (reason: ReconcileReason = 'manual') => {
        const outcome = await engine.reconcile(reason);
        expectValid(outcome.state);
        return outcome;
      },
      /** argv of the `/sbin/route` calls since the previous `routeArgv()`. */
      routeArgv: () => {
        const all = runner.calls.filter((call) => call.bin === ROUTE).map((call) => call.args);
        const fresh = all.slice(taken);
        taken = all.length;
        return fresh;
      },
    };
  };

  it('sends an ip rule as -host (even 10.0.0.0) and a subnet rule as -net, then nothing on the second pass', async () => {
    const r = real(config([HOST, NET, rule(6, 'ip', '10.0.0.0', 'ethernet'), WIFI_HOST]));

    const first = await r.run('startup');

    expect(r.routeArgv()).toEqual([
      ['-n', 'add', '-host', '172.16.12.40', ETH_GW],
      ['-n', 'add', '-net', '172.16.0.0/12', ETH_GW],
      ['-n', 'add', '-host', '10.0.0.0', ETH_GW],
      ['-n', 'add', '-host', '203.0.113.7', WIFI_GW],
    ]);
    expect(first.state.rules.map((entry) => [entry.status, entry.appliedDestinations])).toEqual([
      ['active', ['172.16.12.40']],
      ['active', ['172.16.0.0/12']],
      ['active', ['10.0.0.0']],
      ['active', ['203.0.113.7']],
    ]);
    expect(first.state.interfaces).toEqual({
      ethernet: { device: 'en5', ip: '10.20.4.23', gateway: ETH_GW, up: true },
      wifi: { device: 'en0', ip: '192.168.1.23', gateway: WIFI_GW, up: true },
    });

    await r.run('drift-check');
    expect(r.routeArgv()).toEqual([]);
  });

  it('replaces the routes of an interface whose gateway changed and removes them when it loses its gateway', async () => {
    const r = real(config([HOST, NET, WIFI_HOST]));
    await r.run('startup');
    r.routeArgv();

    r.lease.en5.router = '10.20.4.254';
    r.expireCache();
    await r.run('network-change');

    // Each delete is preceded by its lookup; every delete still comes before any add.
    expect(r.routeArgv()).toEqual([
      ['-n', 'get', '-host', '172.16.12.40'],
      ['-n', 'delete', '-host', '172.16.12.40'],
      ['-n', 'get', '-net', '172.16.0.0/12'],
      ['-n', 'delete', '-net', '172.16.0.0/12'],
      ['-n', 'add', '-host', '172.16.12.40', '10.20.4.254'],
      ['-n', 'add', '-net', '172.16.0.0/12', '10.20.4.254'],
    ]);

    r.lease.en5.router = null;
    r.expireCache();
    const outcome = await r.run('network-change');

    expect(r.routeArgv()).toEqual([
      ['-n', 'get', '-host', '172.16.12.40'],
      ['-n', 'delete', '-host', '172.16.12.40'],
      ['-n', 'get', '-net', '172.16.0.0/12'],
      ['-n', 'delete', '-net', '172.16.0.0/12'],
    ]);
    expect([...r.table.keys()]).toEqual(['-host 203.0.113.7']);
    expect(outcome.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
      ['pending', 'no-gateway'],
      ['pending', 'no-gateway'],
      ['active', null],
    ]);
  });

  it('never starts /sbin/route for a forbidden or directly connected destination', async () => {
    const r = real(
      rawConfig([
        rule(1, 'subnet', '0.0.0.0/0', 'ethernet'),
        rule(2, 'subnet', '192.168.1.0/24', 'ethernet'),
        rule(3, 'subnet', '10.20.4.0/24', 'ethernet'),
        rule(4, 'ip', ETH_GW, 'ethernet'),
      ]),
    );

    const outcome = await r.run('startup');

    expect(r.routeArgv()).toEqual([]);
    expect(outcome.state.rules.map((entry) => entry.reasonCode)).toEqual([
      'forbidden-destination',
      'connected-network',
      'connected-network',
      'connected-network',
    ]);
  });

  it('flagship case: 10.0.0.0/8 through ethernet at 10.20.4.23/24 is one -net add via 10.20.4.1', async () => {
    const r = real(
      config([
        rule(1, 'subnet', '10.0.0.0/8', 'ethernet'),
        rule(2, 'subnet', '192.168.0.0/16', 'wifi'),
      ]),
    );

    const outcome = await r.run('startup');

    expect(r.routeArgv()).toEqual([
      ['-n', 'add', '-net', '10.0.0.0/8', ETH_GW],
      ['-n', 'add', '-net', '192.168.0.0/16', WIFI_GW],
    ]);
    expect(outcome.state.rules.map((entry) => [entry.status, entry.appliedDestinations])).toEqual([
      ['active', ['10.0.0.0/8']],
      ['active', ['192.168.0.0/16']],
    ]);
  });

  it('applies a wider block through the other role: 10.0.0.0/8 through wifi while ethernet is in 10.20.4.0/24', async () => {
    const r = real(config([rule(1, 'subnet', '10.0.0.0/8', 'wifi')]));

    const outcome = await r.run('startup');

    expect(r.routeArgv()).toEqual([['-n', 'add', '-net', '10.0.0.0/8', WIFI_GW]]);
    expect(outcome.state.rules[0]?.status).toBe('active');
  });

  it('reports "File exists" recovery as a replaced foreign route', async () => {
    const r = real(config([HOST]));
    let attempts = 0;
    r.runner.whenMatching((bin, args) => {
      if (bin !== ROUTE || args[1] !== 'add') return undefined;
      attempts += 1;
      return attempts === 1
        ? { ...FILE_EXISTS, stdout: `add host 172.16.12.40: gateway ${ETH_GW}: File exists\n` }
        : {};
    });
    // The entry in the way goes through the Wi-Fi gateway.
    r.runner.when(ROUTE, ['-n', 'get', '-host', '172.16.12.40'], {
      stdout: routeGetBlock({ address: '172.16.12.40', gateway: WIFI_GW, device: 'en0', flags: 'UP,GATEWAY,HOST,DONE,STATIC' }),
    });

    const outcome = await r.run('startup');

    expect(r.routeArgv()).toEqual([
      ['-n', 'add', '-host', '172.16.12.40', ETH_GW],
      ['-n', 'get', '-host', '172.16.12.40'],
      ['-n', 'delete', '-host', '172.16.12.40'],
      ['-n', 'add', '-host', '172.16.12.40', ETH_GW],
    ]);
    expect(outcome.state.rules[0]?.status).toBe('active');
    expect(engineLogs(r.entries, 'warn', 'existing foreign route replaced')).toHaveLength(1);
  });

  it('adopts a route that already goes through the right gateway without deleting anything', async () => {
    const r = real(config([rule(1, 'subnet', '198.51.100.0/24', 'ethernet')]));
    r.runner.when(ROUTE, ['-n', 'add', '-net', '198.51.100.0/24', ETH_GW], FILE_EXISTS);
    r.runner.when(ROUTE, ['-n', 'get', '-net', '198.51.100.0/24'], {
      stdout: routeGetBlock({ address: '198.51.100.0', mask: '255.255.255.0', gateway: ETH_GW, device: 'en5', flags: 'UP,GATEWAY,DONE,STATIC,PRCLONING' }),
    });

    const outcome = await r.run('startup');

    expect(r.routeArgv()).toEqual([
      ['-n', 'add', '-net', '198.51.100.0/24', ETH_GW],
      ['-n', 'get', '-net', '198.51.100.0/24'],
    ]);
    expect(outcome.state.rules[0]).toMatchObject({ status: 'active', appliedDestinations: ['198.51.100.0/24'] });
    expect(engineLogs(r.entries, 'warn', 'existing foreign route adopted')).toHaveLength(1);

    // Ours from here on: switching everything off removes it.
    r.engine.setEnabled(false);
    await r.run('enabled-change');
    expect(r.routeArgv()).toEqual([
      ['-n', 'get', '-net', '198.51.100.0/24'],
      ['-n', 'delete', '-net', '198.51.100.0/24'],
    ]);
  });

  describe('deletes are inspected first: an entry that is no longer our route is never deleted', () => {
    const LAN = rule(4, 'subnet', '192.168.1.0/24', 'ethernet');
    const LAN_KEY = '-net 192.168.1.0/24';
    const LAN_GET = ['-n', 'get', '-net', '192.168.1.0/24'];
    const routeLogs = (r: ReturnType<typeof real>, level: LogEntry['level']) =>
      r.entries.filter((entry) => entry.level === level && entry.context?.['component'] === 'route' && entry.context['op'] === 'delete');

    /** The engine routes 192.168.1.0/24 through ethernet while Wi-Fi is off; then Wi-Fi joins exactly that subnet. */
    const ownedThenConnected = async () => {
      const r = real(config([LAN, HOST]));
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], NO_VALUE);
      const before = await r.run('startup');
      expect(before.state.rules.map((entry) => entry.status)).toEqual(['active', 'active']);
      expect(r.table.get(LAN_KEY)).toEqual({ gateway: ETH_GW, device: 'en5' });
      r.routeArgv();

      // Wi-Fi joins: the entry at that destination is now the kernel's connected route.
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
      r.table.set(LAN_KEY, { gateway: null, device: 'en0' });
      r.expireCache();
      return r;
    };

    it('rule removed after Wi-Fi joined the subnet the engine owned: [get] only, connected route untouched, forgotten with a warn', async () => {
      const r = await ownedThenConnected();

      r.engine.setConfig(config([HOST]));
      const outcome = await r.run('config-change');

      expect(r.routeArgv()).toEqual([LAN_GET]);
      expect(r.table.get(LAN_KEY)).toEqual({ gateway: null, device: 'en0' });
      expect(r.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.40']);
      expect(outcome.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
      expect(routeLogs(r, 'warn').map((entry) => entry.context)).toEqual([
        {
          component: 'route',
          op: 'delete',
          dst: '192.168.1.0/24',
          gateway: ETH_GW,
          kind: 'net',
          outcome: 'not-ours',
          existing: 'connected',
          existingIface: 'en0',
        },
      ]);
      expect(engineLogs(r.entries, 'warn', 'applied route is no longer ours; forgotten, nothing was deleted').map((entry) => entry.context)).toMatchObject([
        { reason: 'config-change', dst: '192.168.1.0/24', gateway: ETH_GW, found: 'connected' },
      ]);

      // Nothing more on later passes, whatever their reason.
      r.expireCache();
      await r.run('network-change');
      await r.run('drift-check');
      expect(r.routeArgv()).toEqual([]);
    });

    it('rule still there: the guard now refuses it, the engine gives the route up with [get] only and never re-adds', async () => {
      const r = await ownedThenConnected();

      const outcome = await r.run('network-change');

      expect(r.routeArgv()).toEqual([LAN_GET]);
      expect(r.table.get(LAN_KEY)).toEqual({ gateway: null, device: 'en0' });
      expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
      expect(r.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.40']);
    });

    it('global toggle off in the same situation: the connected route stays, the other route is removed with [get, delete]', async () => {
      const r = await ownedThenConnected();

      r.engine.setEnabled(false);
      await r.run('enabled-change');

      expect(r.routeArgv()).toEqual([LAN_GET, ['-n', 'get', '-host', '172.16.12.40'], ['-n', 'delete', '-host', '172.16.12.40']]);
      expect([...r.table]).toEqual([[LAN_KEY, { gateway: null, device: 'en0' }]]);
      expect(r.engine.getApplied()).toEqual([]);
    });

    it('a route someone replaced with one through another gateway is left alone and forgotten', async () => {
      const r = real(config([rule(4, 'subnet', '198.51.100.0/24', 'ethernet')]));
      await r.run('startup');
      r.routeArgv();
      r.table.set('-net 198.51.100.0/24', { gateway: WIFI_GW, device: 'en0' });

      r.engine.setConfig(config([]));
      await r.run('config-change');

      expect(r.routeArgv()).toEqual([['-n', 'get', '-net', '198.51.100.0/24']]);
      expect(r.table.get('-net 198.51.100.0/24')).toEqual({ gateway: WIFI_GW, device: 'en0' });
      expect(r.engine.getApplied()).toEqual([]);
      expect(routeLogs(r, 'warn').map((entry) => entry.context?.['existing'])).toEqual(['other-gateway']);
    });

    it('a route that is already gone costs one lookup and counts as removed', async () => {
      const r = real(config([HOST]));
      await r.run('startup');
      r.routeArgv();
      r.table.clear();

      r.engine.setConfig(config([]));
      const outcome = await r.run('config-change');

      // The lookup falls through to the default route: no exact entry, nothing to delete.
      expect(r.routeArgv()).toEqual([['-n', 'get', '-host', '172.16.12.40']]);
      expect(outcome.summary.removed).toBe(1);
      expect(r.engine.getApplied()).toEqual([]);
    });

    it('a lookup that fails keeps the route applied and is repeated on every pass until it answers; then the route is deleted', async () => {
      const r = real(config([HOST]));
      await r.run('startup');
      r.routeArgv();
      const get = ['-n', 'get', '-host', '172.16.12.40'];
      r.runner.when(ROUTE, get, { failure: 'timeout', error: 'Timed out after 10000 ms' });

      r.engine.setConfig(config([]));
      const first = await r.run('config-change');
      const second = await r.run('drift-check');

      expect(r.routeArgv()).toEqual([get, get]);
      expect([first.summary.failed, second.summary.failed]).toEqual([1, 1]);
      expect(r.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.40']);
      expect(r.table.has('-host 172.16.12.40')).toBe(true);

      r.runner.when(ROUTE, get, {
        stdout: routeGetBlock({ address: '172.16.12.40', gateway: ETH_GW, device: 'en5', flags: 'UP,GATEWAY,HOST,DONE,STATIC' }),
      });
      const third = await r.run('drift-check');
      expect(r.routeArgv()).toEqual([get, ['-n', 'delete', '-host', '172.16.12.40']]);
      expect(third.summary).toMatchObject({ removed: 1, failed: 0 });
      expect(r.table.size).toBe(0);
    });

    it('restored routes of a previous process are cleaned up the same way', async () => {
      const r = real(config([]));
      r.table.set('-host 172.16.12.40', { gateway: ETH_GW, device: 'en5' });
      r.table.set(LAN_KEY, { gateway: null, device: 'en0' });
      r.table.set('-net 198.51.100.0/24', { gateway: WIFI_GW, device: 'en0' });
      r.engine.restoreApplied([
        { dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [] },
        { dst: '192.168.1.0/24', gateway: ETH_GW, ruleIds: [] },
        { dst: '198.51.100.0/24', gateway: ETH_GW, ruleIds: [] },
        { dst: '203.0.113.7', gateway: WIFI_GW, ruleIds: [] },
      ]);

      const outcome = await r.run('startup');

      expect(r.routeArgv()).toEqual([
        ['-n', 'get', '-host', '172.16.12.40'],
        ['-n', 'delete', '-host', '172.16.12.40'],
        LAN_GET,
        ['-n', 'get', '-net', '198.51.100.0/24'],
        ['-n', 'get', '-host', '203.0.113.7'],
      ]);
      // Ours deleted; the connected route and the foreign route untouched; the absent one just dropped.
      expect([...r.table.keys()]).toEqual([LAN_KEY, '-net 198.51.100.0/24']);
      expect(r.engine.getApplied()).toEqual([]);
      expect(outcome.summary).toMatchObject({ removed: 2, failed: 0 });
    });
  });

  describe('a standing connected-route refusal is not re-run on periodic passes', () => {
    it('static IP, own LAN: add + lookup on startup, nothing on drift-check and dns-refresh, again on network-change', async () => {
      const r = real(config([rule(4, 'subnet', '10.20.4.0/24', 'ethernet')]));
      r.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], NO_VALUE);
      r.table.set('-net 10.20.4.0/24', { gateway: null, device: 'en5' });
      const attempt = [
        ['-n', 'add', '-net', '10.20.4.0/24', ETH_GW],
        ['-n', 'get', '-net', '10.20.4.0/24'],
      ];

      await r.run('startup');
      expect(r.routeArgv()).toEqual(attempt);

      for (const reason of ['drift-check', 'dns-refresh', 'drift-check'] as const) {
        r.expireCache();
        const outcome = await r.run(reason);
        expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
      }
      expect(r.routeArgv()).toEqual([]);
      const refusals = r.entries.filter((entry) => entry.context?.['component'] === 'route' && entry.context['failure'] === 'connected-route');
      expect(refusals).toHaveLength(1);

      r.expireCache();
      await r.run('network-change');
      expect(r.routeArgv()).toEqual(attempt);
      expect(r.table.get('-net 10.20.4.0/24')).toEqual({ gateway: null, device: 'en5' });
    });
  });

  describe('the wrapper as the second layer: a connected route is never deleted', () => {
    const LAN_ADD = ['-n', 'add', '-net', '10.20.4.0/24', ETH_GW];
    const LAN_GET = ['-n', 'get', '-net', '10.20.4.0/24'];

    it('static IP, subnet unknown to the guard: the own LAN reaches route add, is inspected and left alone', async () => {
      const r = real(config([rule(4, 'subnet', '10.20.4.0/24', 'ethernet'), HOST]));
      r.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], NO_VALUE);
      r.runner.when(ROUTE, LAN_ADD, FILE_EXISTS);
      r.runner.when(ROUTE, LAN_GET, {
        stdout: routeGetBlock({ address: '10.20.4.0', mask: '255.255.255.0', device: 'en5', flags: 'UP,DONE,CLONING,STATIC' }),
      });

      const first = await r.run('startup');
      r.expireCache();
      const second = await r.run('network-change');

      // Pass 1: add, read-only lookup, nothing else for the LAN. Pass 2: the same two, never a delete.
      expect(r.routeArgv()).toEqual([LAN_ADD, LAN_GET, ['-n', 'add', '-host', '172.16.12.40', ETH_GW], LAN_ADD, LAN_GET]);
      for (const outcome of [first, second]) {
        expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
        expect(outcome.state.rules[1]?.status).toBe('active');
      }
      const refusals = r.entries.filter((entry) => entry.context?.['component'] === 'route' && entry.context['failure'] === 'connected-route');
      expect(refusals.map((entry) => entry.level)).toEqual(['warn', 'warn']);
      expect(engineLogs(r.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
    });

    it('leaves the existing entry alone when the lookup cannot say what it is', async () => {
      const r = real(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet')]));
      r.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], NO_VALUE);
      r.runner.when(ROUTE, LAN_ADD, FILE_EXISTS);
      r.runner.when(ROUTE, LAN_GET, { failure: 'timeout', error: 'Timed out after 10000 ms' });

      const outcome = await r.run('startup');

      expect(r.routeArgv()).toEqual([LAN_ADD, LAN_GET]);
      expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'route-failed', appliedDestinations: [] });
    });

    it('stale snapshot: Wi-Fi moved to another LAN during a degraded burst; a rule equal to the new LAN is not deleted', async () => {
      const r = real(config([]));
      await r.run('startup');
      // Wi-Fi is now in 192.168.50.0/24, and its address lookup keeps timing out:
      // the guard still believes the snapshot (192.168.1.0/24) and lets the rule through.
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { failure: 'timeout' });
      const add = ['-n', 'add', '-net', '192.168.50.0/24', ETH_GW];
      const get = ['-n', 'get', '-net', '192.168.50.0/24'];
      r.runner.when(ROUTE, add, FILE_EXISTS);
      r.runner.when(ROUTE, get, {
        stdout: routeGetBlock({ address: '192.168.50.0', mask: '255.255.255.0', device: 'en0', flags: 'UP,DONE,CLONING,STATIC' }),
      });
      r.engine.setConfig(config([rule(1, 'subnet', '192.168.50.0/24', 'ethernet')]));

      const outcomes = [];
      for (let pass = 0; pass < 4; pass += 1) {
        r.expireCache();
        outcomes.push(await r.run('network-change'));
      }

      // Nothing on the two held passes; on each accepted pass an add and a lookup, never a delete.
      expect(r.routeArgv()).toEqual([add, get, add, get]);
      expect(outcomes[3]?.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network', appliedDestinations: [] });
    });
  });

  it('reports a route command the system refuses (not root) as a failed rule', async () => {
    const r = real(config([HOST]));
    r.runner.when(ROUTE, ['-n', 'add', '-host', '172.16.12.40', ETH_GW], {
      exitCode: 77,
      stderr: 'route: must be root to alter routing table\n',
    });

    const outcome = await r.run('startup');

    expect(outcome.state.rules[0]).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: 'Could not add the route for 172.16.12.40: must be root to alter routing table',
      appliedDestinations: [],
    });

    // Not ours, so switching everything off deletes nothing.
    r.routeArgv();
    r.engine.setEnabled(false);
    await r.run('enabled-change');
    expect(r.routeArgv()).toEqual([]);
  });

  describe('an untrusted detection never weakens the guard', () => {
    const TIMEOUT: FakeCommandResponse = { failure: 'timeout' };
    /** Lets the cache expire and reconciles; the engine forces the detection itself after a degraded one. */
    const next = async (r: ReturnType<typeof real>, reason: ReconcileReason = 'network-change') => {
      r.expireCache();
      return r.run(reason);
    };

    it('QA reproduction: a getifaddr timeout on Wi-Fi never lets 192.168.1.0/24 through ethernet reach route', async () => {
      const r = real(config([rule(1, 'subnet', '192.168.1.0/24', 'ethernet')]));
      const verdicts: (readonly [string, string | null])[] = [];
      const record = (outcome: ReconcileOutcome): void => {
        const entry = outcome.state.rules[0];
        verdicts.push([entry?.status ?? '', entry?.reasonCode ?? null]);
      };

      record(await r.run('startup'));
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], TIMEOUT);
      const degraded = [await next(r), await next(r), await next(r), await next(r)];
      degraded.forEach(record);
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
      record(await next(r));

      expect(r.routeArgv()).toEqual([]);
      expect(verdicts).toEqual(Array(6).fill(['error', 'connected-network']));
      expect(degraded.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
      expect(degraded[0]?.state.interfaces.wifi.up).toBe(false);
    });

    it('QA reproduction 2: clean detection while Wi-Fi is off, Wi-Fi joins 192.168.1.0/24, getifaddr times out: nothing reaches route', async () => {
      const r = real(config([HOST]));
      // Wi-Fi off: "no value", which is a clean answer. The snapshot holds nulls for the wifi role.
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], NO_VALUE);
      const before = await r.run('startup');
      expect(before.retryRequested).toBe(false);
      expect(before.state.interfaces.wifi.up).toBe(false);
      expect(r.routeArgv()).toEqual([['-n', 'add', '-host', '172.16.12.40', ETH_GW]]);

      // Wi-Fi joins 192.168.1.0/24; its address lookup times out on every pass; the two rules get enabled.
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], TIMEOUT);
      r.engine.setConfig(
        config([HOST, rule(2, 'subnet', '192.168.1.0/24', 'ethernet'), rule(3, 'ip', WIFI_GW, 'ethernet'), HOST_B]),
      );
      const degraded = [await next(r, 'config-change'), await next(r), await next(r), await next(r)];

      // Held, held, accepted, accepted: an empty /sbin/route argv list on all four.
      expect(r.routeArgv()).toEqual([]);
      expect(degraded.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
      expect(degraded.map((outcome) => outcome.summary.deferred)).toEqual([3, 3, 3, 3]);
      expect(engineLogs(r.entries, 'info', 'reconcile finished').slice(-2).map((entry) => entry.context?.['mode'])).toEqual(['accepted', 'accepted']);
      for (const outcome of degraded) {
        expect(outcome.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
          ['active', null],
          ['pending', 'interface-down'],
          ['pending', 'interface-down'],
          ['pending', 'interface-down'],
        ]);
      }

      // The lookup answers again: the guard knows the Wi-Fi LAN and only the legitimate rule is added.
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
      const settled = await next(r);
      expect(r.routeArgv()).toEqual([['-n', 'add', '-host', '172.16.12.41', ETH_GW]]);
      expect(settled.state.rules.map((entry) => entry.reasonCode)).toEqual([null, 'connected-network', 'connected-network', null]);
    });

    it("never lets the other role's gateway (192.168.1.1 through ethernet) reach route under the same sequence", async () => {
      const r = real(config([rule(1, 'ip', WIFI_GW, 'ethernet')]));

      await r.run('startup');
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], TIMEOUT);
      const degraded = [await next(r), await next(r), await next(r), await next(r)];
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
      const settled = await next(r);

      expect(r.routeArgv()).toEqual([]);
      for (const outcome of [...degraded, settled]) {
        expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
      }
    });

    it('never lets the own LAN (10.20.4.0/24 through ethernet) reach route when the mask lookup times out', async () => {
      const r = real(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet')]));

      await r.run('startup');
      r.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], TIMEOUT);
      const degraded = [await next(r), await next(r), await next(r), await next(r)];

      expect(r.routeArgv()).toEqual([]);
      for (const outcome of degraded) {
        expect(outcome.state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
      }
      expect(degraded.map((outcome) => outcome.retryRequested)).toEqual([true, true, false, false]);
    });

    it('still follows skip-with-warn for a genuine static-IP interface: clean detection, no mask anywhere', async () => {
      const r = real(config([rule(1, 'subnet', '10.20.4.0/24', 'ethernet')]));
      r.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], NO_VALUE);

      const outcome = await r.run('startup');

      expect(outcome.retryRequested).toBe(false);
      expect(r.routeArgv()).toEqual([['-n', 'add', '-net', '10.20.4.0/24', ETH_GW]]);
      expect(outcome.state.rules[0]?.status).toBe('active');
      expect(engineLogs(r.entries, 'warn', 'connected subnet unknown; connected-subnet guard skipped')).toHaveLength(1);
    });

    it('adds a new legitimate rule neither on degraded pass 1 nor 2, but on the accepted third', async () => {
      const r = real(config([HOST]));
      await r.run('startup');
      r.routeArgv();
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], TIMEOUT);

      r.engine.setConfig(config([HOST, rule(8, 'subnet', '198.51.100.0/24', 'ethernet')]));
      const first = await next(r, 'config-change');
      const second = await next(r, 'config-change');
      expect(r.routeArgv()).toEqual([]);
      expect([first, second].map((outcome) => outcome.state.rules[1])).toEqual(
        Array(2).fill(expect.objectContaining({ status: 'pending', reasonCode: 'interface-down', appliedDestinations: [] })),
      );

      const third = await next(r, 'config-change');
      expect(r.routeArgv()).toEqual([['-n', 'add', '-net', '198.51.100.0/24', ETH_GW]]);
      expect(third.state.rules.map((entry) => entry.status)).toEqual(['active', 'active']);
    });

    it('adds a new legitimate rule immediately on a clean pass', async () => {
      const r = real(config([HOST]));
      await r.run('startup');
      r.routeArgv();

      r.engine.setConfig(config([HOST, rule(8, 'subnet', '198.51.100.0/24', 'ethernet')]));
      await next(r, 'config-change');

      expect(r.routeArgv()).toEqual([['-n', 'add', '-net', '198.51.100.0/24', ETH_GW]]);
    });

    it('first detection of the process degraded: no route command until a clean detection arrives', async () => {
      const r = real(config([HOST, rule(2, 'subnet', '192.168.1.0/24', 'ethernet')]));
      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], TIMEOUT);

      const degraded = [await r.run('startup'), await next(r, 'startup'), await next(r, 'startup'), await next(r, 'startup')];

      expect(r.routeArgv()).toEqual([]);
      expect(degraded[3]?.state.rules.map((entry) => [entry.status, entry.reasonCode])).toEqual([
        ['pending', 'interface-down'],
        ['pending', 'interface-down'],
      ]);

      r.runner.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
      const settled = await next(r, 'network-change');
      expect(r.routeArgv()).toEqual([['-n', 'add', '-host', '172.16.12.40', ETH_GW]]);
      expect(settled.state.rules.map((entry) => entry.reasonCode)).toEqual([null, 'connected-network']);
    });
  });

  it('deletes nothing while networksetup fails, then gives the routes up on the third failure', async () => {
    const r = real(config([HOST]));
    await r.run('startup');
    r.routeArgv();
    r.runner.whenMatching((bin) => (bin === '/usr/sbin/networksetup' ? { failure: 'timeout' } : undefined));
    r.expireCache();

    const first = await r.run('network-change');
    const second = await r.run('network-change');
    expect(r.routeArgv()).toEqual([]);
    expect([first.retryRequested, second.retryRequested]).toEqual([true, true]);

    const third = await r.run('network-change');
    expect(r.routeArgv()).toEqual([
      ['-n', 'get', '-host', '172.16.12.40'],
      ['-n', 'delete', '-host', '172.16.12.40'],
    ]);
    expect(third.retryRequested).toBe(false);
    // The forced retries really bypassed the cache: networksetup ran once per pass.
    expect(r.runner.calls.filter((call) => call.bin === '/usr/sbin/networksetup')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Config-change hook, explicit rules before resolved addresses, DNS facts
// ---------------------------------------------------------------------------

describe('onConfigChanged', () => {
  it('is called once for every real change of the config or the toggle, with the new config', () => {
    const seen: Config[] = [];
    const first = config([HOST]);
    const h = setup(first, { deps: { onConfigChanged: (next) => seen.push(next) } });

    expect(seen).toEqual([]);
    expect(h.engine.setConfig(config([HOST]))).toBe(false);
    expect(h.engine.setEnabled(true)).toBe(false);
    expect(seen).toEqual([]);

    const second = config([HOST, NET]);
    expect(h.engine.setConfig(second)).toBe(true);
    expect(seen).toEqual([second]);
    expect(seen[0]).toBe(h.engine.getConfig());

    expect(h.engine.setEnabled(false)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ ...second, enabled: false });
    expect(seen[1]).toBe(h.engine.getConfig());
  });

  it('is called before the call returns, so before the reconcile that follows', async () => {
    const order: string[] = [];
    const h = setup(config([HOST]), {
      deps: {
        onConfigChanged: () => order.push('config-changed'),
        resolveDomain: () => {
          order.push('resolve');
          return unresolvedDomain(DOMAIN_RULE);
        },
      },
    });

    h.engine.setConfig(config([DOMAIN_RULE]));
    order.push('returned');
    await h.run('config-change');

    expect(order).toEqual(['config-changed', 'returned', 'resolve']);
  });

  it('contains a hook that throws: the change stands and the engine goes on', async () => {
    const h = setup(config([HOST]), {
      deps: {
        onConfigChanged: () => {
          throw new Error('listener bug');
        },
      },
    });

    expect(h.engine.setConfig(config([HOST, HOST_B]))).toBe(true);
    expect(h.engine.setEnabled(false)).toBe(true);
    expect(h.engine.setEnabled(true)).toBe(true);
    const outcome = await h.run('config-change');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(outcome.state.configRevision).toBe(3);
    expect(engineLogs(h.entries, 'error', 'config-change listener failed')).toHaveLength(3);
  });
});

const DOMAIN_RULE = rule(5, 'domain', 'corp.local', 'ethernet');
const domainAnswer = (destinations: readonly string[]): DomainTargets => ({
  destinations,
  status: 'active',
  reasonCode: null,
  reason: null,
  lastResolvedAt: '2026-10-12T08:29:00.000Z',
});

describe('explicit rules outrank resolved addresses', () => {
  const WIFI_IP = rule(3, 'ip', '172.16.12.40', 'wifi');
  const WIFI_SUBNET_32 = rule(4, 'subnet', '172.16.12.40/32', 'wifi');
  const answerWith = { resolveDomain: () => domainAnswer(['172.16.12.40', '172.16.12.41']) };

  it.each([
    ['the ip rule comes first', [WIFI_IP, DOMAIN_RULE]],
    ['the domain rule comes first', [DOMAIN_RULE, WIFI_IP]],
    ['a /32 subnet rule comes last', [DOMAIN_RULE, WIFI_SUBNET_32]],
  ])('gives the destination to the explicit rule when %s', async (_name, rules) => {
    const h = setup(config(rules), { deps: answerWith });

    const outcome = await h.run();

    // The explicit destination goes through Wi-Fi; the domain keeps its other address.
    expect(h.take()).toEqual([add('172.16.12.40', WIFI_GW), add('172.16.12.41', ETH_GW)]);
    const explicit = outcome.state.rules.find((entry) => entry.ruleId !== ruleId(5));
    expect(explicit).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    // The domain works through its other address: a warning, not an error (TASK-DELTA-07).
    expect(ruleState(outcome, 5)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason: '1 resolved address is routed by another rule, which takes precedence',
      appliedDestinations: ['172.16.12.41'],
    });
    // The rules are reported in config order, whatever order they were planned in.
    expect(outcome.state.rules.map((entry) => entry.ruleId)).toEqual(rules.map((entry) => entry.id));

    // Stable: the next passes run no command.
    await h.run('dns-refresh');
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
  });

  it('does not take the route of an explicit rule when the domain resolves to its address later', async () => {
    let destinations: readonly string[] = ['172.16.12.41'];
    const h = setup(config([DOMAIN_RULE, WIFI_IP]), { deps: { resolveDomain: () => domainAnswer(destinations) } });
    await h.run();
    expect(h.take()).toEqual([add('172.16.12.40', WIFI_GW), add('172.16.12.41', ETH_GW)]);

    destinations = ['172.16.12.40', '172.16.12.41'];
    const outcome = await h.run('dns-refresh');

    // Before, the domain rule placed first deleted the route and added it through Ethernet.
    expect(h.take()).toEqual([]);
    expect(ruleState(outcome, 3)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
  });

  it('shares the route when the explicit rule and the domain use the same interface', async () => {
    const sameRole = rule(3, 'ip', '172.16.12.40', 'ethernet');
    const h = setup(config([DOMAIN_RULE, sameRole]), { deps: answerWith });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40', '172.16.12.41'] });
    expect(ruleState(outcome, 3)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
  });

  it('leaves an address alone that merely lies inside an explicit subnet of the other interface', async () => {
    const wifiSubnet = rule(4, 'subnet', '172.16.12.0/24', 'wifi');
    const h = setup(config([wifiSubnet, DOMAIN_RULE]), { deps: answerWith });

    const outcome = await h.run();

    // The host routes are more specific: these two addresses go through Ethernet, as the domain rule says.
    expect(h.take()).toEqual([add('172.16.12.0/24', WIFI_GW), add('172.16.12.40', ETH_GW), add('172.16.12.41', ETH_GW)]);
    expect(outcome.state.rules.map((entry) => entry.status)).toEqual(['active', 'active']);
  });

  it('keeps the first of two domain rules that resolve to the same address through different interfaces, without thrashing', async () => {
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');
    const h = setup(config([DOMAIN_RULE, viaWifi]), { deps: { resolveDomain: () => domainAnswer(['172.16.12.40']) } });

    const outcome = await h.run();
    for (let pass = 0; pass < 5; pass += 1) await h.run('dns-refresh');

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 6)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: '172.16.12.40 is already routed through the ethernet interface by another rule',
    });
  });
});

describe('DNS servers of the interfaces', () => {
  type Reported = NonNullable<DetectedInterfaces['dnsServers']>;
  // A new object every time: the engine takes the DNS servers of one detection in once.
  const withDns = (dnsServers: Reported | undefined, extra: Partial<DetectedInterfaces> = {}): DetectedInterfaces => ({
    ...network(extra),
    ...(dnsServers === undefined ? {} : { dnsServers }),
  });
  const SERVERS: Reported = { ethernet: ['10.20.0.10'], wifi: ['192.168.1.1'] };
  const DEGRADED = { degraded: true };

  const recording = () => {
    const contexts: DomainContext[] = [];
    const resolveDomain: DomainResolver = (_rule, context) => {
      contexts.push(context);
      return domainAnswer(['172.16.12.40']);
    };
    return { contexts, resolveDomain };
  };

  /** One pass per detection, in order; returns what the resolver was told in each. */
  const through = async (detections: FakeNetInfo['results'], rules: readonly Rule[] = [DOMAIN_RULE]) => {
    const { contexts, resolveDomain } = recording();
    const h = setup(config(rules), { netinfo: createFakeNetInfo(...detections), deps: { resolveDomain } });
    for (let pass = 0; pass < detections.length; pass += 1) await h.run('network-change');
    return { h, contexts };
  };

  it('asks the detection for them whenever an enabled domain rule exists, and never otherwise', async () => {
    const withOwnDns = rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.20.0.10' });
    const cases: readonly (readonly [Config, boolean])[] = [
      [config([]), false],
      [config([HOST, NET]), false],
      [config([HOST, { ...DOMAIN_RULE, enabled: false }]), false],
      [config([HOST, { ...withOwnDns, enabled: false }]), false],
      [config([DOMAIN_RULE], { enabled: false }), false],
      [config([HOST, DOMAIN_RULE]), true],
      // Also for a rule with its own server: the interfaces' servers must be kept out of its answers.
      [config([HOST, withOwnDns]), true],
    ];
    for (const [initial, wanted] of cases) {
      const h = setup(initial);
      await h.run();
      expect(h.netinfo.calls).toHaveLength(1);
      expect(h.netinfo.calls[0]?.dns).toBe(wanted ? true : undefined);
      expect('dns' in (h.netinfo.calls[0] ?? {})).toBe(wanted);
    }
  });

  it('hands the resolver the servers of the role of the rule, and those of every role', async () => {
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');

    const { contexts } = await through([withDns(SERVERS)], [DOMAIN_RULE, viaWifi]);

    expect(contexts).toEqual([
      { dnsServers: ['10.20.0.10'], interfaceDnsServers: ['10.20.0.10', '192.168.1.1'] },
      { dnsServers: ['192.168.1.1'], interfaceDnsServers: ['10.20.0.10', '192.168.1.1'] },
    ]);
  });

  it('says "not known, nothing better coming" when the detection does not report them at all', async () => {
    const { contexts } = await through([network()]);

    expect(contexts).toEqual([{ dnsServers: undefined, interfaceDnsServers: [] }]);
  });

  it('asks only trusted servers, while the exclusion also takes in what untrusted detections report', async () => {
    const poisoned: Reported = { ethernet: ['203.0.113.53'], wifi: ['203.0.113.54'] };
    const { contexts } = await through([
      withDns(SERVERS),
      withDns(poisoned, DEGRADED),
      withDns({ ethernet: ['203.0.113.55'], wifi: [] }, DEGRADED),
      // The third degraded detection in a row is accepted for routes; its DNS servers still are not asked.
      withDns(poisoned, DEGRADED),
      withDns({ ethernet: ['10.30.0.10'], wifi: ['192.168.1.1'] }),
    ]);

    expect(contexts.map((context) => context.dnsServers)).toEqual([
      ['10.20.0.10'],
      ['10.20.0.10'],
      ['10.20.0.10'],
      ['10.20.0.10'],
      ['10.30.0.10'],
    ]);
    expect(contexts.map((context) => context.interfaceDnsServers)).toEqual([
      ['10.20.0.10', '192.168.1.1'],
      ['10.20.0.10', '203.0.113.53', '192.168.1.1', '203.0.113.54'],
      ['10.20.0.10', '203.0.113.53', '203.0.113.55', '192.168.1.1', '203.0.113.54'],
      // Reported again: moved behind the one seen since.
      ['10.20.0.10', '203.0.113.55', '203.0.113.53', '192.168.1.1', '203.0.113.54'],
      // Only a clean detection that reports the role lets addresses go.
      ['10.30.0.10', '192.168.1.1'],
    ]);
  });

  it('excludes the servers of a detection that is never clean, and makes the rule wait only while a clean one may still come', async () => {
    const seen: Reported = { ethernet: ['10.20.9.53'], wifi: ['192.168.1.1'] };
    const { contexts, h } = await through([
      withDns(seen, DEGRADED),
      withDns(seen, DEGRADED),
      withDns(seen, DEGRADED),
      withDns(seen, DEGRADED),
    ]);

    expect(contexts.map((context) => context.dnsServers)).toEqual([null, null, undefined, undefined]);
    expect(contexts.every((context) => context.interfaceDnsServers.join() === '10.20.9.53,192.168.1.1')).toBe(true);
    // Held twice, accepted on the third pass: the route is added then, with the exclusion already in force.
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
  });

  it('keeps the exclusion through a detection that fails outright', async () => {
    const { contexts } = await through([
      withDns(SERVERS),
      () => {
        throw new Error('detection failed');
      },
      withDns({ ethernet: ['203.0.113.53'], wifi: null }, DEGRADED),
    ]);

    // No resolver call in the failed pass; the next one still excludes everything seen so far.
    expect(contexts.map((context) => context.interfaceDnsServers)).toEqual([
      ['10.20.0.10', '192.168.1.1'],
      ['10.20.0.10', '203.0.113.53', '192.168.1.1'],
    ]);
  });

  it('keeps what it knew about a role whose lookup failed', async () => {
    const { contexts } = await through([withDns(SERVERS), withDns({ ethernet: null, wifi: ['192.168.1.9'] })]);

    expect(contexts.at(-1)).toEqual({ dnsServers: ['10.20.0.10'], interfaceDnsServers: ['10.20.0.10', '192.168.1.9'] });
  });

  it('tells a rule whose role was never looked up successfully to stop waiting', async () => {
    const { contexts } = await through([withDns({ ethernet: null, wifi: [] })]);

    expect(contexts).toEqual([{ dnsServers: undefined, interfaceDnsServers: [] }]);
  });

  it('does not believe a lease that loses its DNS server until it has said so three times', async () => {
    const none = (): DetectedInterfaces => withDns({ ethernet: [], wifi: ['192.168.1.1'] });
    const { contexts } = await through([withDns(SERVERS), none(), none(), none(), none()]);

    expect(DNS_LOSS_GRACE).toBe(2);
    expect(contexts.map((context) => context.dnsServers)).toEqual([['10.20.0.10'], ['10.20.0.10'], ['10.20.0.10'], [], []]);
    expect(contexts.map((context) => context.interfaceDnsServers.includes('10.20.0.10'))).toEqual([true, true, true, false, false]);
  });

  it('starts the count again when the server is back in between, and does not count a cached detection twice', async () => {
    const cached = withDns({ ethernet: [], wifi: ['192.168.1.1'] });
    const { contexts } = await through([
      withDns(SERVERS),
      cached,
      cached,
      cached,
      cached,
      withDns(SERVERS),
      withDns({ ethernet: [], wifi: ['192.168.1.1'] }),
      withDns({ ethernet: [], wifi: ['192.168.1.1'] }),
    ]);

    // The same (cached) detection four times is one report; then the server is back; then two reports.
    expect(contexts).toHaveLength(8);
    expect(contexts.every((context) => context.dnsServers?.join() === '10.20.0.10')).toBe(true);
  });

  it('believes at once that a role has no server when it never had one', async () => {
    const { contexts } = await through([withDns({ ethernet: [], wifi: [] })]);

    expect(contexts).toEqual([{ dnsServers: [], interfaceDnsServers: [] }]);
  });

  it('remembers at most eight excluded addresses per role', async () => {
    const detections = Array.from({ length: 12 }, (_unused, index) =>
      withDns({ ethernet: [`203.0.113.${String(index + 1)}`], wifi: [] }, DEGRADED),
    );

    const { contexts } = await through(detections);

    expect(MAX_EXCLUDED_DNS_PER_ROLE).toBe(8);
    expect(contexts.at(-1)?.interfaceDnsServers).toEqual(Array.from({ length: 8 }, (_unused, index) => `203.0.113.${String(index + 5)}`));
  });

  it('always excludes the servers it asks, whatever the untrusted detections push out of the remembered ones (QA verdict 2)', async () => {
    const others = Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE + 4 }, (_unused, index) =>
      withDns({ ethernet: [`10.66.0.${String(index + 1)}`], wifi: ['192.168.1.1'] }, DEGRADED),
    );

    const { contexts } = await through([withDns({ ethernet: ['10.20.9.53'], wifi: ['192.168.1.1'] }), ...others]);

    expect(contexts.every((context) => context.dnsServers?.join() === '10.20.9.53')).toBe(true);
    expect(contexts.every((context) => context.interfaceDnsServers.includes('10.20.9.53'))).toBe(true);
    // The cap still holds for the remembered ones: the eight reported last, besides the server asked.
    expect(contexts.at(-1)?.interfaceDnsServers).toEqual([
      '10.20.9.53',
      ...Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE }, (_unused, index) => `10.66.0.${String(index + 5)}`),
      '192.168.1.1',
    ]);
  });

  it('drops the address not reported for longest, not one that was reported again', async () => {
    const report = (address: string): DetectedInterfaces => withDns({ ethernet: [address], wifi: [] }, DEGRADED);
    const first = Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE }, (_unused, index) => report(`203.0.113.${String(index + 1)}`));

    // 203.0.113.1 is reported again before the ninth value comes: 203.0.113.2 is the one to go.
    const { contexts } = await through([...first, report('203.0.113.1'), report('203.0.113.99')]);

    expect(contexts.at(-1)?.interfaceDnsServers).toEqual([
      ...Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE - 2 }, (_unused, index) => `203.0.113.${String(index + 3)}`),
      '203.0.113.1',
      '203.0.113.99',
    ]);
  });

  it('always excludes the Wi-Fi servers it asks too, whatever the untrusted detections push out (QA verdict 3)', async () => {
    const others = Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE + 4 }, (_unused, index) =>
      withDns({ ethernet: ['10.20.0.10'], wifi: [`10.99.0.${String(index + 1)}`] }, DEGRADED),
    );
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');

    const { contexts } = await through(
      [withDns({ ethernet: ['10.20.0.10'], wifi: ['10.88.0.53'] }), ...others],
      [viaWifi],
    );

    expect(contexts.every((context) => context.dnsServers?.join() === '10.88.0.53')).toBe(true);
    expect(contexts.every((context) => context.interfaceDnsServers.includes('10.88.0.53'))).toBe(true);
    expect(contexts.at(-1)?.interfaceDnsServers).toEqual([
      '10.20.0.10',
      '10.88.0.53',
      ...Array.from({ length: MAX_EXCLUDED_DNS_PER_ROLE }, (_unused, index) => `10.99.0.${String(index + 5)}`),
    ]);
  });

  describe('the other DNS servers of the system (supplemental resolvers, other interfaces)', () => {
    const withOther = (other: readonly string[] | null | undefined, extra: Partial<DetectedInterfaces> = {}): DetectedInterfaces => ({
      ...withDns(SERVERS, extra),
      ...(other === undefined ? {} : { otherDnsServers: other }),
    });

    it('excludes them after the servers of the roles, and never asks them', async () => {
      const { contexts } = await through([withOther(['10.30.0.53', '10.30.0.54'])]);

      expect(contexts).toEqual([
        { dnsServers: ['10.20.0.10'], interfaceDnsServers: ['10.20.0.10', '192.168.1.1', '10.30.0.53', '10.30.0.54'] },
      ]);
    });

    it('lets a clean detection replace them, while an untrusted one only adds, the one not reported for longest going first', async () => {
      const { contexts } = await through([
        withOther(['10.30.0.53']),
        withOther(['10.30.0.54'], DEGRADED),
        withOther(['10.30.0.53'], DEGRADED),
        // `null`: the configuration could not be read; what was known stays.
        withOther(null, DEGRADED),
        withOther(['10.30.0.55']),
      ]);

      expect(contexts.map((context) => context.interfaceDnsServers.slice(2))).toEqual([
        ['10.30.0.53'],
        ['10.30.0.53', '10.30.0.54'],
        ['10.30.0.54', '10.30.0.53'],
        ['10.30.0.54', '10.30.0.53'],
        ['10.30.0.55'],
      ]);
      expect(contexts.every((context) => context.dnsServers?.join() === '10.20.0.10')).toBe(true);
    });

    it('remembers at most MAX_EXCLUDED_OTHER_DNS of them', async () => {
      const many = (from: number): string[] => Array.from({ length: 20 }, (_unused, index) => `10.40.${String(from)}.${String(index + 1)}`);
      const { contexts } = await through([
        withOther(Array.from({ length: MAX_EXCLUDED_OTHER_DNS + 5 }, (_unused, index) => `10.40.0.${String(index + 1)}`)),
        withOther(many(1), DEGRADED),
        withOther(many(2), DEGRADED),
      ]);

      expect(MAX_EXCLUDED_OTHER_DNS).toBe(32);
      expect(contexts[0]?.interfaceDnsServers.slice(2)).toHaveLength(MAX_EXCLUDED_OTHER_DNS);
      expect(contexts.at(-1)?.interfaceDnsServers.slice(2)).toEqual([...many(1).slice(-12), ...many(2)]);
    });

    it('forgets them with the last domain rule', async () => {
      const { contexts, resolveDomain } = recording();
      const netinfo = createFakeNetInfo(withOther(['10.30.0.53']), network(), withDns({ ethernet: [], wifi: [] }, DEGRADED));
      const h = setup(config([DOMAIN_RULE]), { netinfo, deps: { resolveDomain } });
      await h.run();
      h.engine.setConfig(config([HOST]));
      await h.run('config-change');
      h.engine.setConfig(config([DOMAIN_RULE]));
      await h.run('config-change');

      expect(contexts.at(-1)?.interfaceDnsServers).toEqual([]);
    });

    it('keeps the whole list within what the DNS module reads, the servers asked first, whatever the NetInfo reports', async () => {
      const range = (prefix: string, length: number): string[] =>
        Array.from({ length }, (_unused, index) => `${prefix}.${String(index + 1)}`);
      const trustedEth = range('10.1.0', 12);
      const trustedWifi = range('10.2.0', 12);
      const { contexts } = await through(
        [
          withOther(range('10.5.0', 40), {}),
          ...Array.from({ length: 10 }, (_unused, index) =>
            withOther(range(`10.6.${String(index)}`, 40), { degraded: true }),
          ),
        ].map((detection, index) =>
          index === 0
            ? { ...detection, dnsServers: { ethernet: trustedEth, wifi: trustedWifi } }
            : { ...detection, dnsServers: { ethernet: range(`10.3.${String(index)}`, 12), wifi: range(`10.4.${String(index)}`, 12) } },
        ),
        [DOMAIN_RULE, rule(6, 'domain', 'other.corp.local', 'wifi')],
      );

      expect(MAX_EXCLUDED_DNS_SERVERS).toBe(64);
      for (const context of contexts) {
        expect(context.interfaceDnsServers.length).toBeLessThanOrEqual(MAX_EXCLUDED_DNS_SERVERS);
        // What is asked is excluded, and comes before anything else.
        for (const server of context.dnsServers ?? []) expect(context.interfaceDnsServers).toContain(server);
      }
      const last = contexts.at(-1)?.interfaceDnsServers ?? [];
      expect(last).toHaveLength(MAX_EXCLUDED_DNS_SERVERS);
      expect(last.slice(0, MAX_EXCLUDED_DNS_PER_ROLE)).toEqual(trustedEth.slice(0, MAX_EXCLUDED_DNS_PER_ROLE));
    });
  });

  it('forgets everything when the last enabled domain rule goes, instead of keeping it stale', async () => {
    const { contexts, resolveDomain } = recording();
    const netinfo = createFakeNetInfo(withDns(SERVERS), network(), withDns({ ethernet: ['10.30.0.10'], wifi: [] }, DEGRADED));
    const h = setup(config([DOMAIN_RULE]), { netinfo, deps: { resolveDomain } });
    await h.run();

    // No domain rule: no DNS lookups by the detection, so nothing that was known can be kept current.
    h.engine.setConfig(config([HOST]));
    await h.run('config-change');
    expect(h.netinfo.calls.at(-1)?.dns).toBeUndefined();

    // The rule is back while the interface has another server and the detection is not clean.
    h.engine.setConfig(config([DOMAIN_RULE]));
    await h.run('config-change');

    expect(contexts.at(-1)).toEqual({ dnsServers: null, interfaceDnsServers: ['10.30.0.10'] });
  });
});

// ---------------------------------------------------------------------------
// TASK-111: the rule's own DNS server and the resolver files
// ---------------------------------------------------------------------------

describe('scoped DNS: the route to the rule\'s own DNS server', () => {
  const answer = (destinations: readonly string[]): DomainTargets => ({
    destinations,
    status: 'active',
    reasonCode: null,
    reason: null,
    lastResolvedAt: '2026-10-12T08:29:00.000Z',
  });
  const withServer = (server: string, iface: Rule['iface'] = 'ethernet', n = 5): Rule =>
    rule(n, 'domain', 'corp.local', iface, { dns: server });

  it('routes the server through the rule\'s interface, first, before any answer and as long as the rule lives', async () => {
    let destinations: readonly string[] | null = null;
    const contexts: DomainContext[] = [];
    const h = setup(config([withServer('10.30.0.53')]), {
      deps: {
        resolveDomain: (_rule, context) => {
          contexts.push(context);
          return destinations === null ? unresolvedDomain(_rule) : answer(destinations);
        },
      },
    });

    // Still resolving: the server's route is already there, since the lookups need it.
    const first = await h.run();
    expect(h.take()).toEqual([add('10.30.0.53', ETH_GW)]);
    expect(ruleState(first, 5)).toMatchObject({ status: 'pending', reasonCode: 'resolving', appliedDestinations: ['10.30.0.53'] });

    destinations = ['172.16.12.40'];
    const second = await h.run('dns-refresh');
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(second, 5)).toMatchObject({ status: 'active', appliedDestinations: ['10.30.0.53', '172.16.12.40'] });

    // The context is the engine's own: nothing about the rule's server is added to it.
    expect(contexts.every((context) => !context.interfaceDnsServers.includes('10.30.0.53'))).toBe(true);

    h.engine.setConfig(config([]));
    await h.run('config-change');
    expect(h.take()).toEqual([del('10.30.0.53', ETH_GW), del('172.16.12.40', ETH_GW)]);
  });

  it('adds no route for a server on the interface\'s own link, nor for its gateway, and says nothing about it', async () => {
    for (const server of ['10.20.4.53', ETH_GW]) {
      const h = setup(config([withServer(server)]), { deps: { resolveDomain: () => answer(['172.16.12.40']) } });

      const outcome = await h.run();

      expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
      expect(ruleState(outcome, 5)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: ['172.16.12.40'] });
    }
    // The gateway with an unknown subnet: still the rule's own interface, still no route and no problem.
    const unknownSubnet = createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) }));
    const h = setup(config([withServer(ETH_GW)]), { netinfo: unknownSubnet, deps: { resolveDomain: () => answer(['172.16.12.40']) } });
    const outcome = await h.run();
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 5).status).toBe('active');
  });

  it('still refuses a server on the link of the other interface', async () => {
    const h = setup(config([withServer(WIFI_GW)]), { deps: { resolveDomain: () => answer(['172.16.12.40']) } });

    const outcome = await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
  });

  it('routes the server like an explicit rule: a resolved address of another rule does not take it over, an explicit rule does', async () => {
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');
    const answers = new Map([[ruleId(6), ['10.30.0.53']]]);
    const h = setup(config([viaWifi, withServer('10.30.0.53')]), {
      deps: { resolveDomain: (r) => answer(answers.get(r.id) ?? []) },
    });

    const outcome = await h.run();

    // The domain rules are planned in config order, but the server's route is explicit: the
    // resolved address of the earlier rule gives way.
    expect(h.take()).toEqual([add('10.30.0.53', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'active', appliedDestinations: ['10.30.0.53'] });
    expect(ruleState(outcome, 6)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: '10.30.0.53 is routed through the ethernet interface as the DNS server of another rule, which takes precedence over a resolved address',
    });

    const explicitFirst = setup(config([rule(1, 'ip', '10.30.0.53', 'wifi'), withServer('10.30.0.53')]), {
      deps: { resolveDomain: () => answer(['172.16.12.40']) },
    });
    const second = await explicitFirst.run();
    expect(explicitFirst.take()).toEqual([add('10.30.0.53', WIFI_GW), add('172.16.12.40', ETH_GW)]);
    expect(ruleState(second, 5)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: '10.30.0.53 is already routed through the wifi interface by another rule',
    });
  });

  it('never routes the server twice when an answer contains it, and keeps the rule within the protocol limit', async () => {
    const many = Array.from({ length: 40 }, (_unused, index) => `172.16.13.${String(index + 1)}`);
    const h = setup(config([withServer('10.30.0.53')]), { deps: { resolveDomain: () => answer(['10.30.0.53', ...many]) } });

    const outcome = await h.run();

    expect(ruleState(outcome, 5).appliedDestinations).toEqual(['10.30.0.53', ...many.slice(0, 32)]);
    expect(h.take().filter((call) => call.dst === '10.30.0.53')).toHaveLength(1);
  });

  it('adds no route for the server of an interface (a rule without `dns`)', async () => {
    const withDetected = network();
    const netinfo = createFakeNetInfo({ ...withDetected, dnsServers: { ethernet: ['10.30.0.53'], wifi: [] } });
    const h = setup(config([rule(5, 'domain', 'corp.local', 'ethernet')]), {
      netinfo,
      deps: { resolveDomain: () => answer(['172.16.12.40']) },
    });

    await h.run();

    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
  });
});

describe('scoped DNS: a server of the interface outside its connected subnet', () => {
  const answer: DomainResolver = () => ({ destinations: [], status: 'pending', reasonCode: 'resolving', reason: 'x', lastResolvedAt: null });
  const outsideWarnings = (entries: readonly LogEntry[]): LogEntry[] =>
    engineLogs(entries, 'warn', 'a DNS server of the interface is outside its connected subnet; set `dns` in the rule to route it');
  const detection = (ethernet: readonly string[], subnet = '10.20.4.0/24'): DetectedInterfaces => ({
    ...network({ ethernet: iface('ethernet', { subnet }) }),
    dnsServers: { ethernet, wifi: ['192.168.1.1'] },
  });

  it('warns once per role and set of servers, and again only after it changed', async () => {
    const netinfo = createFakeNetInfo(
      detection(['10.20.4.53', '10.99.0.53']),
      detection(['10.20.4.53', '10.99.0.53']),
      detection(['10.20.4.53']),
      detection(['10.99.0.53']),
      detection(['10.99.0.53'], '10.99.0.0/16'),
      detection(['10.99.0.54'], '10.20.4.0/24'),
    );
    const h = setup(config([rule(5, 'domain', 'corp.local', 'ethernet')]), { netinfo, deps: { resolveDomain: answer } });

    for (let pass = 0; pass < 6; pass += 1) await h.run('network-change');

    expect(outsideWarnings(h.entries).map((entry) => entry.context)).toEqual([
      expect.objectContaining({ role: 'ethernet', subnet: '10.20.4.0/24', servers: ['10.99.0.53'] }),
      expect.objectContaining({ role: 'ethernet', subnet: '10.20.4.0/24', servers: ['10.99.0.53'] }),
      expect.objectContaining({ role: 'ethernet', subnet: '10.20.4.0/24', servers: ['10.99.0.54'] }),
    ]);
  });

  it('says nothing for a rule that names its own server, a subnet that is not known, or no server', async () => {
    const cases: readonly (readonly [Rule, DetectedInterfaces])[] = [
      [rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.30.0.53' }), detection(['10.99.0.53'])],
      [rule(5, 'domain', 'corp.local', 'ethernet'), { ...detection(['10.99.0.53']), ethernet: iface('ethernet', { subnet: null }) }],
      [rule(5, 'domain', 'corp.local', 'ethernet'), detection([])],
    ];
    for (const [domainRule, detected] of cases) {
      const h = setup(config([domainRule]), { netinfo: createFakeNetInfo(detected), deps: { resolveDomain: answer } });
      await h.run();
      expect(outsideWarnings(h.entries)).toEqual([]);
    }
  });
});

describe('scoped DNS: resolver files', () => {
  const DOMAIN_DNS = rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.30.0.53' });
  const pendingAnswer: DomainResolver = () => ({ destinations: [], status: 'pending', reasonCode: 'resolving', reason: 'x', lastResolvedAt: null });

  it('syncs the files with the config of each pass, and makes the rule `error` for a file not in place', async () => {
    const seen: Config[] = [];
    let issues = new Map<string, { reasonCode: 'resolver-conflict'; reason: string }>([
      [ruleId(5), { reasonCode: 'resolver-conflict', reason: '/etc/resolver/corp.local exists and is not managed by RouteSwitch' }],
    ]);
    const syncResolvers = (snapshot: Config): ResolverSync => {
      seen.push(snapshot);
      return { issues };
    };
    const h = setup(config([DOMAIN_DNS, HOST]), { deps: { syncResolvers, resolveDomain: pendingAnswer } });

    const outcome = await h.run();

    expect(seen).toEqual([h.engine.getConfig()]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'error', reasonCode: 'resolver-conflict' });
    // The route to the server is not tied to the file: the helper's own lookups still need it.
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add('10.30.0.53', ETH_GW)]);
    expect(ruleState(outcome, 1).status).toBe('active');

    issues = new Map();
    expect(ruleState(await h.run(), 5)).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
    expect(seen).toHaveLength(2);
  });

  it('shows a file problem also while the interface is down or the detection failed, but never on a disabled rule', async () => {
    const issues = new Map([
      [ruleId(5), { reasonCode: 'resolver-failed' as const, reason: 'cannot write' }],
      [ruleId(6), { reasonCode: 'resolver-failed' as const, reason: 'cannot write' }],
    ]);
    const disabled = rule(6, 'domain', 'other.corp.local', 'ethernet', { dns: '10.30.0.54', enabled: false });
    for (const netinfo of [
      createFakeNetInfo(network({ ethernet: down('ethernet') })),
      createFakeNetInfo(() => {
        throw new Error('detection failed');
      }),
    ]) {
      const seen: Config[] = [];
      const h = setup(config([DOMAIN_DNS, disabled]), {
        netinfo,
        deps: {
          syncResolvers: (snapshot) => {
            seen.push(snapshot);
            return { issues };
          },
        },
      });
      const outcome = await h.run();
      expect(seen).toHaveLength(1);
      expect(ruleState(outcome, 5)).toMatchObject({ status: 'error', reasonCode: 'resolver-failed', reason: 'cannot write' });
      expect(ruleState(outcome, 6).status).toBe('disabled');
    }
  });

  it('turns a sync that throws or rejects into `resolver-failed` of the rules with a server, and nothing else', async () => {
    const plain = rule(6, 'domain', 'other.corp.local', 'ethernet');
    for (const syncResolvers of [
      (): ResolverSync => {
        throw new Error('disk on fire');
      },
      (): Promise<ResolverSync> => Promise.reject(new Error('disk on fire')),
    ]) {
      const h = setup(config([DOMAIN_DNS, plain, HOST]), { deps: { syncResolvers, resolveDomain: pendingAnswer } });

      const outcome = await h.run();

      expect(ruleState(outcome, 5)).toMatchObject({
        status: 'error',
        reasonCode: 'resolver-failed',
        reason: 'Resolver files could not be synced: disk on fire',
      });
      expect(ruleState(outcome, 6)).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
      expect(ruleState(outcome, 1).status).toBe('active');
      expect(engineLogs(h.entries, 'error', 'resolver file sync threw')).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-DELTA-07: a partly applied domain rule is `active` with a warning
// ---------------------------------------------------------------------------

describe('a partly applied domain rule', () => {
  const WIFI_IP = rule(3, 'ip', '172.16.12.40', 'wifi');
  const answer = (
    destinations: readonly string[],
    extra: Partial<DomainTargets> = {},
  ): DomainTargets => ({ ...domainAnswer(destinations), ...extra });
  const partly = (entries: readonly LogEntry[]): LogEntry[] => engineLogs(entries, 'info', 'rule partly applied');

  it('is `active` + `overridden-by-rule` while another address is routed, and says so once', async () => {
    const h = setup(config([DOMAIN_RULE, WIFI_IP]), { deps: { resolveDomain: () => answer(['172.16.12.40', '172.16.12.41']) } });

    const outcome = await h.run();
    await h.run('dns-refresh');
    await h.run('dns-refresh');

    expect(ruleState(outcome, 5)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason: '1 resolved address is routed by another rule, which takes precedence',
      appliedDestinations: ['172.16.12.41'],
    });
    expect(partly(h.entries)).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', 'rule partly applied')).toHaveLength(2);
    expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toEqual([]);
  });

  it('says nothing while the rule is published as deferred, and once when the warning is published (QA verdict 1)', async () => {
    const ethIp = rule(3, 'ip', '172.16.12.40', 'ethernet');
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');
    const netinfo = createFakeNetInfo(network({ degraded: true }), network(), network());
    const h = setup(config([ethIp, viaWifi]), { netinfo, deps: { resolveDomain: () => answer(['172.16.12.40', '172.16.12.41']) } });

    const held = await h.run();
    expect(ruleState(held, 6)).toMatchObject({ status: 'pending', reasonCode: 'interface-down' });
    expect(partly(h.entries)).toEqual([]);
    expect(engineLogs(h.entries, 'debug', 'rule partly applied')).toEqual([]);

    const trusted = await h.run('network-change');
    expect(ruleState(trusted, 6)).toMatchObject({ status: 'active', reasonCode: 'overridden-by-rule', appliedDestinations: ['172.16.12.41'] });
    expect(partly(h.entries)).toHaveLength(1);

    await h.run('network-change');
    expect(partly(h.entries)).toHaveLength(1);
  });

  it('puts the warnings in their order of precedence and counts them all in `reason`', async () => {
    const fromResolver = (reasonCode: 'dns-server-excluded' | 'addresses-truncated', reason: string) =>
      answer(['172.16.12.40', '172.16.12.41', '172.16.12.42'], { reasonCode, reason });
    const cases = [
      [
        fromResolver('dns-server-excluded', '1 resolved address of corp.local is a DNS server and never routed; 40 addresses, the 32 lowest are routed'),
        'overridden-by-rule',
        '1 resolved address is routed by another rule, which takes precedence; 1 resolved address of corp.local is a DNS server and never routed; 40 addresses, the 32 lowest are routed',
      ],
      [
        fromResolver('addresses-truncated', 'corp.local has 40 addresses; the 32 lowest are routed'),
        'overridden-by-rule',
        '1 resolved address is routed by another rule, which takes precedence; corp.local has 40 addresses; the 32 lowest are routed',
      ],
    ] as const;
    for (const [targets, code, reason] of cases) {
      const h = setup(config([DOMAIN_RULE, WIFI_IP]), { deps: { resolveDomain: () => targets } });
      expect(ruleState(await h.run(), 5)).toMatchObject({ status: 'active', reasonCode: code, reason });
    }
    // Without an override the resolver's own warning stands as it is.
    const h = setup(config([DOMAIN_RULE]), {
      deps: { resolveDomain: () => fromResolver('dns-server-excluded', 'x is a DNS server') },
    });
    expect(ruleState(await h.run(), 5)).toMatchObject({ status: 'active', reasonCode: 'dns-server-excluded', reason: 'x is a DNS server' });
  });

  it('counts an address it shares with a rule of its own interface as routed', async () => {
    const ethIp = rule(4, 'ip', '172.16.12.41', 'ethernet');
    const h = setup(config([DOMAIN_RULE, WIFI_IP, ethIp]), { deps: { resolveDomain: () => answer(['172.16.12.40', '172.16.12.41']) } });

    expect(ruleState(await h.run(), 5)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      appliedDestinations: ['172.16.12.41'],
    });
  });

  it('counts overridden addresses, not rules', async () => {
    const wifi41 = rule(4, 'ip', '172.16.12.41', 'wifi');
    const h = setup(config([DOMAIN_RULE, WIFI_IP, wifi41]), {
      deps: { resolveDomain: () => answer(['172.16.12.40', '172.16.12.41', '172.16.12.42']) },
    });

    expect(ruleState(await h.run(), 5)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason: '2 resolved addresses are routed by another rule, which takes precedence',
      appliedDestinations: ['172.16.12.42'],
    });
  });

  it('is an error, as before, when no resolved address is routed (its own DNS server does not count)', async () => {
    for (const rules of [[DOMAIN_RULE, WIFI_IP], [rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.30.0.53' }), WIFI_IP]]) {
      const h = setup(config(rules), { deps: { resolveDomain: () => answer(['172.16.12.40']) } });

      const outcome = await h.run();

      expect(ruleState(outcome, 5)).toMatchObject({
        status: 'error',
        reasonCode: 'route-failed',
        reason: '172.16.12.40 is routed through the wifi interface by an explicit rule, which takes precedence over a resolved address',
      });
      expect(engineLogs(h.entries, 'warn', 'rule cannot be applied')).toHaveLength(1);
      expect(partly(h.entries)).toEqual([]);
    }
  });

  it('counts an address another rule\'s DNS server takes over as overridden too', async () => {
    const viaWifi = rule(6, 'domain', 'other.corp.local', 'wifi');
    const withServer = rule(5, 'domain', 'corp.local', 'ethernet', { dns: '10.30.0.53' });
    const answers = new Map([[ruleId(6), ['10.30.0.53', '172.16.12.50']]]);
    const h = setup(config([viaWifi, withServer]), { deps: { resolveDomain: (r) => answer(answers.get(r.id) ?? []) } });

    const outcome = await h.run();

    expect(ruleState(outcome, 6)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      appliedDestinations: ['172.16.12.50'],
    });
  });

  it('lets any real error win over the warning', async () => {
    const overridden = ['172.16.12.40', '172.16.12.41'];
    const cases: readonly (readonly [string, Parameters<typeof setup>[1], readonly Rule[], string])[] = [
      ['a forbidden address in the answer', { deps: { resolveDomain: () => answer([...overridden, '127.0.0.1']) } }, [DOMAIN_RULE, WIFI_IP], 'forbidden-destination'],
      ['a connected address', { deps: { resolveDomain: () => answer([...overridden, ETH_GW]) } }, [DOMAIN_RULE, WIFI_IP], 'connected-network'],
      ['a failed lookup with the old addresses', {
        deps: { resolveDomain: () => answer(overridden, { status: 'error', reasonCode: 'resolve-failed', reason: 'timed out' }) },
      }, [DOMAIN_RULE, WIFI_IP], 'resolve-failed'],
      ['a resolver file problem', {
        deps: {
          resolveDomain: () => answer(overridden),
          syncResolvers: () => ({ issues: new Map([[ruleId(5), { reasonCode: 'resolver-conflict' as const, reason: 'not ours' }]]) }),
        },
      }, [DOMAIN_RULE, WIFI_IP], 'resolver-conflict'],
      ['two domain rules on one address through two interfaces', {
        deps: { resolveDomain: (r: Rule) => answer(r.id === ruleId(6) ? ['172.16.12.41'] : overridden) },
      }, [rule(6, 'domain', 'other.corp.local', 'wifi'), DOMAIN_RULE, WIFI_IP], 'route-failed'],
    ];
    for (const [name, options, rules, code] of cases) {
      const h = setup(config(rules), options);
      const outcome = await h.run();
      expect([name, ruleState(outcome, 5).status, ruleState(outcome, 5).reasonCode]).toEqual([name, 'error', code]);
      expect(partly(h.entries)).toEqual([]);
    }

    // A route of the remaining address that cannot be added.
    const h = setup(config([DOMAIN_RULE, WIFI_IP]), { deps: { resolveDomain: () => answer(overridden) } });
    h.routes.onAdd = (request) => (request.dst === '172.16.12.41' ? addFailed('add') : added(request));
    expect(ruleState(await h.run(), 5)).toMatchObject({ status: 'error', reasonCode: 'route-failed' });
  });
});

// ---------------------------------------------------------------------------
// Seams of the network monitor (TASK-112)
// ---------------------------------------------------------------------------

describe('forgetApplied (drift check)', () => {
  it('forgets only an entry still applied with the given gateway, deletes nothing, and the next pass adds it again', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = setup(config([HOST, NET]), { deps: { onApplied: (routes) => void snapshots.push(routes) } });
    await h.run('startup');
    h.take();
    snapshots.length = 0;

    const forgotten = h.engine.forgetApplied([
      { dst: '172.16.12.40', gateway: ETH_GW, found: 'missing' },
      // Applied through ETH_GW, not this one: left alone.
      { dst: '172.16.0.0/12', gateway: WIFI_GW, found: 'other-gateway' },
      // Not applied / not a destination at all.
      { dst: '198.51.100.7', gateway: ETH_GW, found: 'missing' },
      { dst: 'garbage', gateway: ETH_GW, found: 'missing' },
    ]);

    expect(forgotten).toBe(1);
    expect(h.take()).toEqual([]);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.0.0/12']);
    const [warning] = engineLogs(h.entries, 'warn', 'applied route is not in the routing table as it was added; forgotten, the next reconcile adds it again');
    expect(warning?.context).toMatchObject({ dst: '172.16.12.40', gateway: ETH_GW, ruleIds: [ruleId(1)], found: 'missing' });

    const outcome = await h.run('drift-check');
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(outcome.summary.added).toBe(1);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    expect(snapshots.at(-1)?.map((route) => route.dst).sort()).toEqual(['172.16.0.0/12', '172.16.12.40']);
  });

  it('reports the smaller applied set to onApplied even when adding it again fails', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = setup(config([HOST]), { deps: { onApplied: (routes) => void snapshots.push(routes) } });
    await h.run('startup');
    snapshots.length = 0;
    expect(h.engine.forgetApplied([{ dst: '172.16.12.40', gateway: ETH_GW, found: 'missing' }])).toBe(1);
    h.routes.onAdd = () => addFailed('add');

    const outcome = await h.run('drift-check');

    expect(outcome.summary).toMatchObject({ added: 0, failed: 1 });
    expect(snapshots).toEqual([[]]);
    // Reported once: the next pass with nothing changed does not report again.
    await h.run('drift-check');
    expect(snapshots).toHaveLength(1);
  });

  it('returns 0 and changes nothing for an empty or unknown list', async () => {
    const h = setup(config([HOST]));
    await h.run('startup');
    expect(h.engine.forgetApplied([])).toBe(0);
    expect(h.engine.forgetApplied([{ dst: '172.16.12.40', gateway: '10.20.4.99', found: 'other-gateway' }])).toBe(0);
    expect(h.engine.getApplied()).toHaveLength(1);
  });
});

describe('isReconciling and getRetryNeeds', () => {
  it('is true while a pass runs and false once it has finished', async () => {
    const netinfo = createFakeNetInfo();
    const gate = deferred();
    netinfo.gate = gate;
    const h = setup(config([HOST]), { netinfo });
    expect(h.engine.isReconciling()).toBe(false);
    const pending = h.engine.reconcile('startup');
    expect(h.engine.isReconciling()).toBe(true);
    gate.open();
    await pending;
    expect(h.engine.isReconciling()).toBe(false);
  });

  it('reports deferred routes of the last pass, refused routes and failing routes', async () => {
    const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    const netinfo = createFakeNetInfo(network({ degraded: true }), network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) }));
    const h = setup(config([LAN, HOST_B]), { netinfo });
    expect(h.engine.getRetryNeeds()).toEqual({ deferred: 0, refused: 0, failing: 0, learnedExpired: 0 });

    await h.run('startup');
    // The LAN rule is the ethernet's own subnet, which the guard keeps out; only HOST_B waits.
    expect(h.engine.getRetryNeeds()).toEqual({ deferred: 1, refused: 0, failing: 0, learnedExpired: 0 });

    h.routes.onAdd = (request) =>
      request.dst === '10.20.4.0/24' ? inspectFailed('connected-route', 'connected route in the way') : addFailed('add');
    await h.run('startup');
    expect(h.engine.getRetryNeeds()).toEqual({ deferred: 0, refused: 1, failing: 1, learnedExpired: 0 });

    h.routes.onAdd = (request) => added(request);
    await h.run('network-change');
    expect(h.engine.getRetryNeeds()).toEqual({ deferred: 0, refused: 0, failing: 0, learnedExpired: 0 });
  });
});

describe('reconcile option retryRefused', () => {
  const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
  const staticEthernet = network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) });

  it('runs a refused add again on a periodic pass', async () => {
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(staticEthernet) });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    await h.run('startup');
    await h.run('drift-check');
    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);

    h.routes.onAdd = (request) => added(request);
    const outcome = await h.engine.reconcile('drift-check', { retryRefused: true });

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
    expect(ruleState(outcome, 1)).toMatchObject({ status: 'active' });
    expect(h.engine.getRetryNeeds().refused).toBe(0);
  });

  it('is kept when calls are merged into one follow-up pass', async () => {
    const netinfo = createFakeNetInfo(staticEthernet);
    const h = setup(config([LAN]), { netinfo });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    await h.run('startup');
    h.take();

    const gate = deferred();
    netinfo.gate = gate;
    const first = h.engine.reconcile('drift-check');
    const merged = [h.engine.reconcile('drift-check', { retryRefused: true }), h.engine.reconcile('dns-refresh')];
    gate.open();
    await Promise.all([first, ...merged]);

    // The first pass skipped the refused add, the merged follow-up ran it.
    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
  });
});

describe('backoff of a route command that keeps failing', () => {
  const clockedSetup = (rules: readonly Rule[]) => {
    const clock = { ms: NOW.getTime() };
    const h = setup(config(rules), { deps: { now: () => new Date(clock.ms) } });
    return { h, clock };
  };

  it('stops deleting on every periodic pass after FAILURE_BACKOFF_AFTER failures and retries after a growing delay', async () => {
    expect(FAILURE_BACKOFF_AFTER).toBe(3);
    const { h, clock } = clockedSetup([HOST, NET]);
    await h.run('startup');
    h.take();
    h.routes.onDelete = (request) => deleteUnidentified(request.dst);
    h.engine.setConfig(config([NET]));

    await h.run('config-change');
    await h.run('drift-check');
    await h.run('dns-refresh');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.12.40', ETH_GW), del('172.16.12.40', ETH_GW)]);
    expect(engineLogs(h.entries, 'warn', 'route command keeps failing; periodic passes retry it less often from now on')).toHaveLength(1);

    // Backed off: no command, the route stays applied, the problem is still counted.
    clock.ms += FAILURE_BACKOFF_BASE_MS - 1;
    const waiting = await h.run('drift-check');
    expect(h.take()).toEqual([]);
    expect(waiting.summary.failed).toBe(0);
    expect(h.engine.getApplied().map((route) => route.dst)).toContain('172.16.12.40');
    expect(h.engine.getRetryNeeds().failing).toBe(1);

    clock.ms += 1;
    await h.run('dns-refresh');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    // The 4th failure doubles the delay.
    clock.ms += FAILURE_BACKOFF_BASE_MS;
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
    clock.ms += FAILURE_BACKOFF_BASE_MS;
    await h.run('drift-check');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);

    // An event pass and a `retryRefused` pass always try.
    await h.run('network-change');
    await h.engine.reconcile('drift-check', { retryRefused: true });
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.12.40', ETH_GW)]);

    h.routes.onDelete = (request) => deleted(request);
    await h.run('manual');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(h.engine.getRetryNeeds().failing).toBe(0);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.0.0/12']);
  });

  it('backs off a failing add the same way and keeps the rule in error meanwhile', async () => {
    const { h, clock } = clockedSetup([HOST]);
    h.routes.onAdd = () => addFailed('add');
    const outcomes = [await h.run('startup'), await h.run('drift-check'), await h.run('dns-refresh')];
    expect(h.take()).toHaveLength(3);

    const skipped = await h.run('drift-check');
    expect(h.take()).toEqual([]);
    expect(ruleState(skipped, 1)).toEqual(ruleState(outcomes[2] ?? clean(), 1));
    expect(ruleState(skipped, 1)).toMatchObject({ status: 'error', reasonCode: 'route-failed' });

    clock.ms += FAILURE_BACKOFF_BASE_MS;
    h.routes.onAdd = (request) => added(request);
    const fixed = await h.run('drift-check');
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(fixed, 1)).toMatchObject({ status: 'active' });
    expect(h.engine.getRetryNeeds().failing).toBe(0);
  });

  it('never waits longer than FAILURE_BACKOFF_MAX_MS', async () => {
    const { h, clock } = clockedSetup([HOST]);
    h.routes.onAdd = () => addFailed('add');
    // Many failures through event passes, which are never backed off.
    for (let index = 0; index < 30; index += 1) await h.run('network-change');
    h.take();
    clock.ms += FAILURE_BACKOFF_MAX_MS - 1;
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
    clock.ms += 1;
    await h.run('drift-check');
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
  });

  it('does not count a refusal or a rejection towards the backoff', async () => {
    const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    const h = setup(config([LAN]), { netinfo: createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) })) });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    for (let index = 0; index < 5; index += 1) await h.run('network-change');
    expect(h.engine.getRetryNeeds()).toMatchObject({ refused: 1, failing: 0 });
  });
});

describe('merged passes keep the urgency of an event reason', () => {
  /** drift-check runs; network-change and then dns-refresh arrive while it does and are merged into one pass. */
  const mergedAfterEvent = async (h: Harness, netinfo: FakeNetInfo): Promise<void> => {
    const gate = deferred();
    netinfo.gate = gate;
    const running = h.engine.reconcile('drift-check');
    const merged = [h.engine.reconcile('network-change'), h.engine.reconcile('dns-refresh')];
    gate.open();
    await Promise.all([running, ...merged]);
    netinfo.gate = null;
  };

  it('retries a backed-off add exactly once', async () => {
    const clock = { ms: NOW.getTime() };
    const netinfo = createFakeNetInfo();
    const h = setup(config([HOST]), { netinfo, deps: { now: () => new Date(clock.ms) } });
    h.routes.onAdd = () => addFailed('add');
    await h.run('startup');
    await h.run('drift-check');
    await h.run('dns-refresh');
    h.take();
    await h.run('drift-check');
    expect(h.take()).toEqual([]);

    await mergedAfterEvent(h, netinfo);

    // The running drift-check is backed off; the merged follow-up (reason dns-refresh) still tries.
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(h.engine.getState().lastReconcileReason).toBe('dns-refresh');
  });

  it('retries a refused add exactly once', async () => {
    const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    const netinfo = createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) }));
    const h = setup(config([LAN]), { netinfo });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    await h.run('startup');
    h.take();

    await mergedAfterEvent(h, netinfo);

    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
  });

  it('does not make a merge of periodic reasons urgent', async () => {
    const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    const netinfo = createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) }));
    const h = setup(config([LAN]), { netinfo });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    await h.run('startup');
    h.take();
    const gate = deferred();
    netinfo.gate = gate;
    const passes = [h.engine.reconcile('drift-check'), h.engine.reconcile('dns-refresh'), h.engine.reconcile('drift-check')];
    gate.open();
    await Promise.all(passes);
    expect(h.take()).toEqual([]);
  });
});

describe('merged passes: retryRefused given on a later merged call (TASK-112 QA follow-up)', () => {
  it('keeps retryRefused passed on the second of two merged periodic calls', async () => {
    const LAN = rule(1, 'subnet', '10.20.4.0/24', 'ethernet');
    const netinfo = createFakeNetInfo(network({ ethernet: iface('ethernet', { subnet: null, netmask: null }) }));
    const h = setup(config([LAN]), { netinfo });
    h.routes.onAdd = () => inspectFailed('connected-route', 'connected route in the way');
    await h.run('startup');
    h.take();
    const gate = deferred();
    netinfo.gate = gate;
    const passes = [
      h.engine.reconcile('dns-refresh'),
      h.engine.reconcile('drift-check'),
      h.engine.reconcile('drift-check', { retryRefused: true }),
      h.engine.reconcile('dns-refresh'),
    ];
    gate.open();
    await Promise.all(passes);
    // The first pass skips the refused add; the merged follow-up runs it once.
    expect(h.take()).toEqual([add('10.20.4.0/24', ETH_GW)]);
  });
});

// ---------------------------------------------------------------------------
// clear() (TASK-113)
// ---------------------------------------------------------------------------

describe('clear', () => {
  const hosts = (count: number): Rule[] =>
    Array.from({ length: count }, (_unused, index) => rule(20 + index, 'ip', `172.16.13.${String(index + 1)}`, 'ethernet'));

  it('deletes every applied route through routeDelete, without detecting the interfaces', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = setup(config([HOST, NET]), { deps: { onApplied: (routes) => void snapshots.push(routes) } });
    await h.run('startup');
    h.take();
    const detections = h.netinfo.calls.length;

    const result = await h.engine.clear();

    expect(result).toEqual({ removed: 2, forgotten: 0, failed: 0 });
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del('172.16.0.0/12', ETH_GW)]);
    expect(h.netinfo.calls).toHaveLength(detections);
    expect(h.engine.getApplied()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);
    const state = h.engine.getState();
    expectValid(state);
    expect(state.rules.every((entry) => entry.appliedDestinations.length === 0)).toBe(true);
  });

  it('forgets a route found through another gateway, keeps one whose delete failed, and reports both', async () => {
    const h = setup(config([HOST, NET, HOST_B]));
    await h.run('startup');
    h.take();
    h.routes.onDelete = (request) =>
      request.dst === '172.16.12.40' ? notOurs(request, 'other-gateway') : request.dst === '172.16.12.41' ? deleteFailed() : deleted(request);

    const result = await h.engine.clear();

    expect(result).toEqual({ removed: 1, forgotten: 1, failed: 1 });
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.41']);
    expect(engineLogs(h.entries, 'warn', 'applied route is no longer ours; forgotten, nothing was deleted')[0]?.context).toMatchObject({
      reason: 'cleanup',
      dst: '172.16.12.40',
    });
    expect(engineLogs(h.entries, 'error', 'route delete failed during cleanup; the route stays applied')).toHaveLength(1);
  });

  it('beforeRoutes (DELTA-31) runs before the first delete; when it rejects, that is logged and the routes go anyway', async () => {
    const h = setup(config([HOST, NET]));
    await h.run('startup');
    h.take();
    const order: string[] = [];
    h.routes.onDelete = (request) => {
      order.push(`delete ${request.dst}`);
      return deleted(request);
    };
    expect(
      await h.engine.clear({
        beforeRoutes: () => {
          order.push('before');
          return Promise.resolve();
        },
      }),
    ).toEqual({ removed: 2, forgotten: 0, failed: 0 });
    expect(order[0]).toBe('before');
    expect(order).toHaveLength(3);

    await h.run('manual');
    h.take();
    expect(await h.engine.clear({ beforeRoutes: () => Promise.reject(new Error('boom')) })).toEqual({ removed: 2, forgotten: 0, failed: 0 });
    expect(engineLogs(h.entries, 'error', 'the step before clearing the routes failed')).toHaveLength(1);
  });

  it('removes routes restored from state.json; one now through another gateway is forgotten, not deleted', async () => {
    const h = setup(config([]));
    h.engine.restoreApplied([
      { dst: '198.51.100.0/24', gateway: ETH_GW, ruleIds: [ruleId(1)] },
      { dst: '192.0.2.7', gateway: ETH_GW, ruleIds: [] },
    ]);
    h.routes.onDelete = (request) => (request.dst === '192.0.2.7' ? notOurs(request, 'other-gateway') : deleted(request));
    expect(await h.engine.clear()).toEqual({ removed: 1, forgotten: 1, failed: 0 });
    expect(h.take()).toEqual([del('198.51.100.0/24', ETH_GW), del('192.0.2.7', ETH_GW)]);
    expect(h.netinfo.calls).toEqual([]);
  });

  it(`runs at most ${String(CLEAR_CONCURRENCY)} deletes at a time`, async () => {
    const h = setup(config(hosts(30)));
    await h.run('startup');
    let inFlight = 0;
    let most = 0;
    const gates: Deferred[] = [];
    h.routes.onDelete = async (request) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
      return deleted(request);
    };
    const clearing = h.engine.clear();
    for (let round = 0; round < 100 && gates.length < 30; round += 1) {
      await Promise.resolve();
      for (const gate of gates) gate.open();
    }
    for (const gate of gates) gate.open();
    expect(await clearing).toEqual({ removed: 30, forgotten: 0, failed: 0 });
    expect(CLEAR_CONCURRENCY).toBe(8);
    expect(most).toBe(CLEAR_CONCURRENCY);
  });

  it('waits for a running pass (and one queued behind it); a reconcile asked for during the deletes runs after them', async () => {
    const netinfo = createFakeNetInfo();
    const h = setup(config([HOST]), { netinfo });
    await h.run('startup');
    h.take();
    const gate = deferred();
    netinfo.gate = gate;
    const running = h.engine.reconcile('manual');
    const queuedBefore = h.engine.reconcile('config-change');
    const clearing = h.engine.clear();
    const during: Promise<ReconcileOutcome>[] = [];
    h.routes.onDelete = (request) => {
      during.push(h.engine.reconcile('config-change'));
      return deleted(request);
    };
    expect(h.engine.isReconciling()).toBe(true);
    gate.open();
    await Promise.all([running, queuedBefore, clearing]);
    expect(during).toHaveLength(1);
    await Promise.all(during);
    // Both passes before the clear found the route in place; the clear removed it; the pass after it added it again.
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), add('172.16.12.40', ETH_GW)]);
    expect(h.engine.getApplied()).toHaveLength(1);
  });

  it('final: nothing reconciles afterwards, also a pass queued while it ran', async () => {
    const h = setup(config([HOST]));
    await h.run('startup');
    h.take();
    const queued: Promise<ReconcileOutcome>[] = [];
    h.routes.onDelete = (request) => {
      queued.push(h.engine.reconcile('dns-refresh'));
      return deleted(request);
    };
    await h.engine.clear({ final: true });
    const late = await h.engine.reconcile('network-change');
    expect(queued).toHaveLength(1);
    await Promise.all(queued);

    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(late.summary).toEqual({ added: 0, removed: 0, failed: 0, kept: 0, deferred: 0 });
    expect(h.engine.getApplied()).toEqual([]);
    expect(h.engine.isReconciling()).toBe(false);
  });

  it('final: a pass queued while a running one finishes does not run, so a stream of requests cannot delay the shutdown', async () => {
    const netinfo = createFakeNetInfo();
    const h = setup(config([HOST]), { netinfo });
    await h.run('startup');
    h.take();
    const gate = deferred();
    netinfo.gate = gate;
    const detections = netinfo.calls.length;
    const running = h.engine.reconcile('manual');
    // Queued behind the running pass before the final clear came (a request, a monitor event).
    const queuedBefore = h.engine.reconcile('config-change');
    const clearing = h.engine.clear({ final: true });
    // Asked for after the final clear was called: answered at once.
    const queuedAfter = h.engine.reconcile('network-change');
    gate.open();
    await Promise.all([running, queuedBefore, clearing, queuedAfter]);
    // Only the running pass detected; the queued one never ran, the clear removed the route.
    expect(netinfo.calls.length).toBe(detections + 1);
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW)]);
    expect(h.engine.getApplied()).toEqual([]);
    expect(h.engine.isReconciling()).toBe(false);
  });

  it('getConfigRevision: goes up with every real change of the config, before any pass', () => {
    const h = setup(config([HOST]));
    expect(h.engine.getConfigRevision()).toBe(0);
    expect(h.engine.setEnabled(true)).toBe(false);
    expect(h.engine.getConfigRevision()).toBe(0);
    h.engine.setEnabled(false);
    h.engine.setConfig(config([]));
    expect(h.engine.getConfigRevision()).toBe(2);
    // The published state catches up only with the next pass.
    expect(h.engine.getState().configRevision).toBe(0);
  });

  it('with nothing applied runs no command and still publishes a valid state', async () => {
    const h = setup(config([HOST], { enabled: false }));
    const seq = h.engine.getState().seq;
    expect(await h.engine.clear()).toEqual({ removed: 0, forgotten: 0, failed: 0 });
    expect(h.take()).toEqual([]);
    expect(h.engine.getState().seq).toBe(seq + 1);
    expectValid(h.engine.getState());
    expect(h.engine.getState().rules[0]).toMatchObject({ status: 'disabled', reasonCode: 'globally-disabled' });
  });

  it('turns a delete that throws into a failure that stays applied', async () => {
    const h = setup(config([HOST]));
    await h.run('startup');
    h.routes.onDelete = () => {
      throw new Error('runner gone');
    };
    expect(await h.engine.clear()).toEqual({ removed: 0, forgotten: 0, failed: 1 });
    expect(h.engine.getApplied()).toHaveLength(1);
  });
});

describe('DNS-server warnings (TASK-DELTA-19)', () => {
  type Reported = NonNullable<DetectedInterfaces['dnsServers']>;
  // A new object every time: the engine takes the DNS servers of one detection in once.
  const withDns = (dnsServers: Reported, extra: Partial<DetectedInterfaces> = {}): DetectedInterfaces => ({
    ...network(extra),
    dnsServers,
  });
  const IN_WIFI_SUBNET: Reported = { ethernet: ['192.168.1.53'], wifi: ['192.168.1.1'] };
  const OUTSIDE: Reported = { ethernet: ['198.51.100.53'], wifi: ['192.168.1.1'] };
  const found = (iface: string): RouteGetResult => ({
    ok: true,
    outcome: 'found',
    route: { target: '198.51.100.53', destination: 'default', mask: null, gateway: WIFI_GW, iface, flags: ['UP', 'GATEWAY'] },
  });
  const resolveDomain: DomainResolver = () => domainAnswer(['172.16.12.40']);

  /** A harness whose route operations can look a route up; `answer` says what the table shows. */
  const rig = (initial: Config, detections: FakeNetInfo['results'], withLookup = true) => {
    const fake = createFakeRoutes();
    const lookups: string[] = [];
    const io: { answer: (server: string) => RouteGetResult | Promise<RouteGetResult> } = {
      answer: () => found('en0'),
    };
    const routes: EngineDeps['routes'] = withLookup
      ? {
          routeAdd: (request) => fake.routeAdd(request),
          routeDelete: (request) => fake.routeDelete(request),
          routeGet: async (server) => {
            lookups.push(server);
            return io.answer(server);
          },
        }
      : { routeAdd: (request) => fake.routeAdd(request), routeDelete: (request) => fake.routeDelete(request) };
    const h = setup(initial, { netinfo: createFakeNetInfo(...detections), deps: { routes, resolveDomain } });
    return { h, fake, lookups, io };
  };

  const SUBNET_WARNING = {
    server: '192.168.1.53',
    source: 'interface',
    role: 'ethernet',
    via: 'wifi',
    code: 'other-interface-subnet',
  } as const;

  it('reports an interface server inside the other role subnet, without a lookup, and changes no rule or route', async () => {
    const { h, fake, lookups } = rig(config([DOMAIN_RULE]), [withDns(IN_WIFI_SUBNET)]);
    const outcome = await h.run('startup');
    expect(outcome.state.dnsWarnings).toEqual([SUBNET_WARNING]);
    expect(lookups).toEqual([]);
    expect(fake.calls).toEqual([add('172.16.12.40', ETH_GW)]);
    expect(ruleState(outcome, 5)).toMatchObject({ status: 'active', reasonCode: null });
  });

  it('drops the warning once an `ip` rule routes the server through its role, and says so once', async () => {
    const { h, fake } = rig(config([DOMAIN_RULE]), [withDns(IN_WIFI_SUBNET), withDns(IN_WIFI_SUBNET), withDns(IN_WIFI_SUBNET)]);
    await h.run('startup');
    h.engine.setConfig(config([DOMAIN_RULE, rule(8, 'ip', '192.168.1.53', 'ethernet')]));
    const outcome = await h.run('config-change');
    expect(fake.calls).toContainEqual(add('192.168.1.53', ETH_GW));
    expect(outcome.state).not.toHaveProperty('dnsWarnings');
    expect(engineLogs(h.entries, 'info', 'DNS servers are reached through their own interfaces again')).toHaveLength(1);
    await h.run('drift-check');
    expect(engineLogs(h.entries, 'info', 'DNS servers are reached through their own interfaces again')).toHaveLength(1);
  });

  it('logs a standing warning at `warn` once, then at `debug`, and again at `warn` when it changes', async () => {
    const MSG = 'a DNS server is reached through the other interface; add an `ip` rule for it';
    const changed: Reported = { ethernet: ['192.168.1.54'], wifi: ['192.168.1.1'] };
    const { h } = rig(config([DOMAIN_RULE]), [withDns(IN_WIFI_SUBNET), withDns(IN_WIFI_SUBNET), withDns(changed)]);
    await h.run('startup');
    await h.run('drift-check');
    expect(engineLogs(h.entries, 'warn', MSG)).toHaveLength(1);
    expect(engineLogs(h.entries, 'debug', MSG)).toHaveLength(1);
    expect(engineLogs(h.entries, 'warn', MSG)[0]?.context).toMatchObject({ reason: 'startup', warnings: [SUBNET_WARNING] });
    await h.run('drift-check');
    expect(engineLogs(h.entries, 'warn', MSG)).toHaveLength(2);
  });

  it('asks the table for a server nothing else decides, once while the interface facts stay the same', async () => {
    const moved = { wifi: iface('wifi', { ip: '192.168.1.24' }) };
    const { h, lookups } = rig(config([DOMAIN_RULE]), [
      withDns(OUTSIDE),
      withDns(OUTSIDE),
      withDns(OUTSIDE),
      withDns(OUTSIDE, moved),
      withDns(OUTSIDE, moved),
      withDns(OUTSIDE, moved),
    ]);
    const first = await h.run('startup');
    expect(first.state.dnsWarnings).toEqual([
      { server: '198.51.100.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'routed-via-other-interface' },
    ]);
    expect(lookups).toEqual(['198.51.100.53']);
    // A periodic pass, same facts: the answer is reused and the warning stays.
    expect((await h.run('drift-check')).state.dnsWarnings).toHaveLength(1);
    expect((await h.run('dns-refresh')).state.dnsWarnings).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    // Interface facts changed: asked again.
    await h.run('drift-check');
    expect(lookups).toHaveLength(2);
    // The monitor's network change: asked again, even with the same facts.
    await h.run('network-change');
    expect(lookups).toHaveLength(3);
    // A forced pass (the "apply" button) as well.
    await h.engine.reconcile('manual', { force: true });
    expect(lookups).toHaveLength(4);
    // The flag is used up by the pass that refreshed: the next periodic pass reuses the answer.
    await h.run('drift-check');
    expect(lookups).toHaveLength(4);
  });

  it('keeps a network change asked for during a pass, although the merged follow-up has another reason', async () => {
    const { h, lookups, io } = rig(config([DOMAIN_RULE]), [withDns(OUTSIDE), withDns(OUTSIDE), withDns(OUTSIDE)]);
    await h.run('startup');
    expect(lookups).toHaveLength(1);
    // The second pass is held inside its lookup while the monitor reports a change.
    const gate = deferred();
    io.answer = async () => {
      await gate.promise;
      return found('en0');
    };
    const running = h.engine.reconcile('network-change');
    await vi.waitFor(() => {
      expect(lookups).toHaveLength(2);
    });
    const merged = [h.engine.reconcile('network-change'), h.engine.reconcile('drift-check')];
    gate.open();
    await running;
    const [followUp] = await Promise.all(merged);
    // One follow-up pass, with the latest reason, that still looks the server up again.
    expect(followUp?.state.lastReconcileReason).toBe('drift-check');
    expect(lookups).toHaveLength(3);
  });

  it('says nothing when the table takes the server through its own role or another device', async () => {
    for (const device of ['en5', 'utun3']) {
      const { h, io } = rig(config([DOMAIN_RULE]), [withDns(OUTSIDE)]);
      io.answer = () => found(device);
      expect((await h.run('startup')).state).not.toHaveProperty('dnsWarnings');
    }
  });

  it('treats a lookup that fails or throws as no answer (no warning), and logs it', async () => {
    const { h, io } = rig(config([DOMAIN_RULE]), [withDns(OUTSIDE), withDns(OUTSIDE)]);
    io.answer = (server) => ({ ok: false, outcome: 'not-found', target: server });
    expect((await h.run('startup')).state).not.toHaveProperty('dnsWarnings');
    expect(engineLogs(h.entries, 'debug', 'route lookup for a DNS server gave no route')).toHaveLength(1);

    io.answer = () => {
      throw new Error('runner gone');
    };
    expect((await h.run('network-change')).state).not.toHaveProperty('dnsWarnings');
    expect(engineLogs(h.entries, 'error', 'route lookup for a DNS server threw')[0]?.context).toMatchObject({
      dst: '198.51.100.53',
      error: 'runner gone',
    });
  });

  it('without a route lookup reports only what its own facts tell', async () => {
    const subnet = rig(config([DOMAIN_RULE]), [withDns(IN_WIFI_SUBNET)], false);
    expect((await subnet.h.run('startup')).state.dnsWarnings).toEqual([SUBNET_WARNING]);
    const outside = rig(config([DOMAIN_RULE]), [withDns(OUTSIDE)], false);
    expect((await outside.h.run('startup')).state).not.toHaveProperty('dnsWarnings');
  });

  it('keeps the previous warnings through an untrusted detection, and looks nothing up then', async () => {
    const { h, lookups } = rig(config([DOMAIN_RULE]), [
      withDns(OUTSIDE),
      withDns({ ethernet: [], wifi: [] }, { degraded: true }),
      withDns({ ethernet: [], wifi: [] }, { degraded: true }),
    ]);
    await h.run('startup');
    expect(lookups).toHaveLength(1);
    const held = await h.run('network-change');
    expect(held.state.dnsWarnings).toHaveLength(1);
    expect((await h.run('network-change')).state.dnsWarnings).toHaveLength(1);
    expect(lookups).toHaveLength(1);
  });

  it('keeps them when the detection fails altogether, and in the state `clear()` publishes', async () => {
    const { h } = rig(config([DOMAIN_RULE]), [
      withDns(IN_WIFI_SUBNET),
      () => {
        throw new Error('detection broke');
      },
    ]);
    await h.run('startup');
    expect((await h.run('network-change')).state.dnsWarnings).toEqual([SUBNET_WARNING]);
    await h.engine.clear();
    expect(h.engine.getState().dnsWarnings).toEqual([SUBNET_WARNING]);
    expectValid(h.engine.getState());
  });

  it('reports a rule `dns` server the engine could not route, with the rule id', async () => {
    // The rule's server is the Wi-Fi gateway: the connected-subnet guard refuses its route.
    const withGatewayDns = rule(5, 'domain', 'corp.local', 'ethernet', { dns: WIFI_GW });
    const { h } = rig(config([withGatewayDns]), [withDns({ ethernet: [], wifi: [] })]);
    const outcome = await h.run('startup');
    expect(outcome.state.dnsWarnings).toEqual([
      { server: WIFI_GW, source: 'rule', role: 'ethernet', via: 'wifi', ruleId: ruleId(5), code: 'other-interface-subnet' },
    ]);
  });

  it('reports nothing for a rule `dns` server the engine routes, or with the global toggle off', async () => {
    const withOwnDns = rule(5, 'domain', 'corp.local', 'ethernet', { dns: '192.168.1.53' });
    const { h, fake } = rig(config([withOwnDns]), [withDns({ ethernet: [], wifi: [] }), withDns({ ethernet: [], wifi: [] })]);
    const outcome = await h.run('startup');
    expect(fake.calls).toContainEqual(add('192.168.1.53', ETH_GW));
    expect(outcome.state).not.toHaveProperty('dnsWarnings');

    const off = rig(config([DOMAIN_RULE], { enabled: false }), [withDns(IN_WIFI_SUBNET)]);
    expect((await off.h.run('startup')).state).not.toHaveProperty('dnsWarnings');
  });

  it('runs at most DNS_LOOKUP_CONCURRENCY lookups at once and at most 16 per pass', async () => {
    const many = Array.from({ length: 20 }, (_, index) => `198.51.100.${String(index + 1)}`);
    const { h, lookups, io } = rig(config([DOMAIN_RULE]), [withDns({ ethernet: many.slice(0, 8), wifi: many.slice(8) })]);
    let inFlight = 0;
    let peak = 0;
    io.answer = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return found('en0');
    };
    const outcome = await h.run('startup');
    expect(peak).toBe(DNS_LOOKUP_CONCURRENCY);
    // The engine keeps at most 8 servers per role; all 16 are looked up once.
    expect(lookups).toHaveLength(16);
    expect(new Set(lookups).size).toBe(16);
    // Through Wi-Fi: wrong for the eight Ethernet servers only.
    expect(outcome.state.dnsWarnings?.map((warning) => warning.role)).toEqual(Array.from({ length: 8 }, () => 'ethernet'));
  });

  it('looks a server up again when it needs a lookup again after an `ip` rule covered it for a while', async () => {
    const coverRule = rule(8, 'ip', '198.51.100.53', 'ethernet');
    const { h, lookups } = rig(config([DOMAIN_RULE]), [withDns(OUTSIDE), withDns(OUTSIDE), withDns(OUTSIDE)]);
    await h.run('startup');
    h.engine.setConfig(config([DOMAIN_RULE, coverRule]));
    expect((await h.run('config-change')).state).not.toHaveProperty('dnsWarnings');
    h.engine.setConfig(config([DOMAIN_RULE]));
    expect((await h.run('config-change')).state.dnsWarnings).toHaveLength(1);
    // Not the answer from before the rule: the table is asked again.
    expect(lookups).toEqual(['198.51.100.53', '198.51.100.53']);
  });

  it('keeps the warnings in the state of a pass that failed unexpectedly', async () => {
    let broken = false;
    // A resolver answer the pass cannot handle: the engine's last line of defence publishes the state.
    const h = setup(config([DOMAIN_RULE]), {
      netinfo: createFakeNetInfo(withDns(IN_WIFI_SUBNET), withDns(IN_WIFI_SUBNET)),
      deps: {
        resolveDomain: () => (broken ? ({ destinations: null } as unknown as DomainTargets) : domainAnswer(['172.16.12.40'])),
      },
    });
    expect((await h.run('startup')).state.dnsWarnings).toEqual([SUBNET_WARNING]);
    broken = true;
    const failed = await h.run('drift-check');
    expect(engineLogs(h.entries, 'error', 'reconcile failed unexpectedly')).toHaveLength(1);
    expect(failed.state.dnsWarnings).toEqual([SUBNET_WARNING]);
  });

  it('judges no rule server while the global toggle is off', async () => {
    const withGatewayDns = rule(5, 'domain', 'corp.local', 'ethernet', { dns: WIFI_GW });
    const { h } = rig(config([withGatewayDns], { enabled: false }), [withDns({ ethernet: [], wifi: [] })]);
    expect((await h.run('startup')).state).not.toHaveProperty('dnsWarnings');
  });

  it('routes exactly as without the warnings (differential)', async () => {
    const scenarios: readonly (readonly [Config, Reported, Partial<DetectedInterfaces>])[] = [
      [config([DOMAIN_RULE]), IN_WIFI_SUBNET, {}],
      [config([DOMAIN_RULE, HOST, WIFI_HOST]), OUTSIDE, {}],
      [config([rule(5, 'domain', 'corp.local', 'ethernet', { dns: WIFI_GW }), NET]), OUTSIDE, {}],
      [config([rule(5, 'domain', 'corp.local', 'ethernet', { dns: '192.168.1.53' }), rule(8, 'ip', '192.168.1.53', 'wifi')]), IN_WIFI_SUBNET, {}],
      [config([DOMAIN_RULE, rule(8, 'ip', '198.51.100.53', 'ethernet')]), OUTSIDE, { wifi: down('wifi') }],
      [config([DOMAIN_RULE, HOST]), IN_WIFI_SUBNET, { ethernet: noGateway('ethernet') }],
    ];
    for (const [initial, servers, extra] of scenarios) {
      const reasons: readonly ReconcileReason[] = ['startup', 'drift-check', 'network-change', 'manual'];
      const detections = reasons.map(() => withDns(servers, extra));
      const withWarnings = rig(initial, detections, true);
      const without = rig(initial, detections.map((detection) => ({ ...detection })), false);
      for (const reason of reasons) {
        const a = await withWarnings.h.run(reason);
        const b = await without.h.run(reason);
        expect(a.state.rules).toEqual(b.state.rules);
        expect(a.summary).toEqual(b.summary);
      }
      expect(withWarnings.fake.calls).toEqual(without.fake.calls);
      expect(withWarnings.h.engine.getApplied()).toEqual(without.h.engine.getApplied());
    }
  });
});

describe('buildEngineState — dnsWarnings', () => {
  const base = {
    helperVersion: '1.2.3',
    seq: 1,
    configRevision: 0,
    config: config([]),
    wire: { interfaces: { ethernet: { device: null, ip: null, gateway: null, up: false }, wifi: { device: null, ip: null, gateway: null, up: false } }, adapters: [] },
    verdicts: new Map(),
    applied: [],
    lastApplyAt: null,
    lastReconcileReason: null,
  } as const;
  const WARNING = { server: '192.168.1.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'other-interface-subnet' } as const;

  it('leaves the field out when there is no warning, and copies the warnings otherwise', () => {
    expect(buildEngineState(base)).not.toHaveProperty('dnsWarnings');
    expect(buildEngineState({ ...base, dnsWarnings: [] })).not.toHaveProperty('dnsWarnings');
    const warnings = [WARNING];
    const state = buildEngineState({ ...base, dnsWarnings: warnings });
    expect(state.dnsWarnings).toEqual([WARNING]);
    expect(state.dnsWarnings?.[0]).not.toBe(WARNING);
    expect(EngineState.safeParse(state).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wildcard domain rules: learned routes (TASK-DELTA-27, ADR-002 §3, §4)
// ---------------------------------------------------------------------------

interface FakeTimers {
  readonly set: NonNullable<EngineDeps['setTimer']>;
  readonly clear: NonNullable<EngineDeps['clearTimer']>;
  /** Delays of the timers that are pending, in the order they were set. */
  pending(): number[];
  /** Fires every pending timer. */
  fireAll(): void;
}

const createFakeTimers = (): FakeTimers => {
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 0;
  return {
    set: (callback, delayMs) => {
      next += 1;
      timers.set(next, { callback, delayMs });
      return next;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
    pending: () => [...timers.values()].map((timer) => timer.delayMs),
    fireAll: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.callback();
    },
  };
};

const WILD = rule(40, 'domain', '*.corp.local', 'ethernet');
const DEEP_WIFI = rule(42, 'domain', '*.a.corp.local', 'wifi');
const OTHER_WILD_WIFI = rule(43, 'domain', '*.other.local', 'wifi');
const L1 = '172.16.20.1';
const L2 = '172.16.20.2';
const L3 = '172.16.20.3';

interface LearningHarness extends Harness {
  readonly timers: FakeTimers;
  readonly resolved: Rule[];
  /** Moves the wall clock and the monotonic clock forward. */
  advance(seconds: number): void;
  learn(n: number, addresses: readonly string[], ttlSec?: number): Promise<Awaited<ReturnType<Engine['learn']>>>;
}

const learning = (
  rules: readonly Rule[],
  options: { netinfo?: FakeNetInfo; deps?: Partial<EngineDeps>; extra?: Partial<Config> } = {},
): LearningHarness => {
  let wallMs = NOW.getTime();
  let monoMs = 0;
  const timers = createFakeTimers();
  const resolved: Rule[] = [];
  const h = setup(config(rules, options.extra), {
    ...(options.netinfo === undefined ? {} : { netinfo: options.netinfo }),
    deps: {
      now: () => new Date(wallMs),
      monotonicNow: () => monoMs,
      setTimer: timers.set,
      clearTimer: timers.clear,
      resolveDomain: (resolvedRule) => {
        resolved.push(resolvedRule);
        return domainAnswer(['172.16.12.40']);
      },
      ...options.deps,
    },
  });
  return {
    ...h,
    timers,
    resolved,
    advance: (seconds) => {
      wallMs += seconds * 1000;
      monoMs += seconds * 1000;
    },
    learn: async (n, addresses, ttlSec = 300) => {
      const result = await h.engine.learn(ruleId(n), addresses, ttlSec);
      expectValid(h.engine.getState());
      return result;
    },
  };
};

const stateOf = (engine: Engine, n: number) => {
  const found = engine.getState().rules.find((entry) => entry.ruleId === ruleId(n));
  if (found === undefined) throw new Error(`no state for rule ${String(n)}`);
  return found;
};

describe('wildcard rules: learn', () => {
  it('is active with nothing routed before an answer, and is never resolved', async () => {
    const h = learning([WILD]);

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([]);
    expect(h.resolved).toEqual([]);
    expect(ruleState(outcome, 40)).toEqual({
      ruleId: ruleId(40),
      status: 'active',
      reasonCode: null,
      reason: null,
      appliedDestinations: [],
      lastResolvedAt: null,
    });
  });

  it('routes new addresses in a light dns-learned pass and resolves when they are in place', async () => {
    const syncs: Config[] = [];
    const h = learning([WILD, DOMAIN_RULE], {
      deps: {
        syncResolvers: (snapshot) => {
          syncs.push(snapshot);
          return { issues: new Map() };
        },
      },
    });
    await h.run('startup');
    h.take();
    const detections = h.netinfo.calls.length;
    const resolutions = h.resolved.length;

    const result = await h.learn(40, [L1, L2]);

    expect(result).toEqual({ outcome: 'applied', reason: null, accepted: 2, rejected: 0, routed: 2 });
    expect(h.take()).toEqual([add(L1, ETH_GW), add(L2, ETH_GW)]);
    // Light: no detection, no resolver-file sync; the exact rule keeps its cached answer.
    expect(h.netinfo.calls).toHaveLength(detections);
    expect(syncs).toHaveLength(1);
    expect(h.resolved.length).toBe(resolutions + 1);
    const state = h.engine.getState();
    expect(state.lastReconcileReason).toBe('dns-learned');
    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'active',
      reasonCode: null,
      appliedDestinations: [L1, L2],
      lastResolvedAt: NOW.toISOString(),
    });
    expect(stateOf(h.engine, 5)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    expect(h.engine.getApplied()).toContainEqual({ dst: L1, gateway: ETH_GW, ruleIds: [ruleId(40)] });
    expect(engineLogs(h.entries, 'debug', 'reconcile finished').at(-1)?.context).toMatchObject({ reason: 'dns-learned', added: 2, light: true });
    // Log hygiene: no address of a learned name above `debug`.
    for (const entry of h.entries.filter((candidate) => candidate.level !== 'debug')) {
      expect(JSON.stringify(entry)).not.toContain(L1);
    }
  });

  it('renews known addresses without a pass', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.learn(40, [L1]);
    h.take();
    const seq = h.engine.getState().seq;

    h.advance(60);
    const result = await h.learn(40, [L1]);

    expect(result).toEqual({ outcome: 'refreshed', reason: null, accepted: 1, rejected: 0, routed: 1 });
    expect(h.take()).toEqual([]);
    expect(h.engine.getState().seq).toBe(seq);
  });

  it('does not work the DNS-server warnings out again in a light pass', async () => {
    // The ethernet DNS server sits in the wifi subnet: a warning every full pass reports.
    const reporting = (): DetectedInterfaces => ({ ...network(), dnsServers: { ethernet: ['192.168.1.53'], wifi: [] } });
    const h = learning([WILD], { netinfo: createFakeNetInfo(reporting) });
    await h.run('startup');
    const said = (): number =>
      h.entries.filter((entry) => entry.msg === 'a DNS server is reached through the other interface; add an `ip` rule for it').length;
    expect(said()).toBe(1);
    expect(h.engine.getState().dnsWarnings).toHaveLength(1);

    await h.learn(40, [L1]);

    expect(said()).toBe(1);
    expect(h.engine.getState().dnsWarnings).toHaveLength(1);
    await h.run('drift-check');
    expect(said()).toBe(2);
  });

  it('runs a full pass for an answer that comes before the pass of a config change', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const detections = h.netinfo.calls.length;
    h.engine.setConfig(config([WILD, HOST]));

    await h.learn(40, [L1]);

    expect(h.netinfo.calls).toHaveLength(detections + 1);
    expect(h.take()).toEqual([add('172.16.12.40', ETH_GW), add(L1, ETH_GW)]);
    expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ reason: 'dns-learned' });
  });

  it.each([
    ['an unknown rule', [WILD], 99, 'not-learning'],
    ['an exact domain rule under no wildcard base', [WILD, rule(6, 'domain', 'corp.example', 'ethernet')], 6, 'not-learning'],
    ['an exact domain rule whose wildcard is disabled', [{ ...WILD, enabled: false }, rule(7, 'domain', 'www.corp.local', 'wifi')], 7, 'not-learning'],
    ['a disabled exact domain rule under a wildcard base', [WILD, { ...rule(7, 'domain', 'www.corp.local', 'wifi'), enabled: false }], 7, 'not-learning'],
    ['an ip rule', [WILD, HOST], 1, 'not-learning'],
    ['a disabled wildcard rule', [{ ...WILD, enabled: false }], 40, 'not-learning'],
  ] as const)('ignores %s', async (_name, rules, n, reason) => {
    const h = learning(rules);
    await h.run('startup');
    h.take();

    expect(await h.learn(n, [L1])).toEqual({ outcome: 'ignored', reason, accepted: 0, rejected: 0, routed: 0 });
    expect(h.take()).toEqual([]);
  });

  it('ignores everything while routing is off', async () => {
    const h = learning([WILD], { extra: { enabled: false } });
    await h.run('startup');

    expect((await h.learn(40, [L1])).reason).toBe('not-learning');
    expect(h.take()).toEqual([]);
  });

  it('ignores an answer before the first pass, and while the interface is down or has no gateway', async () => {
    const h = learning([WILD], { netinfo: createFakeNetInfo(network({ ethernet: down('ethernet') }), network({ ethernet: noGateway('ethernet') })) });
    expect((await h.learn(40, [L1])).reason).toBe('interface-down');

    await h.run('startup');
    expect((await h.learn(40, [L1])).reason).toBe('interface-down');
    await h.run('network-change');
    expect((await h.learn(40, [L1])).reason).toBe('interface-down');
    expect(h.take()).toEqual([]);
  });

  it('ignores an answer while the last detection was not trusted', async () => {
    const h = learning([WILD], { netinfo: createFakeNetInfo(network(), network({ degraded: true })) });
    await h.run('startup');
    await h.run('network-change');

    expect((await h.learn(40, [L1])).reason).toBe('interface-down');
  });

  it('ignores everything after the final cleanup', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.engine.clear({ final: true });

    expect((await h.learn(40, [L1])).reason).toBe('shut-down');
  });

  it('refuses every address that is not a strict, routable, non-DNS, non-connected IPv4 address', async () => {
    const withDns = (): DetectedInterfaces => ({ ...network(), dnsServers: { ethernet: ['10.20.0.10'], wifi: ['192.168.1.1'] } });
    const ownDns = rule(40, 'domain', '*.corp.local', 'ethernet', { dns: '10.30.0.53' });
    const h = learning([ownDns], { netinfo: createFakeNetInfo(withDns) });
    await h.run('startup');
    h.take();
    const refused: unknown[] = [
      '010.1.2.3',
      '172.16.20',
      '0x0a.0.0.1',
      ' 172.16.20.1',
      'corp.local',
      '::1',
      '127.0.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '169.254.1.1',
      '255.255.255.255',
      '10.20.0.10',
      '192.168.1.1',
      '10.30.0.53',
      ETH_GW,
      '10.20.4.23',
      WIFI_GW,
      42,
      null,
    ];

    expect(await h.learn(40, refused as string[])).toEqual({
      outcome: 'ignored',
      reason: 'no-usable-address',
      accepted: 0,
      rejected: refused.length,
      routed: 0,
    });
    const mixed = await h.learn(40, ['127.0.0.1', L1, 'x']);
    expect(mixed).toEqual({ outcome: 'applied', reason: null, accepted: 1, rejected: 2, routed: 1 });
    expect(h.take()).toEqual([add(L1, ETH_GW)]);
  });

  it('reads an answer that is not a list as empty', async () => {
    const h = learning([WILD]);
    await h.run('startup');

    expect((await h.engine.learn(ruleId(40), 'x' as unknown as string[], 300)).reason).toBe('no-usable-address');
  });

  it('reads at most perRule addresses of one answer', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const many = Array.from({ length: LEARNED_ROUTE_LIMITS.perRule + 5 }, (_unused, index) => `172.17.${String(Math.floor(index / 200))}.${String((index % 200) + 1)}`);

    const result = await h.learn(40, many);

    expect(result.accepted).toBe(LEARNED_ROUTE_LIMITS.perRule);
    expect(stateOf(h.engine, 40).appliedDestinations).toHaveLength(LEARNED_ROUTE_LIMITS.perRule);
    expect(stateOf(h.engine, 40).reasonCode).toBeNull();
  });

  it('leaves an address out that is a DNS server reported after it was learned, without failing the rule', async () => {
    const plain = network();
    const reporting = (): DetectedInterfaces => ({ ...network(), dnsServers: { ethernet: [L1], wifi: [] } });
    const h = learning([WILD], { netinfo: createFakeNetInfo(plain, reporting) });
    await h.run('startup');
    await h.learn(40, [L1, L2]);
    h.take();

    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del(L1, ETH_GW)]);
    expect(ruleState(outcome, 40)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L2] });
  });

  it('leaves an address out that has become the gateway, without failing the rule', async () => {
    const h = learning([WILD], { netinfo: createFakeNetInfo(network(), network({ ethernet: iface('ethernet', { gateway: L1 }) })) });
    await h.run('startup');
    await h.learn(40, [L1, L2]);
    h.take();

    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del(L1, ETH_GW), del(L2, ETH_GW), add(L2, L1)]);
    expect(ruleState(outcome, 40)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L2] });
  });

  it('routes the dns server of a wildcard rule like that of any domain rule, and never resolves the rule (TASK-DELTA-24 QA)', async () => {
    const outside = rule(40, 'domain', '*.corp.local', 'ethernet', { dns: '10.30.0.53' });
    const onLink = rule(41, 'domain', '*.lan.local', 'ethernet', { dns: '10.20.4.53' });
    const h = learning([outside, onLink]);

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([add('10.30.0.53', ETH_GW)]);
    expect(h.resolved).toEqual([]);
    expect(ruleState(outcome, 40)).toMatchObject({ status: 'active', appliedDestinations: ['10.30.0.53'] });
    expect(ruleState(outcome, 41)).toMatchObject({ status: 'active', appliedDestinations: [] });

    await h.learn(40, [L1]);
    expect(stateOf(h.engine, 40).appliedDestinations).toEqual(['10.30.0.53', L1]);
  });

  it('reports what is routed when the wait runs out, and the pass goes on', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const gate = deferred();
    h.routes.onAdd = async (request) => {
      await gate.promise;
      return added(request);
    };

    const pending = h.engine.learn(ruleId(40), [L1], 300, { waitMs: 50 });
    await vi.waitFor(() => {
      expect(h.timers.pending()).toEqual([50]);
    });
    h.timers.fireAll();

    expect(await pending).toEqual({ outcome: 'timed-out', reason: null, accepted: 1, rejected: 0, routed: 0 });
    gate.open();
    await vi.waitFor(() => {
      expect(stateOf(h.engine, 40).appliedDestinations).toEqual([L1]);
    });
  });

  it(`waits ${String(LEARN_WAIT_MAX_MS)} ms by default and clears its timer once the routes are in place`, async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const gate = deferred();
    h.routes.onAdd = async (request) => {
      await gate.promise;
      return added(request);
    };

    const pending = h.engine.learn(ruleId(40), [L1], 300);
    await vi.waitFor(() => {
      expect(h.timers.pending()).toEqual([LEARN_WAIT_MAX_MS]);
    });
    gate.open();

    expect((await pending).outcome).toBe('applied');
    // What is left is the coalesced announcement of the pass, not the wait.
    expect(h.timers.pending()).not.toContain(LEARN_WAIT_MAX_MS);
  });

  it('reports a learned address whose add failed as not routed, and the rule as failing', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    h.routes.onAdd = () => addFailed('add');

    expect(await h.learn(40, [L1])).toEqual({ outcome: 'applied', reason: null, accepted: 1, rejected: 0, routed: 0 });
    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'error', reasonCode: 'route-failed' });
  });

  it('never rejects, even when its own bookkeeping throws', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const hostile = new Proxy([L1], {
      get: () => {
        throw new Error('hostile list');
      },
    });

    expect(await h.engine.learn(ruleId(40), hostile, 300)).toMatchObject({ outcome: 'ignored', reason: 'no-usable-address' });
    expect(engineLogs(h.entries, 'error', 'learning addresses failed')).toHaveLength(1);
  });
});

describe('wildcard rules: precedence of learned addresses (shared compareClaim)', () => {
  it('leaves an address to an explicit rule on the other interface: active + overridden-by-rule', async () => {
    const wifiIp = rule(3, 'ip', L1, 'wifi');
    const h = learning([WILD, wifiIp]);
    await h.run('startup');
    h.take();

    await h.learn(40, [L1, L2]);

    expect(h.take()).toEqual([add(L2, ETH_GW)]);
    expect(stateOf(h.engine, 40)).toEqual({
      ruleId: ruleId(40),
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason: '1 learned address is routed by another rule, which takes precedence',
      appliedDestinations: [L2],
      lastResolvedAt: NOW.toISOString(),
    });
    expect(engineLogs(h.entries, 'info', 'rule partly applied').at(-1)?.context).toMatchObject({ reasonCode: 'overridden-by-rule', overridden: 1, routed: 1 });
  });

  it('leaves an address to an exact domain rule on the other interface: active + shared-address', async () => {
    const exactWifi = rule(5, 'domain', 'corp.local', 'wifi');
    const h = learning([WILD, exactWifi], { deps: { resolveDomain: () => domainAnswer([L1]) } });
    await h.run('startup');
    h.take();

    await h.learn(40, [L1, L2]);

    expect(h.take()).toEqual([add(L2, ETH_GW)]);
    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'active',
      reasonCode: 'shared-address',
      reason: '1 learned address is routed through the other interface for another domain rule, which takes precedence',
      appliedDestinations: [L2],
    });
    expect(stateOf(h.engine, 5)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L1] });
    expect(engineLogs(h.entries, 'info', 'rule partly applied').at(-1)?.context).toMatchObject({ reasonCode: 'shared-address', overridden: 0, shared: 1 });
  });

  it('puts overridden-by-rule before shared-address and counts both', async () => {
    const wifiIp = rule(3, 'ip', L1, 'wifi');
    const exactWifi = rule(5, 'domain', 'corp.local', 'wifi');
    const h = learning([WILD, wifiIp, exactWifi], { deps: { resolveDomain: () => domainAnswer([L2]) } });
    await h.run('startup');

    await h.learn(40, [L1, L2, L3]);

    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason:
        '1 learned address is routed by another rule, which takes precedence; 1 learned address is routed through the other interface for another domain rule, which takes precedence',
      appliedDestinations: [L3],
    });
  });

  it('gives a deeper wildcard the address, whatever the config order; the shallower one gets shared-address', async () => {
    const h = learning([WILD, DEEP_WIFI]);
    await h.run('startup');

    await h.learn(40, [L1, L2]);
    expect(h.take()).toEqual([add(L1, ETH_GW), add(L2, ETH_GW)]);
    // The deeper rule learns L1 later: the route moves to its interface.
    await h.learn(42, [L1]);

    expect(h.take()).toEqual([del(L1, ETH_GW), add(L1, WIFI_GW)]);
    expect(stateOf(h.engine, 42)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L1] });
    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'active', reasonCode: 'shared-address', appliedDestinations: [L2] });
  });

  it('gives the address to the earlier of two equally deep wildcards', async () => {
    const h = learning([OTHER_WILD_WIFI, WILD]);
    await h.run('startup');

    await h.learn(40, [L1, L2]);
    await h.learn(43, [L1]);

    expect(h.take()).toEqual([add(L1, ETH_GW), add(L2, ETH_GW), del(L1, ETH_GW), add(L1, WIFI_GW)]);
    expect(stateOf(h.engine, 43).appliedDestinations).toEqual([L1]);
    expect(stateOf(h.engine, 40)).toMatchObject({ reasonCode: 'shared-address', appliedDestinations: [L2] });
  });

  it('shares one route with a rule on the same interface, without a warning', async () => {
    const exactEth = rule(5, 'domain', 'corp.local', 'ethernet');
    const h = learning([WILD, exactEth], { deps: { resolveDomain: () => domainAnswer([L1]) } });
    await h.run('startup');
    h.take();

    await h.learn(40, [L1]);

    expect(h.take()).toEqual([]);
    expect(h.engine.getApplied()).toEqual([{ dst: L1, gateway: ETH_GW, ruleIds: [ruleId(5), ruleId(40)] }]);
    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L1] });
  });

  it('loses an address to the DNS server of another domain rule: overridden-by-rule', async () => {
    const serverRule = rule(5, 'domain', 'corp.local', 'wifi', { dns: L1 });
    const h = learning([WILD, serverRule], { deps: { resolveDomain: () => domainAnswer([]) } });
    await h.run('startup');

    await h.learn(40, [L1, L2]);

    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'active', reasonCode: 'overridden-by-rule', appliedDestinations: [L2] });
    expect(h.engine.getApplied()).toContainEqual({ dst: L1, gateway: WIFI_GW, ruleIds: [ruleId(5)] });
  });

  it('is error / route-failed when every learned address is left to other rules (TASK-DELTA-07 rule)', async () => {
    const wifiIp = rule(3, 'ip', L1, 'wifi');
    const exactWifi = rule(5, 'domain', 'corp.local', 'wifi');
    const h = learning([WILD, wifiIp, exactWifi], { deps: { resolveDomain: () => domainAnswer([L2]) } });
    await h.run('startup');

    await h.learn(40, [L2]);
    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: `${L2} is routed through the wifi interface for another domain rule, which takes precedence over a learned address`,
      appliedDestinations: [],
    });

    await h.learn(40, [L1]);
    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: `${L1} is routed through the wifi interface by an explicit rule, which takes precedence over a resolved address`,
    });
  });

  it('leaves the clash of two exact domain rules as it was: route-failed for the later one (regression)', async () => {
    const first = rule(5, 'domain', 'corp.local', 'ethernet');
    const second = rule(6, 'domain', 'other.local', 'wifi');
    const h = learning([first, second, WILD], { deps: { resolveDomain: () => domainAnswer([L1]) } });

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([add(L1, ETH_GW)]);
    expect(ruleState(outcome, 6)).toMatchObject({
      status: 'error',
      reasonCode: 'route-failed',
      reason: `${L1} is already routed through the ethernet interface by another rule`,
    });
  });

  it('keeps a subnet rule and a learned host route inside it apart (longest prefix)', async () => {
    const wifiNet = rule(2, 'subnet', '172.16.0.0/12', 'wifi');
    const h = learning([WILD, wifiNet]);
    await h.run('startup');
    h.take();

    await h.learn(40, [L1]);

    expect(h.take()).toEqual([add(L1, ETH_GW)]);
    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'active', reasonCode: null });
  });
});

// TASK-DELTA-30: split horizon. `*.corp.local` → ethernet, `www.corp.local` → wifi without `dns`.
// The engine resolves the exact name through the wifi role's DNS (P1), but clients ask the DNS
// proxy, which now forwards the exact name to the same servers and learns what it gave them for
// the exact rule: whatever the clients connect to is routed through the exact rule's interface.
describe('exact domain rules under a wildcard base: learn (split horizon)', () => {
  const EXACT_WIFI = rule(7, 'domain', 'www.corp.local', 'wifi');
  const P1 = '203.0.113.10';
  const P2 = L1;
  const exactLearning = (rules: readonly Rule[] = [WILD, EXACT_WIFI]): LearningHarness =>
    learning(rules, { deps: { resolveDomain: (resolvedRule) => domainAnswer(resolvedRule.id === ruleId(7) ? [P1] : ['172.16.12.40']) } });

  it('routes what the proxy learned for the exact rule through its interface, with its resolved addresses', async () => {
    const h = exactLearning();
    await h.run('startup');
    expect(h.take()).toEqual([add(P1, WIFI_GW)]);

    const result = await h.learn(7, [P2]);

    expect(result).toEqual({ outcome: 'applied', reason: null, accepted: 1, rejected: 0, routed: 1 });
    expect(h.take()).toEqual([add(P2, WIFI_GW)]);
    expect(stateOf(h.engine, 7)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [P1, P2] });
    // An address the resolver also returns is not routed twice.
    expect((await h.learn(7, [P1])).outcome).toBe('applied');
    expect(h.take()).toEqual([]);
  });

  it('keeps the exact-domain claim: the wildcard loses the same learned address (shared-address)', async () => {
    const h = exactLearning();
    await h.run('startup');
    await h.learn(7, [P2]);
    h.take();

    await h.learn(40, [P2, L2]);

    expect(h.take()).toEqual([add(L2, ETH_GW)]);
    expect(stateOf(h.engine, 40)).toMatchObject({ status: 'active', reasonCode: 'shared-address', appliedDestinations: [L2] });
    expect(stateOf(h.engine, 7)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [P1, P2] });
  });

  it('takes an address over from the wildcard when the exact rule learns it later', async () => {
    const h = exactLearning();
    await h.run('startup');
    await h.learn(40, [P2]);
    expect(h.take()).toEqual([add(P1, WIFI_GW), add(P2, ETH_GW)]);

    await h.learn(7, [P2]);

    expect(h.take()).toEqual([del(P2, ETH_GW), add(P2, WIFI_GW)]);
  });

  it('leaves a learned address to an explicit rule without failing the exact rule (overridden-by-rule)', async () => {
    const ethIp = rule(1, 'ip', P2, 'ethernet');
    const h = exactLearning([ethIp, WILD, EXACT_WIFI]);
    await h.run('startup');
    h.take();

    await h.learn(7, [P2, L2]);

    expect(h.take()).toEqual([add(L2, WIFI_GW)]);
    expect(stateOf(h.engine, 7)).toMatchObject({ status: 'active', reasonCode: 'overridden-by-rule', appliedDestinations: [P1, L2] });
  });

  it('checks learned addresses like a wildcard does', async () => {
    const h = exactLearning();
    await h.run('startup');
    h.take();

    const result = await h.learn(7, ['127.0.0.1', '224.0.0.1', WIFI_GW, 'nonsense', P2]);

    expect(result).toMatchObject({ outcome: 'applied', accepted: 1, rejected: 4 });
    expect(h.take()).toEqual([add(P2, WIFI_GW)]);
  });

  it('expires learned addresses like a wildcard does; the resolved ones stay', async () => {
    const h = exactLearning();
    await h.run('startup');
    await h.learn(7, [P2], 5);
    h.take();

    h.advance(LEARNED_ROUTE_LIMITS.minTtlSec);
    expect(h.engine.getRetryNeeds().learnedExpired).toBe(1);
    await h.run('drift-check');

    expect(h.take()).toEqual([del(P2, WIFI_GW)]);
    expect(stateOf(h.engine, 7)).toMatchObject({ status: 'active', appliedDestinations: [P1] });
  });

  it('forgets what the exact rule learned once no enabled wildcard covers it any more', async () => {
    const h = exactLearning();
    await h.run('startup');
    await h.learn(7, [P2]);
    h.take();

    h.engine.setConfig(config([{ ...WILD, enabled: false }, EXACT_WIFI]));
    await h.run('config-change');

    expect(h.take()).toEqual([del(P2, WIFI_GW)]);
    expect(stateOf(h.engine, 7)).toMatchObject({ appliedDestinations: [P1] });
    expect((await h.learn(7, [P2])).reason).toBe('not-learning');
  });
});

describe('wildcard rules: lifetime and bounds', () => {
  it('removes a route when its clamped lifetime is over; the monitor learns of it from getRetryNeeds', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.learn(40, [L1], 5);
    h.take();

    h.advance(LEARNED_ROUTE_LIMITS.minTtlSec - 1);
    expect(h.engine.getRetryNeeds().learnedExpired).toBe(0);
    h.advance(1);
    expect(h.engine.getRetryNeeds().learnedExpired).toBe(1);

    const outcome = await h.run('drift-check');

    expect(h.take()).toEqual([del(L1, ETH_GW)]);
    expect(outcome.summary.removed).toBe(1);
    expect(ruleState(outcome, 40)).toMatchObject({ status: 'active', appliedDestinations: [], lastResolvedAt: null });
    expect(h.engine.getRetryNeeds().learnedExpired).toBe(0);
  });

  it('keeps a route while answers renew it, up to the longest lifetime', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.learn(40, [L1], 10 ** 9);
    h.take();

    h.advance(LEARNED_ROUTE_LIMITS.maxTtlSec - 10);
    expect((await h.learn(40, [L1], 900)).outcome).toBe('refreshed');
    h.advance(20);
    await h.run('drift-check');
    expect(h.take()).toEqual([]);
    expect(stateOf(h.engine, 40).lastResolvedAt).toBe(new Date(NOW.getTime() + (LEARNED_ROUTE_LIMITS.maxTtlSec - 10) * 1000).toISOString());

    h.advance(900);
    await h.run('drift-check');
    expect(h.take()).toEqual([del(L1, ETH_GW)]);
  });

  it('removes an expired address in a light pass too', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.learn(40, [L1], 900);
    h.advance(900);

    await h.learn(40, [L2], 900);

    expect(h.take()).toEqual([add(L1, ETH_GW), del(L1, ETH_GW), add(L2, ETH_GW)]);
  });

  it('keeps an expired route while a degraded detection holds deletions back? No: it is not wanted by the config any more', async () => {
    const h = learning([WILD], { netinfo: createFakeNetInfo(network(), network({ degraded: true })) });
    await h.run('startup');
    await h.learn(40, [L1, L2], 900);
    h.take();
    await h.learn(40, [L2], 3600);
    h.advance(900);

    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([del(L1, ETH_GW)]);
    expect(outcome.summary.kept).toBe(0);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual([L2]);
  });

  it(`drops the address seen longest ago beyond ${String(LEARNED_ROUTE_LIMITS.perRule)} per rule: addresses-truncated until it would have expired`, async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const full = Array.from({ length: LEARNED_ROUTE_LIMITS.perRule }, (_unused, index) => `172.17.${String(Math.floor(index / 200))}.${String((index % 200) + 1)}`);
    await h.learn(40, full, 900);
    h.take();

    h.advance(10);
    await h.learn(40, [L1], 3600);

    expect(h.take()).toEqual([del(full[0] ?? '', ETH_GW), add(L1, ETH_GW)]);
    expect(stateOf(h.engine, 40)).toMatchObject({
      status: 'active',
      reasonCode: 'addresses-truncated',
      reason: `Learned addresses are limited to ${String(LEARNED_ROUTE_LIMITS.perRule)} per rule and ${String(LEARNED_ROUTE_LIMITS.total)} in all; the ones seen longest ago were dropped`,
    });
    expect(stateOf(h.engine, 40).appliedDestinations).toHaveLength(LEARNED_ROUTE_LIMITS.perRule);
    expect(engineLogs(h.entries, 'info', 'learned addresses reached their limit; the ones seen longest ago are dropped')).toHaveLength(1);

    h.advance(890);
    const after = await h.run('drift-check');
    expect(ruleState(after, 40)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: [L1] });
  });

  it(`drops the address seen longest ago of all wildcard rules beyond ${String(LEARNED_ROUTE_LIMITS.total)} in all`, async () => {
    const count = LEARNED_ROUTE_LIMITS.total / LEARNED_ROUTE_LIMITS.perRule;
    const wildcards = Array.from({ length: count + 1 }, (_unused, index) => rule(100 + index, 'domain', `*.w${String(index)}.local`, 'ethernet'));
    const h = learning(wildcards);
    await h.run('startup');
    for (let index = 0; index < count; index += 1) {
      h.advance(1);
      await h.learn(
        100 + index,
        Array.from({ length: LEARNED_ROUTE_LIMITS.perRule }, (_unused, host) => `172.${String(17 + index)}.${String(Math.floor(host / 200))}.${String((host % 200) + 1)}`),
      );
    }
    expect(h.engine.getApplied()).toHaveLength(LEARNED_ROUTE_LIMITS.total);
    h.take();

    h.advance(1);
    await h.learn(100 + count, [L1]);

    expect(h.take()).toEqual([del('172.17.0.1', ETH_GW), add(L1, ETH_GW)]);
    expect(h.engine.getApplied()).toHaveLength(LEARNED_ROUTE_LIMITS.total);
    expect(stateOf(h.engine, 100).reasonCode).toBe('addresses-truncated');
    expect(stateOf(h.engine, 100 + count).reasonCode).toBeNull();
    expect(h.engine.getApplied().length).toBeLessThanOrEqual(MAX_APPLIED_ROUTES);
  });
});

describe('wildcard rules: cleanup', () => {
  it('forgets what a rule learned at once when it is removed, disabled or retargeted; keeps it when only the interface changes', async () => {
    const h = learning([WILD, OTHER_WILD_WIFI]);
    await h.run('startup');
    await h.learn(40, [L1]);
    await h.learn(43, [L2]);
    h.take();

    h.engine.setConfig(config([{ ...WILD, iface: 'wifi' }, OTHER_WILD_WIFI]));
    expect((await h.learn(40, [L1])).outcome).toBe('refreshed');
    await h.run('config-change');
    expect(h.take()).toEqual([del(L1, ETH_GW), add(L1, WIFI_GW)]);

    h.engine.setConfig(config([{ ...WILD, iface: 'wifi', target: '*.new.local' }, { ...OTHER_WILD_WIFI, enabled: false }]));
    expect(engineLogs(h.entries, 'info', 'learned addresses forgotten after a config change').at(-1)?.context).toMatchObject({ dropped: 2 });
    const outcome = await h.run('config-change');
    expect(h.take()).toEqual([del(L2, WIFI_GW), del(L1, WIFI_GW)]);
    expect(ruleState(outcome, 40)).toMatchObject({ appliedDestinations: [], lastResolvedAt: null });

    // Enabled again: nothing comes back until the next answer.
    h.engine.setConfig(config([WILD, OTHER_WILD_WIFI]));
    await h.run('config-change');
    expect(h.take()).toEqual([]);
  });

  it('forgets everything when routing is turned off; clear() removes the routes and the pass counts them', async () => {
    const h = learning([WILD, HOST]);
    await h.run('startup');
    await h.learn(40, [L1, L2]);
    h.take();

    h.engine.setEnabled(false);
    expect(await h.engine.clear()).toEqual({ removed: 3, forgotten: 0, failed: 0 });
    const off = await h.run('enabled-change');
    expect(off.summary.removed).toBe(3);
    expect(engineLogs(h.entries, 'info', 'reconcile finished').at(-1)?.context).toMatchObject({ reason: 'enabled-change', removed: 3 });

    h.engine.setEnabled(true);
    const on = await h.run('enabled-change');
    expect(h.take()).toEqual([del('172.16.12.40', ETH_GW), del(L1, ETH_GW), del(L2, ETH_GW), add('172.16.12.40', ETH_GW)]);
    expect(on.summary.removed).toBe(0);
    expect(ruleState(on, 40).appliedDestinations).toEqual([]);
  });

  it('forgets everything as soon as routing is turned off, even before any cleanup', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    await h.learn(40, [L1]);
    h.take();

    h.engine.setEnabled(false);
    h.engine.setEnabled(true);
    await h.run('enabled-change');

    expect(h.take()).toEqual([del(L1, ETH_GW)]);
    expect(engineLogs(h.entries, 'info', 'learned addresses forgotten after a config change').at(-1)?.context).toMatchObject({ dropped: 1 });
  });

  it('keeps a learned route while a degraded detection shows its interface differently (held, like any wanted route)', async () => {
    const moved = network({ ethernet: iface('ethernet', { gateway: '10.20.4.254' }), degraded: true });
    const h = learning([WILD], { netinfo: createFakeNetInfo(network(), moved) });
    await h.run('startup');
    await h.learn(40, [L1]);
    h.take();

    const outcome = await h.run('network-change');

    expect(h.take()).toEqual([]);
    expect(outcome.summary.kept).toBe(1);
    expect(h.engine.getApplied()).toEqual([{ dst: L1, gateway: ETH_GW, ruleIds: [ruleId(40)] }]);
  });

  it('clear() forgets every learned address, so nothing is added again after it', async () => {
    const snapshots: (readonly AppliedRoute[])[] = [];
    const h = learning([WILD], { deps: { onApplied: (routes) => void snapshots.push(routes) } });
    await h.run('startup');
    await h.learn(40, [L1]);
    expect(snapshots.at(-1)).toEqual([{ dst: L1, gateway: ETH_GW, ruleIds: [ruleId(40)] }]);

    await h.engine.clear();
    expect(snapshots.at(-1)).toEqual([]);
    expect(engineLogs(h.entries, 'info', 'learned addresses forgotten').at(-1)?.context).toMatchObject({ reason: 'cleanup', dropped: 1 });
    await h.run('drift-check');

    expect(h.take()).toEqual([add(L1, ETH_GW), del(L1, ETH_GW)]);
    expect(h.engine.getApplied()).toEqual([]);
  });

  it('removes a learned route a previous process left in state.json and does not learn it again', async () => {
    const h = learning([WILD]);
    h.engine.restoreApplied([{ dst: L1, gateway: ETH_GW, ruleIds: [ruleId(40)] }]);

    const outcome = await h.run('startup');

    expect(h.take()).toEqual([del(L1, ETH_GW)]);
    expect(ruleState(outcome, 40).appliedDestinations).toEqual([]);
  });

  it('a summary counts the routes a clear() removed only once', async () => {
    const h = learning([HOST]);
    await h.run('startup');
    await h.engine.clear();

    expect((await h.run('drift-check')).summary.removed).toBe(1);
    expect((await h.run('drift-check')).summary.removed).toBe(0);
  });
});

describe('dns-learned passes: queueing and announcements', () => {
  it('never turns a queued full pass into a light one, and a later full reason replaces a queued light one', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const gate = deferred();
    h.netinfo.gate = gate;

    const running = h.engine.reconcile('drift-check');
    const config1 = h.engine.reconcile('config-change');
    const learned = h.engine.learn(ruleId(40), [L1], 300);
    gate.open();
    await Promise.all([running, config1, learned]);
    const reasons = engineLogs(h.entries, 'info', 'reconcile finished').map((entry) => entry.context?.['reason']);
    expect(reasons.slice(-2)).toEqual(['drift-check', 'config-change']);

    const gate2 = deferred();
    h.netinfo.gate = gate2;
    const busy = h.engine.reconcile('drift-check');
    const light = h.engine.learn(ruleId(40), [L2], 300);
    const full = h.engine.reconcile('network-change');
    gate2.open();
    await Promise.all([busy, light, full]);
    const after = engineLogs(h.entries, 'info', 'reconcile finished').map((entry) => entry.context?.['reason']);
    expect(after.slice(-2)).toEqual(['drift-check', 'network-change']);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual([L1, L2]);
  });

  it('announces the state of dns-learned passes at most once a second, always the latest; every-pass listeners hear each', async () => {
    const h = learning([WILD]);
    await h.run('startup');
    const announced: number[] = [];
    const everyPass: number[] = [];
    h.engine.subscribe((state) => announced.push(state.seq));
    h.engine.subscribe((state) => everyPass.push(state.seq), { everyPass: true });

    h.advance(1);
    await h.learn(40, [L1]);
    const first = h.engine.getState().seq;
    expect(announced).toEqual([first]);

    h.advance(0.2);
    await h.learn(40, [L2]);
    await h.learn(40, [L3]);
    expect(everyPass).toEqual([first, first + 1, first + 2]);
    expect(announced).toEqual([first]);
    expect(h.timers.pending()).toEqual([STATE_ANNOUNCE_MIN_INTERVAL_MS - 200]);

    h.timers.fireAll();
    expect(announced).toEqual([first, first + 2]);

    // Another reason is announced at once and takes a pending announcement with it.
    h.advance(0.1);
    await h.learn(40, ['172.16.20.4']);
    expect(h.timers.pending()).toHaveLength(1);
    await h.run('drift-check');
    expect(h.timers.pending()).toEqual([]);
    expect(announced.at(-1)).toBe(h.engine.getState().seq);
    expect(announced).toHaveLength(3);

    // A second later the next light pass is announced at once again.
    h.advance(1);
    await h.learn(40, ['172.16.20.5']);
    expect(announced.at(-1)).toBe(h.engine.getState().seq);
  });

  it('stops telling a listener that unsubscribed, either kind', async () => {
    const h = learning([WILD]);
    const seen: string[] = [];
    const offA = h.engine.subscribe(() => seen.push('a'));
    const offB = h.engine.subscribe(() => seen.push('b'), { everyPass: true });
    await h.run('startup');
    offA();
    offB();
    await h.run('startup');

    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('announces at once when the monotonic clock went back', async () => {
    let mono = 10_000;
    const timers = createFakeTimers();
    const h = setup(config([WILD]), { deps: { monotonicNow: () => mono, setTimer: timers.set, clearTimer: timers.clear } });
    await h.run('startup');
    const announced: number[] = [];
    h.engine.subscribe((state) => announced.push(state.seq));
    mono = 5_000;

    await h.engine.learn(ruleId(40), [L1], 300);

    expect(announced).toEqual([h.engine.getState().seq]);
    expect(timers.pending()).toEqual([]);
  });
});

describe('wildcard rules: model-based (random learn / expire / config sequences)', () => {
  const POOL = ['172.16.30.1', '172.16.30.2', '172.16.30.3', '172.16.30.4', '172.16.30.5', '172.16.30.6'];
  const WILDS = [
    rule(50, 'domain', '*.m.local', 'ethernet'),
    rule(51, 'domain', '*.x.m.local', 'wifi'),
    rule(52, 'domain', '*.n.local', 'wifi', { dns: '10.40.0.53' }),
  ];
  const EXPLICIT = rule(53, 'ip', '172.16.30.1', 'wifi');
  const EXACT = rule(54, 'domain', 'exact.m.local', 'wifi');

  it('keeps applied within what the rules want, and never breaks the bounds (3000 random steps)', async () => {
    let seed = 2026;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;

    const h = learning([...WILDS, EXPLICIT, EXACT], { deps: { resolveDomain: () => domainAnswer(['172.16.30.2']) } });
    await h.run('startup');
    let rules: Rule[] = [...WILDS, EXPLICIT, EXACT];
    let enabled = true;
    /** Rule id -> address -> when it expires (ms), as far as the test knows (never evicted: the pool is small). */
    const model = new Map<string, Map<string, number>>();
    let nowMs = NOW.getTime();

    for (let step = 0; step < 3000; step += 1) {
      const op = random(10);
      if (op < 5) {
        const target = pick(WILDS);
        const addresses = Array.from({ length: 1 + random(3) }, () => pick(POOL));
        const ttl = pick([1, 900, 1800, 5000, 100_000]);
        const result = await h.engine.learn(target.id, addresses, ttl);
        const current = rules.find((candidate) => candidate.id === target.id);
        if (result.outcome !== 'ignored' && current !== undefined) {
          const known = model.get(target.id) ?? new Map<string, number>();
          const expires = nowMs + Math.min(Math.max(ttl, 900), 86_400) * 1000;
          for (const address of new Set(addresses)) known.set(address, Math.max(known.get(address) ?? 0, expires));
          model.set(target.id, known);
        } else {
          expect(result.accepted).toBe(0);
        }
      } else if (op < 7) {
        const seconds = pick([30, 600, 900, 3600]);
        h.advance(seconds);
        nowMs += seconds * 1000;
        await h.run('drift-check');
      } else if (op < 9) {
        const changed = pick(WILDS);
        const variant = random(3);
        rules = rules.map((candidate) =>
          candidate.id !== changed.id
            ? candidate
            : variant === 0
              ? { ...candidate, enabled: !candidate.enabled }
              : variant === 1
                ? { ...candidate, iface: candidate.iface === 'wifi' ? 'ethernet' : 'wifi' }
                : candidate,
        );
        const before = h.engine.getConfig().rules.find((candidate) => candidate.id === changed.id);
        const after = rules.find((candidate) => candidate.id === changed.id);
        if (before?.enabled === true && after?.enabled === false) model.delete(changed.id);
        h.engine.setConfig(config(rules, { enabled }));
        await h.run('config-change');
      } else {
        enabled = !enabled;
        h.engine.setEnabled(enabled);
        if (!enabled) {
          model.clear();
          await h.engine.clear();
        }
        await h.run('enabled-change');
      }

      // Invariants after every step.
      const state = h.engine.getState();
      expectValid(state);
      const applied = h.engine.getApplied();
      expect(new Set(applied.map((route) => route.dst)).size).toBe(applied.length);
      for (const known of model.values()) for (const [address, expires] of known) if (expires <= nowMs) known.delete(address);
      const wantedBy = (route: AppliedRoute): boolean =>
        route.ruleIds.some((owner) => {
          const owning = rules.find((candidate) => candidate.id === owner);
          if (owning === undefined || !owning.enabled || !enabled) return false;
          if (owning.kind === 'ip') return owning.target === route.dst;
          if (!isWildcardTarget(owning.target)) return route.dst === '172.16.30.2';
          return route.dst === owning.dns || (model.get(owner)?.has(route.dst) ?? false);
        });
      // Right after a pass: applied ⊆ desired (only a light learn can leave the expired ones for the next pass).
      if (op >= 5) for (const route of applied) expect(wantedBy(route)).toBe(true);
      // Precedence: the explicit rule's address is never routed for a wildcard rule.
      const explicitRoute = applied.find((route) => route.dst === EXPLICIT.target);
      if (enabled) expect(explicitRoute?.gateway).toBe(WIFI_GW);
      for (const entry of state.rules) {
        expect(entry.appliedDestinations.length).toBeLessThanOrEqual(LEARNED_ROUTE_LIMITS.perRule + 1);
        if (!enabled) expect(entry.appliedDestinations).toEqual([]);
      }
      expect(applied.length).toBeLessThanOrEqual(MAX_APPLIED_ROUTES);
    }
  });
});

const isWildcardTarget = (target: string): boolean => target.startsWith('*.');

describe('wildcard rules: configs without them behave as before', () => {
  it('learn calls between the passes change nothing for configs without wildcard rules (differential, 300 random scenarios)', async () => {
    const HOSTS = ['172.16.12.40', '172.16.12.41', '10.30.0.53', '10.20.4.53', '203.0.113.7'];
    const REASONS: ReconcileReason[] = ['startup', 'config-change', 'manual', 'network-change', 'dns-refresh', 'drift-check'];
    for (let scenario = 1; scenario <= 300; scenario += 1) {
      let seed = scenario;
      const random = (n: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed % n;
      };
      const rules: Rule[] = Array.from({ length: 1 + random(5) }, (_unused, index) => {
        const kind = (['ip', 'subnet', 'domain'] as const)[random(3)] ?? 'ip';
        const target = kind === 'ip' ? (HOSTS[random(HOSTS.length)] ?? '') : kind === 'subnet' ? '172.16.0.0/12' : `d${String(index)}.corp.local`;
        return rule(60 + index, kind, target, random(2) === 0 ? 'ethernet' : 'wifi', kind === 'domain' && random(2) === 0 ? { dns: HOSTS[random(HOSTS.length)] ?? '' } : {});
      });
      const parsed = Config.safeParse({ version: 1, enabled: true, rules });
      if (!parsed.success) continue;
      const answers = Array.from({ length: 12 }, () => HOSTS.filter(() => random(2) === 0));
      const detections = Array.from({ length: 12 }, () => (random(5) === 0 ? network({ degraded: true }) : random(6) === 0 ? network({ wifi: down('wifi') }) : network()));
      const reasons = Array.from({ length: 12 }, () => REASONS[random(REASONS.length)] ?? 'manual');
      const make = () => {
        let call = 0;
        return setup(parsed.data, {
          netinfo: createFakeNetInfo(...detections),
          deps: { resolveDomain: () => domainAnswer(answers[call++ % answers.length] ?? []) },
        });
      };
      const plain = make();
      const noisy = make();
      for (const reason of reasons) {
        const expected = await plain.engine.reconcile(reason);
        for (const each of rules) await noisy.engine.learn(each.id, ['172.16.12.40', '172.16.50.1'], 300);
        const actual = await noisy.engine.reconcile(reason);
        expect(actual.summary).toEqual(expected.summary);
        expect(actual.state).toEqual(expected.state);
      }
      expect(noisy.routes.calls).toEqual(plain.routes.calls);
    }
  });

  it('learn is ignored for every rule of a config without wildcard rules and changes nothing', async () => {
    const rules = [HOST, NET, WIFI_HOST, DOMAIN_RULE];
    const h = learning(rules);
    const first = await h.run('startup');
    const calls = h.take();

    for (const each of rules) expect((await h.learn(Number(each.id.slice(-12)), ['172.16.40.1'])).reason).toBe('not-learning');

    const second = await h.run('drift-check');
    expect(h.take()).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(second.state.rules).toEqual(first.state.rules);
    expect(h.engine.getRetryNeeds()).toEqual({ deferred: 0, refused: 0, failing: 0, learnedExpired: 0 });
  });
});
