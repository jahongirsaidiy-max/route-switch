import {
  PATHS,
  PROTOCOL_LIMITS,
  cidrContains,
  claimOf,
  claimPrecedence,
  compareClaim,
  diagnoseTargetKind,
  isWildcardDomain,
  matchDomainRule,
  parseIpv4Destination,
  wildcardBase,
  wildcardDepth,
  type AddressClaim,
  type Config,
  type DiagnoseAddress,
  type DiagnoseDns,
  type DiagnoseMatch,
  type DiagnoseMatchVia,
  type DiagnoseNote,
  type DiagnosePrecedence,
  type DiagnoseResult,
  type EngineState,
  type IfaceRole,
  type Rule,
  type RuleReasonCode,
} from '@routeswitch/shared';

import type { CachedDomain, ProbeResult } from './dns';
import type { AppliedRoute } from './engine';
import type { Logger } from './logger';
import { isExplicitTarget, planningOrder } from './precedence';
import { resolverFileName } from './resolver';
import type { RouteGetResult } from './route';

/**
 * The `diagnose` method: explains how traffic to one address or name leaves
 * the machine. Read-only by construction: it reads the engine's config, state
 * and applied routes, the DNS module's cache, looks routes up with
 * `route -n get` and sends at most one DNS query. It never adds, removes or
 * writes anything and never asks the engine for a pass.
 *
 * A root daemon must not become a resolver for arbitrary names: a domain is
 * looked up only when an enabled domain rule names it exactly, or a wildcard
 * rule covers it (`*.corp.local` covers `app.corp.local`, never `corp.local`;
 * the same match as the DNS proxy's, `matchDomainRule`). Any other name
 * is answered with `name-not-covered` and nothing is sent anywhere; the app
 * resolves it itself, without privileges, and asks again for each address.
 *
 * Which rule matches comes from `precedence.ts`, the module the engine plans
 * its passes with, so the explanation follows the same rules as the routing.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface DiagnoseLimits {
  /** `diagnose` requests one connection may have running; one more is refused. */
  readonly perConnectionParallel: number;
  /** `diagnose` requests one connection may start per `windowMs`. */
  readonly perConnectionPerWindow: number;
  readonly windowMs: number;
  /** `diagnose` requests running at the same time, all connections together. */
  readonly totalParallel: number;
  /** Time one request may take before it is answered `operation-failed`. */
  readonly deadlineMs: number;
}

export const DIAGNOSE_LIMITS: DiagnoseLimits = {
  perConnectionParallel: 1,
  perConnectionPerWindow: 10,
  windowMs: 60_000,
  totalParallel: 2,
  deadlineMs: 8000,
};

export type DiagnoseRefusal = 'connection-busy' | 'connection-rate' | 'busy';

export type DiagnoseSlot = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly reason: DiagnoseRefusal };

export interface DiagnoseLimiter {
  /** Takes a slot for one request of `connection`, or says why not. A request that is refused is not counted. */
  tryAcquire(connection: number): DiagnoseSlot;
  /** Connections remembered (running or within the window), for tests. */
  tracked(): number;
}

/**
 * Admission of `diagnose` requests. Refuses instead of queueing: a client that
 * asks too much is told so at once and holds nothing. A slot is held until
 * the work behind it has really finished, not only until it was answered, so
 * work cut off by the deadline still counts against the limits.
 */
export const createDiagnoseLimiter = (limits: DiagnoseLimits, monotonicNow: () => number): DiagnoseLimiter => {
  const perConnection = new Map<number, { running: number; started: number[] }>();
  let running = 0;

  const prune = (now: number): void => {
    for (const [connection, entry] of perConnection) {
      entry.started = entry.started.filter((at) => now - at < limits.windowMs && at <= now);
      if (entry.running === 0 && entry.started.length === 0) perConnection.delete(connection);
    }
  };

  const tryAcquire = (connection: number): DiagnoseSlot => {
    const now = monotonicNow();
    prune(now);
    const entry = perConnection.get(connection) ?? { running: 0, started: [] };
    if (entry.running >= limits.perConnectionParallel) return { ok: false, reason: 'connection-busy' };
    if (entry.started.length >= limits.perConnectionPerWindow) return { ok: false, reason: 'connection-rate' };
    if (running >= limits.totalParallel) return { ok: false, reason: 'busy' };
    entry.running += 1;
    entry.started.push(now);
    perConnection.set(connection, entry);
    running += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        running -= 1;
        entry.running -= 1;
        prune(monotonicNow());
      },
    };
  };

  return { tryAcquire, tracked: () => perConnection.size };
};

