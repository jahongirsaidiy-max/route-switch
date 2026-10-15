import {
  PATHS,
  PROTOCOL_LIMITS,
  cidrContains,
  diagnoseTargetKind,
  parseIpv4Destination,
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
 * looked up only when an enabled domain rule names it exactly. Any other name
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
}

export interface AddressMatch {
  /** The winning enabled rule and why; null when no enabled rule covers the address. */
  readonly match: DiagnoseMatch | null;
  readonly rule: Rule | null;
  /** True when a rule that is switched off (by its own toggle) covers the address. */
  readonly disabledCover: boolean;
}

/** The addresses a domain rule's lookup currently has, or null when there is no answer yet. */
export type CachedAddresses = (ruleId: string) => readonly string[] | null;

const covers = (rule: Rule, address: string, cached: CachedAddresses): Omit<Candidate, 'rule'> | null => {
  if (rule.kind !== 'domain') {
    const destination = parseIpv4Destination(rule.target);
    if (destination === null || !cidrContains(destination.cidr, address)) return null;
    return { prefix: destination.prefix, explicit: isExplicitTarget(rule, rule.target), via: rule.kind };
  }
  if (rule.dns === address) return { prefix: 32, explicit: isExplicitTarget(rule, address), via: 'dns-server' };
  if (cached(rule.id)?.includes(address) === true) return { prefix: 32, explicit: isExplicitTarget(rule, address), via: 'domain' };
  return null;
};

const precedenceOf = (winner: Candidate, candidates: readonly Candidate[]): DiagnosePrecedence => {
  if (candidates.length === 1) return 'only-match';
  const rivals = candidates.filter((candidate) => candidate !== winner && candidate.prefix === winner.prefix);
  if (rivals.length > 0) {
    // Same destination: an explicit target beats resolved addresses; otherwise the one planned first won.
    return winner.explicit && rivals.every((rival) => !rival.explicit) ? 'host-route' : 'config-order';
  }
  // Only wider destinations are left: the kernel picks the longest prefix.
  if (winner.prefix === 32) return winner.explicit ? 'host-route' : 'domain-address';
  return 'longest-prefix';
};

/**
 * The rule that owns `address`, by the engine's rules (`precedence.ts`): the
 * longest prefix that covers it wins; for the same destination an explicit
 * target beats a resolved address, then planning order decides. Only enabled
 * rules match; with the global toggle off none does.
 */
export const matchAddress = (address: string, config: Config, cached: CachedAddresses): AddressMatch => {
  const candidates: Candidate[] = [];
  let disabledCover = false;
  for (const rule of planningOrder(config.rules)) {
    const found = covers(rule, address, cached);
    if (found === null) continue;
    if (!rule.enabled) {
      disabledCover = true;
      continue;
    }
    if (config.enabled) candidates.push({ rule, ...found });
  }
  if (candidates.length === 0) return { match: null, rule: null, disabledCover };
  const longest = Math.max(...candidates.map((candidate) => candidate.prefix));
  const sameDestination = candidates.filter((candidate) => candidate.prefix === longest);
  const winner = sameDestination.find((candidate) => candidate.explicit) ?? sameDestination[0];
  if (winner === undefined) return { match: null, rule: null, disabledCover };
  return {
    match: { ruleId: winner.rule.id, via: winner.via, precedence: precedenceOf(winner, candidates) },
    rule: winner.rule,
    disabledCover,
  };
};

/** The enabled domain rule that names `name` exactly (the first in config order), and whether a switched-off one does. */
export const matchDomain = (
  name: string,
  config: Config,
): { readonly match: DiagnoseMatch | null; readonly rule: Rule | null; readonly disabledCover: boolean } => {
  const named = config.rules.filter((rule) => rule.kind === 'domain' && rule.target === name);
  const enabled = config.enabled ? named.filter((rule) => rule.enabled) : [];
  const [winner] = enabled;
  const disabledCover = named.some((rule) => !rule.enabled);
  if (winner === undefined) return { match: null, rule: null, disabledCover };
  return {
    match: { ruleId: winner.id, via: 'domain', precedence: enabled.length === 1 ? 'only-match' : 'config-order' },
    rule: winner,
    disabledCover,
  };
};

// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------

export interface DiagnoseDeps {
  readonly getConfig: () => Config;
  readonly getState: () => EngineState;
  readonly getApplied: () => readonly AppliedRoute[];
  /** The DNS module's cache, read-only. */
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
  const cached: CachedAddresses = (ruleId) => deps.peekDomain(ruleId)?.addresses ?? null;

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
      const lookup = deps.peekDomain(rule.id);
      const server = rule.dns ?? lookup?.servers[0] ?? null;
      const fromCache = lookup?.addresses ?? null;
      if (fromCache !== null) addresses = fromCache.map((address) => ({ address, source: 'rule-cache' as const }));
      if (lookup?.truncated === true) notes.add('addresses-truncated');
      let probe: ProbeResult | null = null;
      if (server !== null) {
        // The one query of this request: it answers whether the server is reachable, and gives the
        // addresses when the rule has none cached yet.
        probe = await deps.probe(server, rule.target);
        logger.debug('dns probe', { ruleId: rule.id, server, domain: rule.target, outcome: probe.outcome, ms: probe.ms });
        if (fromCache === null && probe.outcome === 'ok') {
          addresses = probe.addresses.map((address) => ({ address, source: 'query' as const }));
          if (probe.truncated) notes.add('addresses-truncated');
        }
      }
      if (fromCache === null && probe !== null && probe.outcome !== 'ok') notes.add('resolve-failed');
      if (addresses.length === 0 && (fromCache !== null || probe?.outcome === 'ok')) notes.add('no-addresses');
      if (server !== null) {
        const file = rule.dns === undefined ? null : resolverFileName(rule.target);
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

  const applied = deps.getApplied();
  const listed = addresses.slice(0, PROTOCOL_LIMITS.maxDiagnoseAddresses);
  if (listed.length < addresses.length) notes.add('addresses-truncated');
  const rows = await Promise.all(
    listed.map(async ({ address, source }): Promise<DiagnoseAddress> => {
      const owner = matchAddress(address, config, cached).rule;
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
