import dns from 'node:dns';
import dnsPromises, { Resolver } from 'node:dns/promises';

import { Config, EngineState, LIMITS, type Rule } from '@routeswitch/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DNS_QUERY_TIMEOUT_MS,
  DNS_QUERY_TRIES,
  LOOKUP_TIMEOUT_MS,
  MAX_ANSWER_RECORDS,
  MAX_CONCURRENT_LOOKUPS,
  RECONCILE_DEBOUNCE_MS,
  RETRY_FLOOR_MS,
  createDomainResolver,
  createSystemResolver,
  sanitizeAnswer,
  type DomainResolverDeps,
  type DomainResolverService,
} from './dns';
import { createFakeDns, createFakeScheduler, flush, type FakeDns, type FakeScheduler } from './dns-test-utils';
import { createEngine, type Engine, type ReconcileOutcome } from './engine';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import type { DetectedInterfaces, InterfaceInfo, NetInfo } from './netinfo';
import type { RouteAddRequest, RouteAddResult, RouteDeleteRequest, RouteDeleteResult } from './route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-12T08:30:00.000Z');
const ETH_GW = '10.20.4.1';
const DNS_SERVER = '10.20.0.10';
const REFRESH_MS = 600_000;

const ruleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const domainRule = (n: number, target = 'corp.local', extra: Partial<Rule> = {}): Rule => ({
  id: ruleId(n),
  enabled: true,
  kind: 'domain',
  target,
  iface: 'ethernet',
  refreshSec: 600,
  ...extra,
});

const DOMAIN = domainRule(5);

const config = (rules: readonly Rule[], enabled = true): Config => Config.parse({ version: 1, enabled, rules });

interface Harness {
  readonly service: DomainResolverService;
  readonly scheduler: FakeScheduler;
  readonly dns: FakeDns;
  readonly entries: readonly LogEntry[];
  /** Reasons `requestReconcile` was called with. */
  readonly reconciles: string[];
  /** Entries of the DNS component at or above `info`. */
  loud(): LogEntry[];
  logs(level: LogEntry['level'], msg?: string): LogEntry[];
}

const setup = (extra: Partial<DomainResolverDeps> = {}): Harness => {
  const scheduler = createFakeScheduler(NOW);
  const fakeDns = createFakeDns();
  const memory = createMemorySink();
  const reconciles: string[] = [];
  const service = createDomainResolver({
    logger: createLogger({ sinks: [memory.sink], now: scheduler.now }),
    now: scheduler.now,
    createResolver: fakeDns.factory,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    requestReconcile: (reason) => {
      reconciles.push(reason);
    },
    ...extra,
  });
  const ofDns = (): LogEntry[] => memory.entries.filter((entry) => entry.context?.['component'] === 'dns');
  return {
    service,
    scheduler,
    dns: fakeDns,
    entries: memory.entries,
    reconciles,
    loud: () => ofDns().filter((entry) => entry.level !== 'debug'),
    logs: (level, msg) => ofDns().filter((entry) => entry.level === level && (msg === undefined || entry.msg === msg)),
  };
};

/** Answers the oldest open query and lets the result be processed. */
const answer = async (h: Harness, records: unknown): Promise<void> => {
  const lookup = h.dns.open()[0];
  if (lookup === undefined) throw new Error('no open DNS query');
  lookup.answer(records);
  await flush();
};

const fail = async (h: Harness, code: string): Promise<void> => {
  const lookup = h.dns.open()[0];
  if (lookup === undefined) throw new Error('no open DNS query');
  lookup.fail(code);
  await flush();
};

/** First use of `rule` followed by a successful answer. */
const resolveFirst = async (h: Harness, rule: Rule, records: unknown): Promise<void> => {
  h.service.resolveDomain(rule);
  await answer(h, records);
};

// ---------------------------------------------------------------------------
// sanitizeAnswer
// ---------------------------------------------------------------------------