// ---------------------------------------------------------------------------
// Which rule matches (pure)
// ---------------------------------------------------------------------------

interface Candidate {
  readonly rule: Rule;
  /** Prefix length of the destination the rule would route the address with. */
  readonly prefix: number;
  readonly explicit: boolean;
  readonly via: DiagnoseMatchVia;
  /** Position in the engine's planning order: the tie-break between equal claims. */
  readonly order: number;
}

const isWildcardRule = (rule: Pick<Rule, 'kind' | 'target'>): boolean => rule.kind === 'domain' && isWildcardDomain(rule.target);

export interface AddressMatch {
  /** The winning enabled rule and why; null when no enabled rule covers the address. */
  readonly match: DiagnoseMatch | null;
  readonly rule: Rule | null;
  /** True when a rule that is switched off (by its own toggle) covers the address. */
  readonly disabledCover: boolean;
}

/**
 * The addresses a domain rule's lookup currently has, or null when there is
 * no answer yet; for a wildcard rule, the addresses routed for it (learned).
 */
export type CachedAddresses = (ruleId: string) => readonly string[] | null;

const covers = (rule: Rule, address: string, cached: CachedAddresses): Omit<Candidate, 'rule' | 'order'> | null => {
  if (rule.kind !== 'domain') {
    const destination = parseIpv4Destination(rule.target);
    if (destination === null || !cidrContains(destination.cidr, address)) return null;
    return { prefix: destination.prefix, explicit: isExplicitTarget(rule, rule.target), via: rule.kind };
  }
  if (rule.dns === address) return { prefix: 32, explicit: isExplicitTarget(rule, address), via: 'dns-server' };
  if (cached(rule.id)?.includes(address) === true) {
    return { prefix: 32, explicit: isExplicitTarget(rule, address), via: isWildcardRule(rule) ? 'wildcard' : 'domain' };
  }
  return null;
};

const claimOfCandidate = (candidate: Candidate): AddressClaim => claimOf(candidate.rule, candidate.explicit, candidate.order);

/** Strongest claim first (`compareClaim`, the engine's order for one address — ADR-002 §3). */
const byClaim = (a: Candidate, b: Candidate): number => compareClaim(claimOfCandidate(a), claimOfCandidate(b));

const precedenceOf = (winner: Candidate, candidates: readonly Candidate[]): DiagnosePrecedence => {
  if (candidates.length === 1) return 'only-match';
  const [strongestRival] = candidates.filter((candidate) => candidate !== winner && candidate.prefix === winner.prefix).sort(byClaim);
  if (strongestRival !== undefined) {
    // Same destination: an explicit target beats any name's address, an exact domain a wildcard,
    // a deeper wildcard a shallower one; otherwise the one planned first won.
    return claimPrecedence(claimOfCandidate(winner), claimOfCandidate(strongestRival));
  }
  // Only wider destinations are left: the kernel picks the longest prefix.
  if (winner.prefix === 32) return winner.explicit ? 'host-route' : 'domain-address';
  return 'longest-prefix';
};

/**
 * The rule that owns `address`, by the engine's rules (`precedence.ts`): the
 * longest prefix that covers it wins; for the same destination an explicit
 * target beats a resolved address, an exact domain's address a learned one,
 * a deeper wildcard a shallower one (`compareClaim`), then planning order
 * decides. Only enabled rules match; with the global toggle off none does.
 */
export const matchAddress = (address: string, config: Config, cached: CachedAddresses): AddressMatch => {
  const candidates: Candidate[] = [];
  let disabledCover = false;
  for (const [order, rule] of planningOrder(config.rules).entries()) {
    const found = covers(rule, address, cached);
    if (found === null) continue;
    if (!rule.enabled) {
      disabledCover = true;
      continue;
    }
    if (config.enabled) candidates.push({ rule, ...found, order });
  }
  if (candidates.length === 0) return { match: null, rule: null, disabledCover };
  const longest = Math.max(...candidates.map((candidate) => candidate.prefix));
  const [winner] = candidates.filter((candidate) => candidate.prefix === longest).sort(byClaim);
  if (winner === undefined) return { match: null, rule: null, disabledCover };
  return {
    match: { ruleId: winner.rule.id, via: winner.via, precedence: precedenceOf(winner, candidates) },
    rule: winner.rule,
    disabledCover,
  };
};

/** True when the domain rule covers `name`: names it exactly, or is a wildcard whose base is a strict suffix of it. */
const coversName = (rule: Rule, name: string): boolean => {
  if (rule.kind !== 'domain') return false;
  if (rule.target === name) return true;
  const base = wildcardBase(rule.target);
  return base !== null && name.endsWith(`.${base}`);
};

