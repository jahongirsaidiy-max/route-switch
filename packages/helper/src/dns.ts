import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';

import {
  LIMITS,
  normalizeDomain,
  normalizeHostAddress,
  normalizeIpv4,
  type Config,
  type Rule,
  type RuleReasonCode,
} from '@routeswitch/shared';

import { MAX_EXCLUDED_DNS_SERVERS, type DomainContext, type DomainTargets } from './engine';
import type { Logger } from './logger';

/**
 * Domain rules: resolves the A records of a domain and hands them to the
 * engine as host-route destinations.
 *
 * The engine awaits `resolveDomain` for every enabled domain rule, one after
 * the other, inside each pass, so `resolveDomain` here is synchronous and
 * answers from the cache only. The DNS queries run in the background, bounded
 * in time and in number; when an answer changes what the engine was told
 * last, a `reconcile('dns-refresh')` is requested and the engine's own diff
 * removes the routes of addresses that went away and adds the new ones.
 *
 * DNS answers are untrusted input for a root daemon. Every address is parsed
 * strictly and checked against the forbidden destinations, the set is
 * de-duplicated, sorted and capped, and a lookup that never answers is cut off
 * by a timer.
 *
 * An answer never yields the address of a DNS server: not of the system
 * resolvers, not of an interface, not the `dns` of any rule. A host route to
 * the machine's own resolver through the rule's interface would divert every
 * DNS query; the refreshes would then time out and keep that very route
 * alive. For the same reason the last known addresses are not kept for ever:
 * after `staleLimitMs` without an answer they are dropped.
 *
 * Which server is asked:
 * - a rule with `dns`: that server;
 * - a rule without: the DNS servers of the interface that plays the rule's
 *   role (from `scutil --dns`: the lease's servers or those set by hand), as
 *   the engine passes them in from the last trusted detection, in order — the
 *   resolver falls back to the next one when a server does not answer. With
 *   two interfaces up, the system resolvers are those of the primary service
 *   only, so an internal name bound to the other role would get NXDOMAIN or
 *   the public half of a split-horizon answer;
 * - when the interface has no known server: the system resolvers, with one
 *   warning per rule.
 * The query to an interface's server leaves through that interface only when
 * the server is inside its connected subnet. No route is added for it here:
 * its address came from the system's configuration (DHCP) and was checked for
 * syntax only. A server
 * elsewhere is reached through the default route, or not at all; the failure
 * then says to set `dns` in the rule, which is the case scoped DNS handles.
 *
 * Rotating answers (CDN, round robin): an address stays for
 * `STICKY_REFRESHES` refresh intervals after it was last in an answer, so a
 * name that returns another few addresses each time does not make routes come
 * and go. The price: an address that should not have been in an answer lives
 * that much longer.
 *
 * `Resolver.resolve4` and not `dns.lookup`, deliberately:
 * - only a `Resolver` can query one given server (`rule.dns`);
 * - `dns.lookup` runs `getaddrinfo` on the libuv thread pool, where it can be
 *   neither cancelled nor timed out, and a few hanging lookups would starve
 *   the file-system work of the daemon;
 * - `resolve4` returns A records only.
 * The limitation: a `Resolver` asks the servers it is given, directly. It
 * does not read `/etc/hosts`, does not resolve mDNS names and does not follow
 * `/etc/resolver/<domain>`. A domain that only an internal DNS server in
 * another subnet knows therefore needs `dns` in its rule; with it the query
 * goes to that server, which is also what the `/etc/resolver` file of the
 * rule makes the rest of the system do.
 *
 * Nothing here adds the route to the DNS server or writes resolver files. The
 * module that does (scoped DNS) wraps `resolveDomain` and puts `rule.dns` in
 * front of `destinations`; the engine applies one destination more than
 * `LIMITS.maxIpsPerDomain` per rule for exactly that. `rule.dns` is never
 * among the destinations returned here (see above), so the wrapper is the
 * only source of that route. A first query that went out before that route
 * existed fails and is retried after `RETRY_FLOOR_MS`, or at once when
 * `refreshAll()` is called.
 */

/** `timeout` of each `Resolver`: how long one try waits for a server, in milliseconds. */
export const DNS_QUERY_TIMEOUT_MS = 2000;
/** `tries` of each `Resolver`: how often a server is asked before the resolver gives up. */
export const DNS_QUERY_TRIES = 2;
/** Hard limit for one lookup, whatever the resolver does: after it the lookup is cancelled and counts as failed. */
export const LOOKUP_TIMEOUT_MS = 5000;
/** Lookups running at the same time; the rest wait in a queue. */
export const MAX_CONCURRENT_LOOKUPS = 8;
/**
 * Lookups running at the same time against one set of servers, so that one
 * server that does not answer cannot hold every slot.
 */
export const MAX_LOOKUPS_PER_SERVER_SET = 4;
/**
 * Of those, the ones for entries whose last lookup failed. Names that keep
 * failing are retried through this narrow lane and leave the rest of the
 * server's slots to names that answer.
 */
export const MAX_FAILING_LOOKUPS_PER_SERVER_SET = 2;
/** An address stays this many refresh intervals after it was last in an answer. */
export const STICKY_REFRESHES = 3;
/** The last known addresses are dropped after this many refresh intervals without an answer ... */
export const STALE_REFRESHES = 10;
/** ... but never sooner than this. */
export const STALE_FLOOR_MS = 3_600_000;
/** How long the last known addresses of an entry outlive its last successful answer. */
export const staleLimitMs = (refreshMs: number): number => Math.max(STALE_REFRESHES * refreshMs, STALE_FLOOR_MS);
/**
 * A changed answer asks for a reconcile this long after the first change;
 * every change within the window shares that one request. The window is not
 * extended by later changes, so a steady stream of them cannot postpone it.
 */
export const RECONCILE_DEBOUNCE_MS = 500;
/**
 * Delay before the first retry of a failed lookup. It doubles with every
 * further failure and never exceeds the `refreshSec` of the rule.
 */
export const RETRY_FLOOR_MS = 10_000;
/** A DNS message cannot carry more A records than this; a longer answer is refused as malformed. */
export const MAX_ANSWER_RECORDS = 4096;

const MAX_BACKOFF_DOUBLINGS = 16;
const MAX_IPV4_TEXT_LENGTH = 15;
/** Servers one lookup is pointed at; a longer list from an interface is cut. */
const MAX_SERVERS_PER_LOOKUP = 4;
/** DNS-server addresses taken from the system resolver list, and the least read of any other list. */
const MAX_LISTED_SERVERS = 64;
/** A domain is shortened to this in a `reason`, so that what follows it still fits. */
const REASON_NAME_LENGTH = 80;
/** Refusal code of an answer record that is the address of a DNS server. */
export const DNS_SERVER_REFUSAL = 'dns-server';

