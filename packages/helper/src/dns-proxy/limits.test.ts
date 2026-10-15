import { describe, expect, it } from 'vitest';

import {
  BIND_RETRY_FIRST_MS,
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