/**
 * The enabled domain rule a name falls under — the one that names it exactly
 * (the first in config order), else the wildcard with the deepest base, as
 * the DNS proxy decides (`matchDomainRule`) — and whether a switched-off rule
 * covers it.
 */
export const matchDomain = (
  name: string,
  config: Config,
): { readonly match: DiagnoseMatch | null; readonly rule: Rule | null; readonly disabledCover: boolean } => {
  const covering = config.rules.filter((rule) => coversName(rule, name));
  const enabled = config.enabled ? covering.filter((rule) => rule.enabled) : [];
  const disabledCover = covering.some((rule) => !rule.enabled);
  const found = matchDomainRule(name, enabled);
  if (found === null) return { match: null, rule: null, disabledCover };
  const winner = found.rule;
  const rivals = enabled.filter((rule) => rule !== winner);
  let precedence: DiagnosePrecedence;
  if (found.via === 'domain') {
    // Another exact rule for the name was later in the config; a wildcard covering it lost to the exact name.
    precedence = rivals.some((rule) => rule.target === name) ? 'config-order' : rivals.length > 0 ? 'exact-domain' : 'only-match';
  } else {
    const depth = wildcardDepth(winner.target);
    precedence = rivals.some((rule) => wildcardDepth(rule.target) === depth)
      ? 'config-order'
      : rivals.length > 0
        ? 'deeper-wildcard'
        : 'only-match';
  }
  return { match: { ruleId: winner.id, via: found.via, precedence }, rule: winner, disabledCover };
};

// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------

export interface DiagnoseDeps {
  readonly getConfig: () => Config;
  readonly getState: () => EngineState;
  readonly getApplied: () => readonly AppliedRoute[];
  /**
   * The DNS module's cache, read-only. For a wildcard rule the daemon reports
   * the servers its DNS proxy forwards the rule's names to (no addresses: a
   * wildcard has no single answer).
   */
  readonly peekDomain: (ruleId: string) => CachedDomain | null;
  /** `route -n get -host`, already behind the semaphore it shares with `test`. */
  readonly routeGet: (address: string) => Promise<RouteGetResult>;
  /** One A query to one server (`probeDns`). */
  readonly probe: (server: string, name: string) => Promise<ProbeResult>;
  readonly logger: Logger;
}

/** Rule state codes that explain something about a diagnosed address, and the note each becomes. */
const STATE_NOTES: Partial<Readonly<Record<RuleReasonCode, DiagnoseNote>>> = {
  'connected-network': 'connected-network',
  'dns-server-excluded': 'dns-server-excluded',
  'no-addresses': 'no-addresses',
  'resolve-failed': 'resolve-failed',
  'addresses-truncated': 'addresses-truncated',
};

const roleOf = (state: EngineState, device: string): IfaceRole | null => {
  if (state.interfaces.ethernet.device === device) return 'ethernet';
  if (state.interfaces.wifi.device === device) return 'wifi';
  return null;
};

/**
 * Builds the result for a target that has passed the request schema (a
 * routable IPv4 address or a domain). The caller validates it with
 * `DiagnoseResult` before sending it.
 */