/** The part of `dns.promises.Resolver` this module uses. */
export interface DnsResolverLike {
  setServers(servers: readonly string[]): void;
  /** The answer is validated here, so it is typed as unknown. */
  resolve4(hostname: string): Promise<unknown>;
  cancel(): void;
}

export interface DnsResolverOptions {
  readonly timeout: number;
  readonly tries: number;
}

/** Builds the resolver for one lookup. */
export type DnsResolverFactory = (options: DnsResolverOptions) => DnsResolverLike;

/** A new `Resolver` of its own for every lookup; the resolver shared by the process (`dns.setServers`) is never touched. */
export const createSystemResolver: DnsResolverFactory = (options) => new Resolver(options);

export type SetTimer = (callback: () => void, delayMs: number) => unknown;
export type ClearTimer = (handle: unknown) => void;

export const realSetTimer: SetTimer = (callback, delayMs) => setTimeout(callback, delayMs);
export const realClearTimer: ClearTimer = (handle) => {
  // The handle is whatever `realSetTimer` returned.
  clearTimeout(handle as NodeJS.Timeout);
};

export interface DomainResolverDeps {
  readonly logger: Logger;
  readonly now?: (() => Date) | undefined;
  readonly createResolver?: DnsResolverFactory | undefined;
  readonly setTimer?: SetTimer | undefined;
  readonly clearTimer?: ClearTimer | undefined;
  /**
   * Called (debounced) when an answer changed what `resolveDomain` returns
   * for a rule. The daemon passes `() => engine.reconcile('dns-refresh')`.
   */
  readonly requestReconcile?: ((reason: 'dns-refresh') => unknown) | undefined;
  /**
   * The resolvers of the process, whose addresses are never routed. Defaults
   * to `dns.getServers()`, read through the module object: `dns.setServers`
   * re-binds the functions of the module, which a named import would not follow.
   */
  readonly systemServers?: (() => readonly string[]) | undefined;
}

export interface DomainResolverStats {
  /** Distinct lookups (domain + server) being tracked. */
  readonly entries: number;
  readonly inFlight: number;
  readonly queued: number;
  /** Timers currently pending: lookup timeouts, the refresh timer and the reconcile debounce. */
  readonly timers: number;
}

export interface DomainResolverService {
  /**
   * For `EngineDeps.resolveDomain` (a `DomainResolver`). Synchronous: answers
   * from the cache, never waits for the network. Without `context` (a caller
   * that knows nothing about the interfaces) a rule without `dns` is asked
   * from the system resolvers.
   */
  readonly resolveDomain: (rule: Rule, context?: DomainContext) => DomainTargets;
  /**
   * Tells the resolver which rules exist now. Everything that belongs to a
   * rule that was removed, disabled or pointed at another domain or server is
   * dropped: its cached answer, its running lookup and its refresh. With the
   * global toggle off everything is dropped. Wire it to
   * `EngineDeps.onConfigChanged`, and call it once with the initial config.
   */
  readonly syncConfig: (config: Pick<Config, 'enabled' | 'rules'>) => void;
  /**
   * Resolves every tracked domain again right away (the network changed).
   * Cached answers keep being served until the new ones arrive; running
   * lookups are cancelled and started again.
   */
  readonly refreshAll: () => void;
  /** Resolves when no lookup is running or queued. Does not wait for scheduled refreshes or retries. */
  readonly whenIdle: () => Promise<void>;
  readonly stats: () => DomainResolverStats;
  /** Cancels every lookup and timer and forgets everything. Afterwards `resolveDomain` starts nothing. */
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface SanitizedAnswer {
  /** Usable addresses: unique, in ascending numeric order, at most `LIMITS.maxIpsPerDomain`. */
  readonly addresses: readonly string[];
  /** Unique usable addresses before the cap. */
  readonly usable: number;
  /** Records that were dropped, by reason (`loopback`, `invalid-ipv4`, `dns-server`, ...). */
  readonly refused: Readonly<Record<string, number>>;
  readonly refusedTotal: number;
}

const addressValue = (address: string): number =>
  address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);

/**
 * Turns a raw `resolve4` answer into the addresses that may be routed. Null
 * when the answer is not a list of a plausible size.
 *
 * Each record must be a strict dotted-decimal IPv4 address that is not a
 * forbidden destination and not in `excluded` (the DNS servers, refused as
 * `dns-server`). The survivors are de-duplicated and sorted by
 * numeric value, so the same set in another order is the same answer; when
 * there are more than `LIMITS.maxIpsPerDomain`, the numerically lowest ones
 * are kept.
 */
export const sanitizeAnswer = (raw: unknown, excluded?: ReadonlySet<string>): SanitizedAnswer | null => {
  if (!Array.isArray(raw) || raw.length > MAX_ANSWER_RECORDS) return null;
  const records: readonly unknown[] = raw;
  const unique = new Set<string>();
  const refused: Record<string, number> = {};
  let refusedTotal = 0;
  for (const record of records) {
    const result =
      typeof record === 'string' && record.length <= MAX_IPV4_TEXT_LENGTH ? normalizeHostAddress(record) : null;
    if (result?.ok === true && excluded?.has(result.value) !== true) {
      unique.add(result.value);
      continue;
    }
    const code = result === null ? 'invalid-ipv4' : result.ok ? DNS_SERVER_REFUSAL : result.error.code;
    refused[code] = (refused[code] ?? 0) + 1;
    refusedTotal += 1;
  }
  const sorted = [...unique].sort((a, b) => addressValue(a) - addressValue(b));
  return { addresses: sorted.slice(0, LIMITS.maxIpsPerDomain), usable: sorted.length, refused, refusedTotal };
};

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** The error code of a rejected lookup, when it looks like one; the message is never used. */
const errorCodeOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const { code } = error;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : null;
};

type LookupOutcome = { readonly kind: 'answer'; readonly raw: unknown } | { readonly kind: 'failure'; readonly reason: string };

/**
 * `ENODATA` is an answer: the name exists and has no A records. Everything
 * else is a failed lookup, `ENOTFOUND` (NXDOMAIN) included: a server that is
 * asked for a name it does not know (an internal name sent to a public
 * server while the network is changing) says exactly that, and it must not
 * take the last known addresses away.
 */
