import { Resolver } from 'node:dns/promises';

import { LIMITS, normalizeDomain, normalizeHostAddress, type Config, type Rule, type RuleReasonCode } from '@routeswitch/shared';

import type { DomainTargets } from './engine';
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
 * `Resolver.resolve4` and not `dns.lookup`, deliberately:
 * - only a `Resolver` can query one given server (`rule.dns`);
 * - `dns.lookup` runs `getaddrinfo` on the libuv thread pool, where it can be
 *   neither cancelled nor timed out, and a few hanging lookups would starve
 *   the file-system work of the daemon;
 * - `resolve4` returns A records only.
 * The limitation: a `Resolver` without servers of its own asks the DNS servers
 * of the primary network service, directly. It does not read `/etc/hosts`,
 * does not resolve mDNS names and does not follow the scoped resolvers of
 * macOS (`/etc/resolver/<domain>`, per-interface DNS). A domain that only an
 * internal DNS server knows therefore needs `dns` in its rule; with it the
 * query goes to that server, which is also what the `/etc/resolver` file of
 * the rule makes the rest of the system do.
 *
 * Nothing here adds the route to the DNS server or writes resolver files. The
 * module that does (scoped DNS) wraps `resolveDomain` and puts `rule.dns` in
 * front of `destinations`; the engine applies one destination more than
 * `LIMITS.maxIpsPerDomain` per rule for exactly that. A first query that went
 * out before that route existed fails and is retried after `RETRY_FLOOR_MS`,
 * or at once when `refreshAll()` is called.
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
  /** For `EngineDeps.resolveDomain` (a `DomainResolver`). Synchronous: answers from the cache, never waits for the network. */
  readonly resolveDomain: (rule: Rule) => DomainTargets;
  /**
   * Tells the resolver which rules exist now. Everything that belongs to a
   * rule that was removed, disabled or pointed at another domain or server is
   * dropped: its cached answer, its running lookup and its refresh. With the
   * global toggle off everything is dropped. Call it after every config or
   * toggle change, before the reconcile that follows.
   */
  syncConfig(config: Pick<Config, 'enabled' | 'rules'>): void;
  /**
   * Resolves every tracked domain again right away (the network changed).
   * Cached answers keep being served until the new ones arrive; running
   * lookups are cancelled and started again.
   */
  refreshAll(): void;
  /** Resolves when no lookup is running or queued. Does not wait for scheduled refreshes or retries. */
  whenIdle(): Promise<void>;
  stats(): DomainResolverStats;
  /** Cancels every lookup and timer and forgets everything. Afterwards `resolveDomain` starts nothing. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface SanitizedAnswer {
  /** Usable addresses: unique, in ascending numeric order, at most `LIMITS.maxIpsPerDomain`. */
  readonly addresses: readonly string[];
  /** Unique usable addresses before the cap. */
  readonly usable: number;
  /** Records that were dropped, by reason (`loopback`, `invalid-ipv4`, ...). */
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
 * forbidden destination. The survivors are de-duplicated and sorted by
 * numeric value, so the same set in another order is the same answer; when
 * there are more than `LIMITS.maxIpsPerDomain`, the numerically lowest ones
 * are kept.
 */
