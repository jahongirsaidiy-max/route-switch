import { Config, LIMITS, type Rule } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { PROBE_TIMEOUT_MS, createDomainResolver, probeDns, type DnsResolverFactory, type ProbeDeps } from './dns';
import { createFakeDns, createFakeScheduler, flush } from './dns-test-utils';
import { createLogger } from './logger';

const NOW = new Date('2026-10-15T08:00:00.000Z');

const probeHarness = () => {
  const fake = createFakeDns();
  const scheduler = createFakeScheduler(NOW);
  const deps: ProbeDeps = {
    createResolver: fake.factory,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    monotonicNow: () => scheduler.now().getTime(),
  };
  return { fake, scheduler, deps };
};

describe('probeDns', () => {
  it('asks the one server once, with a single try, and reports the time', async () => {
    const h = probeHarness();
    const pending = probeDns('10.20.0.10', 'corp.local', h.deps);
    await flush();
    expect(h.fake.lookups).toHaveLength(1);
    const [lookup] = h.fake.lookups;
    expect(lookup).toMatchObject({ hostname: 'corp.local', servers: ['10.20.0.10'], options: { timeout: PROBE_TIMEOUT_MS, tries: 1 } });
    h.scheduler.advance(42);
    lookup?.answer(['10.30.0.6', '10.30.0.5', '127.0.0.1', 'bogus']);
    expect(await pending).toEqual({ outcome: 'ok', ms: 42, addresses: ['10.30.0.5', '10.30.0.6'], truncated: false });
    expect(h.scheduler.pending()).toBe(0);
  });

  it('ENODATA is an answer without addresses', async () => {
    const h = probeHarness();
    h.fake.auto = () => Object.assign(new Error('x'), { code: 'ENODATA' });
    expect(await probeDns('10.20.0.10', 'corp.local', h.deps)).toEqual({ outcome: 'ok', ms: 0, addresses: [], truncated: false });
  });

  it.each([
    ['ETIMEOUT', 'timeout'],
    ['EREFUSED', 'refused'],
    ['ENOTFOUND', 'error'],
    ['ESERVFAIL', 'error'],
  ] as const)('%s is %s', async (code, outcome) => {
    const h = probeHarness();
    h.fake.auto = () => Object.assign(new Error('x'), { code });
    expect(await probeDns('10.20.0.10', 'corp.local', h.deps)).toMatchObject({ outcome, addresses: [] });
  });

  it('an error without a code, and an answer that is not a list, are errors', async () => {
    const h = probeHarness();
    h.fake.auto = () => new Error('x');
    expect((await probeDns('10.20.0.10', 'corp.local', h.deps)).outcome).toBe('error');
    h.fake.auto = () => 'not a list';
    expect((await probeDns('10.20.0.10', 'corp.local', h.deps)).outcome).toBe('error');
  });

  it(`is cut off after ${String(PROBE_TIMEOUT_MS)} ms and the query cancelled, also when the resolver ignores the cancel`, async () => {
    const h = probeHarness();
    h.fake.ignoreCancel = true;
    const pending = probeDns('10.20.0.10', 'corp.local', h.deps);
    await flush();
    h.scheduler.advance(PROBE_TIMEOUT_MS - 1);
    await flush();
    expect(h.fake.lookups[0]?.cancelled).toBe(false);
    h.scheduler.advance(1);
    expect(await pending).toEqual({ outcome: 'timeout', ms: PROBE_TIMEOUT_MS, addresses: [], truncated: false });
    expect(h.fake.lookups[0]?.cancelled).toBe(true);
    // A late answer changes nothing.
    h.fake.lookups[0]?.answer(['10.30.0.5']);
    await flush();
  });

  it('a resolver that cannot be built is an error, never a throw', async () => {
    const h = probeHarness();
    const broken: DnsResolverFactory = () => {
      throw new Error('no resolver');
    };
    expect(await probeDns('10.20.0.10', 'corp.local', { ...h.deps, createResolver: broken })).toMatchObject({ outcome: 'error' });
    expect(h.scheduler.pending()).toBe(0);
  });

  it('keeps at most the per-domain limit of addresses and says so', async () => {
    const h = probeHarness();
    h.fake.auto = () => Array.from({ length: LIMITS.maxIpsPerDomain + 3 }, (_, index) => `10.30.0.${String(index + 1)}`);
    const result = await probeDns('10.20.0.10', 'corp.local', h.deps);
    expect(result.addresses).toHaveLength(LIMITS.maxIpsPerDomain);
    expect(result.truncated).toBe(true);
  });
});

describe('DomainResolverService.peek', () => {
  const rule: Rule = {
    id: '00000000-0000-4000-8000-000000000005',
    enabled: true,
    kind: 'domain',
    target: 'corp.local',
    iface: 'ethernet',
    dns: '10.20.0.10',
    refreshSec: 600,
  };

  const service = () => {
    const fake = createFakeDns();
    const scheduler = createFakeScheduler(NOW);
    const resolver = createDomainResolver({
      logger: createLogger({ sinks: [] }),
      now: scheduler.now,
      createResolver: fake.factory,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      systemServers: () => [],
    });
    resolver.syncConfig(Config.parse({ version: 1, rules: [rule] }));
    return { fake, resolver };
  };

  it('knows nothing of a rule that was never asked about, and starts nothing', () => {
    const h = service();
    expect(h.resolver.peek(rule.id)).toBeNull();
    expect(h.fake.lookups).toEqual([]);
    expect(h.resolver.stats()).toMatchObject({ entries: 0, inFlight: 0, queued: 0 });
  });

  it('reports the servers before the first answer and the addresses after it, without a lookup of its own', async () => {
    const h = service();
    h.resolver.resolveDomain(rule);
    await flush();
    expect(h.resolver.peek(rule.id)).toEqual({ addresses: null, truncated: false, servers: ['10.20.0.10'], source: 'rule' });
    h.fake.lookups[0]?.answer(['10.30.0.6', '10.30.0.5']);
    await flush();
    const lookups = h.fake.lookups.length;
    expect(h.resolver.peek(rule.id)).toEqual({ addresses: ['10.30.0.5', '10.30.0.6'], truncated: false, servers: ['10.20.0.10'], source: 'rule' });
    expect(h.fake.lookups).toHaveLength(lookups);
  });

  it('knows nothing once the rule is gone or the resolver stopped', async () => {
    const h = service();
    h.resolver.resolveDomain(rule);
    await flush();
    h.resolver.syncConfig(Config.parse({ version: 1, rules: [] }));
    expect(h.resolver.peek(rule.id)).toBeNull();
    h.resolver.resolveDomain(rule);
    h.resolver.stop();
    expect(h.resolver.peek(rule.id)).toBeNull();
  });
});