const outcomeOfRejection = (error: unknown): LookupOutcome => {
  const code = errorCodeOf(error);
  if (code === 'ENODATA') return { kind: 'answer', raw: [] };
  if (code === 'ENOTFOUND') return { kind: 'failure', reason: 'the DNS server does not know the name (ENOTFOUND)' };
  return { kind: 'failure', reason: code === null ? 'the DNS lookup failed' : `the DNS lookup failed (${code})` };
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What the last successful answer said, apart from the addresses themselves. */
interface Answer {
  /** Unique usable addresses in that answer, before the cap. */
  readonly usable: number;
  readonly refused: Readonly<Record<string, number>>;
  readonly refusedTotal: number;
  /** When the answer arrived, as `toISOString()`. */
  readonly at: string;
}

interface Flight {
  readonly entry: Entry;
  /** `entry.generation` when the lookup started; the lookup counts only while the two are equal. */
  readonly generation: number;
  readonly startedAt: number;
  /** The entry was in a failure streak when the lookup started. */
  readonly failing: boolean;
  /** The entry had answered its last lookup when this one started (see `isProven`). */
  readonly proven: boolean;
  resolver: DnsResolverLike | null;
  timer: unknown;
}

/** Where the servers of a lookup come from. */
export type ServerSource = 'rule' | 'interface' | 'system';

/** One distinct lookup: a domain asked from one set of servers. */
interface Entry {
  readonly key: string;
  readonly domain: string;
  /** The servers asked, in order; empty for the system resolvers. */
  readonly servers: readonly string[];
  readonly source: ServerSource;
  /** Identifies the server set, for the per-server limits. */
  readonly serverKey: string;
  /** Rule id -> `refreshSec` of the rules that use this lookup. */
  readonly subscribers: Map<string, number>;
  /** Goes up whenever a lookup starts or is given up; an answer of an older generation is ignored. */
  generation: number;
  flight: Flight | null;
  queued: boolean;
  /** Address -> when it was last in an answer (epoch milliseconds). */
  readonly seen: Map<string, number>;
  /** The keys of `seen` in ascending numeric order: what is served. */
  addresses: readonly string[];
  /** The last successful answer; null until there is one. */
  answer: Answer | null;
  /** Why the last lookup failed; null after a success. */
  failure: string | null;
  failures: number;
  /** Time without an answer since the last successful one, as far as it has been observed. */
  staleMs: number;
  /** When `staleMs` was last brought up to date. */
  observedAt: number | null;
  /**
   * Set when the last known addresses were dropped because `staleMs` passed
   * the limit: how long there had been no answer at that moment. Null otherwise.
   */
  expiredAfterMs: number | null;
  /** End of the last lookup, in epoch milliseconds. */
  lastAttemptAt: number | null;
  /** When the next lookup is due, in epoch milliseconds; null until the first one has finished. */
  dueAt: number | null;
  /** Signature of what `resolveDomain` returned last, i.e. what the engine knows. */
  served: string | null;
  /** Signature a reconcile was last requested for, so one change is announced once even if no pass asks about the rule. */
  announced: string | null;
  /** The refused/truncated situation that was logged at `warn`, so a standing one is not repeated. */
  warned: string;
}

interface Identity {
  readonly key: string;
  /** The part of the key the rule alone determines: domain and its own `dns`. */
  readonly base: string;
  readonly domain: string;
  readonly servers: readonly string[];
  readonly source: ServerSource;
}

interface Subscription {
  key: string;
  base: string;
  /** The rule's own `dns`, which no answer may contain. */
  dns: string | null;
  /** Position in the order rules were last asked about; the lowest is the least recently used. */
  seq: number;
}

const NOT_A_DOMAIN_RULE: DomainTargets = {
  destinations: [],
  status: 'error',
  reasonCode: 'internal',
  reason: 'The rule cannot be resolved: it is not a valid domain rule',
  lastResolvedAt: null,
};

const resolving = (reason: string): DomainTargets => ({
  destinations: [],
  status: 'pending',
  reasonCode: 'resolving',
  reason,
  lastResolvedAt: null,
});

/** Usable, distinct server addresses out of a list that came from somewhere else; at most `limit`. */
const usableServers = (list: unknown, limit: number): string[] => {
  if (!Array.isArray(list)) return [];
  const candidates: readonly unknown[] = list.slice(0, Math.max(limit, MAX_LISTED_SERVERS));
  const servers: string[] = [];
  for (const candidate of candidates) {
    const server =
      typeof candidate === 'string' && candidate.length <= MAX_IPV4_TEXT_LENGTH ? normalizeHostAddress(candidate) : null;
    if (server?.ok === true && !servers.includes(server.value) && servers.length < limit) servers.push(server.value);
  }
  return servers;
};

/** The IPv4 addresses in a `dns.getServers()` list (`a.b.c.d` or `a.b.c.d:port`); anything else is skipped. */
const systemAddresses = (list: unknown): string[] => {
  if (!Array.isArray(list)) return [];
  const candidates: readonly unknown[] = list.slice(0, MAX_LISTED_SERVERS);
  const addresses: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length > MAX_IPV4_TEXT_LENGTH + 6) continue;
    const [host = ''] = candidate.split(':');
    const address = normalizeIpv4(host);
    if (address.ok) addresses.push(address.value);
  }
  return addresses;
};

/**
 * What determines the answer: the domain and the servers asked. Null when the
 * rule is not a valid domain rule. `context` is only looked at for a rule
 * without `dns`.
 */
const identityOf = (rule: Pick<Rule, 'kind' | 'target' | 'dns'>, context: DomainContext | undefined): Identity | null => {
  if (rule.kind !== 'domain' || typeof rule.target !== 'string') return null;
  const domain = normalizeDomain(rule.target);
  if (!domain.ok) return null;
  if (rule.dns !== undefined) {
    const server = typeof rule.dns === 'string' ? normalizeHostAddress(rule.dns) : null;
    if (server?.ok !== true) return null;
    const base = `${domain.value}|${server.value}`;
    return { key: `${base}|rule`, base, domain: domain.value, servers: [server.value], source: 'rule' };
  }
  const base = `${domain.value}|`;
  const servers = usableServers(context?.dnsServers, MAX_SERVERS_PER_LOOKUP);
  return servers.length === 0
    ? { key: `${base}|system`, base, domain: domain.value, servers, source: 'system' }
    : { key: `${base}${servers.join(',')}|interface`, base, domain: domain.value, servers, source: 'interface' };
};

const refreshSecOf = (rule: Pick<Rule, 'refreshSec'>): number => {
  const value: unknown = rule.refreshSec;
  if (typeof value !== 'number' || !Number.isFinite(value)) return LIMITS.refreshSecDefault;
  return Math.min(LIMITS.refreshSecMax, Math.max(LIMITS.refreshSecMin, Math.floor(value)));
};

