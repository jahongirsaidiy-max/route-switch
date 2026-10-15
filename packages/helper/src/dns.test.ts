import dns from 'node:dns';
import dnsPromises, { Resolver } from 'node:dns/promises';

import { Config, EngineState, LIMITS, PROTOCOL_LIMITS, type Rule } from '@routeswitch/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DNS_QUERY_TIMEOUT_MS,
  DNS_QUERY_TRIES,
  LOOKUP_TIMEOUT_MS,
  MAX_ANSWER_RECORDS,
  MAX_CONCURRENT_LOOKUPS,
  MAX_FAILING_LOOKUPS_PER_SERVER_SET,
  MAX_LOOKUPS_PER_SERVER_SET,
  RECONCILE_DEBOUNCE_MS,
  RETRY_FLOOR_MS,
  STALE_FLOOR_MS,
  STICKY_REFRESHES,
  createDomainResolver,
  createSystemResolver,
  sanitizeAnswer,
  staleLimitMs,
  type DomainResolverDeps,
  type DomainResolverService,
} from './dns';
import { createFakeDns, createFakeScheduler, dnsError, flush, type FakeDns, type FakeScheduler } from './dns-test-utils';
import {
  createEngine,
  MAX_EXCLUDED_DNS_PER_ROLE,
  MAX_EXCLUDED_DNS_SERVERS,
  MAX_EXCLUDED_OTHER_DNS,
  type DomainContext, type DomainResolver, type Engine, type ReconcileOutcome } from './engine';
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
    // Never the resolvers of the machine the tests run on.
    systemServers: () => [],
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
    // The address that is no longer in the answer stays for a while (see "rotating answers").
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40', '172.16.12.41', '172.16.12.42']);
    expect(h.logs('info', 'domain resolved').at(-1)?.context).toMatchObject({ addresses: 3, answered: 2, added: 1, removed: 0 });
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

  it('runs at most four lookups at a time against one server set for 500 domain rules, with a bounded number of timers', async () => {
    const h = setup();
    const rules = Array.from({ length: 500 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));

    for (const rule of rules) h.service.resolveDomain(rule);

    expect(MAX_LOOKUPS_PER_SERVER_SET).toBe(4);
    expect(h.dns.open()).toHaveLength(4);
    expect(h.service.stats()).toEqual({ entries: 500, inFlight: 4, queued: 496, timers: 4 });
    expect(h.scheduler.pending()).toBe(4);

    let mostOpen = 0;
    let mostTimers = 0;
    while (h.dns.open().length > 0) {
      mostOpen = Math.max(mostOpen, h.dns.open().length);
      mostTimers = Math.max(mostTimers, h.scheduler.pending());
      await answer(h, ['172.16.12.40']);
    }

    expect(mostOpen).toBe(4);
    // Four lookup timeouts, the refresh timer and the reconcile debounce.
    expect(mostTimers).toBeLessThanOrEqual(6);
    expect(h.dns.lookups).toHaveLength(500);
    // First come, first served.
    expect(h.dns.lookups.map((lookup) => lookup.hostname)).toEqual(rules.map((rule) => rule.target));
    expect(h.service.stats()).toEqual({ entries: 500, inFlight: 0, queued: 0, timers: 2 });
    expect(h.scheduler.pending()).toBe(2);

    // 500 changed answers, one reconcile request.
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toEqual(['dns-refresh']);
    expect(h.scheduler.pending()).toBe(1);

    // And the refresh of all 500 goes through the same pool, behind one timer.
    h.scheduler.advance(REFRESH_MS);
    expect(h.dns.open()).toHaveLength(4);
    expect(h.service.stats()).toMatchObject({ inFlight: 4, queued: 496 });
  });

  it('runs at most eight lookups at a time over all server sets', () => {
    const h = setup();
    const servers = ['10.20.0.10', '10.20.0.11', '10.20.0.12'];
    const rules = servers.flatMap((dns, group) =>
      Array.from({ length: 10 }, (_unused, index) => domainRule(group * 10 + index + 1, `host-${String(index)}.corp.local`, { dns })),
    );

    for (const rule of rules) h.service.resolveDomain(rule);

    expect(MAX_CONCURRENT_LOOKUPS).toBe(8);
    expect(h.dns.open().map((lookup) => lookup.servers?.[0])).toEqual([
      ...Array.from({ length: 4 }, () => '10.20.0.10'),
      ...Array.from({ length: 4 }, () => '10.20.0.11'),
    ]);
    expect(h.service.stats()).toMatchObject({ inFlight: 8, queued: 22 });
  });

  it('keeps the pool moving when every lookup hangs', () => {
    const h = setup();
    const rules = Array.from({ length: 20 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);

    let mostInFlight = 0;
    for (let step = 0; step < 5; step += 1) {
      mostInFlight = Math.max(mostInFlight, h.service.stats().inFlight);
      h.scheduler.advance(LOOKUP_TIMEOUT_MS);
    }

    // Five rounds of four: every name was asked once before any retry got a turn beyond its lane.
    expect(mostInFlight).toBe(4);
    expect(new Set(h.dns.lookups.map((lookup) => lookup.hostname)).size).toBe(20);
    expect(rules.every((rule) => h.service.resolveDomain(rule).reasonCode === 'resolve-failed')).toBe(true);
    // What runs now are retries of names that failed: no more than two at a time per server set.
    expect(h.service.stats().inFlight).toBe(MAX_FAILING_LOOKUPS_PER_SERVER_SET);
  });

  it('gives up the rule asked about longest ago when the table is full, instead of refusing a new one', () => {
    const h = setup();
    for (let index = 0; index < LIMITS.maxRules; index += 1) {
      h.service.resolveDomain(domainRule(index + 1, `host-${String(index)}.corp.local`));
    }

    const extra = h.service.resolveDomain(domainRule(9999, 'one-too-many.corp.local'));

    expect(extra).toMatchObject({ destinations: [], status: 'pending', reasonCode: 'resolving' });
    expect(h.service.stats().entries).toBe(LIMITS.maxRules);
    expect(h.logs('warn', 'too many rules are tracked; the one asked about longest ago is dropped')[0]?.context).toMatchObject({
      ruleId: ruleId(1),
    });
  });

  it('is not exhausted by rule ids that come and go without `syncConfig` (QA reproduction)', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    // 2000 rules that existed once and were never reported as removed.
    for (let index = 0; index < 2000; index += 1) {
      const orphan = h.service.resolveDomain(domainRule(10_000 + index, `gone-${String(index)}.corp.local`));
      expect(orphan.reasonCode).toBe('resolving');
      // The rule that is really there is asked about in every pass.
      if (index % 100 === 0) expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    }

    expect(h.service.stats().entries).toBeLessThanOrEqual(LIMITS.maxRules);
    expect(h.service.resolveDomain(domainRule(7, 'new.corp.local'))).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', destinations: ['172.16.12.40'] });
    expect(h.logs('warn', 'too many rules are tracked; the one asked about longest ago is dropped')).toHaveLength(1);
    expect(JSON.stringify(h.entries)).not.toContain('Too many');
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
    expect(h.service.stats()).toMatchObject({ inFlight: 4, queued: 8 });

    h.service.syncConfig(config(rules.slice(0, 8)));

    expect(h.service.stats()).toEqual({ entries: 8, inFlight: 4, queued: 4, timers: 4 });
    expect(h.dns.lookups).toHaveLength(4);
  });

  it('gives the slot of a dropped lookup to the next one in the queue', () => {
    const h = setup();
    const rules = Array.from({ length: 9 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`));
    for (const rule of rules) h.service.resolveDomain(rule);
    expect(h.dns.lookups).toHaveLength(4);

    h.service.syncConfig(config(rules.slice(1)));

    expect(h.dns.lookups).toHaveLength(5);
    expect(h.dns.lookups[4]?.hostname).toBe('host-4.corp.local');
    expect(h.service.stats()).toMatchObject({ entries: 8, inFlight: 4, queued: 4 });
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

    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40', '172.16.12.41']);
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
    expect(h.scheduler.pending()).toBe(6);
    const running = h.dns.open();
    expect(running).toHaveLength(4);

    h.service.stop();
    h.service.stop();

    expect(h.scheduler.pending()).toBe(0);
    expect(h.service.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });
    expect(running.every((lookup) => lookup.cancelled)).toBe(true);

    for (const lookup of running) lookup.answer(['172.16.12.66']);
    await flush();
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.reconciles).toEqual([]);
    expect(h.dns.lookups).toHaveLength(5);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], status: 'pending', reasonCode: 'resolving' });
    h.service.syncConfig(config([DOMAIN]));
    h.service.refreshAll();
    expect(h.dns.lookups).toHaveLength(5);
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

interface EngineOptions {
  /** What the detection returns; replace `current` to change the network. */
  readonly network?: { current: DetectedInterfaces };
  readonly deps?: Partial<DomainResolverDeps>;
  /** Wraps the resolver the way the scoped-DNS module will. */
  readonly wrap?: (service: DomainResolverService) => DomainResolver;
}

const withEngine = (rules: readonly Rule[], options: EngineOptions = {}): EngineHarness => {
  const passes: Promise<ReconcileOutcome>[] = [];
  const calls: string[] = [];
  const network = options.network ?? { current: NETWORK };
  const netinfo: NetInfo = { detectInterfaces: () => Promise.resolve(network.current), invalidate: () => undefined };
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
    ...options.deps,
  });
  const engine = createEngine({
    netinfo,
    routes,
    logger: createLogger({ sinks: [] }),
    helperVersion: '1.2.3',
    initialConfig: config(rules),
    now: h.scheduler.now,
    resolveDomain: options.wrap?.(h.service) ?? h.service.resolveDomain,
    onConfigChanged: h.service.syncConfig,
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

  it('after `refreshSec` routes the new address of a domain, and removes the one that is gone once it has been absent long enough', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '172.16.12.41']);
    await h.settle();
    h.take();

    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41', '172.16.12.42']);
    const changed = await h.settle();

    // The new address is routed at once; the old one is not torn down by one answer without it.
    expect(h.take()).toEqual([`add 172.16.12.42 ${ETH_GW}`]);
    expect(stateOf(changed)).toMatchObject({
      status: 'active',
      appliedDestinations: ['172.16.12.40', '172.16.12.41', '172.16.12.42'],
    });

    // Two more refreshes without it. Every answer arrives a little after its refresh was due, so at the
    // third answer without the address it has been absent for more than three intervals.
    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41', '172.16.12.42']);
    await h.settle();
    expect(h.take()).toEqual([]);
    h.scheduler.advance(REFRESH_MS);
    await answer(h, ['172.16.12.41', '172.16.12.42']);
    const outcome = await h.settle();

    expect(h.take()).toEqual(['delete 172.16.12.40']);
    expect(stateOf(outcome)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.41', '172.16.12.42'] });
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

    expect(h.take()).toEqual([`add 172.16.12.43 ${ETH_GW}`]);
    expect(stateOf(recovered)).toMatchObject({
      status: 'active',
      reasonCode: null,
      appliedDestinations: ['172.16.12.40', '172.16.12.41', '172.16.12.43'],
    });
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

// ---------------------------------------------------------------------------
// DNS servers are never routed because a name resolved to them
// ---------------------------------------------------------------------------

const context = (dnsServers: readonly string[] | null | undefined, all: readonly string[] = dnsServers ?? []): DomainContext => ({
  dnsServers,
  interfaceDnsServers: all,
});

/** Moves the clock in steps and lets the lookups that fall due answer (through `dns.auto`) or fail. */
const pass = async (h: Harness, ms: number, step = 10_000): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    h.scheduler.advance(Math.min(step, ms - elapsed));
    await flush();
  }
};

/** The next refresh: waits one interval and answers the lookup that starts. */
const refresh = async (h: Harness, records: unknown): Promise<void> => {
  h.scheduler.advance(REFRESH_MS);
  await answer(h, records);
};

const block = (third: number, count: number, from = 1): string[] =>
  Array.from({ length: count }, (_unused, index) => `172.16.${String(third)}.${String(from + index)}`);

describe('DNS-server addresses in an answer', () => {
  const SYSTEM = '192.0.2.53';

  it('are refused by `sanitizeAnswer` as `dns-server`', () => {
    expect(sanitizeAnswer([SYSTEM, '172.16.12.40', SYSTEM], new Set([SYSTEM]))).toEqual({
      addresses: ['172.16.12.40'],
      usable: 1,
      refused: { 'dns-server': 2 },
      refusedTotal: 2,
    });
    expect(sanitizeAnswer([SYSTEM], new Set())?.addresses).toEqual([SYSTEM]);
  });

  it('stays an error when a forbidden address comes along with a DNS server (TASK-DELTA-07)', async () => {
    const h = setup({ systemServers: () => [SYSTEM] });

    await resolveFirst(h, DOMAIN, [SYSTEM, '127.0.0.1', '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: ['172.16.12.40'],
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason: '2 resolved addresses of corp.local must never be routed (dns-server: 1, loopback: 1)',
    });
  });

  it('counts a truncated answer in the warning of an excluded DNS server (TASK-DELTA-07)', async () => {
    const h = setup({ systemServers: () => [SYSTEM] });
    const many = Array.from({ length: 40 }, (_unused, index) => `172.16.13.${String(index + 1)}`);

    await resolveFirst(h, DOMAIN, [SYSTEM, ...many]);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      status: 'active',
      reasonCode: 'dns-server-excluded',
      reason: '1 resolved address of corp.local is a DNS server and never routed; 40 addresses, the 32 lowest are routed',
    });
  });

  it('drops the resolvers of the system from an answer, with one warning', async () => {
    const h = setup({ systemServers: () => [SYSTEM, '[2001:db8::53]:53', '192.0.2.54:5353', 'garbage', '999.1.1.1'] });

    await resolveFirst(h, DOMAIN, [SYSTEM, '192.0.2.54', '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN)).toEqual({
      destinations: ['172.16.12.40'],
      status: 'active',
      reasonCode: 'dns-server-excluded',
      reason: '2 resolved addresses of corp.local are DNS servers and never routed',
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
    const warnings = h.logs('warn', 'resolved addresses refused; they are never routed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({ refused: 2, reasons: { 'dns-server': 2 } });

    await refresh(h, [SYSTEM, '192.0.2.54', '172.16.12.40']);
    expect(h.logs('warn')).toHaveLength(1);
  });

  it('reports `no-addresses` when the answer holds nothing but a DNS server', async () => {
    const h = setup({ systemServers: () => [SYSTEM] });

    await resolveFirst(h, DOMAIN, [SYSTEM]);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: [],
      status: 'error',
      reasonCode: 'no-addresses',
      reason: 'corp.local has no usable A records: 1 address must never be routed (dns-server: 1)',
    });
  });

  it('reads the resolvers of the system when the answer arrives, not once at the start', async () => {
    let servers = ['192.0.2.1'];
    const h = setup({ systemServers: () => servers });
    await resolveFirst(h, DOMAIN, [SYSTEM, '172.16.12.40']);
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40', SYSTEM]);

    // The network changed: that address is the resolver now.
    servers = [SYSTEM];
    await refresh(h, [SYSTEM, '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: ['172.16.12.40'], reasonCode: 'dns-server-excluded' });
  });

  it('keeps the list it had when the resolvers of the system cannot be read', async () => {
    let broken = false;
    const h = setup({
      systemServers: () => {
        if (broken) throw new Error('no resolver list');
        return [SYSTEM];
      },
    });
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);

    broken = true;
    await refresh(h, [SYSTEM, '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    expect(h.logs('error', 'the system DNS servers could not be read')).toHaveLength(1);
  });

  it.each([
    ['with `syncConfig`', true],
    ['without it, from the rules it is asked about', false],
  ])('drops the `dns` of every rule from every answer, its own included (%s)', async (_name, synced) => {
    const h = setup();
    const own = domainRule(1, 'corp.local', { dns: DNS_SERVER });
    const other = domainRule(2, 'other.corp.local');
    if (synced) h.service.syncConfig(config([own, other]));
    h.service.resolveDomain(own);
    h.service.resolveDomain(other);

    await answer(h, [DNS_SERVER, '172.16.12.40']);
    await answer(h, ['172.16.12.50', DNS_SERVER]);

    expect(h.service.resolveDomain(own)).toMatchObject({ destinations: ['172.16.12.40'], reasonCode: 'dns-server-excluded' });
    expect(h.service.resolveDomain(other)).toMatchObject({
      destinations: ['172.16.12.50'],
      reason: '1 resolved address of other.corp.local is a DNS server and never routed',
    });
  });

  it('drops the DNS servers of the interfaces', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN, context(['10.20.0.10'], ['10.20.0.10', '192.168.1.1']));

    await answer(h, ['192.168.1.1', '10.20.0.10', '172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN, context(['10.20.0.10'], ['10.20.0.10', '192.168.1.1']))).toMatchObject({
      destinations: ['172.16.12.40'],
      reason: '2 resolved addresses of corp.local are DNS servers and never routed',
    });
  });

  it('stops serving a cached address the moment it becomes the `dns` of a rule', async () => {
    const h = setup();
    h.service.syncConfig(config([DOMAIN]));
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40', '172.16.12.41']);

    h.service.syncConfig(config([DOMAIN, domainRule(6, 'other.corp.local', { dns: '172.16.12.41' })]));

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: ['172.16.12.40'],
      status: 'active',
      reasonCode: 'dns-server-excluded',
      reason: '1 resolved address of corp.local is a DNS server and never routed',
    });
    // And it is served again once no rule uses it as a server.
    h.service.syncConfig(config([DOMAIN]));
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: ['172.16.12.40', '172.16.12.41'], status: 'active' });
  });

  it('never reaches `routeAdd` with the resolver of the system, and lets go of the routes when DNS stays dead (lock-in scenario)', async () => {
    const rule = domainRule(5, 'corp.local', { refreshSec: 60 });
    const h = withEngine([rule], { deps: { systemServers: () => [SYSTEM] } });
    await h.engine.reconcile('startup');

    // A poisoned answer: the name "resolves" to the machine's own resolver.
    await answer(h, [SYSTEM, '172.16.12.40']);
    const poisoned = await h.settle();

    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`]);
    expect(stateOf(poisoned)).toMatchObject({ status: 'active', reasonCode: 'dns-server-excluded', appliedDestinations: ['172.16.12.40'] });

    // From here on every lookup fails. The routes stay for a while ...
    h.dns.auto = () => dnsError('ETIMEOUT');
    await pass(h, STALE_FLOOR_MS - RECONCILE_DEBOUNCE_MS);
    const failing = await h.settle();
    expect(h.take()).toEqual([]);
    expect(stateOf(failing)).toMatchObject({ status: 'error', reasonCode: 'resolve-failed', appliedDestinations: ['172.16.12.40'] });

    // ... and not for ever.
    await pass(h, 10_000);
    const expired = await h.settle();
    expect(h.take()).toEqual(['delete 172.16.12.40']);
    expect(stateOf(expired)).toMatchObject({ status: 'error', reasonCode: 'resolve-failed', appliedDestinations: [] });
    expect(stateOf(expired).reason).toContain('the last known addresses expired after 60 min without an answer');
  });

  it('leaves room for the scoped-DNS module to route the `dns` of a rule itself', async () => {
    const rule = domainRule(5, 'corp.local', { dns: DNS_SERVER });
    const h = withEngine([rule], {
      wrap: (service) => (asked, facts) => {
        const targets = service.resolveDomain(asked, facts);
        return asked.dns === undefined ? targets : { ...targets, destinations: [asked.dns, ...targets.destinations] };
      },
    });

    const first = await h.engine.reconcile('startup');
    // The route to the server is there before the name has resolved.
    expect(h.take()).toEqual([`add ${DNS_SERVER} ${ETH_GW}`]);
    expect(stateOf(first)).toMatchObject({ status: 'pending', reasonCode: 'resolving', appliedDestinations: [DNS_SERVER] });

    await answer(h, ['172.16.12.40']);
    const outcome = await h.settle();

    expect(h.dns.lookups[0]?.servers).toEqual([DNS_SERVER]);
    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`]);
    expect(stateOf(outcome)).toMatchObject({ status: 'active', appliedDestinations: [DNS_SERVER, '172.16.12.40'] });
  });
});

// ---------------------------------------------------------------------------
// The last known addresses expire
// ---------------------------------------------------------------------------

/** A harness whose wall clock can be moved against its timers: `clock.offset` is added to the time. */
const setupWithClock = (): { h: Harness; clock: { offset: number } } => {
  const clock = { offset: 0 };
  const holder: { h: Harness | null } = { h: null };
  const h = setup({ now: () => new Date((holder.h?.scheduler.now().getTime() ?? NOW.getTime()) + clock.offset) });
  holder.h = h;
  return { h, clock };
};

describe('expiry of the last known addresses', () => {
  it('uses ten refresh intervals, but never less than an hour', () => {
    expect(STALE_FLOOR_MS).toBe(3_600_000);
    expect(staleLimitMs(60_000)).toBe(3_600_000);
    expect(staleLimitMs(360_000)).toBe(3_600_000);
    expect(staleLimitMs(360_001)).toBe(3_600_010);
    expect(staleLimitMs(600_000)).toBe(6_000_000);
    expect(staleLimitMs(86_400_000)).toBe(864_000_000);
  });

  it.each([
    [60, 3_600_000, 60],
    [360, 3_600_000, 60],
    [600, 6_000_000, 100],
    [3600, 36_000_000, 600],
    [86_400, 864_000_000, 14_400],
  ])('with refreshSec %i keeps them up to %i ms after the last answer and drops them a millisecond later', async (refreshSec, limit, minutes) => {
    const h = setup();
    const rule = domainRule(5, 'corp.local', { refreshSec });
    await resolveFirst(h, rule, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(rule);
    h.dns.auto = () => dnsError('ESERVFAIL');

    await pass(h, limit - RECONCILE_DEBOUNCE_MS, 60_000);

    // Exactly at the limit: still routed.
    expect(h.service.resolveDomain(rule)).toMatchObject({
      destinations: ['172.16.12.40', '172.16.12.41'],
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'Could not refresh corp.local: the DNS lookup failed (ESERVFAIL); the last known 2 addresses stay routed',
    });
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toEqual([]);
    const before = h.reconciles.length;

    h.scheduler.advance(1);

    expect(h.service.resolveDomain(rule)).toEqual({
      destinations: [],
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: `Could not refresh corp.local: the DNS lookup failed (ESERVFAIL); the last known addresses expired after ${String(minutes)} min without an answer`,
      lastResolvedAt: '2026-10-12T08:30:00.000Z',
    });
    const dropped = h.logs('warn', 'no answer for too long; the last known addresses are dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.context).toMatchObject({ domain: 'corp.local', dropped: 2, limitMs: limit, staleMs: limit + 1 });
    // The engine is told, once.
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toHaveLength(before + 1);

    // It stays that way, quietly, while the failures go on.
    await pass(h, limit, 60_000);
    expect(h.service.resolveDomain(rule).destinations).toEqual([]);
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toHaveLength(1);
    expect(h.reconciles).toHaveLength(before + 1);
  });

  it('notices the limit when the rule is asked about, even if no timer has fired', async () => {
    const { h, clock } = setupWithClock();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(REFRESH_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    const before = h.reconciles.length;

    // The timers do not run (a stalled event loop); the rule is asked about once per refresh interval.
    const limit = 6_000_000;
    for (let elapsed = REFRESH_MS + RECONCILE_DEBOUNCE_MS; elapsed + REFRESH_MS <= limit; elapsed += REFRESH_MS) {
      clock.offset += REFRESH_MS;
      expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    }
    clock.offset = limit - REFRESH_MS - RECONCILE_DEBOUNCE_MS;
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
    clock.offset += 1;

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], reasonCode: 'resolve-failed' });
    // The engine was told in that very call: no reconcile is asked for on top of it.
    expect(h.scheduler.delays()).not.toContain(RECONCILE_DEBOUNCE_MS);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toHaveLength(before);
  });

  it.each([
    ['while the name was answering', false],
    ['in the middle of a failure streak', true],
  ])('does not take nine hours of sleep %s for nine hours without an answer', async (_name, failingBefore) => {
    const { h, clock } = setupWithClock();
    const rule = domainRule(5, 'corp.local', { refreshSec: 60 });
    await resolveFirst(h, rule, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(rule);
    h.dns.auto = () => dnsError('ESERVFAIL');
    if (failingBefore) await pass(h, 600_000);

    // The lid closes for nine hours: the clock moves, the timers do not. Then the network is not up yet.
    clock.offset += 9 * 3_600_000;
    h.service.refreshAll();
    await flush();

    // One failed lookup after waking up: the routes stay. Before, everything was dropped right here.
    expect(h.service.resolveDomain(rule)).toMatchObject({
      destinations: ['172.16.12.40', '172.16.12.41'],
      status: 'error',
      reasonCode: 'resolve-failed',
    });
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toEqual([]);

    // The gap counted as one refresh interval, no more: the hour of real failures is still needed.
    await pass(h, STALE_FLOOR_MS - (failingBefore ? 600_000 : 0) - 180_000);
    expect(h.service.resolveDomain(rule).destinations).toEqual(['172.16.12.40', '172.16.12.41']);
    await pass(h, 240_000);
    expect(h.service.resolveDomain(rule).destinations).toEqual([]);
  });

  it('restores the rule as soon as an answer arrives, and starts counting anew', async () => {
    const h = setup();
    const rule = domainRule(5, 'corp.local', { refreshSec: 60 });
    await resolveFirst(h, rule, ['172.16.12.40']);
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, STALE_FLOOR_MS + 60_000, 60_000);
    expect(h.service.resolveDomain(rule).destinations).toEqual([]);
    const before = h.reconciles.length;

    h.dns.auto = () => ['172.16.12.41'];
    await pass(h, 60_000);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.service.resolveDomain(rule)).toMatchObject({ destinations: ['172.16.12.41'], status: 'active', reasonCode: null });
    expect(h.reconciles).toHaveLength(before + 1);
    expect(h.logs('info', 'domain resolved').at(-1)?.context).toMatchObject({ addresses: 1, added: 1 });

    // A new failure streak has its own hour.
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, STALE_FLOOR_MS - 120_000, 60_000);
    expect(h.service.resolveDomain(rule)).toMatchObject({ destinations: ['172.16.12.41'], reasonCode: 'resolve-failed' });
    await pass(h, 240_000, 60_000);
    expect(h.service.resolveDomain(rule).destinations).toEqual([]);
  });

  it('has nothing to expire for a rule that never resolved', async () => {
    const h = setup();
    h.dns.auto = () => dnsError('ESERVFAIL');
    h.service.resolveDomain(DOMAIN);

    await pass(h, 3 * 6_000_000, 60_000);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: [],
      reason: 'Could not resolve corp.local: the DNS lookup failed (ESERVFAIL)',
    });
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toEqual([]);
  });

  it('neither expires early nor never when the clock is set back', async () => {
    const { h, clock } = setupWithClock();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, 3_000_000);

    // Half way to the limit the wall clock jumps back by more than the time that has passed.
    clock.offset = -4_000_000;
    await pass(h, 2_900_000);

    // 5 900 s of failures so far: not yet, whatever the clock says.
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);

    // What was not yet counted when the clock jumped is lost: at most one retry interval (`refreshSec`).
    await pass(h, 100_000 + REFRESH_MS + 20_000);

    // 6 620 s of failures: gone, although by the wall clock only 2 620 s have passed.
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual([]);
  });

  it('credits nothing for the jump itself when the clock is set back between two observations', async () => {
    const { h, clock } = setupWithClock();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, 3_000_000);

    // Asked about, the clock jumps back, asked about again a moment later.
    h.service.resolveDomain(DOMAIN);
    clock.offset = -4_000_000;
    h.service.resolveDomain(DOMAIN);
    await pass(h, 2_700_000);

    // 5 700 s of failures. Had the jump counted as an interval of its own, the limit would be passed.
    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(['172.16.12.40']);
  });

  it('expires on time a name whose lookups are queued for longer than a refresh interval', async () => {
    const h = setup();
    // 40 names on one server, a refresh a minute; then every lookup hangs. Two failing lookups at a
    // time, five seconds each: a name gets its turn every 100 s, less often than it has to be observed.
    const rules = Array.from({ length: 40 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`, { refreshSec: 60 }));
    h.dns.auto = () => ['172.16.12.40'];
    for (const rule of rules) h.service.resolveDomain(rule);
    await flush();
    expect(rules.every((rule) => h.service.resolveDomain(rule).status === 'active')).toBe(true);
    h.dns.auto = null;

    await pass(h, STALE_FLOOR_MS);
    expect(rules.every((rule) => h.service.resolveDomain(rule).destinations.length === 1)).toBe(true);
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toEqual([]);
    h.scheduler.advance(1);

    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toHaveLength(40);
    expect(rules.every((rule) => h.service.resolveDomain(rule).destinations.length === 0)).toBe(true);
  });

  it('expires on time although the network keeps changing and no lookup ever gets to its retry time', async () => {
    const h = setup();
    const rules = Array.from({ length: 40 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`, { refreshSec: 60 }));
    h.dns.auto = () => ['172.16.12.40'];
    for (const rule of rules) h.service.resolveDomain(rule);
    await flush();
    h.dns.auto = null;

    // Every name fails once ...
    await pass(h, 200_000);
    expect(rules.every((rule) => h.service.resolveDomain(rule).reasonCode === 'resolve-failed')).toBe(true);
    // ... and from then on `refreshAll()` every 4 s starts every lookup over before it can time out:
    // no lookup ever ends, so no name is observed by a lookup of its own or waits for a retry time.
    // Only the timer is left to count.
    for (let elapsed = 200_000; elapsed < STALE_FLOOR_MS; elapsed += 4000) {
      await pass(h, 4000);
      if (elapsed + 4000 < STALE_FLOOR_MS) h.service.refreshAll();
    }
    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toEqual([]);
    h.scheduler.advance(1);

    expect(h.logs('warn', 'no answer for too long; the last known addresses are dropped')).toHaveLength(40);
  });

  it('refreshes on time after the clock is set back, instead of a jump late', async () => {
    const { h, clock } = setupWithClock();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(100_000);

    clock.offset = -3_600_000;
    h.service.resolveDomain(DOMAIN);
    h.scheduler.advance(REFRESH_MS - 1);
    expect(h.dns.lookups).toHaveLength(1);
    h.scheduler.advance(1);

    expect(h.dns.lookups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Which server a rule without `dns` is asked from
// ---------------------------------------------------------------------------

describe('the DNS server of the interface', () => {
  const ETH_DNS = ['10.20.0.10', '10.20.0.11'];

  it('asks the servers of the rule\'s interface, in order, and says so in the log', async () => {
    const h = setup();

    h.service.resolveDomain(DOMAIN, context(ETH_DNS));
    await answer(h, ['172.16.12.40']);

    expect(h.dns.lookups[0]?.servers).toEqual(ETH_DNS);
    expect(h.logs('info', 'domain resolved')[0]?.context).toMatchObject({
      domain: 'corp.local',
      dns: null,
      servers: ETH_DNS,
      source: 'interface',
    });
    expect(h.logs('warn')).toEqual([]);
    expect(h.service.resolveDomain(DOMAIN, context(ETH_DNS)).destinations).toEqual(['172.16.12.40']);
    expect(h.dns.lookups).toHaveLength(1);
  });

  it('names the source in the log for the other two cases as well', async () => {
    const h = setup();
    const explicit = domainRule(1, 'corp.local', { dns: DNS_SERVER });
    h.service.resolveDomain(explicit, context(ETH_DNS));
    h.service.resolveDomain(domainRule(2, 'other.corp.local'));

    await answer(h, ['172.16.12.40']);
    await answer(h, ['172.16.12.50']);

    expect(h.logs('info', 'domain resolved').map((entry) => [entry.context?.['dns'], entry.context?.['servers'], entry.context?.['source']])).toEqual([
      [DNS_SERVER, [DNS_SERVER], 'rule'],
      [null, [], 'system'],
    ]);
    // The rule's own server is asked whatever the interface has.
    expect(h.dns.lookups[0]?.servers).toEqual([DNS_SERVER]);
  });

  it('uses only usable, distinct addresses and at most four of them', () => {
    const h = setup();
    const messy = ['10.20.0.10', '10.20.0.10', '127.0.0.1', 'ns.corp.local', '0.0.0.0', '10.20.0.11', '10.20.0.12', '10.20.0.13', '10.20.0.14'];

    h.service.resolveDomain(DOMAIN, context(messy));

    expect(h.dns.lookups[0]?.servers).toEqual(['10.20.0.10', '10.20.0.11', '10.20.0.12', '10.20.0.13']);
  });

  it.each([
    ['has none', context([])],
    ['is not known', context(undefined)],
    ['has nothing usable', context(['127.0.0.1', 'garbage'])],
  ])('falls back to the system resolvers when the interface %s, and warns once per rule', (_name, facts) => {
    const h = setup();
    const other = domainRule(6, 'other.corp.local');

    for (let asked = 0; asked < 3; asked += 1) {
      h.service.resolveDomain(DOMAIN, facts);
      h.service.resolveDomain(other, facts);
    }

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([null, null]);
    const warnings = h.logs('warn', 'no DNS server is known for the interface of the rule; the system resolvers are asked');
    expect(warnings.map((entry) => entry.context)).toEqual([
      { component: 'dns', ruleId: ruleId(5), domain: 'corp.local', iface: 'ethernet' },
      { component: 'dns', ruleId: ruleId(6), domain: 'other.corp.local', iface: 'ethernet' },
    ]);
  });

  it('does not warn a caller that knows nothing about interfaces, nor a rule with its own `dns`', () => {
    const h = setup();

    h.service.resolveDomain(DOMAIN);
    h.service.resolveDomain(domainRule(6, 'other.corp.local', { dns: DNS_SERVER }), context([]));

    expect(h.logs('warn')).toEqual([]);
  });

  it('warns again when the interface loses its server a second time', () => {
    const h = setup();

    h.service.resolveDomain(DOMAIN, context([]));
    h.service.resolveDomain(DOMAIN, context(ETH_DNS));
    h.service.resolveDomain(DOMAIN, context([]));

    expect(h.logs('warn', 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toHaveLength(2);
  });

  it('warns once when a rule goes from its interface\'s server to the system resolvers (QA reproduction)', () => {
    const h = setup();
    const warnings = (): number =>
      h.logs('warn', 'no DNS server is known for the interface of the rule; the system resolvers are asked').length;
    const counts: number[] = [];

    h.service.resolveDomain(DOMAIN, context(['10.20.9.53']));
    for (let asked = 0; asked < 4; asked += 1) {
      h.service.resolveDomain(DOMAIN, context([]));
      counts.push(warnings());
    }
    // Before: 1, 2, 2, 2 -- the flag was cleared by the very call that set it.
    expect(counts).toEqual([1, 1, 1, 1]);

    // A new episode: the interface had a server again and lost it again.
    h.service.resolveDomain(DOMAIN, context(['10.20.9.53']));
    h.service.resolveDomain(DOMAIN, context([]));
    h.service.resolveDomain(DOMAIN, context([]));
    expect(warnings()).toBe(2);

    // Not a new episode: the same rule pointed at another name, still without a server of its own.
    h.service.resolveDomain({ ...DOMAIN, target: 'renamed.corp.local' }, context([]));
    h.service.resolveDomain(DOMAIN, context([]));
    expect(warnings()).toBe(2);

    // And another: the rule was removed and came back.
    h.service.syncConfig(config([]));
    h.service.syncConfig(config([DOMAIN]));
    h.service.resolveDomain(DOMAIN, context([]));
    h.service.resolveDomain(DOMAIN, context([]));
    expect(warnings()).toBe(3);
  });

  it('waits, without asking anyone, while the servers of the interface are not known yet', () => {
    const h = setup();

    const waiting = h.service.resolveDomain(DOMAIN, context(null, ['10.20.9.53']));

    expect(waiting).toEqual({
      destinations: [],
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Waiting for the DNS server of the ethernet interface to be known',
      lastResolvedAt: null,
    });
    expect(h.dns.created).toBe(0);
    expect(h.scheduler.scheduled).toEqual([]);
    expect(h.service.stats().entries).toBe(0);
    expect(h.logs('warn')).toEqual([]);

    // Once they are known, it asks them; once the engine gives up waiting, the system resolvers.
    h.service.resolveDomain(DOMAIN, context(['10.20.0.10']));
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10']]);
    const other = domainRule(6, 'other.corp.local');
    h.service.resolveDomain(other, context(null));
    h.service.resolveDomain(other, context(undefined));
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10'], null]);
    expect(h.logs('warn')).toHaveLength(1);
  });

  it('keeps serving and refreshing what a rule has while the servers are "not known yet"', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN, context(['10.20.0.10']));
    await answer(h, ['172.16.12.40']);

    expect(h.service.resolveDomain(DOMAIN, context(null))).toMatchObject({ status: 'active', destinations: ['172.16.12.40'] });
    expect(h.service.stats().entries).toBe(1);
    h.scheduler.advance(REFRESH_MS);
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10'], ['10.20.0.10']]);

    // The same for a rule that was being asked from the system resolvers.
    const fallback = domainRule(6, 'other.corp.local');
    h.service.resolveDomain(fallback, context([]));
    expect(h.service.resolveDomain(fallback, context(null)).reason).toBe('Resolving other.corp.local');

    // A rule that names its server never waits; an edited rule does not get the answer of the old name.
    const own = domainRule(7, 'own.corp.local', { dns: DNS_SERVER });
    expect(h.service.resolveDomain(own, context(null)).reason).toBe('Resolving own.corp.local');
    expect(h.service.resolveDomain({ ...DOMAIN, target: 'renamed.corp.local' }, context(null))).toMatchObject({
      destinations: [],
      reason: 'Waiting for the DNS server of the ethernet interface to be known',
    });
  });

  it('resolves again, from nothing, when the interface gets other servers', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN, context(ETH_DNS));
    await answer(h, ['172.16.12.40']);

    const moved = h.service.resolveDomain(DOMAIN, context(['10.30.0.10']));

    expect(moved).toMatchObject({ destinations: [], status: 'pending', reasonCode: 'resolving' });
    expect(h.dns.lookups[1]?.servers).toEqual(['10.30.0.10']);
    expect(h.service.stats().entries).toBe(1);

    await answer(h, ['172.16.99.40']);
    expect(h.service.resolveDomain(DOMAIN, context(['10.30.0.10'])).destinations).toEqual(['172.16.99.40']);
  });

  it('resolves one name separately for each interface it is bound to', async () => {
    const h = setup();
    const viaWifi = domainRule(6, 'corp.local', { iface: 'wifi' });
    h.service.resolveDomain(DOMAIN, context(ETH_DNS, [...ETH_DNS, '192.168.1.1']));
    h.service.resolveDomain(viaWifi, context(['192.168.1.1'], [...ETH_DNS, '192.168.1.1']));

    await answer(h, ['172.16.12.40']);
    await answer(h, ['203.0.113.40']);

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([ETH_DNS, ['192.168.1.1']]);
    expect(h.service.resolveDomain(DOMAIN, context(ETH_DNS)).destinations).toEqual(['172.16.12.40']);
    expect(h.service.resolveDomain(viaWifi, context(['192.168.1.1'])).destinations).toEqual(['203.0.113.40']);
  });

  it('points at `dns` when a lookup through the interface\'s server fails', async () => {
    const h = setup();
    h.service.resolveDomain(DOMAIN, context(ETH_DNS));

    await fail(h, 'ENOTFOUND');

    expect(h.service.resolveDomain(DOMAIN, context(ETH_DNS)).reason).toBe(
      'Could not resolve corp.local: the DNS server does not know the name (ENOTFOUND); if only an internal server knows the name, set `dns` in the rule',
    );
    expect(h.logs('warn', 'domain lookup failed')[0]?.context).toMatchObject({
      servers: ETH_DNS,
      source: 'interface',
      hint: 'set `dns` in the rule if only an internal server knows the name',
    });
  });

  it('through the engine: asks the server of the rule\'s role, follows a network change, ignores a degraded detection', async () => {
    const withServers = (ethernet: readonly string[], degraded = false): DetectedInterfaces => ({
      ...NETWORK,
      degraded,
      dnsServers: { ethernet, wifi: ['192.168.1.1'] },
    });
    const network = { current: withServers(['10.20.0.10']) };
    const h = withEngine([DOMAIN], { network });

    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '192.168.1.1']);
    const first = await h.settle();

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10']]);
    // The Wi-Fi resolver in the answer is not routed through Ethernet.
    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`]);
    expect(stateOf(first)).toMatchObject({ reasonCode: 'dns-server-excluded', appliedDestinations: ['172.16.12.40'] });

    // A detection that cannot be trusted reports another server: nothing changes.
    network.current = withServers(['203.0.113.53'], true);
    await h.engine.reconcile('network-change');
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.take()).toEqual([]);

    // A clean one does: the name is resolved again from the new server.
    network.current = withServers(['10.30.0.10']);
    const moved = await h.engine.reconcile('network-change');
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10'], ['10.30.0.10']]);
    expect(stateOf(moved)).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
    expect(h.take()).toEqual(['delete 172.16.12.40']);

    await answer(h, ['172.16.99.40']);
    const settled = await h.settle();
    expect(h.take()).toEqual([`add 172.16.99.40 ${ETH_GW}`]);
    expect(stateOf(settled)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.99.40'] });
  });
});

