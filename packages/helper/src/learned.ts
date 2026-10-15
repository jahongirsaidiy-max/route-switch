import { LEARNED_ROUTE_LIMITS } from '@routeswitch/shared';

/**
 * The addresses wildcard domain rules have learned from DNS answers
 * (ADR-002 §4): a pure, bounded set with a lifetime per address and
 * least-recently-seen eviction. It runs no command and has no clock of its
 * own: every call that depends on time takes `nowMs` (wall clock, ms).
 *
 * - An entry belongs to an owner: the engine uses one owner per wildcard rule
 *   and target (`learnedOwner`), so a rule whose target changes starts empty.
 * - Lifetime: the answer's TTL clamped to `minTtlSec`..`maxTtlSec`; an answer
 *   that carries the address again renews it (the later expiry wins) and makes
 *   it the most recently seen.
 * - Bounds: at most `perRule` entries per owner and `total` in all. A new
 *   address beyond a bound drops the entry seen longest ago (of the owner, or
 *   of all owners for `total`); that owner reports truncation until the
 *   dropped entry would have expired.
 * - An entry is expired at its expiry, and also when the clock reads more
 *   than `maxTtlSec` before the time it was last seen (the clock was set back:
 *   the lifetime is never stretched beyond the bound).
 */

export interface LearnedLimits {
  readonly perRule: number;
  readonly total: number;
  readonly minTtlSec: number;
  readonly maxTtlSec: number;
}

export interface LearnedEntry {
  readonly owner: string;
  readonly address: string;
  /** When an answer carried the address last (ms). */
  readonly seenAt: number;
  /** When the address stops being routed (ms). */
  readonly expiresAt: number;
}

export interface LearnOutcome {
  /** Addresses that were not in the owner's set before, in input order. */
  readonly added: readonly string[];
  /** Addresses that were there already and got a new lifetime. */
  readonly renewed: readonly string[];
  /** Entries dropped to make room, of this owner or of another one. */
  readonly evicted: readonly LearnedEntry[];
}

export interface LearnedRoutes {
  /**
   * Records the addresses of one answer for `owner`. The addresses are taken
   * as given (the caller has validated them); duplicates count once and at
   * most `perRule` of them are read.
   */
  learn(owner: string, addresses: readonly string[], ttlSec: number, nowMs: number): LearnOutcome;
  /** The owner's addresses, the one seen longest ago first. */
  addressesOf(owner: string): readonly string[];
  /** When the owner learned an address last (ms), or null when it has none. */
  lastLearnedAt(owner: string): number | null;
  /** True while an entry dropped from the owner at a bound would still be alive. */
  isTruncated(owner: string, nowMs: number): boolean;
  /** Removes and returns the expired entries. */
  expire(nowMs: number): readonly LearnedEntry[];
  /** How many entries are expired (and still held). */
  countExpired(nowMs: number): number;
  /** Keeps only the owners `keep` accepts; returns how many entries were dropped. */
  retain(keep: (owner: string) => boolean): number;
  /** Forgets everything; returns how many entries were dropped. */
  clear(): number;
  /** Entries held now, of one owner or of all. */
  size(owner?: string): number;
}

/** The TTL an address lives for: the answer's TTL clamped to the bounds; a value that is not a number lives the shortest. */
export const clampTtlSec = (ttlSec: number, limits: Pick<LearnedLimits, 'minTtlSec' | 'maxTtlSec'> = LEARNED_ROUTE_LIMITS): number => {
  if (Number.isNaN(ttlSec)) return limits.minTtlSec;
  return Math.min(limits.maxTtlSec, Math.max(limits.minTtlSec, Math.floor(ttlSec)));
};

interface MutableEntry {
  readonly owner: string;
  readonly address: string;
  seenAt: number;
  expiresAt: number;
}