export const sanitizeAnswer = (raw: unknown): SanitizedAnswer | null => {
  if (!Array.isArray(raw) || raw.length > MAX_ANSWER_RECORDS) return null;
  const records: readonly unknown[] = raw;
  const unique = new Set<string>();
  const refused: Record<string, number> = {};
  let refusedTotal = 0;
  for (const record of records) {
    const result =
      typeof record === 'string' && record.length <= MAX_IPV4_TEXT_LENGTH ? normalizeHostAddress(record) : null;
    if (result?.ok === true) {
      unique.add(result.value);
      continue;
    }
    const code = result === null ? 'invalid-ipv4' : result.error.code;
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

interface Answer {
  readonly addresses: readonly string[];
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
  resolver: DnsResolverLike | null;
  timer: unknown;
}

/** One distinct lookup: a domain asked from one server (or from the system's). */
interface Entry {
  readonly key: string;
  readonly domain: string;
  readonly server: string | null;
  /** Rule id -> `refreshSec` of the rules that use this lookup. */
  readonly subscribers: Map<string, number>;
  /** Goes up whenever a lookup starts or is given up; an answer of an older generation is ignored. */
  generation: number;
  flight: Flight | null;
  queued: boolean;
  /** The last successful answer; kept while later lookups fail. */
  answer: Answer | null;
  /** Why the last lookup failed; null after a success. */
  failure: string | null;
  failures: number;
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
  readonly domain: string;
  readonly server: string | null;
}

const NOT_A_DOMAIN_RULE: DomainTargets = {
  destinations: [],
  status: 'error',
  reasonCode: 'internal',
  reason: 'The rule cannot be resolved: it is not a valid domain rule',
  lastResolvedAt: null,
};

const TOO_MANY: DomainTargets = {
  destinations: [],
  status: 'error',
  reasonCode: 'internal',
  reason: 'Too many domains are being resolved',
  lastResolvedAt: null,
};

const resolving = (reason: string): DomainTargets => ({
  destinations: [],
  status: 'pending',
  reasonCode: 'resolving',
  reason,
  lastResolvedAt: null,
});

/** What determines the answer: the domain and the server asked. Null when either is not valid. */
const identityOf = (rule: Pick<Rule, 'kind' | 'target' | 'dns'>): Identity | null => {
  if (rule.kind !== 'domain' || typeof rule.target !== 'string') return null;
  const domain = normalizeDomain(rule.target);
  if (!domain.ok) return null;
  if (rule.dns === undefined) return { key: `${domain.value}|`, domain: domain.value, server: null };
  const server = typeof rule.dns === 'string' ? normalizeHostAddress(rule.dns) : null;
  if (server?.ok !== true) return null;
  return { key: `${domain.value}|${server.value}`, domain: domain.value, server: server.value };
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

const describeRefused = (answer: Answer): string =>
  Object.entries(answer.refused)
    .map(([code, count]) => `${code}: ${String(count)}`)
    .join(', ');

/** What the engine is told for an entry in its current state. */
const targetsOf = (entry: Entry): DomainTargets => {
  const { answer, failure } = entry;
  const lastResolvedAt = answer?.at ?? null;
  const destinations = answer?.addresses ?? [];
  const verdict = (status: DomainTargets['status'], reasonCode: RuleReasonCode | null, reason: string | null): DomainTargets => ({
    destinations,
    status,
    reasonCode,
    reason,
    lastResolvedAt,
  });

  if (failure !== null) {
    return verdict(
      'error',
      'resolve-failed',
      answer === null
        ? `Could not resolve ${entry.domain}: ${failure}`
        : `Could not refresh ${entry.domain}: ${failure}; the last known ${plural(destinations.length, 'address')} stay routed`,
    );
  }
  if (answer === null) return resolving(`Resolving ${entry.domain}`);
  if (destinations.length === 0) {
    return verdict(
      'error',
      'no-addresses',
      answer.refusedTotal === 0
        ? `${entry.domain} has no A records`
        : `${entry.domain} has no usable A records: ${plural(answer.refusedTotal, 'address')} must never be routed (${describeRefused(answer)})`,
    );
  }
  const truncated = answer.usable > destinations.length;
  const truncation = `${entry.domain} has ${String(answer.usable)} addresses; the ${String(destinations.length)} lowest are routed`;
  if (answer.refusedTotal > 0) {
    return verdict(
      'error',
      'forbidden-destination',
      `${plural(answer.refusedTotal, 'resolved address')} of ${entry.domain} must never be routed (${describeRefused(answer)})${truncated ? `; ${truncation}` : ''}`,
    );
  }
  return truncated ? verdict('active', 'addresses-truncated', truncation) : verdict('active', null, null);
};

/** Status, code and addresses: what makes a pass of the engine come out differently. */
const signatureOf = (targets: DomainTargets): string =>
  `${targets.status}|${String(targets.reasonCode)}|${targets.destinations.join(',')}`;

export const createDomainResolver = (deps: DomainResolverDeps): DomainResolverService => {
  const logger = deps.logger.child({ component: 'dns' });
  const now = deps.now ?? (() => new Date());
  const createResolver = deps.createResolver ?? createSystemResolver;
  const setTimer = deps.setTimer ?? realSetTimer;
  const clearTimer = deps.clearTimer ?? realClearTimer;

  const entries = new Map<string, Entry>();
  /** Rule id -> key of the entry the rule subscribes to. */
  const ruleKeys = new Map<string, string>();
  const active = new Set<Flight>();
  let queue: Entry[] = [];
  let idleWaiters: (() => void)[] = [];
  let stopped = false;

  /** The one refresh timer, set for the earliest `dueAt` of all idle entries. */
  let wheel: { readonly handle: unknown; readonly at: number } | null = null;
  let debounce: { readonly handle: unknown } | null = null;

  const nowMs = (): number => now().getTime();

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

  const scheduleWheel = (): void => {
    let earliest: number | null = null;
    for (const entry of entries.values()) {
      if (isIdle(entry) && entry.dueAt !== null && (earliest === null || entry.dueAt < earliest)) earliest = entry.dueAt;
    }
    if (wheel !== null) {
      if (wheel.at === earliest) return;
      clearTimer(wheel.handle);
      wheel = null;
    }
    if (earliest === null) return;
    // A clock that jumped must not produce a negative or an absurd delay.
    const delay = Math.min(Math.max(earliest - nowMs(), 0), LIMITS.refreshSecMax * 1000);
    wheel = {
      handle: setTimer(() => {
        guarded('refresh timer', onWheel);
      }, delay),
      at: earliest,
    };
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

  const logAnswer = (entry: Entry, previous: Answer | null, answer: Answer, recovered: boolean, durationMs: number): void => {
    const before = new Set(previous?.addresses ?? []);
    const after = new Set(answer.addresses);
    const added = answer.addresses.filter((address) => !before.has(address)).length;
    const removed = [...before].filter((address) => !after.has(address)).length;
    const changed = previous === null || added > 0 || removed > 0;
    const context = { domain: entry.domain, dns: entry.server, addresses: answer.addresses.length, added, removed, durationMs };
    logger.log(changed || recovered ? 'info' : 'debug', changed ? 'domain resolved' : 'domain resolved; addresses unchanged', context);

    const truncated = answer.usable > answer.addresses.length;
    const situation = answer.refusedTotal === 0 && !truncated ? '' : `${describeRefused(answer)}|${truncated ? String(answer.usable) : ''}`;
    if (answer.refusedTotal > 0) {
      logger.log(situation === entry.warned ? 'debug' : 'warn', 'resolved addresses refused; they are never routed', {
        domain: entry.domain,
        dns: entry.server,
        refused: answer.refusedTotal,
        reasons: answer.refused,
      });
    }
    if (truncated) {
      logger.log(situation === entry.warned ? 'debug' : 'warn', 'more addresses than the per-domain limit; the lowest are routed', {
        domain: entry.domain,
        dns: entry.server,
        resolved: answer.usable,
        kept: answer.addresses.length,
        limit: LIMITS.maxIpsPerDomain,
      });
    }
    entry.warned = situation;
  };

  const settle = (entry: Entry, outcome: LookupOutcome, startedAt: number): void => {
    const finishedAt = nowMs();
    const durationMs = Math.max(0, finishedAt - startedAt);
    const sanitized = outcome.kind === 'answer' ? sanitizeAnswer(outcome.raw) : null;
    const failure = outcome.kind === 'failure' ? outcome.reason : sanitized === null ? 'the DNS answer is malformed' : null;

    entry.lastAttemptAt = finishedAt;
    if (sanitized !== null && failure === null) {
      const previous = entry.answer;
      const recovered = entry.failure !== null;
      entry.answer = { ...sanitized, at: new Date(finishedAt).toISOString() };
      entry.failure = null;
      entry.failures = 0;
      logAnswer(entry, previous, entry.answer, recovered, durationMs);
    } else {
      // The first failure of a streak is a warning; while it lasts, the retries are not.
      logger.log(entry.failures === 0 ? 'warn' : 'debug', 'domain lookup failed', {
        domain: entry.domain,
        dns: entry.server,
        error: failure,
        consecutive: entry.failures + 1,
        keptAddresses: entry.answer?.addresses.length ?? 0,
        durationMs,
      });
      entry.failure = failure;
      entry.failures += 1;
    }
    setDue(entry);
    const signature = signatureOf(targetsOf(entry));
    if (entry.served === null || signature === entry.served || signature === entry.announced) return;
    entry.announced = signature;
    requestReconcileSoon();
  };

  const finish = (flight: Flight, outcome: LookupOutcome): void => {
    if (!isCurrent(flight)) {
      logger.debug('late DNS answer ignored', { domain: flight.entry.domain, dns: flight.entry.server });
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
    const flight: Flight = { entry, generation: entry.generation, startedAt: nowMs(), resolver: null, timer: null };
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
      if (entry.server !== null) resolver.setServers([entry.server]);
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

  function pump(): void {
    while (active.size < MAX_CONCURRENT_LOOKUPS) {
      const entry = queue.shift();
      if (entry === undefined) return;
      if (entry.queued) startFlight(entry);
    }
  }

  const enqueue = (entry: Entry): void => {
    if (entry.queued || entry.flight !== null) return;
    entry.queued = true;
    queue.push(entry);
  };

  function onWheel(): void {
    wheel = null;
    const at = nowMs();
    for (const entry of entries.values()) {
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
    const key = ruleKeys.get(ruleId);
    ruleKeys.delete(ruleId);
    const entry = key === undefined ? undefined : entries.get(key);
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
    pump();
    scheduleWheel();
    notifyIdle();
  };

  const subscribe = (rule: Rule, identity: Identity): Entry | null => {
    const previousKey = ruleKeys.get(rule.id);
    if (previousKey !== undefined && previousKey !== identity.key) unsubscribe(rule.id);

    let entry = entries.get(identity.key);
    if (entry === undefined) {
      if (entries.size >= LIMITS.maxRules || ruleKeys.size >= LIMITS.maxRules) return null;
      entry = {
        ...identity,
        subscribers: new Map(),
        generation: 0,
        flight: null,
        queued: false,
        answer: null,
        failure: null,
        failures: 0,
        lastAttemptAt: null,
        dueAt: null,
        served: null,
        announced: null,
        warned: '',
      };
      entries.set(identity.key, entry);
    } else if (!ruleKeys.has(rule.id) && ruleKeys.size >= LIMITS.maxRules) {
      return null;
    }
    const refreshSec = refreshSecOf(rule);
    const changed = entry.subscribers.get(rule.id) !== refreshSec;
    entry.subscribers.set(rule.id, refreshSec);
    ruleKeys.set(rule.id, identity.key);
    // A changed `refreshSec` moves the next refresh; the cached answer stays.
    if (changed && isIdle(entry)) setDue(entry);
    return entry;
  };

  const resolveDomain = (rule: Rule): DomainTargets => {
    if (stopped) return resolving('The resolver is stopped');
    const identity = rule.enabled ? identityOf(rule) : null;
    if (identity === null) return NOT_A_DOMAIN_RULE;
    const entry = subscribe(rule, identity);
    if (entry === null) {
      settleAfterChange();
      return TOO_MANY;
    }
    // Never resolved, or due while the timer has not fired yet: look it up in the background.
    if (isIdle(entry) && (entry.dueAt === null || entry.dueAt <= nowMs())) enqueue(entry);
    const targets = targetsOf(entry);
    entry.served = signatureOf(targets);
    settleAfterChange();
    return targets;
  };

  const syncConfig = (config: Pick<Config, 'enabled' | 'rules'>): void => {
    if (stopped) return;
    const wanted = new Map<string, { readonly key: string; readonly refreshSec: number }>();
    if (config.enabled) {
      for (const rule of config.rules) {
        const identity = rule.enabled ? identityOf(rule) : null;
        if (identity !== null) wanted.set(rule.id, { key: identity.key, refreshSec: refreshSecOf(rule) });
      }
    }
    let dropped = 0;
    for (const [ruleId, key] of [...ruleKeys]) {
      const keep = wanted.get(ruleId);
      if (keep?.key !== key) {
        if (unsubscribe(ruleId)) dropped += 1;
        continue;
      }
      const entry = entries.get(key);
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
    ruleKeys.clear();
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