export const runDiagnose = async (target: string, deps: DiagnoseDeps): Promise<DiagnoseResult> => {
  const logger = deps.logger.child({ component: 'diagnose' });
  const config = deps.getConfig();
  const state = deps.getState();
  const targetKind = diagnoseTargetKind(target);
  const notes = new Set<DiagnoseNote>();
  const applied = deps.getApplied();
  const wildcardRules = new Map(config.rules.filter(isWildcardRule).map((entry) => [entry.id, entry]));
  /** A wildcard rule's addresses are the host routes applied for it: what its DNS proxy learned. */
  const learnedOf = (wildcard: Rule): string[] =>
    applied
      .filter((entry) => entry.ruleIds.includes(wildcard.id) && !entry.dst.includes('/') && entry.dst !== wildcard.dns)
      .map((entry) => entry.dst);
  const cached: CachedAddresses = (ruleId) => {
    const wildcard = wildcardRules.get(ruleId);
    return wildcard === undefined ? (deps.peekDomain(ruleId)?.addresses ?? null) : learnedOf(wildcard);
  };

  let match: DiagnoseMatch | null;
  let rule: Rule | null;
  let addresses: { readonly address: string; readonly source: DiagnoseAddress['source'] }[] = [];
  let dns: DiagnoseDns | null = null;

  if (targetKind === 'ip') {
    const found = matchAddress(target, config, cached);
    ({ match, rule } = found);
    if (match === null) notes.add('no-matching-rule');
    if (match === null && found.disabledCover) notes.add('rule-disabled');
    addresses = [{ address: target, source: 'query' }];
  } else {
    const found = matchDomain(target, config);
    ({ match, rule } = found);
    if (rule === null) {
      // Not ours to resolve: nothing is looked up, the app resolves the name itself.
      notes.add('name-not-covered');
      if (found.disabledCover) notes.add('rule-disabled');
    } else {
      const wildcard = isWildcardRule(rule);
      const lookup = deps.peekDomain(rule.id);
      const server = rule.dns ?? lookup?.servers[0] ?? null;
      // A wildcard rule has no answer for this one name cached: the query below gives it.
      const fromCache = wildcard ? null : (lookup?.addresses ?? null);
      if (fromCache !== null) addresses = fromCache.map((address) => ({ address, source: 'rule-cache' as const }));
      if (lookup?.truncated === true) notes.add('addresses-truncated');
      let probe: ProbeResult | null = null;
      if (server !== null) {
        // The one query of this request: it answers whether the server is reachable, and gives the
        // addresses when the rule has none cached yet.
        // The name asked about: the rule's own target, or a name under a wildcard's base.
        probe = await deps.probe(server, target);
        logger.debug('dns probe', { ruleId: rule.id, server, domain: target, outcome: probe.outcome, ms: probe.ms });
        if (fromCache === null && probe.outcome === 'ok') {
          addresses = probe.addresses.map((address) => ({ address, source: 'query' as const }));
          if (probe.truncated) notes.add('addresses-truncated');
        }
      }
      if (fromCache === null && probe !== null && probe.outcome !== 'ok') notes.add('resolve-failed');
      if (addresses.length === 0 && (fromCache !== null || probe?.outcome === 'ok')) notes.add('no-addresses');
      if (server !== null) {
        // A wildcard's base file points at the DNS proxy, while the proxy listens.
        const proxyDown = state.rules.some((entry) => entry.ruleId === rule?.id && entry.reasonCode === 'dns-proxy-unavailable');
        const file = wildcard
          ? proxyDown
            ? null
            : resolverFileName(wildcardBase(rule.target))
          : rule.dns === undefined
            ? null
            : resolverFileName(rule.target);
        dns = {
          server,
          role: rule.iface,
          resolverFile: file === null ? null : `${PATHS.resolverDir}/${file}`,
          outcome: probe?.outcome ?? 'not-queried',
          ms: probe?.ms ?? null,
        };
      }
    }
  }
  if (!config.enabled) notes.add('globally-disabled');

  if (rule !== null) {
    const iface = state.interfaces[rule.iface];
    if (!iface.up) notes.add('interface-down');
    else if (iface.gateway === null) notes.add('no-gateway');
    const reasonCode = state.rules.find((entry) => entry.ruleId === rule.id)?.reasonCode ?? null;
    const stateNote = reasonCode === null ? undefined : STATE_NOTES[reasonCode];
    if (stateNote !== undefined) notes.add(stateNote);
  }

  const listed = addresses.slice(0, PROTOCOL_LIMITS.maxDiagnoseAddresses);
  /** The wildcard rule a name fell under: an address of its answer not learned yet still belongs to it. */
  const wildcardOwner = targetKind === 'domain' && rule !== null && isWildcardRule(rule) ? rule : null;
  if (listed.length < addresses.length) notes.add('addresses-truncated');
  const rows = await Promise.all(
    listed.map(async ({ address, source }): Promise<DiagnoseAddress> => {
      const owner = matchAddress(address, config, cached).rule ?? wildcardOwner;
      const expectedRole = owner?.iface ?? null;
      if (owner !== null && !applied.some((entry) => entry.ruleIds.includes(owner.id) && cidrContains(entry.dst, address))) {
        notes.add('not-applied');
      }
      const found = await deps.routeGet(address);
      const route = found.ok ? { device: found.route.iface, gateway: found.route.gateway, role: roleOf(state, found.route.iface) } : null;
      const matchesExpected = route === null || expectedRole === null ? null : route.role === expectedRole;
      if (matchesExpected === false) notes.add('route-mismatch');
      return { address, source, route, expectedRole, matchesExpected };
    }),
  );

  logger.debug('diagnosed', { target, targetKind, ruleId: match?.ruleId ?? null, addresses: rows.length, notes: [...notes].join(',') });
  return { target, targetKind, match, addresses: rows, dns, notes: [...notes] };
};
