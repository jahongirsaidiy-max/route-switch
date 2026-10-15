import { Config, DiagnoseResult, EngineState, type ConfigInput, type RuleState } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import {
  DIAGNOSE_LIMITS,
  createDiagnoseLimiter,
  matchAddress,
  matchDomain,
  runDiagnose,
  type CachedAddresses,
  type DiagnoseDeps,
} from './diagnose';
import type { CachedDomain, ProbeResult } from './dns';
import type { AppliedRoute } from './engine';
import { createLogger, createMemorySink } from './logger';
import type { RouteGetResult } from './route';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const config = (rules: ConfigInput['rules'], enabled = true): Config => Config.parse({ version: 1, enabled, rules });

const noCache: CachedAddresses = () => null;

describe('matchAddress', () => {
  it('matches the only rule that covers the address', () => {
    const result = matchAddress('10.1.2.3', config([{ id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' }]), noCache);
    expect(result.match).toEqual({ ruleId: id(1), via: 'subnet', precedence: 'only-match' });
    expect(result.rule?.iface).toBe('ethernet');
  });

  it('matches nothing when no rule covers the address', () => {
    expect(matchAddress('192.0.2.1', config([{ id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' }]), noCache)).toEqual({
      match: null,
      rule: null,
      disabledCover: false,
    });
  });

  it('picks the longest prefix, like the kernel', () => {
    const rules = config([
      { id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
      { id: id(2), kind: 'subnet', target: '10.20.0.0/16', iface: 'wifi' },
    ]);
    expect(matchAddress('10.20.0.5', rules, noCache).match).toEqual({ ruleId: id(2), via: 'subnet', precedence: 'longest-prefix' });
    expect(matchAddress('10.30.0.5', rules, noCache).match).toEqual({ ruleId: id(1), via: 'subnet', precedence: 'only-match' });
  });

  it('an ip rule inside a subnet is a host route', () => {
    const rules = config([
      { id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
      { id: id(2), kind: 'ip', target: '10.20.0.10', iface: 'wifi' },
    ]);
    expect(matchAddress('10.20.0.10', rules, noCache).match).toEqual({ ruleId: id(2), via: 'ip', precedence: 'host-route' });
  });

  it('a resolved address of a domain rule beats a covering subnet', () => {
    const rules = config([
      { id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
      { id: id(2), kind: 'domain', target: 'corp.local', iface: 'wifi' },
    ]);
    const cached: CachedAddresses = (ruleId) => (ruleId === id(2) ? ['10.30.0.5'] : null);
    expect(matchAddress('10.30.0.5', rules, cached).match).toEqual({ ruleId: id(2), via: 'domain', precedence: 'domain-address' });
  });

  it('an explicit ip rule beats a resolved address of the same destination, whatever the config order', () => {
    const rules = config([
      { id: id(1), kind: 'domain', target: 'corp.local', iface: 'wifi' },
      { id: id(2), kind: 'ip', target: '10.30.0.5', iface: 'ethernet' },
    ]);
    const cached: CachedAddresses = (ruleId) => (ruleId === id(1) ? ['10.30.0.5'] : null);
    expect(matchAddress('10.30.0.5', rules, cached).match).toEqual({ ruleId: id(2), via: 'ip', precedence: 'host-route' });
  });

  it('the DNS server of a domain rule beats a resolved address of another domain', () => {
    const rules = config([
      { id: id(1), kind: 'domain', target: 'a.corp.local', iface: 'wifi' },
      { id: id(2), kind: 'domain', target: 'b.corp.local', iface: 'ethernet', dns: '10.20.0.10' },
    ]);
    const cached: CachedAddresses = (ruleId) => (ruleId === id(1) ? ['10.20.0.10'] : null);
    expect(matchAddress('10.20.0.10', rules, cached).match).toEqual({ ruleId: id(2), via: 'dns-server', precedence: 'host-route' });
  });

  it('between equals the one planned first wins: an /32 subnet and an ip rule for the same address', () => {
    const rules = config([
      { id: id(1), kind: 'subnet', target: '10.30.0.5/32', iface: 'ethernet' },
      { id: id(2), kind: 'ip', target: '10.30.0.5', iface: 'ethernet' },
    ]);
    expect(matchAddress('10.30.0.5', rules, noCache).match).toEqual({ ruleId: id(1), via: 'subnet', precedence: 'config-order' });
  });

  it('between two domains that resolved to the same address the first in the config wins', () => {
    const rules = config([
      { id: id(1), kind: 'domain', target: 'a.corp.local', iface: 'wifi' },
      { id: id(2), kind: 'domain', target: 'b.corp.local', iface: 'wifi' },
    ]);
    const cached: CachedAddresses = () => ['10.30.0.5'];
    expect(matchAddress('10.30.0.5', rules, cached).match).toEqual({ ruleId: id(1), via: 'domain', precedence: 'config-order' });
  });

  it('ignores disabled rules but says one covers the address', () => {
    const rules = config([
      { id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: false },
      { id: id(2), kind: 'subnet', target: '10.0.0.0/16', iface: 'wifi' },
    ]);
    expect(matchAddress('10.0.0.5', rules, noCache)).toMatchObject({
      match: { ruleId: id(2), precedence: 'only-match' },
      disabledCover: true,
    });
    expect(matchAddress('10.9.0.5', rules, noCache)).toEqual({ match: null, rule: null, disabledCover: true });
  });

  it('matches nothing with the global toggle off', () => {
    const rules = config([{ id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' }], false);
    expect(matchAddress('10.1.2.3', rules, noCache).match).toBeNull();
  });
});

describe('matchDomain', () => {
  it('matches an enabled domain rule that names the domain exactly', () => {
    const rules = config([{ id: id(1), kind: 'domain', target: 'corp.local', iface: 'ethernet' }]);
    expect(matchDomain('corp.local', rules)).toMatchObject({ match: { ruleId: id(1), via: 'domain', precedence: 'only-match' }, disabledCover: false });
  });

  it.each(['www.corp.local', 'local', 'corp.localhost'])('does not cover %s: only the exact name', (name) => {
    expect(matchDomain(name, config([{ id: id(1), kind: 'domain', target: 'corp.local', iface: 'ethernet' }])).match).toBeNull();
  });

  it('takes the first of two rules for the same name', () => {
    const rules = config([
      { id: id(1), kind: 'domain', target: 'corp.local', iface: 'ethernet' },
      { id: id(2), kind: 'domain', target: 'corp.local', iface: 'ethernet' },
    ]);
    expect(matchDomain('corp.local', rules).match).toEqual({ ruleId: id(1), via: 'domain', precedence: 'config-order' });
  });

  it('a disabled rule or the global toggle off covers nothing', () => {
    const rule = { id: id(1), kind: 'domain' as const, target: 'corp.local', iface: 'ethernet' as const };
    expect(matchDomain('corp.local', config([{ ...rule, enabled: false }]))).toEqual({ match: null, rule: null, disabledCover: true });
    expect(matchDomain('corp.local', config([rule], false)).match).toBeNull();
  });
});

describe('createDiagnoseLimiter', () => {
  const clock = () => {
    let now = 0;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('one at a time per connection', () => {
    const time = clock();
    const limiter = createDiagnoseLimiter(DIAGNOSE_LIMITS, time.now);
    const first = limiter.tryAcquire(1);
    expect(first.ok).toBe(true);
    expect(limiter.tryAcquire(1)).toEqual({ ok: false, reason: 'connection-busy' });
    if (first.ok) first.release();
    expect(limiter.tryAcquire(1).ok).toBe(true);
  });

  it('at most two over all connections', () => {
    const limiter = createDiagnoseLimiter(DIAGNOSE_LIMITS, clock().now);
    const a = limiter.tryAcquire(1);
    expect(limiter.tryAcquire(2).ok).toBe(true);
    expect(limiter.tryAcquire(3)).toEqual({ ok: false, reason: 'busy' });
    if (a.ok) a.release();
    expect(limiter.tryAcquire(3).ok).toBe(true);
  });

  it('ten per minute and connection, then the window moves on', () => {
    const time = clock();
    const limiter = createDiagnoseLimiter(DIAGNOSE_LIMITS, time.now);
    for (let n = 0; n < DIAGNOSE_LIMITS.perConnectionPerWindow; n += 1) {
      const slot = limiter.tryAcquire(1);
      expect(slot.ok).toBe(true);
      if (slot.ok) slot.release();
      time.advance(1000);
    }
    expect(limiter.tryAcquire(1)).toEqual({ ok: false, reason: 'connection-rate' });
    expect(limiter.tryAcquire(2).ok).toBe(true);
    time.advance(DIAGNOSE_LIMITS.windowMs - 10 * 1000 + 1000);
    expect(limiter.tryAcquire(1).ok).toBe(true);
  });

  it('a refused request is not counted, and a release twice frees one slot only', () => {
    const limiter = createDiagnoseLimiter({ ...DIAGNOSE_LIMITS, perConnectionPerWindow: 2 }, clock().now);
    const first = limiter.tryAcquire(1);
    expect(limiter.tryAcquire(1).ok).toBe(false);
    if (first.ok) {
      first.release();
      first.release();
    }
    expect(limiter.tryAcquire(1).ok).toBe(true);
    const other = limiter.tryAcquire(2);
    expect(other.ok).toBe(true);
    expect(limiter.tryAcquire(3)).toEqual({ ok: false, reason: 'busy' });
  });

  it('forgets connections once their window is over', () => {
    const time = clock();
    const limiter = createDiagnoseLimiter(DIAGNOSE_LIMITS, time.now);
    for (let connection = 1; connection <= 50; connection += 1) {
      const slot = limiter.tryAcquire(connection);
      if (slot.ok) slot.release();
    }
    expect(limiter.tracked()).toBe(50);
    time.advance(DIAGNOSE_LIMITS.windowMs);
    const slot = limiter.tryAcquire(99);
    if (slot.ok) slot.release();
    expect(limiter.tracked()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runDiagnose
// ---------------------------------------------------------------------------

const ETH = { device: 'en5', ip: '10.20.4.23', gateway: '10.20.4.1', up: true };
const WIFI = { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', up: true };

const state = (overrides: { ethernet?: object; wifi?: object; rules?: RuleState[]; enabled?: boolean } = {}): EngineState =>
  EngineState.parse({
    helperVersion: '0.0.0',
    seq: 1,
    configRevision: 1,
    enabled: overrides.enabled ?? true,
    interfaces: { ethernet: overrides.ethernet ?? ETH, wifi: overrides.wifi ?? WIFI },
    adapters: [],
    rules: overrides.rules ?? [],
    lastApplyAt: null,
    lastReconcileReason: null,
  });

const found = (address: string, iface: string, gateway: string | null): RouteGetResult => ({
  ok: true,
  outcome: 'found',
  route: { target: address, destination: 'default', mask: null, gateway, iface, flags: ['UP'] },
});

const DOMAIN = id(3);
const RULES: ConfigInput['rules'] = [
  { id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
  { id: id(2), kind: 'ip', target: '203.0.113.7', iface: 'wifi' },
  { id: DOMAIN, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' },
];

interface Setup {
  readonly config?: Config;
  readonly state?: EngineState;
  readonly applied?: AppliedRoute[];
  readonly cache?: Record<string, CachedDomain>;
  readonly routes?: Record<string, RouteGetResult>;
  readonly probe?: ProbeResult;
}

const setup = (options: Setup = {}) => {
  const probes: string[] = [];
  const lookups: string[] = [];
  const memory = createMemorySink();
  const deps: DiagnoseDeps = {
    getConfig: () => options.config ?? config(RULES),
    getState: () => options.state ?? state(),
    getApplied: () =>
      options.applied ?? [
        { dst: '10.0.0.0/8', gateway: '10.20.4.1', ruleIds: [id(1)] },
        { dst: '203.0.113.7', gateway: '192.168.1.1', ruleIds: [id(2)] },
      ],
    peekDomain: (ruleId) => options.cache?.[ruleId] ?? null,
    routeGet: (address) => {
      lookups.push(address);
      return Promise.resolve(options.routes?.[address] ?? found(address, 'en5', '10.20.4.1'));
    },
    probe: (server, name) => {
      probes.push(`${server} ${name}`);
      return Promise.resolve(options.probe ?? { outcome: 'ok', ms: 4, addresses: ['10.30.0.5'], truncated: false });
    },
    logger: createLogger({ sinks: [memory.sink] }),
  };
  const run = async (target: string) => {
    const result = await runDiagnose(target, deps);
    // Every result fits the protocol.
    expect(DiagnoseResult.safeParse(result).success).toBe(true);
    return result;
  };
  return { run, probes, lookups, memory };
};

describe('runDiagnose: an address', () => {
  it('explains a covered address whose route goes the expected way', async () => {
    const h = setup();
    expect(await h.run('10.1.2.3')).toEqual({
      target: '10.1.2.3',
      targetKind: 'ip',
      match: { ruleId: id(1), via: 'subnet', precedence: 'only-match' },
      addresses: [
        { address: '10.1.2.3', source: 'query', route: { device: 'en5', gateway: '10.20.4.1', role: 'ethernet' }, expectedRole: 'ethernet', matchesExpected: true },
      ],
      dns: null,
      notes: [],
    });
    expect(h.probes).toEqual([]);
    expect(h.lookups).toEqual(['10.1.2.3']);
  });

  it('an address no rule covers leaves through the default route', async () => {
    const h = setup({ routes: { '192.0.2.1': found('192.0.2.1', 'en0', '192.168.1.1') } });
    const result = await h.run('192.0.2.1');
    expect(result.match).toBeNull();
    expect(result.notes).toEqual(['no-matching-rule']);
    expect(result.addresses[0]).toMatchObject({ route: { role: 'wifi' }, expectedRole: null, matchesExpected: null });
  });

  it('notices a route through the other interface', async () => {
    const h = setup({ routes: { '10.1.2.3': found('10.1.2.3', 'en0', '192.168.1.1') } });
    const result = await h.run('10.1.2.3');
    expect(result.addresses[0]).toMatchObject({ matchesExpected: false });
    expect(result.notes).toEqual(['route-mismatch']);
  });

  it('a route on a device of no role, and a lookup that finds nothing', async () => {
    const h = setup({
      routes: {
        '10.1.2.3': found('10.1.2.3', 'utun3', null),
        '10.1.2.4': { ok: false, outcome: 'not-found', target: '10.1.2.4' },
      },
    });
    expect((await h.run('10.1.2.3')).addresses[0]).toMatchObject({ route: { device: 'utun3', gateway: null, role: null }, matchesExpected: false });
    expect((await h.run('10.1.2.4')).addresses[0]).toMatchObject({ route: null, matchesExpected: null });
  });

  it('says when the rule has no route in the table and why', async () => {
    const down = setup({ applied: [], state: state({ ethernet: { device: null, ip: null, gateway: null, up: false } }) });
    // The kernel still names en5, which has no role any more: that is a mismatch too.
    expect((await down.run('10.1.2.3')).notes).toEqual(['interface-down', 'not-applied', 'route-mismatch']);
    const noGateway = setup({ applied: [], state: state({ ethernet: { ...ETH, gateway: null } }) });
    expect((await noGateway.run('10.1.2.3')).notes).toEqual(['no-gateway', 'not-applied']);
  });

  it('passes on what the rule state says about the rule', async () => {
    const h = setup({
      applied: [],
      state: state({
        rules: [{ ruleId: id(1), status: 'error', reasonCode: 'connected-network', reason: 'x', appliedDestinations: [], lastResolvedAt: null }],
      }),
    });
    expect((await h.run('10.1.2.3')).notes).toEqual(['connected-network', 'not-applied']);
  });

  it('a disabled rule and the global toggle off', async () => {
    const disabled = setup({ config: config([{ id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: false }]) });
    expect((await disabled.run('10.1.2.3')).notes).toEqual(['no-matching-rule', 'rule-disabled']);
    const off = setup({ config: config(RULES, false) });
    expect((await off.run('10.1.2.3')).notes).toEqual(['no-matching-rule', 'globally-disabled']);
  });
});

describe('runDiagnose: a name', () => {
  it('a name no enabled domain rule covers is never looked up', async () => {
    const h = setup();
    expect(await h.run('example.com')).toEqual({
      target: 'example.com',
      targetKind: 'domain',
      match: null,
      addresses: [],
      dns: null,
      notes: ['name-not-covered'],
    });
    expect(h.probes).toEqual([]);
    expect(h.lookups).toEqual([]);
  });

  it('a name of a disabled rule is not covered either', async () => {
    const h = setup({ config: config([{ ...RULES[2], enabled: false } as ConfigInput['rules'][number]]) });
    expect((await h.run('corp.local')).notes).toEqual(['name-not-covered', 'rule-disabled']);
    expect(h.probes).toEqual([]);
  });

  it('uses the cached addresses and probes the rule server once', async () => {
    const h = setup({
      cache: { [DOMAIN]: { addresses: ['10.30.0.5', '10.30.0.6'], truncated: false, servers: ['10.20.0.10'], source: 'rule' } },
      applied: [
        { dst: '10.30.0.5', gateway: '10.20.4.1', ruleIds: [DOMAIN] },
        { dst: '10.30.0.6', gateway: '10.20.4.1', ruleIds: [DOMAIN] },
      ],
      probe: { outcome: 'ok', ms: 12, addresses: ['10.99.0.1'], truncated: false },
    });
    const result = await h.run('corp.local');
    expect(h.probes).toEqual(['10.20.0.10 corp.local']);
    expect(result).toMatchObject({
      match: { ruleId: DOMAIN, via: 'domain', precedence: 'only-match' },
      addresses: [
        { address: '10.30.0.5', source: 'rule-cache', expectedRole: 'ethernet', matchesExpected: true },
        { address: '10.30.0.6', source: 'rule-cache', expectedRole: 'ethernet', matchesExpected: true },
      ],
      dns: { server: '10.20.0.10', role: 'ethernet', resolverFile: '/etc/resolver/corp.local', outcome: 'ok', ms: 12 },
      notes: [],
    });
    expect(h.lookups).toEqual(['10.30.0.5', '10.30.0.6']);
  });

  it('without a cache the probe answer gives the addresses', async () => {
    // 10.30.0.5 is not in the domain's cache, so the 10.0.0.0/8 rule owns it until the domain routes it.
    const h = setup();
    const result = await h.run('corp.local');
    expect(result.addresses).toMatchObject([{ address: '10.30.0.5', source: 'query', expectedRole: 'ethernet', matchesExpected: true }]);
    expect(result.notes).toEqual([]);
  });

  it('an address of the name that no rule has routed yet is not-applied', async () => {
    const rules = config([{ id: DOMAIN, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' }]);
    const h = setup({ config: rules, applied: [], cache: { [DOMAIN]: { addresses: ['10.30.0.5'], truncated: false, servers: ['10.20.0.10'], source: 'rule' } } });
    expect((await h.run('corp.local')).notes).toEqual(['not-applied']);
  });

  it.each(['timeout', 'refused', 'error'] as const)('a probe that ends in %s: resolve-failed without a cache', async (outcome) => {
    const h = setup({ probe: { outcome, ms: 3000, addresses: [], truncated: false } });
    const result = await h.run('corp.local');
    expect(result.addresses).toEqual([]);
    expect(result.dns).toMatchObject({ outcome, ms: 3000 });
    expect(result.notes).toEqual(['resolve-failed']);
  });

  it('a failed probe keeps the cached addresses: only the server is unreachable', async () => {
    const h = setup({
      cache: { [DOMAIN]: { addresses: ['10.30.0.5'], truncated: false, servers: ['10.20.0.10'], source: 'rule' } },
      applied: [{ dst: '10.30.0.5', gateway: '10.20.4.1', ruleIds: [DOMAIN] }],
      probe: { outcome: 'timeout', ms: 3000, addresses: [], truncated: false },
    });
    const result = await h.run('corp.local');
    expect(result.addresses).toHaveLength(1);
    expect(result.notes).toEqual([]);
  });

  it('a name without A records', async () => {
    const h = setup({ probe: { outcome: 'ok', ms: 2, addresses: [], truncated: false } });
    expect((await h.run('corp.local')).notes).toEqual(['no-addresses']);
  });

  it('reports truncation from the cache and from the probe', async () => {
    const cached = setup({ cache: { [DOMAIN]: { addresses: ['10.30.0.5'], truncated: true, servers: [], source: 'rule' } }, applied: [] });
    expect((await cached.run('corp.local')).notes).toContain('addresses-truncated');
    const probed = setup({ probe: { outcome: 'ok', ms: 2, addresses: ['10.30.0.5'], truncated: true } });
    expect((await probed.run('corp.local')).notes).toContain('addresses-truncated');
  });

  it('a rule without dns asks the server its lookup uses, and has no resolver file', async () => {
    const rules = config([{ id: DOMAIN, kind: 'domain', target: 'corp.local', iface: 'wifi' }]);
    const h = setup({ config: rules, cache: { [DOMAIN]: { addresses: null, truncated: false, servers: ['192.168.1.1'], source: 'interface' } } });
    const result = await h.run('corp.local');
    expect(h.probes).toEqual(['192.168.1.1 corp.local']);
    expect(result.dns).toEqual({ server: '192.168.1.1', role: 'wifi', resolverFile: null, outcome: 'ok', ms: 4 });
  });

  it('no known server: nothing is queried and there is no dns part', async () => {
    const rules = config([{ id: DOMAIN, kind: 'domain', target: 'corp.local', iface: 'wifi' }]);
    const h = setup({ config: rules });
    const result = await h.run('corp.local');
    expect(h.probes).toEqual([]);
    expect(result).toMatchObject({ addresses: [], dns: null });
  });

  it('an address of the name that an explicit rule takes over is expected on that rule\'s interface', async () => {
    const h = setup({
      cache: { [DOMAIN]: { addresses: ['203.0.113.7'], truncated: false, servers: ['10.20.0.10'], source: 'rule' } },
      routes: { '203.0.113.7': found('203.0.113.7', 'en0', '192.168.1.1') },
    });
    const result = await h.run('corp.local');
    expect(result.addresses[0]).toMatchObject({ expectedRole: 'wifi', matchesExpected: true });
  });

  it('logs names and addresses at debug only', async () => {
    const h = setup();
    await h.run('corp.local');
    const loud = h.memory.entries.filter((entry) => entry.level !== 'debug');
    expect(loud).toEqual([]);
    expect(h.memory.entries.map((entry) => entry.msg)).toEqual(['dns probe', 'diagnosed']);
  });
});

describe('wildcard rules (TASK-DELTA-28)', () => {
  const WILD = id(20);
  const DEEP = id(21);
  const EXACT = id(22);
  const wildRules = (extra: ConfigInput['rules'] = []): Config =>
    config([{ id: WILD, kind: 'domain', target: '*.corp.local', iface: 'wifi' }, ...extra]);

  describe('matchDomain', () => {
    it('a name under the base falls under the wildcard; the base itself and a look-alike do not', () => {
      expect(matchDomain('app.corp.local', wildRules()).match).toEqual({ ruleId: WILD, via: 'wildcard', precedence: 'only-match' });
      expect(matchDomain('a.b.corp.local', wildRules()).match?.ruleId).toBe(WILD);
      expect(matchDomain('corp.local', wildRules())).toEqual({ match: null, rule: null, disabledCover: false });
      expect(matchDomain('badcorp.local', wildRules()).match).toBeNull();
    });

    it('the deepest base wins; an exact rule beats every wildcard', () => {
      const rules = wildRules([
        { id: DEEP, kind: 'domain', target: '*.lab.corp.local', iface: 'ethernet' },
        { id: EXACT, kind: 'domain', target: 'db.lab.corp.local', iface: 'ethernet' },
      ]);
      expect(matchDomain('x.lab.corp.local', rules).match).toEqual({ ruleId: DEEP, via: 'wildcard', precedence: 'deeper-wildcard' });
      expect(matchDomain('db.lab.corp.local', rules).match).toEqual({ ruleId: EXACT, via: 'domain', precedence: 'exact-domain' });
      expect(matchDomain('app.corp.local', rules).match).toEqual({ ruleId: WILD, via: 'wildcard', precedence: 'only-match' });
    });

    it('two wildcards with one base: the first in the config, by config order', () => {
      const rules = config([
        { id: WILD, kind: 'domain', target: '*.corp.local', iface: 'wifi' },
        { id: DEEP, kind: 'domain', target: '*.corp.local', iface: 'wifi', dns: '10.30.0.53' },
      ]);
      expect(matchDomain('app.corp.local', rules).match).toEqual({ ruleId: WILD, via: 'wildcard', precedence: 'config-order' });
    });

    it('a disabled wildcard or the toggle off covers nothing, and says a switched-off rule would', () => {
      const off = config([{ id: WILD, kind: 'domain', target: '*.corp.local', iface: 'wifi', enabled: false }]);
      expect(matchDomain('app.corp.local', off)).toEqual({ match: null, rule: null, disabledCover: true });
      expect(matchDomain('app.corp.local', config([{ id: WILD, kind: 'domain', target: '*.corp.local', iface: 'wifi' }], false)).match).toBeNull();
    });
  });

  describe('matchAddress', () => {
    it('a learned address is a host route of the wildcard (`via: wildcard`)', () => {
      const rules = wildRules([{ id: id(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' }]);
      const cached: CachedAddresses = (ruleId) => (ruleId === WILD ? ['10.30.0.5'] : null);
      expect(matchAddress('10.30.0.5', rules, cached).match).toEqual({ ruleId: WILD, via: 'wildcard', precedence: 'domain-address' });
    });

    it('for one address: exact domain > deeper wildcard > shallower wildcard, whatever the config order (ADR-002 §3)', () => {
      const rules = wildRules([
        { id: DEEP, kind: 'domain', target: '*.lab.corp.local', iface: 'ethernet' },
        { id: EXACT, kind: 'domain', target: 'db.example.com', iface: 'ethernet' },
      ]);
      const all: CachedAddresses = () => ['10.30.0.5'];
      expect(matchAddress('10.30.0.5', rules, all).match).toEqual({ ruleId: EXACT, via: 'domain', precedence: 'exact-domain' });
      const wildcards: CachedAddresses = (ruleId) => (ruleId === EXACT ? null : ['10.30.0.5']);
      expect(matchAddress('10.30.0.5', rules, wildcards).match).toEqual({ ruleId: DEEP, via: 'wildcard', precedence: 'deeper-wildcard' });
    });
  });

  describe('runDiagnose: a name under a wildcard', () => {
    const NAME = 'app.corp.local';
    const wildState = (reasonCode: RuleState['reasonCode'] = null): EngineState =>
      state({
        rules: [
          {
            ruleId: WILD,
            status: reasonCode === null ? 'active' : 'error',
            reasonCode,
            reason: reasonCode === null ? null : 'x',
            appliedDestinations: [],
            lastResolvedAt: null,
          },
        ],
      });
    const PEEK: Record<string, CachedDomain> = { [WILD]: { addresses: null, truncated: false, servers: ['192.168.1.1'], source: 'interface' } };

    it('queries the name itself through the proxy\'s upstream and shows its learned route', async () => {
      const h = setup({
        config: wildRules(),
        state: wildState(),
        cache: PEEK,
        applied: [{ dst: '10.30.0.5', gateway: '192.168.1.1', ruleIds: [WILD] }],
        routes: { '10.30.0.5': found('10.30.0.5', 'en0', '192.168.1.1') },
      });
      const result = await h.run(NAME);
      expect(h.probes).toEqual([`192.168.1.1 ${NAME}`]);
      expect(result).toEqual({
        target: NAME,
        targetKind: 'domain',
        match: { ruleId: WILD, via: 'wildcard', precedence: 'only-match' },
        addresses: [
          {
            address: '10.30.0.5',
            source: 'query',
            route: { device: 'en0', gateway: '192.168.1.1', role: 'wifi' },
            expectedRole: 'wifi',
            matchesExpected: true,
          },
        ],
        dns: { server: '192.168.1.1', role: 'wifi', resolverFile: '/etc/resolver/corp.local', outcome: 'ok', ms: 4 },
        notes: [],
      });
    });

    it('an address not learned yet still belongs to the wildcard: `not-applied`, expected on its interface', async () => {
      const h = setup({ config: wildRules(), state: wildState(), cache: PEEK, applied: [] });
      const result = await h.run(NAME);
      expect(result.addresses[0]).toMatchObject({ address: '10.30.0.5', expectedRole: 'wifi', matchesExpected: false });
      expect(result.notes).toEqual(['not-applied', 'route-mismatch']);
    });

    it('asks the rule\'s own `dns` when it has one', async () => {
      const rules = config([{ id: WILD, kind: 'domain', target: '*.corp.local', iface: 'wifi', dns: '10.30.0.53' }]);
      const h = setup({ config: rules, state: wildState(), applied: [{ dst: '10.30.0.5', gateway: '192.168.1.1', ruleIds: [WILD] }] });
      await h.run(NAME);
      expect(h.probes).toEqual([`10.30.0.53 ${NAME}`]);
    });

    it('has no resolver file while the proxy cannot listen', async () => {
      const h = setup({ config: wildRules(), state: wildState('dns-proxy-unavailable'), cache: PEEK, applied: [] });
      expect((await h.run(NAME)).dns).toMatchObject({ server: '192.168.1.1', resolverFile: null });
    });

    it('the base itself is not covered: nothing is looked up', async () => {
      const h = setup({ config: wildRules(), state: wildState(), cache: PEEK });
      expect((await h.run('corp.local')).notes).toEqual(['name-not-covered']);
      expect(h.probes).toEqual([]);
    });

    it('an address learned for the wildcard is explained as such when asked for by address', async () => {
      const h = setup({
        config: wildRules(),
        state: wildState(),
        applied: [{ dst: '10.30.0.5', gateway: '192.168.1.1', ruleIds: [WILD] }],
        routes: { '10.30.0.5': found('10.30.0.5', 'en0', '192.168.1.1') },
      });
      const result = await h.run('10.30.0.5');
      expect(result.match).toEqual({ ruleId: WILD, via: 'wildcard', precedence: 'only-match' });
      expect(result.notes).toEqual([]);
    });

    it('an address the proxy learned for an exact rule under the base belongs to the exact rule (TASK-DELTA-30)', async () => {
      const h = setup({
        config: wildRules([{ id: EXACT, kind: 'domain', target: 'www.corp.local', iface: 'wifi' }]),
        state: wildState(),
        cache: { [EXACT]: { addresses: ['203.0.113.10'], truncated: false, servers: ['192.168.1.1'], source: 'interface' } },
        applied: [
          { dst: '203.0.113.10', gateway: '192.168.1.1', ruleIds: [EXACT] },
          { dst: '10.30.0.6', gateway: '192.168.1.1', ruleIds: [EXACT] },
        ],
        routes: { '10.30.0.6': found('10.30.0.6', 'en0', '192.168.1.1') },
      });
      const result = await h.run('10.30.0.6');
      expect(result.match).toEqual({ ruleId: EXACT, via: 'domain', precedence: 'only-match' });
    });
  });
});