// ---------------------------------------------------------------------------
// Rotating answers
// ---------------------------------------------------------------------------

describe('rotating answers', () => {
  const served = (h: Harness): readonly string[] => h.service.resolveDomain(DOMAIN).destinations;

  it('keeps an address for three refresh intervals after it was last in an answer', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);

    expect(STICKY_REFRESHES).toBe(3);
    for (let missed = 1; missed <= 3; missed += 1) {
      await refresh(h, ['172.16.12.41']);
      // Absent for exactly `missed` intervals; three is still within the limit.
      expect(served(h)).toEqual(['172.16.12.40', '172.16.12.41']);
    }
    await refresh(h, ['172.16.12.41']);

    expect(served(h)).toEqual(['172.16.12.41']);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', reasonCode: null });
  });

  it('starts the three intervals again every time the address is seen', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);

    await refresh(h, ['172.16.12.41']);
    await refresh(h, ['172.16.12.41']);
    await refresh(h, ['172.16.12.40']);
    for (let missed = 1; missed <= 3; missed += 1) await refresh(h, ['172.16.12.42']);

    expect(served(h)).toEqual(['172.16.12.40', '172.16.12.42']);
  });

  it('asks for a reconcile only when the served set changes', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    served(h);
    expect(h.reconciles).toHaveLength(1);

    // A name that hands out two of three addresses each time.
    const rotation = [
      ['172.16.12.41', '172.16.12.42'],
      ['172.16.12.42', '172.16.12.40'],
      ['172.16.12.40', '172.16.12.41'],
      ['172.16.12.41', '172.16.12.42'],
    ];
    for (const records of rotation) {
      h.scheduler.advance(REFRESH_MS - RECONCILE_DEBOUNCE_MS);
      await answer(h, records);
      h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
      expect(served(h)).toEqual(['172.16.12.40', '172.16.12.41', '172.16.12.42']);
    }

    // One for the third address turning up; none for the rotation itself.
    expect(h.reconciles).toHaveLength(2);
    expect(h.logs('debug', 'domain resolved; addresses unchanged')).toHaveLength(3);
  });

  it('caps the union at 32: the address seen longest ago goes first, of two seen together the higher one', async () => {
    const h = setup();
    const first = block(20, 20);
    const second = block(21, 20);
    await resolveFirst(h, DOMAIN, first);

    await refresh(h, second);

    // 40 in all: the eight highest of the older answer make room.
    expect(served(h)).toEqual([...first.slice(0, 12), ...second]);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', reasonCode: null });

    const third = block(22, 5);
    await refresh(h, third);

    // 37: five more of the oldest go, again from the top; the second answer is untouched.
    expect(served(h)).toEqual([...first.slice(0, 7), ...second, ...third]);
    expect(served(h)).toHaveLength(32);
  });

  it('never gives up an address of the current answer for an older one', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, block(20, 32));

    // Numerically higher than everything before, and enough to fill the table alone.
    await refresh(h, block(30, 32));

    expect(served(h)).toEqual(block(30, 32));
  });

  it('does not give up an address of the current answer even when the clock makes an older one look just as fresh', async () => {
    const { h, clock } = setupWithClock();
    await resolveFirst(h, DOMAIN, block(20, 32));

    // The clock is set back: every older address now counts as seen "just now", like the new ones,
    // and of two seen at the same time the higher one goes first. The new ones are the higher ones.
    clock.offset = -3_600_000;
    h.service.refreshAll();
    await answer(h, block(30, 32));

    expect(h.service.resolveDomain(DOMAIN).destinations).toEqual(block(30, 32));
  });

  it('keeps nothing older when the current answer alone exceeds the limit', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.1.1', '172.16.1.2']);

    await refresh(h, block(30, 40));

    expect(served(h)).toEqual(block(30, 32));
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ status: 'active', reasonCode: 'addresses-truncated' });
  });

  it.each([
    ['an empty answer', (h: Harness) => answer(h, []), 'corp.local has no A records'],
    ['ENODATA', (h: Harness) => fail(h, 'ENODATA'), 'corp.local has no A records'],
    [
      'an answer with nothing usable in it',
      (h: Harness) => answer(h, ['127.0.0.1']),
      'corp.local has no usable A records: 1 address must never be routed (loopback: 1)',
    ],
  ])('clears everything at once on %s after a good one', async (_name, respond, reason) => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    served(h);

    h.scheduler.advance(REFRESH_MS);
    await respond(h);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: [], status: 'error', reasonCode: 'no-addresses', reason });
    expect(h.reconciles).toHaveLength(2);

    // And nothing comes back with the next answer but what is in it.
    await refresh(h, ['172.16.12.42']);
    expect(served(h)).toEqual(['172.16.12.42']);
  });

  it('through the engine: an empty answer after a good one removes the routes', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '172.16.12.41']);
    await h.settle();
    h.take();

    h.scheduler.advance(REFRESH_MS);
    await answer(h, []);
    const outcome = await h.settle();

    expect(h.take()).toEqual(['delete 172.16.12.40', 'delete 172.16.12.41']);
    expect(stateOf(outcome)).toMatchObject({ status: 'error', reasonCode: 'no-addresses', appliedDestinations: [] });
  });

  it('evicts nothing while lookups fail, and does not count failures as "seen"', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40', '172.16.12.41']);
    await refresh(h, ['172.16.12.41']);

    // Five intervals of failures: `.40` was last seen six intervals ago, and is still there.
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, 5 * REFRESH_MS, 60_000);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({
      destinations: ['172.16.12.40', '172.16.12.41'],
      reasonCode: 'resolve-failed',
    });

    // The first answer after the outage decides: `.40` has been absent for far too long.
    h.dns.auto = () => ['172.16.12.41'];
    await pass(h, REFRESH_MS, 60_000);
    expect(h.service.resolveDomain(DOMAIN)).toMatchObject({ destinations: ['172.16.12.41'], status: 'active' });
  });

  it('through the engine: overlapping answers cause no route churn, and an address absent too long is removed', async () => {
    const h = withEngine([DOMAIN]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40', '172.16.12.41']);
    await h.settle();
    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`, `add 172.16.12.41 ${ETH_GW}`]);

    const rotation = [
      ['172.16.12.41', '172.16.12.42'],
      ['172.16.12.42', '172.16.12.40'],
      ['172.16.12.40', '172.16.12.41'],
      ['172.16.12.41', '172.16.12.42'],
    ];
    const commands: string[] = [];
    for (const records of rotation) {
      h.scheduler.advance(REFRESH_MS);
      await answer(h, records);
      await h.settle();
      commands.push(...h.take());
    }
    // The third address is added once; nothing is ever deleted and added back.
    expect(commands).toEqual([`add 172.16.12.42 ${ETH_GW}`]);

    // The name settles on one address: the others go when they have been absent for more than three intervals.
    for (let turn = 0; turn < 4; turn += 1) {
      h.scheduler.advance(REFRESH_MS);
      await answer(h, ['172.16.12.42']);
      await h.settle();
      commands.push(...h.take());
    }
    expect(commands.slice(1).sort()).toEqual(['delete 172.16.12.40', 'delete 172.16.12.41']);
    expect(h.engine.getApplied().map((route) => route.dst)).toEqual(['172.16.12.42']);
  });
});

// ---------------------------------------------------------------------------
// Fixes from the QA verdict of TASK-110
// ---------------------------------------------------------------------------

describe('QA reproductions', () => {
  it('announces B again after A -> B -> A -> B when no pass asked in between', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    h.service.resolveDomain(DOMAIN);
    expect(h.reconciles).toHaveLength(1);

    // A (active) -> B (error): announced. The pass it asked for did not get to the rule.
    h.scheduler.advance(REFRESH_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toHaveLength(2);

    // B -> A: what the engine has. Nothing to announce.
    h.scheduler.advance(RETRY_FLOOR_MS);
    await answer(h, ['172.16.12.40']);
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toHaveLength(2);

    // A -> B again: the engine still believes A, so it has to be told.
    h.scheduler.advance(REFRESH_MS);
    await fail(h, 'ESERVFAIL');
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);
    expect(h.reconciles).toHaveLength(3);
  });

  it('does not ask for a reconcile after the config lost its last domain rule', async () => {
    const h = setup();
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    expect(h.scheduler.delays()).toEqual([RECONCILE_DEBOUNCE_MS, REFRESH_MS]);

    h.service.syncConfig(config([]));

    expect(h.scheduler.pending()).toBe(0);
    h.scheduler.advance(REFRESH_MS);
    expect(h.reconciles).toEqual([]);
  });

  it('still asks when other domains remain', async () => {
    const h = setup();
    const other = domainRule(6, 'other.corp.local');
    await resolveFirst(h, DOMAIN, ['172.16.12.40']);
    await resolveFirst(h, other, ['172.16.12.50']);

    h.service.syncConfig(config([other]));
    h.scheduler.advance(RECONCILE_DEBOUNCE_MS);

    expect(h.reconciles).toEqual(['dns-refresh']);
  });

  it('keeps one dead server from holding every slot', () => {
    const h = setup();
    const dead = Array.from({ length: 10 }, (_unused, index) =>
      domainRule(index + 1, `host-${String(index)}.corp.local`, { dns: '10.20.0.10' }),
    );
    const alive = domainRule(50, 'alive.corp.local', { dns: '10.20.0.11' });

    for (const rule of [...dead, alive]) h.service.resolveDomain(rule);

    expect(h.dns.open().map((lookup) => lookup.servers?.[0])).toEqual([
      '10.20.0.10',
      '10.20.0.10',
      '10.20.0.10',
      '10.20.0.10',
      '10.20.0.11',
    ]);
    expect(h.service.stats()).toMatchObject({ inFlight: 5, queued: 6 });

    // Once its names are known to fail, the dead server gets two slots, not four.
    for (let round = 0; round < 6; round += 1) h.scheduler.advance(LOOKUP_TIMEOUT_MS);
    expect(h.dns.open().filter((lookup) => lookup.servers?.[0] === '10.20.0.10').length).toBeLessThanOrEqual(
      MAX_FAILING_LOOKUPS_PER_SERVER_SET,
    );
  });

  it('lets a name that answers refresh ahead of names that have never answered', async () => {
    const h = setup();
    const healthy = domainRule(900, 'healthy.corp.local', { refreshSec: 60 });
    h.dns.auto = (hostname) => (hostname === 'healthy.corp.local' ? ['172.16.12.40'] : undefined);
    h.service.resolveDomain(healthy);
    await flush();
    // 100 new names that hang: 125 s of queue at four lookups per five seconds.
    for (let index = 0; index < 100; index += 1) h.service.resolveDomain(domainRule(index + 1, `host-${String(index)}.corp.local`));

    for (let second = 0; second < 66; second += 1) {
      h.scheduler.advance(1000);
      await flush(4);
    }

    // Due at 60 s, it took the first slot that came free instead of the end of the queue.
    expect(h.dns.lookups.filter((lookup) => lookup.hostname === 'healthy.corp.local')).toHaveLength(2);
    expect(h.service.stats().queued).toBeGreaterThan(40);
  });

  it('refreshes a healthy name on time next to 499 names that hang on the same server', async () => {
    const h = setup();
    const hanging = Array.from({ length: 499 }, (_unused, index) =>
      domainRule(index + 1, `host-${String(index)}.corp.local`, { refreshSec: 60 }),
    );
    const healthy = domainRule(900, 'healthy.corp.local', { refreshSec: 60 });
    h.dns.auto = (hostname) => (hostname === 'healthy.corp.local' ? ['172.16.12.40'] : undefined);
    // The healthy one is asked about last: the worst place in the queue.
    for (const rule of [...hanging, healthy]) h.service.resolveDomain(rule);

    let mostInFlight = 0;
    for (let second = 0; second < 3600; second += 1) {
      h.scheduler.advance(1000);
      await flush(4);
      mostInFlight = Math.max(mostInFlight, h.service.stats().inFlight);
    }

    const refreshes = h.dns.lookups.filter((lookup) => lookup.hostname === 'healthy.corp.local').length;
    // An hour at one refresh a minute. Before: 12, because every slot was held by a hanging lookup.
    expect(refreshes).toBeGreaterThanOrEqual(50);
    expect(refreshes).toBeLessThanOrEqual(61);
    expect(mostInFlight).toBeLessThanOrEqual(MAX_LOOKUPS_PER_SERVER_SET);
    expect(h.service.resolveDomain(healthy)).toMatchObject({ status: 'active', destinations: ['172.16.12.40'] });
  });

  it('keeps the code and the detail in the reason of a rule with a very long domain', async () => {
    const label = 'a'.repeat(63);
    const long = `${label}.${label}.${label}.${'b'.repeat(61)}`;
    expect(long).toHaveLength(253);
    const rule = domainRule(5, long, { refreshSec: 60 });
    const facts = context(['10.20.0.10']);
    const reasons: string[] = [];
    const h = setup({ systemServers: () => ['192.0.2.53'] });
    const note = (): void => {
      reasons.push(h.service.resolveDomain(rule, facts).reason ?? '');
    };

    h.service.resolveDomain(rule, facts);
    note();
    await fail(h, 'ESERVFAIL');
    note();
    h.scheduler.advance(RETRY_FLOOR_MS);
    await answer(h, ['192.0.2.53', '127.0.0.1', '0.0.0.0', '224.0.0.1', '169.254.1.1', '255.255.255.255', 'x', ...block(30, 40)]);
    note();
    h.scheduler.advance(60_000);
    await answer(h, block(30, 40));
    note();
    h.scheduler.advance(60_000);
    await answer(h, ['192.0.2.53']);
    note();
    h.scheduler.advance(60_000);
    await answer(h, ['172.16.12.40']);
    h.dns.auto = () => dnsError('ECONNREFUSED');
    await pass(h, 120_000);
    note();
    await pass(h, STALE_FLOOR_MS);
    note();

    expect(reasons.map((reason) => reason.slice(reason.indexOf('…') + 1))).toEqual([
      '',
      ': the DNS lookup failed (ESERVFAIL); if only an internal server knows the name, set `dns` in the rule',
      ' must never be routed (dns-server: 1, loopback: 1, default-route: 1, multicast: 1, link-local: 1, broadcast: 1, invalid-ipv4: 1); 40 addresses, the 32 lowest are routed',
      ' has 40 addresses; the 32 lowest are routed',
      ' has no usable A records: 1 address must never be routed (dns-server: 1)',
      ': the DNS lookup failed (ECONNREFUSED); the last known 1 address stay routed; if only an internal server knows the name, set `dns` in the rule',
      ': the DNS lookup failed (ECONNREFUSED); the last known addresses expired after 60 min without an answer; if only an internal server knows the name, set `dns` in the rule',
    ]);
    expect(reasons.every((reason) => reason.length <= PROTOCOL_LIMITS.reasonMaxLength)).toBe(true);
    expect(reasons.every((reason) => reason.includes(`${long.slice(0, 79)}…`))).toBe(true);
  });

  it('never writes a resolved address into the log', async () => {
    const h = setup({ systemServers: () => ['192.0.2.53'] });
    const rule = domainRule(5, 'corp.local', { refreshSec: 60 });
    const answers = [
      ['198.51.100.40', '198.51.100.41'],
      ['198.51.100.41', '198.51.100.42', '127.0.0.1', '192.0.2.53'],
      Array.from({ length: 40 }, (_unused, index) => `198.51.100.${String(100 + index)}`),
      [],
      ['198.51.100.43'],
    ];
    h.service.resolveDomain(rule, context(['10.20.0.10']));
    for (const records of answers) {
      await answer(h, records);
      h.scheduler.advance(60_000);
    }
    h.dns.auto = () => dnsError('ESERVFAIL');
    await pass(h, STALE_FLOOR_MS + 120_000, 60_000);
    h.service.refreshAll();
    h.service.syncConfig(config([]));

    const text = JSON.stringify(h.entries);
    // Every kind of line was written ...
    for (const msg of [
      'domain resolved',
      'resolved addresses refused; they are never routed',
      'more addresses than the per-domain limit; the lowest are routed',
      'domain lookup failed',
      'no answer for too long; the last known addresses are dropped',
      'resolving every domain again',
      'domains no longer resolved',
    ]) {
      expect(text).toContain(`"msg":"${msg}"`);
    }
    // ... and none of them carries an address that came out of an answer. (The servers asked are there on purpose.)
    expect(text).not.toMatch(/198\.51\.100\.|127\.0\.0\.1|192\.0\.2\.53/);
    expect(text).toContain('10.20.0.10');
  });

  it('through the engine: a rule that is disabled or removed stops being resolved without anyone calling `syncConfig`', async () => {
    const other = domainRule(6, 'other.corp.local');
    const h = withEngine([DOMAIN, other]);
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await answer(h, ['172.16.12.50']);
    await h.settle();
    h.take();

    h.engine.setConfig(config([{ ...DOMAIN, enabled: false }]));
    await h.engine.reconcile('config-change');
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.take().sort()).toEqual(['delete 172.16.12.40', 'delete 172.16.12.50']);
    expect(h.dns.lookups).toHaveLength(2);
    expect(h.service.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });

    // The same for the global toggle.
    h.engine.setConfig(config([DOMAIN]));
    await h.engine.reconcile('config-change');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.engine.setEnabled(false);
    await h.engine.reconcile('enabled-change');
    h.scheduler.advance(REFRESH_MS * 3);

    expect(h.dns.lookups).toHaveLength(3);
    expect(h.scheduler.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rejection 1: interface DNS servers are never routed, in any pass mode
// ---------------------------------------------------------------------------

describe('the DNS servers of the interfaces are never routed from an answer', () => {
  type Reported = NonNullable<DetectedInterfaces['dnsServers']>;
  const detection = (dnsServers: Reported, degraded = false): DetectedInterfaces => ({ ...NETWORK, degraded, dnsServers });
  const viaWifiWithDns = domainRule(5, 'corp.local', { iface: 'wifi', dns: '198.51.100.53' });
  const WIFI_GW = '192.168.1.1';

  it('for a config whose only domain rule names its own server (QA scenario i)', async () => {
    const network = { current: detection({ ethernet: ['10.20.4.53'], wifi: ['192.168.1.1'] }) };
    const h = withEngine([viaWifiWithDns], { network });
    await h.engine.reconcile('startup');

    // The answer contains the DHCP DNS server of Ethernet.
    await answer(h, ['10.20.4.53', '172.16.12.40']);
    const outcome = await h.settle();

    expect(h.dns.lookups[0]?.servers).toEqual(['198.51.100.53']);
    // The rule's own server is routed (TASK-111): it is not the server of an interface.
    expect(h.take()).toEqual([`add 198.51.100.53 ${WIFI_GW}`, `add 172.16.12.40 ${WIFI_GW}`]);
    expect(stateOf(outcome)).toMatchObject({
      reasonCode: 'dns-server-excluded',
      appliedDestinations: ['198.51.100.53', '172.16.12.40'],
    });
  });

  it('when the detection is never clean and is accepted as it is (QA scenario ii)', async () => {
    const network = { current: detection({ ethernet: ['10.20.9.53'], wifi: ['192.168.1.1'] }, true) };
    const h = withEngine([viaWifiWithDns], { network });

    await h.engine.reconcile('startup');
    await answer(h, ['10.20.9.53', '172.16.12.40']);
    // Held, held, accepted: the third pass adds routes on a detection that was never trusted.
    await h.engine.reconcile('network-change');
    expect(h.take()).toEqual([]);
    const accepted = await h.engine.reconcile('network-change');

    expect(h.take()).toEqual([`add 198.51.100.53 ${WIFI_GW}`, `add 172.16.12.40 ${WIFI_GW}`]);
    expect(stateOf(accepted)).toMatchObject({
      reasonCode: 'dns-server-excluded',
      appliedDestinations: ['198.51.100.53', '172.16.12.40'],
    });
  });

  it('for a server an interface got while no domain rule existed (QA scenario iii)', async () => {
    const network = { current: detection({ ethernet: ['10.20.0.10'], wifi: ['192.168.1.1'] }) };
    const host: Rule = { id: ruleId(1), enabled: true, kind: 'ip', target: '172.16.12.99', iface: 'ethernet', refreshSec: 600 };
    const h = withEngine([DOMAIN, host], { network });
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    // The domain rule goes; the interface moves to a network with another DNS server; the rule comes back.
    h.engine.setConfig(config([host]));
    await h.engine.reconcile('config-change');
    network.current = detection({ ethernet: ['10.30.0.10'], wifi: ['192.168.1.1'] });
    h.engine.setConfig(config([viaWifiWithDns, host]));
    await h.engine.reconcile('config-change');
    h.take();
    await answer(h, ['10.30.0.10', '10.20.0.10', '172.16.12.41']);
    const outcome = await h.settle();

    // The new server is excluded; the old one is an ordinary address again.
    expect(h.take()).toEqual([`add 10.20.0.10 ${WIFI_GW}`, `add 172.16.12.41 ${WIFI_GW}`]);
    expect(stateOf(outcome).reason).toBe('1 resolved address of corp.local is a DNS server and never routed');
  });

  it('keeps excluding what untrusted detections reported until a clean one says otherwise', async () => {
    const network = { current: detection({ ethernet: ['10.20.0.10'], wifi: ['192.168.1.1'] }) };
    const h = withEngine([viaWifiWithDns], { network });
    await h.engine.reconcile('startup');
    await answer(h, ['10.20.9.53', '172.16.12.40']);
    await h.settle();
    // Not a DNS server as far as anyone knows: routed (after the rule's own server).
    expect(h.take()).toEqual([`add 198.51.100.53 ${WIFI_GW}`, `add 10.20.9.53 ${WIFI_GW}`, `add 172.16.12.40 ${WIFI_GW}`]);

    // A degraded detection reports it as Ethernet's server. Nothing is deleted on a held pass ...
    network.current = detection({ ethernet: ['10.20.9.53'], wifi: null }, true);
    await h.engine.reconcile('network-change');
    expect(h.take()).toEqual([]);
    network.current = detection({ ethernet: ['10.20.9.53'], wifi: null }, true);
    await h.engine.reconcile('network-change');
    // ... and on the accepted one the route goes, although that detection is not trusted for anything else.
    network.current = detection({ ethernet: ['10.20.9.53'], wifi: null }, true);
    await h.engine.reconcile('network-change');
    expect(h.take()).toEqual(['delete 10.20.9.53']);

    // A clean detection that no longer reports it releases the address.
    network.current = detection({ ethernet: ['10.20.0.10'], wifi: ['192.168.1.1'] });
    await h.engine.reconcile('network-change');
    expect(h.take()).toEqual([`add 10.20.9.53 ${WIFI_GW}`]);
  });

  it('keeps excluding the server it asks after eight untrusted detections reported others (QA verdict 2)', async () => {
    const viaEthernet = domainRule(5, 'a.corp.local');
    const viaWifi = domainRule(6, 'b.corp.local', { iface: 'wifi', dns: '10.77.0.53' });
    const network = { current: detection({ ethernet: ['10.20.9.53'], wifi: ['192.168.1.1'] }) };
    const answers = new Map<string, readonly string[]>([
      ['a.corp.local', ['172.16.12.40']],
      ['b.corp.local', ['172.16.12.50']],
    ]);
    const h = withEngine([viaEthernet, viaWifi], { network });
    h.dns.auto = (hostname) => answers.get(hostname);
    await h.engine.reconcile('startup');
    await flush();
    await h.settle();
    expect(h.take()).toEqual([`add 10.77.0.53 ${WIFI_GW}`, `add 172.16.12.40 ${ETH_GW}`, `add 172.16.12.50 ${WIFI_GW}`]);

    // Eight degraded detections, each with another Ethernet DNS server: more than the cap of the remembered ones.
    for (let index = 1; index <= MAX_EXCLUDED_DNS_PER_ROLE; index += 1) {
      network.current = detection({ ethernet: [`10.66.0.${String(index)}`], wifi: ['192.168.1.1'] }, true);
      await h.engine.reconcile('network-change');
    }
    h.take();

    // The trusted server is still the one asked, and its own address in the answer is not routed.
    answers.set('a.corp.local', ['10.20.9.53', '198.51.100.7']);
    h.scheduler.advance(REFRESH_MS);
    await flush();
    const outcome = await h.settle();

    expect(h.dns.lookups.filter((lookup) => lookup.hostname === 'a.corp.local').map((lookup) => lookup.servers)).toEqual([
      ['10.20.9.53'],
      ['10.20.9.53'],
    ]);
    const calls = h.take();
    expect(calls).toContain(`add 198.51.100.7 ${ETH_GW}`);
    expect(calls.filter((call) => call.startsWith('add 10.20.9.53'))).toEqual([]);
    expect(stateOf(outcome)).toMatchObject({ reasonCode: 'dns-server-excluded' });
    expect(stateOf(outcome).appliedDestinations).not.toContain('10.20.9.53');
  });
});

describe('every DNS server of the system (scutil --dns)', () => {
  const viaEthernet = domainRule(5, 'a.corp.local');

  it('asks all servers of the interface in order and never routes a server of a supplemental resolver', async () => {
    const network = {
      current: {
        ...NETWORK,
        dnsServers: { ethernet: ['10.20.0.10', '10.20.0.11'], wifi: ['192.168.1.1'] },
        otherDnsServers: ['10.30.0.53', '10.30.0.54'],
      } satisfies DetectedInterfaces,
    };
    const h = withEngine([viaEthernet], { network });
    h.dns.auto = () => ['10.30.0.54', '10.20.0.11', '172.16.12.40'];

    await h.engine.reconcile('startup');
    await flush();
    const outcome = await h.settle();

    // Both servers, in order: the resolver falls back to the second one when the first does not answer.
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10', '10.20.0.11']]);
    expect(h.take()).toEqual([`add 172.16.12.40 ${ETH_GW}`]);
    expect(stateOf(outcome)).toMatchObject({
      reasonCode: 'dns-server-excluded',
      reason: '2 resolved addresses of a.corp.local are DNS servers and never routed',
      appliedDestinations: ['172.16.12.40'],
    });
  });
});

describe('the whole exclusion list is read (TASK-DELTA-06 QA verdict 1)', () => {
  const range = (prefix: string, length: number): string[] =>
    Array.from({ length }, (_unused, index) => `${prefix}.${String(index + 1)}`);

  it('never routes the last server of the longest list the engine makes', async () => {
    const viaEthernet = domainRule(5, 'a.corp.local');
    const viaWifi = domainRule(6, 'b.corp.local', { iface: 'wifi' });
    const OTHERS = range('10.5.0', MAX_EXCLUDED_OTHER_DNS);
    const LAST = OTHERS.at(-1) ?? '';
    // A clean detection: 8 servers per role (asked) and 32 others ...
    const network = {
      current: {
        ...NETWORK,
        dnsServers: { ethernet: range('10.1.0', MAX_EXCLUDED_DNS_PER_ROLE), wifi: range('10.2.0', MAX_EXCLUDED_DNS_PER_ROLE) },
        otherDnsServers: OTHERS,
      } satisfies DetectedInterfaces as DetectedInterfaces,
    };
    const contexts: DomainContext[] = [];
    const h = withEngine([viaEthernet, viaWifi], {
      network,
      wrap: (service) => (rule, context) => {
        contexts.push(context);
        return service.resolveDomain(rule, context);
      },
    });
    const answers = new Map<string, readonly string[]>([
      ['a.corp.local', ['172.16.12.40']],
      ['b.corp.local', ['172.16.12.50']],
    ]);
    h.dns.auto = (hostname) => answers.get(hostname);
    await h.engine.reconcile('startup');
    await flush();
    await h.settle();
    h.take();

    // ... then untrusted ones that report 8 more per role and cannot read the rest: remembered on top.
    for (let pass = 0; pass < 3; pass += 1) {
      network.current = {
        ...NETWORK,
        degraded: true,
        dnsServers: { ethernet: range('10.3.0', MAX_EXCLUDED_DNS_PER_ROLE), wifi: range('10.4.0', MAX_EXCLUDED_DNS_PER_ROLE) },
        otherDnsServers: null,
      };
      await h.engine.reconcile('network-change');
    }
    h.take();
    const list = contexts.at(-1)?.interfaceDnsServers ?? [];
    expect(list).toHaveLength(MAX_EXCLUDED_DNS_SERVERS);
    expect(list.at(-1)).toBe(LAST);

    // The answer names the 64th server: it is excluded, the other address is routed.
    answers.set('a.corp.local', [LAST, '198.51.100.7']);
    h.scheduler.advance(REFRESH_MS);
    await flush();
    const outcome = await h.settle();

    const calls = h.take();
    expect(calls).toContain(`add 198.51.100.7 ${ETH_GW}`);
    expect(calls.filter((call) => call.includes(LAST))).toEqual([]);
    expect(stateOf(outcome)).toMatchObject({ reasonCode: 'dns-server-excluded' });
    expect(stateOf(outcome).appliedDestinations).not.toContain(LAST);
  });
});

describe('a rule without `dns` and an unreliable detection', () => {
  const detection = (ethernet: readonly string[] | null, degraded = false): DetectedInterfaces => ({
    ...NETWORK,
    degraded,
    dnsServers: { ethernet, wifi: ['192.168.1.1'] },
  });

  it('asks nobody on the first, degraded passes and its interface\'s server once a clean detection knows it', async () => {
    const network = { current: detection(['10.20.0.10'], true) };
    const h = withEngine([DOMAIN], { network });

    const held = await h.engine.reconcile('startup');

    expect(h.dns.created).toBe(0);
    expect(stateOf(held)).toMatchObject({
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Waiting for the DNS server of the ethernet interface to be known',
    });
    expect(h.logs('warn')).toEqual([]);

    network.current = detection(['10.20.0.10']);
    await h.engine.reconcile('network-change');

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10']]);
  });

  it('stops waiting when the degraded detection is accepted, and then asks the system resolvers with the warning', async () => {
    const network = { current: detection(['10.20.0.10'], true) };
    const h = withEngine([DOMAIN], { network });

    for (let pass = 0; pass < 2; pass += 1) {
      await h.engine.reconcile('startup');
      network.current = detection(['10.20.0.10'], true);
    }
    expect(h.dns.created).toBe(0);
    await h.engine.reconcile('startup');

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([null]);
    expect(h.logs('warn', 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toHaveLength(1);
  });

  it('keeps its addresses and routes through a lease that has no DNS server for a moment', async () => {
    const network = { current: detection(['10.20.0.10']) };
    const h = withEngine([DOMAIN], { network });
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    // A DHCP renewal: two detections in a row report no server, then it is back.
    for (let blip = 0; blip < 2; blip += 1) {
      network.current = detection([]);
      const during = await h.engine.reconcile('network-change');
      expect(stateOf(during)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    }
    network.current = detection(['10.20.0.10']);
    await h.engine.reconcile('network-change');

    expect(h.take()).toEqual([]);
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.logs('warn')).toEqual([]);
  });

  it('follows a lease that has really lost its DNS server, on the third detection that says so', async () => {
    const network = { current: detection(['10.20.0.10']) };
    const h = withEngine([DOMAIN], { network });
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    for (let report = 0; report < 3; report += 1) {
      network.current = detection([]);
      await h.engine.reconcile('network-change');
    }

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.20.0.10'], null]);
    expect(h.take()).toEqual(['delete 172.16.12.40']);
    expect(h.logs('warn', 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toHaveLength(1);
  });

  it('keeps asking the server it knows when a later lookup of the interface\'s server fails', async () => {
    const network = { current: detection(['10.20.0.10']) };
    const h = withEngine([DOMAIN], { network });
    await h.engine.reconcile('startup');
    await answer(h, ['172.16.12.40']);
    await h.settle();
    h.take();

    network.current = detection(null);
    const outcome = await h.engine.reconcile('network-change');

    expect(stateOf(outcome)).toMatchObject({ status: 'active', appliedDestinations: ['172.16.12.40'] });
    expect(h.take()).toEqual([]);
    expect(h.dns.lookups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rejection 1: a new name is not starved by refreshes
// ---------------------------------------------------------------------------

describe('the slot reserved for names that have not answered', () => {
  /** Answers every open lookup `latencyMs` after it started, stepping the clock by 500 ms. */
  const started = new WeakMap<object, number>();
  const simulate = async (h: Harness, ms: number, latencyMs: number, records: (hostname: string) => unknown): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      const at = h.scheduler.now().getTime();
      for (const lookup of h.dns.open()) {
        const since = started.get(lookup);
        if (since === undefined) started.set(lookup, at);
        else if (at - since >= latencyMs) lookup.answer(records(lookup.hostname));
      }
      await flush(6);
      h.scheduler.advance(500);
    }
  };

  it('gets a new name looked up while refreshes of answering names would fill every slot (QA case)', async () => {
    const h = setup();
    // 100 names, a refresh a minute, 2.5 s per answer: 250 s of lookups per minute for 4 slots (240 s).
    const busy = Array.from({ length: 100 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`, { refreshSec: 60 }));
    for (const rule of busy) h.service.resolveDomain(rule);
    await simulate(h, 600_000, 2500, () => ['172.16.12.40']);
    expect(h.service.stats()).toMatchObject({ inFlight: 4 });
    expect(busy.every((rule) => h.service.resolveDomain(rule).status === 'active')).toBe(true);

    const newcomer = domainRule(900, 'new.corp.local', { refreshSec: 60 });
    h.service.resolveDomain(newcomer);
    const askedAt = h.scheduler.now().getTime();
    let firstLookupAfter: number | null = null;
    for (let step = 0; step < 60 && firstLookupAfter === null; step += 1) {
      await simulate(h, 500, 2500, () => ['172.16.12.40']);
      if (h.dns.lookups.some((lookup) => lookup.hostname === 'new.corp.local')) {
        firstLookupAfter = h.scheduler.now().getTime() - askedAt;
      }
    }

    // Before: never (0 lookups in 30 minutes). Now: as soon as one of the four lookups in flight ends.
    expect(firstLookupAfter).not.toBeNull();
    expect(firstLookupAfter ?? 0).toBeLessThanOrEqual(3000);
    await simulate(h, 5000, 2500, () => ['172.16.12.40']);
    expect(h.service.resolveDomain(newcomer)).toMatchObject({ status: 'active' });
  });

  it('is one slot per server set, and is not held when no such name waits', async () => {
    const h = setup();
    const answering = Array.from({ length: 8 }, (_unused, index) => domainRule(index + 1, `host-${String(index)}.corp.local`, { refreshSec: 60 }));
    h.dns.auto = () => ['172.16.12.40'];
    for (const rule of answering) h.service.resolveDomain(rule);
    await flush();
    h.dns.auto = null;

    // All eight are due together; no new name waits: the refreshes use all four slots.
    h.scheduler.advance(60_000);
    expect(h.dns.open()).toHaveLength(4);
    expect(h.dns.open().every((lookup) => lookup.hostname.startsWith('host-'))).toBe(true);

    // Two new names arrive. When slots come free, one goes to a new name; the other new name waits its turn.
    h.service.resolveDomain(domainRule(900, 'new-a.corp.local'));
    h.service.resolveDomain(domainRule(901, 'new-b.corp.local'));
    await answer(h, ['172.16.12.40']);
    await answer(h, ['172.16.12.40']);

    const open = h.dns.open().map((lookup) => lookup.hostname);
    expect(open).toHaveLength(4);
    expect(open.filter((hostname) => hostname.startsWith('new-'))).toEqual(['new-a.corp.local']);
  });
});