const describeThrown = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
};

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 'es'}`;

const describeRefused = (refused: Readonly<Record<string, number>>): string =>
  Object.entries(refused)
    .map(([code, count]) => `${code}: ${String(count)}`)
    .join(', ');

/** The domain as it appears in a `reason`: cut, so that the code and the detail after it always fit. */
const nameOf = (domain: string): string =>
  domain.length <= REASON_NAME_LENGTH ? domain : `${domain.slice(0, REASON_NAME_LENGTH - 1)}…`;

/** An entry whose last lookup was answered: neither new nor in a failure streak. */
const isProven = (entry: Entry): boolean => entry.answer !== null && entry.failures === 0;

const INTERFACE_HINT = '; if only an internal server knows the name, set `dns` in the rule';

/** Status, code and addresses: what makes a pass of the engine come out differently. */
const signatureOf = (targets: DomainTargets): string =>
  `${targets.status}|${String(targets.reasonCode)}|${targets.destinations.join(',')}`;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const createDomainResolver = (deps: DomainResolverDeps): DomainResolverService => {
  const logger = deps.logger.child({ component: 'dns' });
  const now = deps.now ?? (() => new Date());
  const createResolver = deps.createResolver ?? createSystemResolver;
  const setTimer = deps.setTimer ?? realSetTimer;
  const clearTimer = deps.clearTimer ?? realClearTimer;
  const readSystemServers = deps.systemServers ?? (() => dns.getServers());

  const entries = new Map<string, Entry>();
  /** Rule id -> what the rule subscribes to. Never more than `LIMITS.maxRules`. */
  const subscriptions = new Map<string, Subscription>();
  /** Rules that were told once that their interface has no DNS server. */
  const warnedNoServer = new Set<string>();
  const active = new Set<Flight>();
  let queue: Entry[] = [];
  let idleWaiters: (() => void)[] = [];
  let stopped = false;
  let askSeq = 0;
  let evictionReported = false;
  /** The highest clock reading so far, to notice a clock that went back. */
  let lastNow: number | null = null;

  /** `dns` of the enabled domain rules of the config, as of the last `syncConfig`. */
  let configDns: readonly string[] = [];
  /** DNS servers of the interfaces, as of the last `resolveDomain` that came with a context. */
  let interfaceDns: readonly string[] = [];
  let systemDns: readonly string[] = [];
  let systemDnsRead = false;
  /** The union of the three plus the `dns` of every subscribed rule; rebuilt when one of them changes. */
  let excluded: ReadonlySet<string> | null = null;

  /** The one timer for scheduled work: the earliest refresh, retry or expiry of all entries. */
  let wheel: { readonly handle: unknown; readonly at: number } | null = null;
  let debounce: { readonly handle: unknown } | null = null;

  /**
   * Runs a timer or promise callback. Nothing may escape from one: an
   * exception there would be an uncaught one and take the daemon down.
   */
  const guarded = (what: string, work: () => void): void => {
    try {
      work();
    } catch (error) {
      logger.error('dns callback failed', { what, error: describeThrown(error) });
    }
  };

  // -------------------------------------------------------------------------
  // Timing
  // -------------------------------------------------------------------------

  const refreshMsOf = (entry: Entry): number => {
    let seconds: number = LIMITS.refreshSecMax;
    for (const refreshSec of entry.subscribers.values()) seconds = Math.min(seconds, refreshSec);
    return seconds * 1000;
  };

  /** After a success: `refreshSec`. After the n-th failure in a row: the floor doubled n-1 times, at most `refreshSec`. */
  const delayOf = (entry: Entry): number => {
    const refreshMs = refreshMsOf(entry);
    if (entry.failure === null) return refreshMs;
    const doublings = Math.min(Math.max(entry.failures - 1, 0), MAX_BACKOFF_DOUBLINGS);
    return Math.min(refreshMs, RETRY_FLOOR_MS * 2 ** doublings);
  };

  const setDue = (entry: Entry): void => {
    entry.dueAt = entry.lastAttemptAt === null ? null : entry.lastAttemptAt + delayOf(entry);
  };

  const isIdle = (entry: Entry): boolean => entry.flight === null && !entry.queued;

  /**
   * The clock, with one repair. Everything here is timed on the injected wall
   * clock, the only one there is. When it is seen to have gone back, every
   * timestamp that now lies in the future is pulled back to the present:
   * otherwise a refresh would be late by the size of the jump. Nothing is
   * credited for the jump either, so nothing expires early because of it.
   */
  const tick = (): number => {
    const at = now().getTime();
    if (lastNow !== null && at < lastNow) {
      for (const entry of entries.values()) {
        if (entry.lastAttemptAt !== null && entry.lastAttemptAt > at) {
          entry.lastAttemptAt = at;
          if (isIdle(entry)) setDue(entry);
        }
        for (const [address, seenAt] of entry.seen) if (seenAt > at) entry.seen.set(address, at);
      }
    }
    lastNow = at;
    return at;
  };

  /**
   * Brings `staleMs` up to date. The time since the last observation counts,
   * but never more than one refresh interval of it: while the process runs, an
   * entry is observed at least that often (see `scheduleWheel`), so a longer
   * gap means the machine slept, and sleep is not time without an answer. A
   * clock that went back counts for nothing.
   */
  const observe = (entry: Entry, at: number): void => {
    if (entry.observedAt !== null && at > entry.observedAt) {
      entry.staleMs += Math.min(at - entry.observedAt, refreshMsOf(entry));
    }
    entry.observedAt = at;
  };

  /** A failing entry that still serves addresses, and so can run out of time. */
  const canExpire = (entry: Entry): boolean =>
    entry.failure !== null && entry.expiredAfterMs === null && entry.addresses.length > 0;

  // -------------------------------------------------------------------------
  // Addresses that are never served
  // -------------------------------------------------------------------------

  const excludedSet = (): ReadonlySet<string> => {
    if (excluded === null) {
      const all = new Set<string>([...configDns, ...interfaceDns, ...systemDns]);
      for (const subscription of subscriptions.values()) if (subscription.dns !== null) all.add(subscription.dns);
      excluded = all;
    }
    return excluded;
  };

  const refreshSystemServers = (): void => {
    let list: readonly string[];
    try {
      list = systemAddresses(readSystemServers());
    } catch (error) {
      // Keep the list there was: an unreadable one must not make the exclusion weaker.
      logger.error('the system DNS servers could not be read', { error: describeThrown(error) });
      return;
    }
    systemDnsRead = true;
    if (sameList(list, systemDns)) return;
    systemDns = list;
    excluded = null;
  };

  // -------------------------------------------------------------------------
  // What the engine is told
  // -------------------------------------------------------------------------

  const targetsOf = (entry: Entry): DomainTargets => {
    const { answer, failure } = entry;
    const name = nameOf(entry.domain);
    const lastResolvedAt = answer?.at ?? null;
    // Checked again on the way out: the servers may have changed since the answer was stored.
    const never = excludedSet();
    const destinations = entry.addresses.filter((address) => !never.has(address));
    const late = entry.addresses.length - destinations.length;
    const refused: Record<string, number> = { ...(answer?.refused ?? {}) };
    if (late > 0) refused[DNS_SERVER_REFUSAL] = (refused[DNS_SERVER_REFUSAL] ?? 0) + late;
    const refusedTotal = (answer?.refusedTotal ?? 0) + late;
    const verdict = (status: DomainTargets['status'], reasonCode: RuleReasonCode | null, reason: string | null): DomainTargets => ({
      destinations,
      status,
      reasonCode,
      reason,
      lastResolvedAt,
    });
    const hint = entry.source === 'interface' ? INTERFACE_HINT : '';

    if (failure !== null) {
      if (answer === null) return verdict('error', 'resolve-failed', `Could not resolve ${name}: ${failure}${hint}`);
      if (entry.expiredAfterMs !== null) {
        return verdict(
          'error',
          'resolve-failed',
          `Could not refresh ${name}: ${failure}; the last known addresses expired after ${String(Math.floor(entry.expiredAfterMs / 60_000))} min without an answer${hint}`,
        );
      }
      return verdict(
        'error',
        'resolve-failed',
        `Could not refresh ${name}: ${failure}; the last known ${plural(destinations.length, 'address')} stay routed${hint}`,
      );
    }
    if (answer === null) return resolving(`Resolving ${name}`);
    if (destinations.length === 0) {
      return verdict(
        'error',
        'no-addresses',
        refusedTotal === 0
          ? `${name} has no A records`
          : `${name} has no usable A records: ${plural(refusedTotal, 'address')} must never be routed (${describeRefused(refused)})`,
      );
    }
    const truncated = answer.usable > LIMITS.maxIpsPerDomain;
    if (refusedTotal > 0) {
      return verdict(
        'error',
        'forbidden-destination',
        `${plural(refusedTotal, 'resolved address')} of ${name} must never be routed (${describeRefused(refused)})${
          truncated ? `; ${String(answer.usable)} addresses, the ${String(LIMITS.maxIpsPerDomain)} lowest are routed` : ''
        }`,
      );
    }
    return truncated
      ? verdict(
          'active',
          'addresses-truncated',
          `${name} has ${String(answer.usable)} addresses; the ${String(LIMITS.maxIpsPerDomain)} lowest are routed`,
        )
      : verdict('active', null, null);
  };

  // -------------------------------------------------------------------------
  // Reconcile requests
  // -------------------------------------------------------------------------

  const fireReconcile = (): void => {
    debounce = null;
    const { requestReconcile } = deps;
    if (requestReconcile === undefined) return;
    try {
      Promise.resolve(requestReconcile('dns-refresh')).catch((error: unknown) => {
        logger.error('reconcile request failed', { reason: 'dns-refresh', error: describeThrown(error) });
      });
    } catch (error) {
      logger.error('reconcile request failed', { reason: 'dns-refresh', error: describeThrown(error) });
    }
  };

  const requestReconcileSoon = (): void => {
    if (deps.requestReconcile === undefined || debounce !== null) return;
    debounce = {
      handle: setTimer(() => {
        guarded('reconcile request', fireReconcile);
      }, RECONCILE_DEBOUNCE_MS),
    };
  };

  /** Asks for a reconcile when what the entry serves now is not what the engine was told. */
  const announce = (entry: Entry): void => {
    if (entry.served === null) return;
    const signature = signatureOf(targetsOf(entry));
    if (signature === entry.served) {
      // Back to what the engine has: whatever was announced in between is void,
      // and must be announced again should it come back.
      entry.announced = null;
      return;
    }
    if (signature === entry.announced) return;
    entry.announced = signature;
    requestReconcileSoon();
  };

  // -------------------------------------------------------------------------
  // Expiry of the last known addresses
  // -------------------------------------------------------------------------

  /** Drops the last known addresses of an entry that has gone without an answer for too long; says whether it did. */
  const checkExpiry = (entry: Entry, at: number): boolean => {
    observe(entry, at);
    if (!canExpire(entry) || entry.staleMs <= staleLimitMs(refreshMsOf(entry))) return false;
    const dropped = entry.addresses.length;
    entry.expiredAfterMs = entry.staleMs;
    entry.seen.clear();
    entry.addresses = [];
    logger.warn('no answer for too long; the last known addresses are dropped', {
      domain: entry.domain,
      servers: entry.servers,
      source: entry.source,
      dropped,
      staleMs: entry.staleMs,
      limitMs: staleLimitMs(refreshMsOf(entry)),
    });
    return true;
  };

  const scheduleWheel = (): void => {
    const deadlines: number[] = [];
    for (const entry of entries.values()) {
      if (isIdle(entry) && entry.dueAt !== null) deadlines.push(entry.dueAt);
      // One millisecond past the limit: the addresses are kept up to and including the limit itself.
      // And never more than one refresh interval ahead, so that no gap between two observations is
      // longer than what `observe` credits.
      if (canExpire(entry) && entry.observedAt !== null) {
        const refreshMs = refreshMsOf(entry);
        deadlines.push(entry.observedAt + Math.min(staleLimitMs(refreshMs) - entry.staleMs + 1, refreshMs));
      }
    }
    const earliest = deadlines.reduce<number | null>((least, at) => (least === null || at < least ? at : least), null);
    if (wheel !== null) {
      if (wheel.at === earliest) return;
      clearTimer(wheel.handle);
      wheel = null;
    }
    if (earliest === null) return;
    const at = earliest;
    // A clock that jumped must not produce a negative or an absurd delay.
    const delay = Math.min(Math.max(at - now().getTime(), 0), STALE_REFRESHES * LIMITS.refreshSecMax * 1000);
    wheel = {
      handle: setTimer(() => {
        guarded('refresh timer', onWheel);
      }, delay),
      at,
    };
  };

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  const notifyIdle = (): void => {
    if (active.size > 0 || queue.length > 0 || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const done of waiters) done();
  };

  const isCurrent = (flight: Flight): boolean => flight.generation === flight.entry.generation;

  /** Ends a lookup from this module's point of view; whatever it still answers is ignored from here on. */
  const release = (flight: Flight): void => {
    flight.entry.generation += 1;
    flight.entry.flight = null;
    if (flight.timer !== null) clearTimer(flight.timer);
    flight.timer = null;
    active.delete(flight);
  };

  const cancelQuietly = (flight: Flight): void => {
    try {
      flight.resolver?.cancel();
    } catch (error) {
      logger.error('cancelling a DNS lookup failed', { domain: flight.entry.domain, error: describeThrown(error) });
    }
  };

  /** The fields every log line about an entry carries; `dns` is the rule's own server, when it has one. */
  const describe = (entry: Entry) => ({
    domain: entry.domain,
    dns: entry.source === 'rule' ? (entry.servers[0] ?? null) : null,
    servers: entry.servers,
    source: entry.source,
  });

  /**
   * Merges a non-empty answer into what the entry has seen and decides what is
   * served: the answer itself plus every address that was in an answer within
   * the last `STICKY_REFRESHES` refresh intervals, at most
   * `LIMITS.maxIpsPerDomain`. When that is too many, addresses that are not in
   * this answer go first: the one seen longest ago, and of two seen at the
   * same time the numerically higher. An answer that alone exceeds the limit
   * was already cut to its lowest addresses; it fills the table, so nothing
   * older is left.
   */
  const mergeAnswer = (entry: Entry, sanitized: SanitizedAnswer, at: number): void => {
    const current = new Set(sanitized.addresses);
    const never = excludedSet();
    const stickyMs = STICKY_REFRESHES * refreshMsOf(entry);
    for (const [address, seenAt] of entry.seen) {
      if (!current.has(address) && (at - seenAt > stickyMs || never.has(address))) entry.seen.delete(address);
    }
    for (const address of current) entry.seen.set(address, at);
    if (entry.seen.size > LIMITS.maxIpsPerDomain) {
      const older = [...entry.seen]
        .filter(([address]) => !current.has(address))
        .sort(([a, seenA], [b, seenB]) => seenA - seenB || addressValue(b) - addressValue(a));
      for (const [address] of older.slice(0, entry.seen.size - LIMITS.maxIpsPerDomain)) entry.seen.delete(address);
    }
    entry.addresses = [...entry.seen.keys()].sort((a, b) => addressValue(a) - addressValue(b));
  };

  const logAnswer = (
    entry: Entry,
    before: readonly string[],
    first: boolean,
    recovered: boolean,
    sanitized: SanitizedAnswer,
    durationMs: number,
  ): void => {
    const was = new Set(before);
    const is = new Set(entry.addresses);
    const added = entry.addresses.filter((address) => !was.has(address)).length;
    const removed = before.filter((address) => !is.has(address)).length;
    const changed = first || added > 0 || removed > 0;
    logger.log(changed || recovered ? 'info' : 'debug', changed ? 'domain resolved' : 'domain resolved; addresses unchanged', {
      ...describe(entry),
      addresses: entry.addresses.length,
      answered: sanitized.addresses.length,
      added,
      removed,
      durationMs,
    });

    const truncated = sanitized.usable > sanitized.addresses.length;
    const situation =
      sanitized.refusedTotal === 0 && !truncated ? '' : `${describeRefused(sanitized.refused)}|${truncated ? String(sanitized.usable) : ''}`;
    if (sanitized.refusedTotal > 0) {
      logger.log(situation === entry.warned ? 'debug' : 'warn', 'resolved addresses refused; they are never routed', {
        ...describe(entry),
        refused: sanitized.refusedTotal,
        reasons: sanitized.refused,
      });
    }
    if (truncated) {
      logger.log(situation === entry.warned ? 'debug' : 'warn', 'more addresses than the per-domain limit; the lowest are routed', {
        ...describe(entry),
        resolved: sanitized.usable,
        kept: sanitized.addresses.length,
        limit: LIMITS.maxIpsPerDomain,
      });
    }
    entry.warned = situation;
  };

  const settle = (entry: Entry, outcome: LookupOutcome, startedAt: number): void => {
    const finishedAt = tick();
    const durationMs = Math.max(0, finishedAt - startedAt);
    // Read when the answer is there: the resolvers of the system may have changed with the network.
    refreshSystemServers();
    const sanitized = outcome.kind === 'answer' ? sanitizeAnswer(outcome.raw, excludedSet()) : null;
    const failure = outcome.kind === 'failure' ? outcome.reason : sanitized === null ? 'the DNS answer is malformed' : null;

    entry.lastAttemptAt = finishedAt;
    if (sanitized !== null && failure === null) {
      const before = entry.addresses;
      const first = entry.answer === null;
      const recovered = entry.failure !== null;
      if (sanitized.addresses.length === 0) {
        // The name has no (usable) address now: nothing earlier is kept.
        entry.seen.clear();
        entry.addresses = [];
      } else {
        mergeAnswer(entry, sanitized, finishedAt);
      }
      entry.answer = {
        usable: sanitized.usable,
        refused: sanitized.refused,
        refusedTotal: sanitized.refusedTotal,
        at: new Date(finishedAt).toISOString(),
      };
      entry.failure = null;
      entry.failures = 0;
      entry.expiredAfterMs = null;
      entry.staleMs = 0;
      entry.observedAt = finishedAt;
      logAnswer(entry, before, first, recovered, sanitized, durationMs);
    } else {
      // The first failure of a streak is a warning; while it lasts, the retries are not.
      logger.log(entry.failures === 0 ? 'warn' : 'debug', 'domain lookup failed', {
        ...describe(entry),
        error: failure,
        consecutive: entry.failures + 1,
        keptAddresses: entry.addresses.length,
        durationMs,
        ...(entry.source === 'interface' ? { hint: 'set `dns` in the rule if only an internal server knows the name' } : {}),
      });
      entry.failure = failure;
      entry.failures += 1;
      checkExpiry(entry, finishedAt);
    }
    setDue(entry);
    announce(entry);
  };

  const finish = (flight: Flight, outcome: LookupOutcome): void => {
    if (!isCurrent(flight)) {
      logger.debug('late DNS answer ignored', { domain: flight.entry.domain, servers: flight.entry.servers });
      return;
    }
    release(flight);
    settle(flight.entry, outcome, flight.startedAt);
    pump();
    scheduleWheel();
    notifyIdle();
  };

  const startFlight = (entry: Entry): void => {
    entry.queued = false;
    entry.generation += 1;
    const flight: Flight = {
      entry,
      generation: entry.generation,
      startedAt: now().getTime(),
      failing: entry.failures > 0,
      proven: isProven(entry),
      resolver: null,
      timer: null,
    };
    entry.flight = flight;
    active.add(flight);
    flight.timer = setTimer(() => {
      guarded('lookup timeout', () => {
        flight.timer = null;
        if (!isCurrent(flight)) return;
        cancelQuietly(flight);
        finish(flight, { kind: 'failure', reason: `the DNS lookup timed out after ${String(LOOKUP_TIMEOUT_MS)} ms` });
      });
    }, LOOKUP_TIMEOUT_MS);

    let lookup: Promise<unknown>;
    try {
      const resolver = createResolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES });
      flight.resolver = resolver;
      // In order: the resolver falls back to the next server when one does not answer.
      if (entry.servers.length > 0) resolver.setServers(entry.servers);
      lookup = Promise.resolve(resolver.resolve4(entry.domain));
    } catch (error) {
      lookup = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    lookup.then(
      (raw) => {
        guarded('lookup answer', () => {
          finish(flight, { kind: 'answer', raw });
        });
      },
      (error: unknown) => {
        guarded('lookup failure', () => {
          finish(flight, outcomeOfRejection(error));
        });
      },
    );
  };

  /**
   * Starts queued lookups while there is room, in three rounds:
   * 1. for every server set that has no lookup running for a name that is new
   *    or failing, the first such name in the queue. This is the reserved
   *    slot: however many refreshes of answering names are due, a name that
   *    has never been looked up waits for at most the names of its kind ahead
   *    of it, never for the refreshes;
   * 2. names that answered last time (their refresh is quick and their routes
   *    are in use);
   * 3. the remaining new and failing names.
   * Within a round, first come, first served. An entry whose server set is at
   * its limit is passed over, not waited for.
   */
  function pump(): void {
    if (queue.length === 0 || active.size >= MAX_CONCURRENT_LOOKUPS) return;
    interface Load {
      total: number;
      failing: number;
      unproven: number;
    }
    const load = new Map<string, Load>();
    const loadOf = (serverKey: string): Load => {
      let counts = load.get(serverKey);
      if (counts === undefined) {
        counts = { total: 0, failing: 0, unproven: 0 };
        load.set(serverKey, counts);
      }
      return counts;
    };
    for (const flight of active) {
      const counts = loadOf(flight.entry.serverKey);
      counts.total += 1;
      if (flight.failing) counts.failing += 1;
      if (!flight.proven) counts.unproven += 1;
    }
    const round = (proven: boolean, reservedOnly: boolean): void => {
      let index = 0;
      while (index < queue.length && active.size < MAX_CONCURRENT_LOOKUPS) {
        const entry = queue[index];
        if (entry === undefined || !entry.queued) {
          queue.splice(index, 1);
          continue;
        }
        const failing = entry.failures > 0;
        const counts = loadOf(entry.serverKey);
        const room =
          counts.total < MAX_LOOKUPS_PER_SERVER_SET &&
          (!failing || counts.failing < MAX_FAILING_LOOKUPS_PER_SERVER_SET) &&
          (!reservedOnly || counts.unproven === 0);
        if (isProven(entry) !== proven || !room) {
          index += 1;
          continue;
        }
        queue.splice(index, 1);
        counts.total += 1;
        if (failing) counts.failing += 1;
        if (!proven) counts.unproven += 1;
        startFlight(entry);
      }
    };
    round(false, true);
    round(true, false);
    round(false, false);
  }

  const enqueue = (entry: Entry): void => {
    if (entry.queued || entry.flight !== null) return;
    entry.queued = true;
    queue.push(entry);
  };

  function onWheel(): void {
    wheel = null;
    const at = tick();
    for (const entry of entries.values()) {
      if (checkExpiry(entry, at)) announce(entry);
      if (isIdle(entry) && entry.dueAt !== null && entry.dueAt <= at) enqueue(entry);
    }
    pump();
    scheduleWheel();
  }

  // -------------------------------------------------------------------------
  // Entries and their rules
  // -------------------------------------------------------------------------

  const dropEntry = (entry: Entry): void => {
    const { flight } = entry;
    if (flight !== null) {
      release(flight);
      cancelQuietly(flight);
    }
    // Also for an entry without a lookup: nothing that still refers to it may count.
    entry.generation += 1;
    if (entry.queued) {
      entry.queued = false;
      queue = queue.filter((queued) => queued !== entry);
    }
    entries.delete(entry.key);
  };

  /** Returns whether the entry was dropped because no rule uses it any more. */
  const unsubscribe = (ruleId: string): boolean => {
    const subscription = subscriptions.get(ruleId);
    subscriptions.delete(ruleId);
    if (subscription === undefined) return false;
    if (subscription.dns !== null) excluded = null;
    const entry = entries.get(subscription.key);
    if (entry === undefined) return false;
    entry.subscribers.delete(ruleId);
    if (entry.subscribers.size > 0) {
      if (isIdle(entry)) setDue(entry);
      return false;
    }
    dropEntry(entry);
    return true;
  };

  const settleAfterChange = (): void => {
    // Nothing is tracked any more: a reconcile that was about to be asked for has no subject.
    if (entries.size === 0 && debounce !== null) {
      clearTimer(debounce.handle);
      debounce = null;
    }
    pump();
    scheduleWheel();
    notifyIdle();
  };

  /**
   * Makes room for one more rule when the table is full: the rule that was
   * asked about longest ago goes. With `syncConfig` wired to the engine this
   * never happens; without it, ids of rules that no longer exist would pile up
   * until no new rule could be resolved.
   */
  const evictLeastRecentlyUsed = (): void => {
    let oldestId: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [ruleId, subscription] of subscriptions) {
      if (subscription.seq < oldestSeq) {
        oldestId = ruleId;
        oldestSeq = subscription.seq;
      }
    }
    if (oldestId === undefined) return;
    // Once is enough: it says that `syncConfig` is not being called.
    logger.log(evictionReported ? 'debug' : 'warn', 'too many rules are tracked; the one asked about longest ago is dropped', {
      ruleId: oldestId,
      limit: LIMITS.maxRules,
    });
    evictionReported = true;
    warnedNoServer.delete(oldestId);
    unsubscribe(oldestId);
  };

  const subscribe = (rule: Rule, identity: Identity): Entry => {
    const previous = subscriptions.get(rule.id);
    if (previous !== undefined && previous.key !== identity.key) unsubscribe(rule.id);
    if (!subscriptions.has(rule.id) && subscriptions.size >= LIMITS.maxRules) evictLeastRecentlyUsed();

    let entry = entries.get(identity.key);
    if (entry === undefined) {
      entry = {
        key: identity.key,
        domain: identity.domain,
        servers: identity.servers,
        source: identity.source,
        serverKey: identity.servers.join(','),
        subscribers: new Map(),
        generation: 0,
        flight: null,
        queued: false,
        seen: new Map(),
        addresses: [],
        answer: null,
        failure: null,
        failures: 0,
        staleMs: 0,
        observedAt: null,
        expiredAfterMs: null,
        lastAttemptAt: null,
        dueAt: null,
        served: null,
        announced: null,
        warned: '',
      };
      entries.set(identity.key, entry);
    }
    const refreshSec = refreshSecOf(rule);
    const changed = entry.subscribers.get(rule.id) !== refreshSec;
    entry.subscribers.set(rule.id, refreshSec);
    askSeq += 1;
    const ruleDns = identity.source === 'rule' ? (identity.servers[0] ?? null) : null;
    if (subscriptions.get(rule.id)?.dns !== ruleDns) excluded = null;
    subscriptions.set(rule.id, { key: identity.key, base: identity.base, dns: ruleDns, seq: askSeq });
    // A changed `refreshSec` moves the next refresh; the cached answer stays.
    if (changed && isIdle(entry)) setDue(entry);
    return entry;
  };

  const noteInterfaces = (context: DomainContext): void => {
    // As long as the engine makes it: a server cut off here would be routed.
    const servers = usableServers(context.interfaceDnsServers, MAX_EXCLUDED_DNS_SERVERS);
    if (sameList(servers, interfaceDns)) return;
    interfaceDns = servers;
    excluded = null;
  };

  /** Records what was handed to the engine and lets the background work go on. */
  const serve = (entry: Entry, at: number): DomainTargets => {
    // Noticed here, it needs no announcement: the engine is asking right now.
    checkExpiry(entry, at);
    // Never resolved, or due while the timer has not fired yet: look it up in the background.
    if (isIdle(entry) && (entry.dueAt === null || entry.dueAt <= at)) enqueue(entry);
    const targets = targetsOf(entry);
    entry.served = signatureOf(targets);
    settleAfterChange();
    return targets;
  };

  const resolveDomain = (rule: Rule, context?: DomainContext): DomainTargets => {
    if (stopped) return resolving('The resolver is stopped');
    const identity = rule.enabled ? identityOf(rule, context) : null;
    if (identity === null) return NOT_A_DOMAIN_RULE;
    const at = tick();
    if (!systemDnsRead) refreshSystemServers();
    if (context !== undefined) noteInterfaces(context);

    if (identity.source === 'system' && context?.dnsServers === null) {
      // The servers of the interface are not known yet and a trustworthy detection is on its way:
      // asking the system resolvers now would probably ask the wrong server. What the rule already
      // has is served as it is; a rule that has nothing waits.
      const current = entries.get(subscriptions.get(rule.id)?.key ?? '');
      const subscription = subscriptions.get(rule.id);
      if (current === undefined || subscription?.base !== identity.base) {
        return resolving(`Waiting for the DNS server of the ${rule.iface} interface to be known`);
      }
      askSeq += 1;
      subscription.seq = askSeq;
      return serve(current, at);
    }

    const entry = subscribe(rule, identity);
    // One warning per episode: when the rule starts being asked from the system resolvers. It is
    // warned again only after it has had a server of its own or of its interface in between, or
    // after it was removed and came back.
    if (identity.source !== 'system') {
      warnedNoServer.delete(rule.id);
    } else if (context !== undefined && !warnedNoServer.has(rule.id)) {
      warnedNoServer.add(rule.id);
      logger.warn('no DNS server is known for the interface of the rule; the system resolvers are asked', {
        ruleId: rule.id,
        domain: identity.domain,
        iface: rule.iface,
      });
    }
    return serve(entry, at);
  };

  const syncConfig = (config: Pick<Config, 'enabled' | 'rules'>): void => {
    if (stopped) return;
    const wanted = new Map<string, { readonly base: string; readonly refreshSec: number }>();
    const ruleServers: string[] = [];
    if (config.enabled) {
      for (const rule of config.rules.slice(0, LIMITS.maxRules)) {
        const identity = rule.enabled ? identityOf(rule, undefined) : null;
        if (identity === null) continue;
        wanted.set(rule.id, { base: identity.base, refreshSec: refreshSecOf(rule) });
        if (identity.source === 'rule') ruleServers.push(...identity.servers);
      }
    }
    if (!sameList(ruleServers, configDns)) {
      configDns = ruleServers;
      excluded = null;
    }
    let dropped = 0;
    for (const [ruleId, subscription] of [...subscriptions]) {
      const keep = wanted.get(ruleId);
      if (keep?.base !== subscription.base) {
        // The rule is gone or was edited: a new episode starts if it ever falls back again.
        warnedNoServer.delete(ruleId);
        if (unsubscribe(ruleId)) dropped += 1;
        continue;
      }
      const entry = entries.get(subscription.key);
      if (entry !== undefined && entry.subscribers.get(ruleId) !== keep.refreshSec) {
        entry.subscribers.set(ruleId, keep.refreshSec);
        if (isIdle(entry)) setDue(entry);
      }
    }
    if (dropped > 0) logger.info('domains no longer resolved', { dropped, tracked: entries.size });
    settleAfterChange();
  };

  const refreshAll = (): void => {
    if (stopped || entries.size === 0) return;
    refreshSystemServers();
    for (const entry of entries.values()) {
      const { flight } = entry;
      if (flight !== null) {
        release(flight);
        cancelQuietly(flight);
      }
      // The network is different now: the next failure starts a new streak.
      entry.failures = 0;
      enqueue(entry);
    }
    logger.info('resolving every domain again', { domains: entries.size });
    settleAfterChange();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const entry of [...entries.values()]) dropEntry(entry);
    subscriptions.clear();
    warnedNoServer.clear();
    queue = [];
    if (wheel !== null) clearTimer(wheel.handle);
    wheel = null;
    if (debounce !== null) clearTimer(debounce.handle);
    debounce = null;
    notifyIdle();
  };

  return {
    resolveDomain,
    syncConfig,
    refreshAll,
    whenIdle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        notifyIdle();
      }),
    stats: () => ({
      entries: entries.size,
      inFlight: active.size,
      queued: queue.length,
      timers: active.size + (wheel === null ? 0 : 1) + (debounce === null ? 0 : 1),
    }),
    stop,
  };
};
