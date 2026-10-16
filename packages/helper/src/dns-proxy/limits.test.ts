import { describe, expect, it } from 'vitest';

import {
  BIND_RETRY_FIRST_MS,
  CNAME_BINDING_MAX_TTL_SEC,
  CNAME_BINDING_MIN_TTL_SEC,
  MAX_CNAME_BINDINGS,
  cnameBindingTtlSec,
  createCnameBindings,
  BIND_RETRY_MAX_MS,
  LEARN_WAIT_MS,
  MAX_CONCURRENT_UPSTREAM,
  MAX_QUERIES_PER_TCP_CONNECTION,
  MAX_QUERY_BYTES,
  MAX_TCP_CONNECTIONS,
  MAX_TCP_RESPONSE_BYTES,
  MAX_UDP_RESPONSE_BYTES,
  MAX_UPSTREAM_SERVERS,
  RATE_BURST,
  RATE_PER_SECOND,
  TCP_IDLE_MS,
  UPSTREAM_SERVER_TIMEOUT_MS,
  UPSTREAM_TOTAL_TIMEOUT_MS,
  bindRetryDelay,
  createTokenBucket,
  isLoopbackSource,
} from './limits';

describe('limits (ADR-002 §5)', () => {
  it('pins every number ADR-002 fixes', () => {
    expect({
      MAX_QUERY_BYTES,
      MAX_UDP_RESPONSE_BYTES,
      MAX_TCP_RESPONSE_BYTES,
      MAX_CONCURRENT_UPSTREAM,
      RATE_PER_SECOND,
      RATE_BURST,
      MAX_TCP_CONNECTIONS,
      TCP_IDLE_MS,
      MAX_QUERIES_PER_TCP_CONNECTION,
      UPSTREAM_SERVER_TIMEOUT_MS,
      UPSTREAM_TOTAL_TIMEOUT_MS,
      MAX_UPSTREAM_SERVERS,
      LEARN_WAIT_MS,
      BIND_RETRY_FIRST_MS,
      BIND_RETRY_MAX_MS,
    }).toEqual({
      MAX_QUERY_BYTES: 1232,
      MAX_UDP_RESPONSE_BYTES: 4096,
      MAX_TCP_RESPONSE_BYTES: 65_535,
      MAX_CONCURRENT_UPSTREAM: 64,
      RATE_PER_SECOND: 200,
      RATE_BURST: 400,
      MAX_TCP_CONNECTIONS: 16,
      TCP_IDLE_MS: 10_000,
      MAX_QUERIES_PER_TCP_CONNECTION: 32,
      UPSTREAM_SERVER_TIMEOUT_MS: 2_000,
      UPSTREAM_TOTAL_TIMEOUT_MS: 5_000,
      MAX_UPSTREAM_SERVERS: 3,
      LEARN_WAIT_MS: 1_500,
      BIND_RETRY_FIRST_MS: 5_000,
      BIND_RETRY_MAX_MS: 300_000,
    });
  });
});

describe('bindRetryDelay', () => {
  it('starts at 5 s, doubles, and stops at 5 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100, 10_000].map(bindRetryDelay)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
    ]);
  });

  it('treats zero or negative failures as the first', () => {
    expect(bindRetryDelay(0)).toBe(5_000);
    expect(bindRetryDelay(-3)).toBe(5_000);
  });
});

describe('createTokenBucket', () => {
  const takeAll = (bucket: { take(): boolean }, count: number): number => {
    let taken = 0;
    for (let i = 0; i < count; i += 1) if (bucket.take()) taken += 1;
    return taken;
  };

  it('allows a burst of exactly 400, then nothing without time passing', () => {
    const now = 0;
    const bucket = createTokenBucket(() => now);
    expect(takeAll(bucket, 1000)).toBe(400);
    expect(bucket.take()).toBe(false);
  });

  it('refills at 200 a second, never above the burst', () => {
    let now = 0;
    const bucket = createTokenBucket(() => now);
    takeAll(bucket, 400);
    now = 1000;
    expect(takeAll(bucket, 1000)).toBe(200);
    now = 1004;
    expect(bucket.take()).toBe(false);
    now = 1005;
    expect(bucket.take()).toBe(true);
  });

  it('holds 200/s sustained over ten seconds', () => {
    let now = 0;
    const bucket = createTokenBucket(() => now);
    takeAll(bucket, 400);
    let taken = 0;
    for (let ms = 1; ms <= 10_000; ms += 1) {
      now = ms;
      taken += takeAll(bucket, 5);
    }
    expect(taken).toBe(2000);
  });

  it('caps the refill after a long pause at the burst', () => {
    let now = 0;
    const bucket = createTokenBucket(() => now);
    takeAll(bucket, 400);
    now = 3_600_000;
    expect(takeAll(bucket, 1000)).toBe(400);
  });

  it('gains nothing from a clock that goes backwards', () => {
    let now = 10_000;
    const bucket = createTokenBucket(() => now);
    takeAll(bucket, 400);
    now = 0;
    expect(bucket.take()).toBe(false);
    now = 10_000;
    expect(bucket.take()).toBe(false);
    now = 10_005;
    expect(bucket.take()).toBe(true);
  });
});