export const createLearnedRoutes = (limits: LearnedLimits = LEARNED_ROUTE_LIMITS): LearnedRoutes => {
  const maxTtlMs = limits.maxTtlSec * 1000;
  /** Every entry, the one seen longest ago first (a Map keeps insertion order; a renewal re-inserts). */
  const all = new Map<string, MutableEntry>();
  /** Owner -> address -> entry, in the same order. */
  const byOwner = new Map<string, Map<string, MutableEntry>>();
  /** Owner -> until when it reports truncation. */
  const truncatedUntil = new Map<string, number>();

  const keyOf = (owner: string, address: string): string => `${owner}\n${address}`;
  const freeze = ({ owner, address, seenAt, expiresAt }: MutableEntry): LearnedEntry => ({ owner, address, seenAt, expiresAt });
  const isExpired = (entry: MutableEntry, nowMs: number): boolean =>
    nowMs >= entry.expiresAt || nowMs < entry.seenAt - maxTtlMs;

  const remove = (entry: MutableEntry): void => {
    all.delete(keyOf(entry.owner, entry.address));
    const owned = byOwner.get(entry.owner);
    owned?.delete(entry.address);
    if (owned?.size === 0) byOwner.delete(entry.owner);
  };

  const evict = (entry: MutableEntry, evicted: LearnedEntry[]): void => {
    remove(entry);
    evicted.push(freeze(entry));
    truncatedUntil.set(entry.owner, Math.max(truncatedUntil.get(entry.owner) ?? -Infinity, entry.expiresAt));
  };

  const learn = (owner: string, addresses: readonly string[], ttlSec: number, nowMs: number): LearnOutcome => {
    const added: string[] = [];
    const renewed: string[] = [];
    const evicted: LearnedEntry[] = [];
    const expiresAt = nowMs + clampTtlSec(ttlSec, limits) * 1000;
    const unique = [...new Set(addresses.slice(0, limits.perRule))];
    const insert = (entry: MutableEntry): void => {
      let owned = byOwner.get(owner);
      if (owned === undefined) {
        owned = new Map();
        byOwner.set(owner, owned);
      }
      owned.set(entry.address, entry);
      all.set(keyOf(owner, entry.address), entry);
    };
    // Renewals first: they become the most recently seen, so making room for the new addresses
    // never drops an address of this very answer (an answer holds at most `perRule`).
    const fresh: string[] = [];
    for (const address of unique) {
      const existing = byOwner.get(owner)?.get(address);
      if (existing === undefined) {
        fresh.push(address);
        continue;
      }
      remove(existing);
      existing.seenAt = nowMs;
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      insert(existing);
      renewed.push(address);
    }
    for (const address of fresh) {
      const owned = byOwner.get(owner);
      if (owned !== undefined && owned.size >= limits.perRule) {
        const [oldest] = owned.values();
        if (oldest !== undefined) evict(oldest, evicted);
      } else if (all.size >= limits.total) {
        const [oldest] = all.values();
        if (oldest !== undefined) evict(oldest, evicted);
      }
      insert({ owner, address, seenAt: nowMs, expiresAt });
      added.push(address);
    }
    return { added, renewed, evicted };
  };

  const expire = (nowMs: number): readonly LearnedEntry[] => {
    const expired: LearnedEntry[] = [];
    for (const entry of [...all.values()]) {
      if (!isExpired(entry, nowMs)) continue;
      remove(entry);
      expired.push(freeze(entry));
    }
    for (const [owner, until] of truncatedUntil) if (nowMs >= until) truncatedUntil.delete(owner);
    return expired;
  };

  const retain = (keep: (owner: string) => boolean): number => {
    let dropped = 0;
    for (const [owner, owned] of [...byOwner]) {
      if (keep(owner)) continue;
      dropped += owned.size;
      for (const entry of [...owned.values()]) remove(entry);
    }
    for (const owner of [...truncatedUntil.keys()]) if (!keep(owner)) truncatedUntil.delete(owner);
    return dropped;
  };

  const clear = (): number => {
    const dropped = all.size;
    all.clear();
    byOwner.clear();
    truncatedUntil.clear();
    return dropped;
  };

  return {
    learn,
    addressesOf: (owner) => [...(byOwner.get(owner)?.keys() ?? [])],
    lastLearnedAt: (owner) => {
      let latest: number | null = null;
      for (const entry of byOwner.get(owner)?.values() ?? []) latest = latest === null ? entry.seenAt : Math.max(latest, entry.seenAt);
      return latest;
    },
    isTruncated: (owner, nowMs) => nowMs < (truncatedUntil.get(owner) ?? -Infinity),
    expire,
    countExpired: (nowMs) => {
      let count = 0;
      for (const entry of all.values()) if (isExpired(entry, nowMs)) count += 1;
      return count;
    },
    retain,
    clear,
    size: (owner) => (owner === undefined ? all.size : (byOwner.get(owner)?.size ?? 0)),
  };
};