describe('sanitizeAnswer', () => {
  it('sorts by numeric value and removes duplicates, so the order of an answer does not matter', () => {
    const one = sanitizeAnswer(['172.16.12.41', '9.9.9.9', '172.16.12.40', '172.16.12.41', '10.0.0.200', '10.0.0.30']);
    const other = sanitizeAnswer(['10.0.0.30', '10.0.0.200', '172.16.12.40', '9.9.9.9', '172.16.12.41']);

    expect(one?.addresses).toEqual(['9.9.9.9', '10.0.0.30', '10.0.0.200', '172.16.12.40', '172.16.12.41']);
    expect(other?.addresses).toEqual(one?.addresses);
    expect(one).toMatchObject({ usable: 5, refused: {}, refusedTotal: 0 });
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'default-route'],
    ['0.1.2.3', 'this-network'],
    ['169.254.10.20', 'link-local'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses the forbidden address %s (%s)', (address, code) => {
    expect(sanitizeAnswer([address, '172.16.12.40'])).toEqual({
      addresses: ['172.16.12.40'],
      usable: 1,
      refused: { [code]: 1 },
      refusedTotal: 1,
    });
  });

  it.each([
    ['an IPv6 address', '2001:db8::1'],
    ['an IPv4-mapped IPv6 address', '::ffff:10.0.0.1'],
    ['a CIDR', '10.0.0.0/8'],
    ['the default-route CIDR', '0.0.0.0/0'],
    ['the word default', 'default'],
    ['a host name', 'corp.local'],
    ['an octal form', '010.0.0.1'],
    ['a hexadecimal form', '0x0a.0.0.1'],
    ['a short form', '10.1'],
    ['a number as text', '167772161'],
    ['padding', ' 10.0.0.1'],
    ['a trailing newline', '10.0.0.1\n'],
    ['an argument-like string', '-interface'],
    ['an empty string', ''],
    ['an over-long string', '1'.repeat(5000)],
    ['a number', 167772161],
    ['null', null],
    ['an object', { address: '10.0.0.1', ttl: 60 }],
    ['an array', ['10.0.0.1']],
  ])('refuses %s', (_name, record) => {
    expect(sanitizeAnswer([record, '172.16.12.40'])).toEqual({
      addresses: ['172.16.12.40'],
      usable: 1,
      refused: { 'invalid-ipv4': 1 },
      refusedTotal: 1,
    });
  });

  it('keeps the numerically lowest addresses when there are more than the limit, whatever their order', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => `172.16.13.${String(index + 1)}`);
    const expected = many.slice(0, LIMITS.maxIpsPerDomain);

    const forward = sanitizeAnswer(many);
    const backward = sanitizeAnswer([...many].reverse());

    expect(LIMITS.maxIpsPerDomain).toBe(32);
    expect(forward).toEqual({ addresses: expected, usable: 40, refused: {}, refusedTotal: 0 });
    expect(backward?.addresses).toEqual(expected);
  });

  it('does not let refused or repeated records use up the limit', () => {
    const noise = Array.from({ length: 100 }, (_unused, index) => `127.0.0.${String(index + 1)}`);
    const good = Array.from({ length: 32 }, (_unused, index) => `172.16.13.${String(index + 1)}`);

    const result = sanitizeAnswer([...noise, ...good, ...good]);

    expect(result?.addresses).toEqual(good);
    expect(result).toMatchObject({ usable: 32, refusedTotal: 100, refused: { loopback: 100 } });
  });

  it('accepts an empty answer', () => {
    expect(sanitizeAnswer([])).toEqual({ addresses: [], usable: 0, refused: {}, refusedTotal: 0 });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', '10.0.0.1'],
    ['an object', { 0: '10.0.0.1', length: 1 }],
    ['more records than a DNS message can hold', Array.from({ length: MAX_ANSWER_RECORDS + 1 }, () => '10.0.0.1')],
  ])('refuses an answer that is %s', (_name, raw) => {
    expect(sanitizeAnswer(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache first
// ---------------------------------------------------------------------------

describe('resolveDomain: cache first', () => {
  it('answers `resolving` at once, looks the name up in the background and asks for one reconcile', async () => {
    const h = setup();

    const first = h.service.resolveDomain(DOMAIN);

    // Synchronous: the engine awaits it inside a pass.
    expect(first).not.toBeInstanceOf(Promise);
    expect(first).toEqual({
      destinations: [],
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Resolving corp.local',
      lastResolvedAt: null,
    });
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.dns.lookups[0]).toMatchObject({
      hostname: 'corp.local',
      servers: null,
      options: { timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES },
    });
    expect(h.service.stats()).toEqual({ entries: 1, inFlight: 1, queued: 0, timers: 1 });

    // Asking again while the lookup runs starts nothing new.
    expect(h.service.resolveDomain(DOMAIN).reasonCode).toBe('resolving');
    expect(h.dns.lookups).toHaveLength(1);

    await answer(h, ['172.16.12.41', '172.16.12.40']);

    expect(h.reconciles).toEqual([]);
    expect(h.scheduler.delays()).toEqual([RECONCILE_DEBOUNCE_MS, REFRESH_MS]);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh']);

    expect(h.service.resolveDomain(DOMAIN)).toEqual({
      destinations: ['172.16.12.40', '172.16.12.41'],
      status: 'active',
      reasonCode: null,
      reason: null,
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.logs('info', 'domain resolved')).toHaveLength(1);
    expect(h.logs('info', 'domain resolved')[0]?.context).toMatchObject({
      domain: 'corp.local',
      dns: null,
      addresses: 2,
      added: 2,
      removed: 0,
    });
  });

  it('serves the cache for the whole `refreshSec` without another lookup', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    h.scheduler.advance(REFRESH_MS - 1);
    for (let pass = 0; pass < 20; pass += 1) h.service.resolveDomain(DOMAIN);

    expect(h.dns.lookups).toHaveLength(1);
  });

  it('refreshes when `refreshSec` is over; an identical answer changes nothing and stays quiet', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(DOMAIN);
    const loudBefore = h.loud().length;

    h.scheduler.advance(REFRESH_MS - RECONCILE_DEBOUNCE_MS);

    expect(h.dns.lookups).toHaveLength(2);
    // The old answer is served while the refresh runs.
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', destinations: ['172.16.12.40', '172.16.12.41'] });

    await answer(h, ['172.16.12.41', '172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh']);
    expect(h.loud()).toHaveLength(loudBefore);
    expect(h.logs('debug', 'domain resolved; addresses unchanged')).toHaveLength(1);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      status: 'active',
      destinations: ['172.16.12.40', '172.16.12.41'],
      lastResolvedAt: '2026-10-12T08:40:00.000Z',
    });
  });

  it('asks for a reconcile when a refresh brings other addresses', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(DOMAIN);

    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41', '172.16.12.42']);
    expect(h.reconciles).toEqual(['dns-refresh']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.41', '172.16.12.42']);
    expect(h.logs('info', 'domain resolved').at(-1)?.context).toMatchObject({ addresses: 2, added: 1, removed: 1 });
  });

  it('looks a due entry up when it is used, even if the refresh timer has not fired', async () => {
    const scheduler = createFakeScheduler(NOW);
    let offset = 0;
    const h = setup({ now: () => new Date(scheduler.now().getTime() + offset) });
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    // The clock moved on (the machine slept), the timer did not fire.
    offset = REFRESH_MS + 1;
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);

    expect(h.dns.lookups).toHaveLength(2);
  });

  it('uses the time of the last successful answer as `lastResolvedAt`, in the format of the protocol', async () => {
    const h = setup();
    h.scheduler.advance(1234);
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    const { lastResolvedAt } = h.service.resolveDomain(DOMAIN);

    expect(lastResolvedAt).toBe('2026-10-12T08:30:01.234Z');
    expect(lastResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it.each([
    ['an ip rule', { ...DOMAIN, kind: 'ip' as const, target: '172.16.12.40' }],
    ['a disabled rule', { ...DOMAIN, enabled: false }],
    ['a target that is not a domain', { ...DOMAIN, target: '../etc/passwd' }],
    ['a target that is an address', { ...DOMAIN, target: '10.0.0.1' }],
    ['a forbidden DNS server', { ...DOMAIN, dns: '127.0.0.1' }],
    ['a DNS server that is not an address', { ...DOMAIN, dns: 'ns.corp.local' }],
  ])('starts no lookup for %s', (_name, rule) => {
    const h = setup();

    expect(h.service.resolveDomain(rule)).toMatchObject({ destinations: [], status: 'error', reasonCode: 'internal' });

    expect(h.dns.created).toBe(0);
    expect(h.scheduler.pending()).toBe(0);
    expect(h.service.stats().entries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Which server is asked
// ---------------------------------------------------------------------------

describe('lookup', () => {
  // Read through the module objects on purpose: `dns.setServers` installs a new default resolver and
  // re-binds the functions of the module, which a named import taken earlier would not follow.
  const globalServers = (): string[][] => [dns.getServers(), dnsPromises.getServers(), dns.promises.getServers()];
  const systemServers = dns.getServers();
  const before = globalServers();

  afterEach(() => {
    // Only a broken build changes them; keep one failure from spreading.
    if (JSON.stringify(globalServers()) !== JSON.stringify(before)) dns.setServers(systemServers);
  });

  it('can tell when the resolver of the process is changed (the check below is not blind)', () => {
    dns.setServers(['192.0.2.53']);
    try {
      expect(globalServers()).not.toEqual(before);
    } finally {
      dns.setServers(systemServers);
    }
    expect(globalServers()).toEqual(before);
  });

  it('asks only the server of the rule, with a resolver of its own for every lookup', async () => {
    const h = setup();
    const rule = domainRule(5, 'corp.local', { dns: DNS_SERVER });

    await resolveFirst(h, rule, ['172.16.12.40']);
    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.40']);

    expect(h.dns.lookups.map((lookup) => [lookup.hostname, lookup.servers, lookup.resolver])).toEqual([
      ['corp.local', [DNS_SERVER], 0],
      ['corp.local', [DNS_SERVER], 1],
    ]);
    expect(h.dns.created).toBe(2);
    // The resolver shared by the whole process still has the servers of the system.
    expect(globalServers()).toEqual(before);
  });

  it('leaves the servers of the system in place for a rule without `dns`', async () => {
    const h = setup();

    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    expect(h.dns.lookups[0]?.servers).toBeNull();
    expect(globalServers()).toEqual(before);
  });

  it('builds a separate `dns.promises.Resolver` each time by default, apart from the global one', () => {
    const one = createSystemResolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES });
    const other = createSystemResolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES });

    expect(one).toBeInstanceOf(Resolver);
    expect(other).not.toBe(one);
    // RFC 5737 documentation address; nothing is queried.
    one.setServers(['192.0.2.53']);
    expect((one as Resolver).getServers()).toEqual(['192.0.2.53']);
    expect((other as Resolver).getServers()).toEqual(systemServers);
    expect(globalServers()).toEqual(before);
    one.cancel();
  });

  it('treats the same domain on two servers as two lookups, and two rules for one lookup as one', async () => {
    const h = setup();
    const viaSystem = domainRule(1);
    const viaServer = domainRule(2, 'corp.local', { dns: DNS_SERVER });
    const twin = domainRule(3, 'corp.local', { dns: DNS_SERVER, refreshSec: 900 });

    for (const rule of [viaSystem, viaServer, twin]) h.service.resolveDomain(rule);

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([null, [DNS_SERVER]]);
    expect(h.service.stats().entries).toBe(2);

    await answer(h, ['172.16.12.40']);
    await answer(h, ['172.16.12.99']);

    expect(h.service.resolveDomain(viaSystem).destinations).toEqual(['172.16.12.40']);
    expect(h.service.resolveDomain(viaServer).destinations).toEqual(['172.16.12.99']);
    expect(h.service.resolveDomain(twin).destinations).toEqual(['172.16.12.99']);
  });

  it('reports a resolver that cannot even be built or pointed at the server as a failed lookup', async () => {
    const h = setup({
      createResolver: () => {
        throw new Error('no resolver today');
      },
    });

    h.service.resolveDomain(DOMAIN);
    await flush();

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'error', reasonCode: 'resolve-failed', destinations: [] });
    expect(h.service.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });
});

// ---------------------------------------------------------------------------
// Untrusted answers
// ---------------------------------------------------------------------------

describe('untrusted answers', () => {
  it('routes only the usable addresses and reports the refused ones', async () => {
    const h = setup();

    await resolveFirst(h, DOMAIN, ['127.0.0.1', '172.16.12.41', '0.0.0.0', '2001:db8::1', '172.16.12.41', '224.0.0.1', '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN)).toEqual({
      destinations: ['172.16.12.40', '172.16.12.41'],
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason:
        '4 resolved addresses of corp.local must never be routed (loopback: 1, default-route: 1, invalid-ipv4: 1, multicast: 1)',
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
    const warnings = h.logs('warn', 'resolved addresses refused; they are never routed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({
      domain: 'corp.local',
      refused: 4,
      reasons: { loopback: 1, 'default-route': 1, 'invalid-ipv4': 1, multicast: 1 },
    });
  });

  it('warns once about a standing refusal and again only when it changes', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['127.0.0.1', '172.16.12.40']);

    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['127.0.0.1', '172.16.12.40']);
    expect(h.logs('warn')).toHaveLength(1);

    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['127.0.0.1', '127.0.0.2', '172.16.12.40']);
    expect(h.logs('warn')).toHaveLength(2);
  });

  it('keeps 32 of 40 addresses, the lowest ones, and says so on an active rule', async () => {
    const h = setup();
    const many = Array.from({ length: 40 }, (_unused, index) => `172.16.13.${String(40 - index)}`);

    await resolveFirst(h, DOMAIN, many);

    const targets = h.service.resolveDomain(DOMAIN);
    expect(targets.destinations).toHaveLength(32);
    expect(targets.destinations).toEqual(Array.from({ length: 32 }, (_unused, index) => `172.16.13.${String(index + 1)}`));
    expect(targets).toMatchObject({
      status: 'active',
      reasonCode: 'addresses-truncated',
      reason: 'corp.local has 40 addresses; the 32 lowest are routed',
    });
    const warnings = h.logs('warn', 'more addresses than the per-domain limit; the lowest are routed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({ domain: 'corp.local', resolved: 40, kept: 32, limit: 32 });

    // The same 40 in another order is the same answer: no reconcile, no second warning.
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(DOMAIN);
    h.scheduler.advance(REFRESH_MS);
    await answer(h, [...many].reverse());
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh']);
    expect(h.logs('warn')).toHaveLength(1);
  });

  it('does not report exactly 32 addresses as truncated', async () => {
    const h = setup();

    await resolveFirst(
      h,
      DOMAIN,
      Array.from({ length: 32 }, (_unused, index) => `172.16.13.${String(index + 1)}`),
    );

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', reasonCode: null });
    expect(h.service.resolveDomain(DOMAIN).destinations).toHaveLength(32);
  });

  it.each([
    ['an empty answer', (h: Harness) => answer(h, []), 'corp.local has no A records'],
    ['ENODATA', (h: Harness) => fail(h, 'ENODATA'), 'corp.local has no A records'],
    [
      'an answer with nothing usable in it',
      (h: Harness) => answer(h, ['127.0.0.1', '0.0.0.0']),
      'corp.local has no usable A records: 2 addresses must never be routed (loopback: 1, default-route: 1)',
    ],
  ])('reports `no-addresses` for %s', async (_name, respond, reason) => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);

    await respond(h);

    expect(h.service.resolveDomain(DOMAIN)).toEqual({
      destinations: [],
      status: 'error',
      reasonCode: 'no-addresses',
      reason,
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
    // An answer, not a failure: the next lookup is a normal refresh.
    expect(h.scheduler.delays()).toContain(REFRESH_MS);
  });

  it.each([
    ['not a list', 'not-a-list'],
    ['absent', undefined],
    ['absurdly long', Array.from({ length: MAX_ANSWER_RECORDS + 1 }, () => '10.0.0.1')],
  ])('treats an answer that is %s as a failed lookup and keeps the last known addresses', async (_name, raw) => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    h.scheduler.advance(REFRESH_MS);
    await answer(h, raw);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: ['172.16.12.40'],
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'Could not refresh corp.local: the DNS answer is malformed; the last known 1 address stay routed',
    });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('failed lookups', () => {
  it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EREFUSED'])(
    'keeps the last known addresses when a refresh fails with %s',
    async (code) => {
      const h = setup();
      await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
      h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
      h.service.resolveDomain(DOMAIN);

      h.scheduler.advance(REFRESH_MS);
      await fail(h, code);
      h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

      const targets = h.service.resolveDomain(DOMAIN);
      expect(targets).toMatchObject({
        destinations: ['172.16.12.40', '172.16.12.41'],
        status: 'error',
        reasonCode: 'resolve-failed',
        lastResolvedAt: '2026-10-12T08:30:00.000Z',
      });
      expect(targets.reason).toContain(code);
      expect(targets.reason).toContain('the last known 2 addresses stay routed');
      // The engine has to learn that the rule is in error now.
      expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
    },
  );

  it('reports a rule that never resolved as `resolve-failed` without destinations', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);

    await fail(h, 'ESERVFAIL');

    expect(h.service.resolveDomain(DOMAIN)).toEqual({
      destinations: [],
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'Could not resolve corp.local: the DNS lookup failed (ESERVFAIL)',
      lastResolvedAt: null,
    });
  });

  it('never puts the text of a DNS error into the reason, only a well-formed code', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);
    const lookup = h.dns.open()[0];

    lookup?.fail('evil code; rm -rf /');
    await flush();

    expect(h.service.resolveDomain(DOMAIN).reason).toBe('Could not resolve corp.local: the DNS lookup failed');
  });

  it('retries with a doubling delay that starts at the floor and never exceeds `refreshSec`', async () => {
    const h = setup();
    const rule = domainRule(5, 'corp.local', { refreshSec: 60 });
    h.service.resolveDomain(rule);
    const retryDelays: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await fail(h, 'ESERVFAIL');
      h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
      const next = h.scheduler.delays().at(-1) ?? 0;
      retryDelays.push(next + RECONCILE_DEBOUNCE_MS);
      h.scheduler.advance(next);
    }

    expect(RETRY_FLOOR_MS).toBe(10_000);
    expect(retryDelays).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(h.dns.lookups).toHaveLength(7);
  });

  it('warns about the first failure of a streak only, and reports the recovery', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(REFRESH_MS);

    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RETRY_FLOOR_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(2 * RETRY_FLOOR_MS);
    await fail(h, 'ETIMEOUT');

    expect(h.logs('warn', 'domain lookup failed')).toHaveLength(1);
    expect(h.logs('warn', 'domain lookup failed')[0]?.context).toMatchObject({
      domain: 'corp.local',
      error: 'the DNS lookup failed (ESERVFAIL)',
      consecutive: 1,
      keptAddresses: 1,
    });
    expect(h.logs('debug', 'domain lookup failed')).toHaveLength(2);

    h.scheduler.advance(4 * RETRY_FLOOR_MS);
    await answer(h, ['172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: ['172.16.12.40'],
      status: 'active',
      reasonCode: null,
      reason: null,
      lastResolvedAt: '2026-10-12T08:41:10.000Z',
    });
    // Same addresses, but the rule left `error`: worth an `info` line and a reconcile.
    expect(h.logs('info', 'domain resolved; addresses unchanged')).toHaveLength(1);
    expect(h.scheduler.delays()).toEqual([RECONCILE_DEBOUNCE_MS, REFRESH_MS]);

    h.scheduler.advance(REFRESH_MS);
    await fail(h, 'ESERVFAIL');
    expect(h.logs('warn', 'domain lookup failed')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('bounds', () => {
  it('cuts a lookup off that never answers and ignores what it answers afterwards', async () => {
    const h = setup();
    h.dns.ignoreCancel = true;
    h.service.resolveDomain(DOMAIN);
    const hanging = h.dns.lookups[0];

    h.scheduler.advance(LOOKUP_TIMEOUT_MS - 1);
    expect(h.service.resolveDomain(DOMAIN).reasonCode).toBe('resolving');
    h.scheduler.advance(1);

    expect(hanging?.cancelled).toBe(true);
    expect(h.service.stats()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: [],
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'Could not resolve corp.local: the DNS lookup timed out after 5000 ms',
    });

    hanging?.answer(['172.16.12.66']);
    await flush();

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], status: 'error', reasonCode: 'resolve-failed' });
    expect(h.logs('debug', 'late DNS answer ignored')).toHaveLength(1);
    expect(h.dns.lookups).toHaveLength(1);
  });

  it('ignores the answer of a lookup that was started again in the meantime', async () => {
    const h = setup();
    h.dns.ignoreCancel = true;
    h.service.resolveDomain(DOMAIN);
    const [superseded] = h.dns.lookups;

    h.service.refreshAll();
    expect(h.dns.lookups).toHaveLength(2);
    superseded?.answer(['172.16.12.66']);
    await flush();

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], reasonCode: 'resolving' });

    h.dns.lookups[1]?.answer(['172.16.12.40']);
    await flush();

    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    expect(h.service.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('survives a resolver whose `cancel` throws', () => {
    const h = setup({
      createResolver: () => ({
        setServers: () => undefined,
        resolve4: () => new Promise<unknown>(() => undefined),
        cancel: () => {
          throw new Error('cancel failed');
        },
      }),
    });
    h.service.resolveDomain(DOMAIN);

    h.scheduler.advance(LOOKUP_TIMEOUT_MS);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'error', reasonCode: 'resolve-failed' });
    expect(h.logs('error', 'cancelling a DNS lookup failed')).toHaveLength(1);
  });

  it('runs at most eight lookups at a time for 500 domain rules, with a bounded number of timers', async () => {
    const h = setup();
    const rules = Array.from({ length: 500 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));

    for (const rule of rules) h.service.resolveDomain(rule);

    expect(MAX_CONCURRENT_LOOKUPS).toBe(8);
    expect(h.dns.open()).toHaveLength(8);
    expect(h.service.stats()).toEqual({ entries: 500, inFlight: 8, queued: 492, timers: 8 });
    expect(h.scheduler.pending()).toBe(8);

    let mostOpen = 0;
    let mostTimers = 0;
    while (h.dns.open().length > 0) {
      mostOpen = Math.max(mostOpen, h.dns.open().length);
      mostTimers = Math.max(mostTimers, h.scheduler.pending());
      await answer(h, ['172.16.12.40']);
    }

    expect(mostOpen).toBe(8);
    // Eight lookup timeouts, the refresh timer and the reconcile debounce.
    expect(mostTimers).toBeLessThanOrEqual(10);
    expect(h.dns.lookups).toHaveLength(500);
    expect(new Set(h.dns.lookups.map((lookup) => lookup.hostname)).size).toBe(500);
    expect(h.service.stats()).toEqual({ entries: 500, inFlight: 0, queued: 0, timers: 2 });
    expect(h.scheduler.pending()).toBe(2);

    // 500 changed answers, one reconcile request.
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh']);
    expect(h.scheduler.pending()).toBe(1);

    // And the refresh of all 500 goes through the same pool, behind one timer.
    h.scheduler.advance(REFRESH_MS);
    expect(h.dns.open()).toHaveLength(8);
    expect(h.service.stats()).toMatchObject({ inFlight: 8, queued: 492 });
  });

  it('keeps the pool moving when every lookup hangs', () => {
    const h = setup();
    const rules = Array.from({ length: 20 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);

    h.scheduler.advance(LOOKUP_TIMEOUT_MS);
    expect(h.dns.lookups).toHaveLength(16);
    h.scheduler.advance(LOOKUP_TIMEOUT_MS);
    expect(h.dns.lookups).toHaveLength(20);
    h.scheduler.advance(LOOKUP_TIMEOUT_MS - 1);
    expect(h.service.stats()).toMatchObject({ inFlight: 4, queued: 0 });
    h.scheduler.advance(1);

    // The last four have timed out too; the first eight are already being retried.
    expect(h.dns.lookups).toHaveLength(28);
    expect(h.service.stats()).toMatchObject({ inFlight: 8, queued: 0 });
    expect(rules.every((rule) => h.service.resolveDomain(rule).reasonCode === 'resolve-failed')).toBe(true);
  });

  it('refuses to track more lookups than there can be rules', () => {
    const h = setup();
    for (let index = 0; index < LIMITS.maxRules; index += 1) {
      h.service.resolveDomain(domainRule(index + 1, `host-${String(index)}.corp.local`));
    }

    const extra = h.service.resolveDomain(domainRule(9999, 'one-too-many.corp.local'));

    expect(extra).toMatchObject({ destinations: [], status: 'error', reasonCode: 'internal' });
    expect(h.service.stats().entries).toBe(LIMITS.maxRules);
  });

  it('batches the reconcile requests of answers that arrive close together', async () => {
    const h = setup();
    const rules = [1, 2, 3].map((n) => domainRule(n, `host-${String(n)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);

    await answer(h, ['172.16.12.1']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS - 1);
    await answer(h, ['172.16.12.2']);
    expect(h.reconciles).toEqual([]);
    // The window is not extended by the second change.
    h.scheduler.advance(1);
    expect(h.reconciles).toEqual(['dns-refresh']);

    await answer(h, ['172.16.12.3']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('engine is gone');
      },
    ],
    ['rejects', () => Promise.reject(new Error('engine is gone'))],
  ])('logs a reconcile request that %s instead of failing', async (_name, requestReconcile) => {
    const h = setup({ requestReconcile });
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    await flush();

    expect(h.logs('error', 'reconcile request failed')).toHaveLength(1);
    expect(h.service.resolveDomain(DOMAIN).status).toBe('active');
  });

  it('sets no reconcile timer when nobody asked to be told', async () => {
    const h = setup({ requestReconcile: undefined });

    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    expect(h.scheduler.delays()).toEqual([REFRESH_MS]);
  });
});

// ---------------------------------------------------------------------------
// Rules that change
// ---------------------------------------------------------------------------

describe('syncConfig', () => {
  it.each([
    ['removed', config([])],
    ['disabled', config([{ ...DOMAIN, enabled: false }])],
    ['pointed at another domain', config([{ ...DOMAIN, target: 'other.corp.local' }])],
    ['pointed at a DNS server', config([{ ...DOMAIN, dns: DNS_SERVER }])],
    ['switched off globally', config([DOMAIN], false)],
  ])('discards the running lookup of a rule that was %s', async (_name, next) => {
    const h = setup();
    h.dns.ignoreCancel = true;
    h.service.resolveDomain(DOMAIN);
    const [running] = h.dns.lookups;

    h.service.syncConfig(next);

    expect(running?.cancelled).toBe(true);
    expect(h.service.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });
    expect(h.scheduler.pending()).toBe(0);

    running?.answer(['172.16.12.66']);
    await flush();
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.reconciles).toEqual([]);
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.service.stats().entries).toBe(0);
  });

  it.each([
    ['removed', config([])],
    ['disabled', config([{ ...DOMAIN, enabled: false }])],
    ['switched off globally', config([DOMAIN], false)],
  ])('stops refreshing a resolved rule that was %s and forgets its addresses', async (_name, next) => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.scheduler.pending()).toBe(1);

    h.service.syncConfig(next);

    expect(h.scheduler.pending()).toBe(0);
    h.scheduler.advance(REFRESH_MS * 3);
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.logs('info', 'domains no longer resolved')[0]?.context).toMatchObject({ dropped: 1, tracked: 0 });

    // Switched on again, it starts from nothing.
    h.service.syncConfig(config([DOMAIN]));
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], reasonCode: 'resolving', lastResolvedAt: null });
    expect(h.dns.lookups).toHaveLength(2);
  });

  it('removes a queued lookup that is no longer wanted', () => {
    const h = setup();
    const rules = Array.from({ length: 12 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);
    expect(h.service.stats()).toMatchObject({ inFlight: 8, queued: 4 });

    h.service.syncConfig(config(rules.slice(0, 8)));

    expect(h.service.stats()).toEqual({ entries: 8, inFlight: 8, queued: 0, timers: 8 });
    expect(h.dns.lookups).toHaveLength(8);
  });

  it('gives the slot of a dropped lookup to the next one in the queue', () => {
    const h = setup();
    const rules = Array.from({ length: 9 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);
    expect(h.dns.lookups).toHaveLength(8);

    h.service.syncConfig(config(rules.slice(1)));

    expect(h.dns.lookups).toHaveLength(9);
    expect(h.dns.lookups[8]?.hostname).toBe('host-8.corp.local');
    expect(h.service.stats()).toMatchObject({ entries: 8, inFlight: 8, queued: 0 });
  });

  it('follows a rule that is edited without `syncConfig` having been called', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    const edited = { ...DOMAIN, dns: DNS_SERVER };
    expect(h.service.resolveDomain(edited)).toMatchObject({ destinations: [], reasonCode: 'resolving' });

    expect(h.service.stats().entries).toBe(1);
    expect(h.dns.lookups[1]?.servers).toEqual([DNS_SERVER]);
  });

  it('keeps a lookup that another rule still uses', async () => {
    const h = setup();
    const twin = domainRule(6);
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.service.resolveDomain(twin);

    h.service.syncConfig(config([twin]));

    expect(h.service.stats().entries).toBe(1);
    expect(h.service.resolveDomain(twin).destinations).toEqual(['172.16.12.40']);
    expect(h.dns.lookups).toHaveLength(1);
  });

  it('applies a changed `refreshSec` without losing the cached answer', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.scheduler.delays()).toEqual([REFRESH_MS - RECONCILE_DEBOUNCE_MS]);

    h.service.syncConfig(config([{ ...DOMAIN, refreshSec: 60 }]));

    expect(h.scheduler.delays()).toEqual([60_000 - RECONCILE_DEBOUNCE_MS]);
    expect(h.scheduler.pending()).toBe(1);
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.service.resolveDomain({ ...DOMAIN, refreshSec: 60 })).toMatchObject({
      status: 'active',
      destinations: ['172.16.12.40'],
    });

    // The same through `resolveDomain` alone, and back to a longer interval.
    h.service.resolveDomain({ ...DOMAIN, refreshSec: 3600 });
    expect(h.scheduler.delays()).toEqual([3_600_000 - RECONCILE_DEBOUNCE_MS]);
    expect(h.dns.lookups).toHaveLength(1);
  });

  it('refreshes a shared lookup as often as its most impatient rule asks', async () => {
    const h = setup();
    const slow = domainRule(1, 'corp.local', { refreshSec: 3600 });
    const fast = domainRule(2, 'corp.local', { refreshSec: 120 });
    h.service.resolveDomain(slow);
    h.service.resolveDomain(fast);

    await answer(h, ['172.16.12.40']);

    expect(h.scheduler.delays()).toEqual([RECONCILE_DEBOUNCE_MS, 120_000]);

    h.service.syncConfig(config([slow]));
    expect(h.scheduler.delays()).toEqual([RECONCILE_DEBOUNCE_MS, 3_600_000]);
  });

  it('logs nothing and sets no timer for a config without domain rules', () => {
    const h = setup();

    h.service.syncConfig(
      config([
        { id: ruleId(1), enabled: true, kind: 'ip', target: '172.16.12.40', iface: 'ethernet', refreshSec: 600 },
        { id: ruleId(2), enabled: true, kind: 'subnet', target: '172.16.0.0/12', iface: 'ethernet', refreshSec: 600 },
      ]),
    );

    expect(h.entries).toEqual([]);
    expect(h.scheduler.scheduled).toEqual([]);
    expect(h.dns.created).toBe(0);
  });
});

describe('refreshAll', () => {
  it('resolves every domain again at once and keeps serving the cache meanwhile', async () => {
    const h = setup();
    const other = domainRule(6, 'other.corp.local');
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    await resolveFirst(h, other, ['172.16.12.50']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    for (const rule of [DOMAIN, other]) h.service.resolveDomain(rule);

    h.service.refreshAll();

    expect(h.dns.open().map((lookup) => lookup.hostname)).toEqual(['corp.local', 'other.corp.local']);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', destinations: ['172.16.12.40'] });

    await answer(h, ['172.16.12.41']);
    await answer(h, ['172.16.12.50']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.41']);
    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
  });

  it('retries a failing domain right away and restarts its backoff', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RETRY_FLOOR_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.scheduler.delays()).toEqual([2 * RETRY_FLOOR_MS - RECONCILE_DEBOUNCE_MS]);

    h.service.refreshAll();
    expect(h.dns.lookups).toHaveLength(3);
    await fail(h, 'ESERVFAIL');

    expect(h.scheduler.delays()).toEqual([RETRY_FLOOR_MS]);
  });

  it('does not announce a return to what the engine already has', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(DOMAIN);

    // The change is announced, but no pass asks about the rule before the old answer is back.
    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
  });

  it('announces a change once when no pass asks about the rule in between', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);

    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RETRY_FLOOR_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(2 * RETRY_FLOOR_MS);
    await fail(h, 'ETIMEOUT');
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh']);

    h.scheduler.advance(4 * RETRY_FLOOR_MS);
    await answer(h, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh', 'dns-refresh']);
  });

  it('does nothing when no domain is tracked', () => {
    const h = setup();

    h.service.refreshAll();

    expect(h.entries).toEqual([]);
    expect(h.scheduler.scheduled).toEqual([]);
  });
});

describe('stop', () => {
  it('cancels every lookup and timer and starts nothing afterwards', async () => {
    const h = setup();
    h.dns.ignoreCancel = true;
    const rules = Array.from({ length: 12 }, (_unused, index) => domainRule(index + 101, `host-${String(index)}.corp.local`));
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    for (const rule of rules) h.service.resolveDomain(rule);
    // Lookup timeouts, the refresh timer and a pending reconcile request.
    expect(h.scheduler.pending()).toBe(10);
    const running = h.dns.open();
    expect(running).toHaveLength(8);

    h.service.stop();
    h.service.stop();

    expect(h.scheduler.pending()).toBe(0);
    expect(h.service.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });
    expect(running.every((lookup) => lookup.cancelled)).toBe(true);

    for (const lookup of running) lookup.answer(['172.16.12.66']);
    await flush();
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.reconciles).toEqual([]);
    expect(h.dns.lookups).toHaveLength(9);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], status: 'pending', reasonCode: 'resolving' });
    h.service.syncConfig(config([DOMAIN]));
    h.service.refreshAll();
    expect(h.dns.lookups).toHaveLength(9);
    expect(h.scheduler.pending()).toBe(0);
  });
});

describe('whenIdle', () => {
  it('resolves at once when nothing runs, and otherwise when the last lookup has finished', async () => {
    const h = setup();
    await h.service.whenIdle();

    const rules = Array.from({ length: 10 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);
    let idle = false;
    void h.service.whenIdle().then(() => {
      idle = true;
    });

    for (let index = 0; index < 9; index += 1) await answer(h, ['172.16.12.40']);
    expect(idle).toBe(false);
    await fail(h, 'ESERVFAIL');

    // A scheduled retry does not count as work in progress.
    expect(idle).toBe(true);
  });

  it('resolves when the resolver is stopped', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN);
    const idle = h.service.whenIdle();

    h.service.stop();

    await idle;
  });
});

// ---------------------------------------------------------------------------
// Through the real engine
// ---------------------------------------------------------------------------

const iface = (role: InterfaceInfo['role']): InterfaceInfo => {
  const wifi = role === 'wifi';
  return {
    role,
    device: wifi ? 'en0' : 'en5',
    port: wifi ? 'Wi-Fi' : 'USB 10/100/1000 LAN',
    ip: wifi ? '192.168.1.23' : '10.20.4.23',
    gateway: wifi ? '192.168.1.1' : ETH_GW,
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

interface EngineHarness extends Harness {
  readonly engine: Engine;
  /** Route calls since the previous `take()`, as `add <dst> <gateway>` / `delete <dst>`. */
  take(): string[];
  /** Fires the reconcile debounce and waits for the passes it started. */
  settle(): Promise<ReconcileOutcome | undefined>;
}

const withEngine = (rules: readonly Rule[]): EngineHarness => {
  const passes: Promise<ReconcileOutcome>[] = [];
  const calls: string[] = [];
  const netinfo: NetInfo = { detectInterfaces: () => Promise.resolve(NETWORK), invalidate: () => undefined };
  const kindOf = (dst: string): 'host' | 'net' => (dst.includes('/') ? 'net' : 'host');
  const routes = {
    routeAdd: (request: RouteAddRequest): Promise<RouteAddResult> => {
      calls.push(`add ${request.dst} ${request.gateway}`);
      return Promise.resolve({ ok: true, outcome: 'added', dst: request.dst, kind: kindOf(request.dst), gateway: request.gateway });
    },
    routeDelete: (request: RouteDeleteRequest): Promise<RouteDeleteResult> => {
      calls.push(`delete ${request.dst}`);
      return Promise.resolve({ ok: true, outcome: 'deleted', dst: request.dst, kind: kindOf(request.dst) });
    },
  };
  const holder: { engine: Engine | null } = { engine: null };
  const h = setup({
    requestReconcile: (reason) => {
      if (holder.engine !== null) passes.push(holder.engine.reconcile(reason));
    },
  });
  const engine = createEngine({
    netinfo,
    routes,
    logger: createLogger({ sinks: [] }),
    helperVersion: '1.2.3',
    initialConfig: config(rules),
    now: h.scheduler.now,
    resolveDomain: h.service.resolveDomain,
  });
  holder.engine = engine;
  h.service.syncConfig(engine.getConfig());
  let taken = 0;
  return {
    ...h,
    engine,
    take: () => {
      const fresh = calls.slice(taken);
      taken = calls.length;
      return fresh;
    },
    settle: async () => {
      h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
      const outcomes = await Promise.all(passes);
      return outcomes.at(-1);
    },
  };
};

const stateOf = (outcome: ReconcileOutcome | undefined, n = 5) => {
  const found = outcome?.state.rules.find((entry) => entry.ruleId === ruleId(n));
  if (found === undefined) throw new Error(`no state for rule ${String(n)}`);
  expect(EngineState.safeParse(outcome?.state).success).toBe(true);
  return found;
};

describe('with the engine', () => {
  it('routes a domain once it has resolved, without the pass ever waiting for DNS', async () => {
    const h = withEngine([DOMAIN]);

    // The lookup is still open when this pass returns.
    const first = await h.engine.reconcile('startup');

    expect(h.dns.open()).toHaveLength(1);
    expect(h.take()).toEqual([]);
    expect(stateOf(first)).toEqual({
      ruleId: ruleId(5),
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Resolving corp.local',
      appliedDestinations: [],
      lastResolvedAt: null,
    });

    await answer(h, ['172.16.12.41', '172.16.12.40']);
    const second = await h.settle();

    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`, `add 172.16.12.41 ${ETH_GW}`]);
    expect(second?.state.lastReconcileReason).toBe('dns-refresh');
    expect(stateOf(second)).toEqual({
      ruleId: ruleId(5),
      status: 'active',
      reasonCode: null,
      reason: null,
      appliedDestinations: ['172.16.12.40', '172.16.12.41'],
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
  });

  it('after `refreshSec` routes the new address of a domain and removes the one that is gone', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '172.16.12.41']);
    await h.settle();
    h.take();

    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41', '172.16.12.42']);
    const outcome = await h.settle();

    expect(h.take()).toEqual(['delete 172.16.12.40', `add 172.16.12.42 ${ETH_GW}`]);
    expect(stateOf(outcome)).toMatchObject({
      status: 'active',
      appliedDestinations: ['172.16.12.41', '172.16.12.42'],
      lastResolvedAt: '2026-10-12T08:40:00.500Z',
    });
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.41', '172.16.12.42']);
  });

  it('leaves the routes alone and shows the rule in error while the DNS server does not answer', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '172.16.12.41']);
    await h.settle();
    h.take();

    h.scheduler.advance(REFRESH_MS);
    h.scheduler.advance(LOOKUP_TIMEOUT_MS);
    const failed = await h.settle();

    expect(h.take()).toEqual([]);
    expect(stateOf(failed)).toMatchObject({
      status: 'error',
      reasonCode: 'resolve-failed',
      reason:
        'Could not refresh corp.local: the DNS lookup timed out after 5000 ms; the last known 2 addresses stay routed',
      appliedDestinations: ['172.16.12.40', '172.16.12.41'],
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });

    // The server is back with one address changed.
    h.scheduler.advance(RETRY_FLOOR_MS);
    await answer(h, ['172.16.12.40', '172.16.12.43']);
    const recovered = await h.settle();

    expect(h.take()).toEqual(['delete 172.16.12.41', `add 172.16.12.43 ${ETH_GW}`]);
    expect(stateOf(recovered)).toMatchObject({ status: 'active', reasonCode: null, appliedDestinations: ['172.16.12.40', '172.16.12.43'] });
  });

  it('never hands a forbidden address or the gateway of an interface to `routeAdd`', async () => {
    const h = withEngine([DOMAIN, domainRule(6, 'gw.corp.local')]);
    await h.engine.reconcile('startup');

    await answer(h, ['127.0.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255', '172.16.12.40']);
    await answer(h, [ETH_GW, '192.168.1.1', '10.20.4.23', '172.16.12.50']);
    const outcome = await h.settle();

    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`, `add 172.16.12.50 ${ETH_GW}`]);
    expect(stateOf(outcome, 5)).toMatchObject({
      status: 'error',
      reasonCode: 'forbidden-destination',
      appliedDestinations: ['172.16.12.40'],
    });
    expect(stateOf(outcome, 6)).toMatchObject({
      status: 'error',
      reasonCode: 'connected-network',
      appliedDestinations: ['172.16.12.50'],
    });
  });

  it('routes 32 addresses of a domain that has 40 and reports the truncation on the active rule', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');

    await answer(
      h,
      Array.from({ length: 40 }, (_unused, index) => `172.16.13.${String(index + 1)}`),
    );
    const outcome = await h.settle();

    expect(h.take()).toHaveLength(32);
    expect(stateOf(outcome)).toMatchObject({ status: 'active', reasonCode: 'addresses-truncated' });
    expect(stateOf(outcome).appliedDestinations).toHaveLength(32);
  });

  it('removes the routes of a domain that is disabled and resolves nothing for it any more', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    h.engine.setConfig(config([{ ...DOMAIN, enabled: false }]));
    h.service.syncConfig(h.engine.getConfig());
    const outcome = await h.engine.reconcile('config-change');
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.take()).toEqual(['delete 172.16.12.40']);
    expect(stateOf(outcome)).toMatchObject({ status: 'disabled', reasonCode: 'rule-disabled' });
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('removes the routes and stops resolving when the global toggle goes off', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    h.engine.setEnabled(false);
    h.service.syncConfig(h.engine.getConfig());
    await h.engine.reconcile('enabled-change');
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.take()).toEqual(['delete 172.16.12.40']);
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.service.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });
  });
});
