/**
 * Limits of the loopback DNS proxy (ADR-002 §2, §4, §5) and the small pure
 * pieces that enforce them. Every number the proxy checks lives here, so a
 * mutant test can name it.
 */

import { MAX_MESSAGE_BYTES, MAX_QUERY_BYTES } from './packet';

export { MAX_QUERY_BYTES };

/** Largest upstream reply read over UDP; a bigger datagram is dropped. */
export const MAX_UDP_RESPONSE_BYTES = 4096;
/** Largest upstream reply read over TCP (the 16-bit length prefix's ceiling). */
export const MAX_TCP_RESPONSE_BYTES = MAX_MESSAGE_BYTES;
/** Client queries waiting on an upstream server at the same time. */
export const MAX_CONCURRENT_UPSTREAM = 64;
/** Token bucket: sustained queries per second, and the burst it holds. */
export const RATE_PER_SECOND = 200;
export const RATE_BURST = 400;
/** Open client TCP connections; one more is closed at once. */
export const MAX_TCP_CONNECTIONS = 16;
/** A TCP connection with no complete query (and no reply) for this long is closed. */
export const TCP_IDLE_MS = 10_000;
/** Queries read from one TCP connection; the connection is closed on the next one. */
export const MAX_QUERIES_PER_TCP_CONNECTION = 32;
/** One upstream server gets this long to answer before failover to the next (the last server waits out the total budget). */
export const UPSTREAM_SERVER_TIMEOUT_MS = 2_000;
/** All upstream servers of one query together; then the client gets SERVFAIL. */
export const UPSTREAM_TOTAL_TIMEOUT_MS = 5_000;
/** Servers tried for one query (failover order). */
export const MAX_UPSTREAM_SERVERS = 3;
/** The reply waits at most this long for the learned routes, then goes out anyway (fail-open). */
export const LEARN_WAIT_MS = 1_500;
/** Bind retry: first delay, doubled after every failure up to the ceiling. */
export const BIND_RETRY_FIRST_MS = 5_000;
export const BIND_RETRY_MAX_MS = 300_000;
/** Upstream DNS servers listen here. */
export const UPSTREAM_PORT = 53;

/** The delay before bind attempt `failures + 1` (5 s, 10 s, 20 s … 5 min). */
export const bindRetryDelay = (failures: number): number => {
  const steps = Math.max(0, failures - 1);
  // 2^7 * 5 s already passes the ceiling; capping the exponent keeps the number finite.
  return Math.min(BIND_RETRY_MAX_MS, BIND_RETRY_FIRST_MS * 2 ** Math.min(steps, 16));
};

export interface TokenBucket {
  /** Takes one token; false when the bucket is empty (the query is over the rate). */
  take(): boolean;
}

/**
 * A token bucket on a monotonic millisecond clock: `ratePerSecond` tokens a
 * second, at most `burst` stored, full at the start. A clock that goes
 * backwards adds nothing.
 */
export const createTokenBucket = (
  monotonicNow: () => number,
  ratePerSecond: number = RATE_PER_SECOND,
  burst: number = RATE_BURST,
): TokenBucket => {
  let tokens = burst;
  let last = monotonicNow();
  return {
    take: () => {
      const now = monotonicNow();
      if (now > last) {
        tokens = Math.min(burst, tokens + ((now - last) * ratePerSecond) / 1000);
      }
      last = Math.max(last, now);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
};

/** True for an address in 127.0.0.0/8, written as IPv4 or as an IPv4-mapped IPv6 address. */
export const isLoopbackSource = (address: string | undefined): boolean => {
  if (address === undefined) return false;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const parts = v4.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};