describe('isLoopbackSource', () => {
  it.each(['127.0.0.1', '127.255.0.9', '::ffff:127.0.0.1', '::FFFF:127.0.0.2'])('accepts %s', (address) => {
    expect(isLoopbackSource(address)).toBe(true);
  });

  it.each([undefined, '', '10.0.0.1', '128.0.0.1', '::1', '127.0.0', '127.0.0.256', '127.0.0.1.5', '127.a.0.1', '::ffff:10.0.0.1', '1127.0.0.1'])(
    'rejects %s',
    (address) => {
      expect(isLoopbackSource(address)).toBe(false);
    },
  );
});

describe('CNAME bindings (TASK-DELTA-41)', () => {
  const RULE = { ruleId: 'r1', source: 'www.corp.local' };
  const clock = () => {
    let now = 0;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('pins the bounds: 256 bindings, 60 s … 1 day', () => {
    expect(MAX_CNAME_BINDINGS).toBe(256);
    expect(CNAME_BINDING_MIN_TTL_SEC).toBe(60);
    expect(CNAME_BINDING_MAX_TTL_SEC).toBe(86_400);
    expect([0, 59, 60, 300, 86_400, 86_401, 0x7fff_ffff, -5, Number.NaN, Number.POSITIVE_INFINITY].map(cnameBindingTtlSec)).toEqual([
      60, 60, 60, 300, 86_400, 86_400, 86_400, 60, 60, 60,
    ]);
  });

  it('a binding lives exactly its clamped TTL, and an expired one is gone', () => {
    const c = clock();
    const bindings = createCnameBindings(c.now);
    bindings.bind('corp.local', RULE, 120);
    c.advance(119_999);
    expect(bindings.get('corp.local')).toEqual(RULE);
    c.advance(1);
    expect(bindings.get('corp.local')).toBeNull();
    expect(bindings.size()).toBe(0);
    expect(bindings.get('other.corp.local')).toBeNull();
  });

  it('a newer binding of the same target replaces the older one (rule and lifetime)', () => {
    const c = clock();
    const bindings = createCnameBindings(c.now);
    bindings.bind('corp.local', RULE, 86_400);
    bindings.bind('corp.local', { ruleId: 'r2', source: 'mail.corp.local' }, 60);
    expect(bindings.size()).toBe(1);
    c.advance(60_000);
    expect(bindings.get('corp.local')).toBeNull();
  });

  it(`holds at most ${String(MAX_CNAME_BINDINGS)}: expired ones go first, then the least recently used`, () => {
    const c = clock();
    const bindings = createCnameBindings(c.now);
    for (let i = 0; i < MAX_CNAME_BINDINGS; i += 1) bindings.bind(`n${String(i)}.corp.local`, RULE, i === 5 ? 60 : 3_600);
    expect(bindings.size()).toBe(MAX_CNAME_BINDINGS);
    // n5 expires; one more evicts it, not n0.
    c.advance(60_000);
    bindings.bind('extra1.corp.local', RULE, 3_600);
    expect(bindings.size()).toBe(MAX_CNAME_BINDINGS);
    expect(bindings.get('n0.corp.local')).toEqual(RULE);
    // n0 was just used: the next one evicts n1, the least recently used.
    bindings.bind('extra2.corp.local', RULE, 3_600);
    expect(bindings.size()).toBe(MAX_CNAME_BINDINGS);
    expect(bindings.get('n1.corp.local')).toBeNull();
    expect(bindings.get('n0.corp.local')).toEqual(RULE);
    expect(bindings.get('extra1.corp.local')).toEqual(RULE);
    expect(bindings.get('extra2.corp.local')).toEqual(RULE);
    // A flood never grows it.
    for (let i = 0; i < 10_000; i += 1) bindings.bind(`flood${String(i)}.corp.local`, RULE, 3_600);
    expect(bindings.size()).toBe(MAX_CNAME_BINDINGS);
  });

  it('delete and clear', () => {
    const bindings = createCnameBindings(() => 0);
    bindings.bind('a.corp.local', RULE, 300);
    bindings.bind('b.corp.local', RULE, 300);
    bindings.delete('a.corp.local');
    expect(bindings.get('a.corp.local')).toBeNull();
    expect(bindings.size()).toBe(1);
    bindings.clear();
    expect(bindings.size()).toBe(0);
  });
});
