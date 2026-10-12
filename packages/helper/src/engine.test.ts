import { Config, EngineState, parseIpv4Destination, type ReconcileReason, type Rule } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import {
  DEGRADED_ACCEPT_AFTER,
  buildEngineState,
  createEngine,
  findConnectedConflict,
  guardCoversEveryRole,
  unresolvedDomain,
  type AppliedRoute,
  type DomainResolver,
  type DomainTargets,
  type Engine,
  type EngineDeps,
  type GuardFacts,
  type ReconcileOutcome,
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

    expect(h.routes.calls).toHaveLength(33);
    expect(ruleState(outcome, 5).appliedDestinations).toEqual(many.slice(0, 33));
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
    // Every `route` call succeeds unless a test stubs that exact command.
    runner.whenMatching((bin) => (bin === ROUTE ? {} : undefined));

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

    expect(r.routeArgv()).toEqual([
      ['-n', 'delete', '-host', '172.16.12.40'],
      ['-n', 'delete', '-net', '172.16.0.0/12'],
      ['-n', 'add', '-host', '172.16.12.40', '10.20.4.254'],
      ['-n', 'add', '-net', '172.16.0.0/12', '10.20.4.254'],
    ]);

    r.lease.en5.router = null;
    r.expireCache();
    const outcome = await r.run('network-change');

    expect(r.routeArgv()).toEqual([
      ['-n', 'delete', '-host', '172.16.12.40'],
      ['-n', 'delete', '-net', '172.16.0.0/12'],
    ]);
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
    expect(r.routeArgv()).toEqual([['-n', 'delete', '-net', '198.51.100.0/24']]);
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
    expect(r.routeArgv()).toEqual([['-n', 'delete', '-host', '172.16.12.40']]);
    expect(third.retryRequested).toBe(false);
    // The forced retries really bypassed the cache: networksetup ran once per pass.
    expect(r.runner.calls.filter((call) => call.bin === '/usr/sbin/networksetup')).toHaveLength(4);
  });
});
