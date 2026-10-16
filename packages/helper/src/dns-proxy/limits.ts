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
/**
 * CNAME targets bound to an exact domain rule (TASK-DELTA-41): at most this
 * many at once; one more drops the least recently used binding.
 */
export const MAX_CNAME_BINDINGS = 256;
/**
 * A binding lives as long as the alias it came from (the CNAME TTL), within
 * these bounds: never shorter than the follow-up lookup of the target needs,
 * never longer than a learned route (the engine's ceiling, one day).
 */
export const CNAME_BINDING_MIN_TTL_SEC = 60;
export const CNAME_BINDING_MAX_TTL_SEC = 86_400;
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

/** Which exact domain rule answers for a CNAME target, and the rule's own name it came from. */
export interface CnameBinding {
  readonly ruleId: string;
  /** The exact rule's name whose answer made the binding (re-checked on every use). */
  readonly source: string;
}

export interface CnameBindings {
  /** Binds `target` for `ttlSec` (clamped to the binding bounds); replaces an older binding of it. */
  bind(target: string, binding: CnameBinding, ttlSec: number): void;
  /** The live binding of `target` (and marks it recently used); null when none or expired. */
  get(target: string): CnameBinding | null;
  delete(target: string): void;
  clear(): void;
  size(): number;
}

/** `ttlSec` within `CNAME_BINDING_MIN_TTL_SEC`…`CNAME_BINDING_MAX_TTL_SEC`; anything not a finite number reads as the minimum. */
export const cnameBindingTtlSec = (ttlSec: number): number =>
  Number.isFinite(ttlSec) ? Math.min(CNAME_BINDING_MAX_TTL_SEC, Math.max(CNAME_BINDING_MIN_TTL_SEC, ttlSec)) : CNAME_BINDING_MIN_TTL_SEC;

/**
 * A bounded, expiring map of CNAME bindings on a monotonic millisecond clock:
 * at most `cap` entries; expired ones go first, then the least recently used.
 */
export const createCnameBindings = (monotonicNow: () => number, cap: number = MAX_CNAME_BINDINGS): CnameBindings => {
  const entries = new Map<string, { readonly binding: CnameBinding; readonly expiresAt: number }>();

  const dropExpired = (now: number): void => {
    for (const [target, entry] of entries) if (entry.expiresAt <= now) entries.delete(target);
  };

  return {
    bind: (target, binding, ttlSec) => {
      const now = monotonicNow();
      entries.delete(target);
      if (entries.size >= cap) dropExpired(now);
      while (entries.size >= cap) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(target, { binding, expiresAt: now + cnameBindingTtlSec(ttlSec) * 1000 });
    },
    get: (target) => {
      const entry = entries.get(target);
      if (entry === undefined) return null;
      entries.delete(target);
      if (entry.expiresAt <= monotonicNow()) return null;
      entries.set(target, entry);
      return entry.binding;
    },
    delete: (target) => {
      entries.delete(target);
    },
    clear: () => {
      entries.clear();
    },
    size: () => entries.size,
  };
};
