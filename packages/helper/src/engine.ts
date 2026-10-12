import {
  PROTOCOL_LIMITS,
  cidrContains,
  forbiddenDestinationReason,
  normalizeHostAddress,
  parseIpv4Destination,
  type AdapterInfo,
  type Config,
  type Destination,
  type EngineState,
  type IfaceRole,
  type InterfaceState,
  type ReconcileReason,
  type Rule,
  type RuleReasonCode,
  type RuleState,
  type RuleStatus,
} from '@routeswitch/shared';

import type { Logger } from './logger';
import { toWireInterfaces, type DetectedInterfaces, type InterfaceInfo, type NetInfo } from './netinfo';
import type { RouteAddResult, RouteDeleteResult, RouteOperations } from './route';

/**
 * The routing engine: computes the routes that should exist (desired) from
 * the config and the current interfaces, compares them with the routes it has
 * applied itself (applied) and changes only the difference.
 *
 * Invariants:
 * - It never runs a command: every side effect goes through `routes`, every
 *   observation through `netinfo`.
 * - It deletes only routes that are in its own `applied` map.
 * - Every destination passes `forbiddenDestinationReason` here, before
 *   `route.ts` checks it again.
 * - `reconcile` never rejects and never throws: whatever happens ends up in
 *   the returned `EngineState` (a rule in `error`) and in the log.
 * - One pass at a time; calls that arrive during a pass share one follow-up.
 *
 * Seams for the modules that come later (none of them is implemented here):
 * - domain rules: `EngineDeps.resolveDomain` supplies the destinations of a
 *   domain rule (the resolved addresses and, once scoped DNS exists, the
 *   rule's DNS server). The default resolves nothing and reports `resolving`.
 * - `/etc/resolver` files: synchronised between `applyDiff` and the state
 *   computation in `runPass`, reporting per-rule problems the way
 *   `recordIssue` does.
 * - network monitor: calls `netinfo.invalidate()` and then
 *   `reconcile('network-change')`; `scheduleRetry` is the timer hook.
 * - `state.json`: `onApplied` receives the applied routes whenever the set
 *   changed, `getApplied()` reads them and `restoreApplied()` seeds them after
 *   a restart.
 * - socket server: `subscribe`, `getState`, `getConfig`, `setConfig`,
 *   `setEnabled`.
 */

/** A route the engine added and has not removed since. */
export interface AppliedRoute {
  /** As given to `route`: a bare address for a host, a CIDR for a subnet. */
  readonly dst: string;
  readonly gateway: string;
  /** Rules on whose behalf the route exists. */
  readonly ruleIds: readonly string[];
}

/** What a domain rule should be routed to right now. */
export interface DomainTargets {
  /**
   * Destinations to route for the rule. May be non-empty together with
   * `status: 'error'`: the last known addresses stay applied while a refresh
   * fails.
   */
  readonly destinations: readonly string[];
  readonly status: Extract<RuleStatus, 'active' | 'pending' | 'error'>;
  /** Required unless `status` is `active`; `addresses-truncated` may accompany `active`. */
  readonly reasonCode: RuleReasonCode | null;
  readonly reason: string | null;
  /** `Date.prototype.toISOString()` form, or null before the first answer. */
  readonly lastResolvedAt: string | null;
}

/** Supplies the destinations of a domain rule. May be asynchronous; a throw makes the rule `error`/`internal`. */
export type DomainResolver = (rule: Rule) => DomainTargets | Promise<DomainTargets>;

/** The resolver used until the DNS module exists: nothing is routed, the rule waits. */
export const unresolvedDomain: DomainResolver = () => ({
  destinations: [],
  status: 'pending',
  reasonCode: 'resolving',
  reason: 'Domain rules are not resolved yet',
  lastResolvedAt: null,
});

export interface ReconcileOptions {
  /** Bypass the interface cache for this pass (the "apply" button). */
  readonly force?: boolean | undefined;
}

export interface ReconcileSummary {
  readonly added: number;
  readonly removed: number;
  /** Route commands that failed, were refused or threw. */
  readonly failed: number;
  /** Stale routes left in place because the interface detection was degraded. */
  readonly kept: number;
}

export interface ReconcileOutcome {
  readonly state: EngineState;
  /**
   * The interface detection could not be trusted; run `reconcile` again
   * shortly. The engine already remembers to force a fresh detection for that
   * pass. False once the bounded number of attempts is used up.
   */
  readonly retryRequested: boolean;
  readonly summary: ReconcileSummary;
}

export interface RetryRequest {
  readonly reason: ReconcileReason;
  /** 1 for the first untrusted detection in a row, 2 for the second. */
  readonly attempt: number;
}

export interface RestoreResult {
  readonly restored: number;
  /** Entries that were invalid, forbidden, duplicated or already applied. */
  readonly dropped: number;
}

export type StateListener = (state: EngineState) => void;

export interface EngineDeps {
  readonly netinfo: NetInfo;
  readonly routes: Pick<RouteOperations, 'routeAdd' | 'routeDelete'>;
  readonly logger: Logger;
  /** Version reported in `EngineState.helperVersion`. */
  readonly helperVersion: string;
  /** An already validated config; replaced later with `setConfig`. */
  readonly initialConfig: Config;
  /** Wall clock for `lastApplyAt` and durations. */
  readonly now?: (() => Date) | undefined;
  readonly resolveDomain?: DomainResolver | undefined;
  /** Called after a pass that added or removed a route, with everything applied now. */
  readonly onApplied?: ((routes: readonly AppliedRoute[]) => void | Promise<void>) | undefined;
  /** Called when `ReconcileOutcome.retryRequested` is true; the daemon turns it into a timer. */
  readonly scheduleRetry?: ((request: RetryRequest) => void) | undefined;
}

export interface Engine {
  /**
   * Brings the routing table in line with the config. Never rejects. A call
   * made while a pass is running is merged with every other such call into
   * one follow-up pass, which runs with the latest reason; each caller gets
   * the outcome of a pass that started after its call.
   */
  reconcile(reason: ReconcileReason, options?: ReconcileOptions): Promise<ReconcileOutcome>;
  /** The state computed last; before the first reconcile, a state with nothing applied. */
  getState(): EngineState;
  getConfig(): Config;
  /**
   * Replaces the config (already validated by the caller). Returns whether it
   * differed from the stored one; only then `configRevision` goes up. Does not
   * reconcile: the caller follows up with `reconcile('config-change')`.
   */
  setConfig(config: Config): boolean;
  /** Sets the global toggle; same contract as `setConfig`, followed by `reconcile('enabled-change')`. */
  setEnabled(enabled: boolean): boolean;
  /** Registers a listener for every computed state; returns the function that removes it. */
  subscribe(listener: StateListener): () => void;
  getApplied(): readonly AppliedRoute[];
  /**
   * Seeds `applied` with routes a previous process left behind, so the next
   * reconcile removes or adopts them. Every entry is validated again.
   */
  restoreApplied(routes: readonly AppliedRoute[]): RestoreResult;
}

/**
 * How many untrusted interface detections in a row hold deletions back. From
 * this one on a degraded detection is taken at face value: `degraded` can be
 * permanent (an unrelated adapter timing out), and routes of an interface
 * that really went away must not stay forever.
 */
export const DEGRADED_ACCEPT_AFTER = 3;

const ROLES: readonly IfaceRole[] = ['ethernet', 'wifi'];
const MAX_RESTORED_ROUTES = 500 * PROTOCOL_LIMITS.maxAppliedDestinationsPerRule;
const MAX_RULE_IDS_PER_ROUTE = 500;

const DOWN: InterfaceState = { device: null, ip: null, gateway: null, up: false };

/** The `interfaces` and `adapters` fields of `EngineState`, as `toWireInterfaces` returns them. */
export interface WireInterfaces {
  readonly interfaces: { readonly ethernet: InterfaceState; readonly wifi: InterfaceState };
  readonly adapters: readonly AdapterInfo[];
}

const NO_INTERFACES: WireInterfaces = { interfaces: { ethernet: DOWN, wifi: DOWN }, adapters: [] };

interface Issue {
  readonly reasonCode: RuleReasonCode;
  readonly reason: string;
}

interface Verdict {
  readonly status: RuleStatus;
  readonly reasonCode: RuleReasonCode | null;
  readonly reason: string | null;
}

/** One rule while a pass is being worked out. */
interface Draft {
  readonly rule: Rule;
  /** The status the rule has when no route-level problem turns up. */
  readonly base: Verdict;
  readonly lastResolvedAt: string | null;
  /** The first problem found; it turns the rule into `error`. */
  issue: Issue | null;
  /** A route of the rule was not added because the interface detection cannot be trusted yet. */
  deferred: boolean;
}

interface DesiredRoute {
  readonly key: string;
  readonly dst: string;
  readonly gateway: string;
  readonly role: IfaceRole;
  readonly ruleIds: string[];
}

interface AppliedEntry {
  readonly dst: string;
  readonly gateway: string;
  ruleIds: string[];
}

/**
 * - `normal`: the detection is clean and trusted.
 * - `accepted`: the detection is degraded, but often enough in a row to be
 *   taken at face value for deletions. Routes are added only when the guard,
 *   checked against this detection and the last trusted one, clears them.
 * - `hold`: the detection is degraded and not accepted yet. No route is
 *   added; a route is deleted only when the config no longer asks for it,
 *   never because of what the interfaces look like.
 * - `failed`: there is no detection at all. Treated like `hold`.
 */
type PassMode = 'normal' | 'accepted' | 'hold' | 'failed';

const clamp = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const describeThrown = (error: unknown): string => clamp(error instanceof Error ? error.message : String(error), 200);

/** The destination in the form `route` takes and the protocol reports. */
const wireDestination = (destination: Destination): string =>
  destination.isHost ? destination.address : destination.cidr;

const routeKey = (destination: Destination): string => `net:${destination.cidr}`;

export interface ConnectedConflict {
  readonly role: IfaceRole;
  /** `equals-subnet`: exactly the connected subnet. `own-address` / `gateway`: holds that address. */
  readonly kind: 'equals-subnet' | 'own-address' | 'gateway';
}

/**
 * The connected-subnet guard. Decides whether a route for `destination` would
 * interfere with the network an interface (of either role) is directly
 * connected to:
 *
 * - `destination` equals the connected subnet -> conflict. `route add`
 *   answers "File exists" for it, and the wrapper's recovery would delete the
 *   kernel's own connected route and cut the LAN.
 * - `destination` is wider than the connected subnet and contains it ->
 *   allowed. It is a separate table entry; the kernel's more specific
 *   connected route stays and keeps winning for the LAN itself. This is the
 *   main use case: `10.0.0.0/8` through an interface that sits in
 *   `10.20.4.0/24`.
 * - `destination` is the interface's own address or its gateway -> conflict:
 *   the route to a gateway must stay on-link, or every route through that
 *   gateway (the default route included) stops resolving.
 * - `destination` lies strictly inside the connected subnet -> allowed, unless
 *   it holds the interface's own address or its gateway. A more specific
 *   route is a separate table entry that leaves the connected route alone; it
 *   is what a user writes to reach one LAN host through the other interface.
 * - anything else (disjoint) -> allowed.
 *
 * A wider block is not checked against the addresses inside the subnet it
 * contains: they are covered by the connected route.
 *
 * An interface whose subnet is unknown is checked for the address and gateway
 * equality only; the caller logs that the rest was skipped.
 */
export const findConnectedConflict = (
  destination: Destination,
  interfaces: readonly Pick<InterfaceInfo, 'role' | 'ip' | 'gateway' | 'subnet'>[],
): ConnectedConflict | null => {
  for (const { role, ip, gateway, subnet } of interfaces) {
    if (destination.isHost) {
      if (gateway !== null && destination.address === gateway) return { role, kind: 'gateway' };
      if (ip !== null && destination.address === ip) return { role, kind: 'own-address' };
    }
    if (subnet === null) continue;
    const inside = cidrContains(subnet, destination.cidr);
    if (inside && cidrContains(destination.cidr, subnet)) return { role, kind: 'equals-subnet' };
    if (inside) {
      if (gateway !== null && cidrContains(destination.cidr, gateway)) return { role, kind: 'gateway' };
      if (ip !== null && cidrContains(destination.cidr, ip)) return { role, kind: 'own-address' };
    }
  }
  return null;
};

const CONFLICT_TEXT: Readonly<Record<ConnectedConflict['kind'], string>> = {
  'equals-subnet': 'is the subnet the interface is directly connected to',
  'own-address': 'holds the address of the interface itself',
  gateway: 'holds the gateway of the interface',
};

export interface EngineStateInput {
  readonly helperVersion: string;
  readonly seq: number;
  readonly configRevision: number;
  readonly config: Config;
  readonly wire: WireInterfaces;
  /** Rule id -> verdict; a rule without one is reported as `error`/`internal`. */
  readonly verdicts: ReadonlyMap<string, Verdict & { readonly lastResolvedAt: string | null }>;
  readonly applied: Iterable<AppliedRoute>;
  readonly lastApplyAt: string | null;
  readonly lastReconcileReason: ReconcileReason | null;
}

/** Pure: the wire state for a set of engine data. One `rules` entry per config rule, in config order. */
export const buildEngineState = (input: EngineStateInput): EngineState => {
  const owned = new Map<string, string[]>();
  for (const route of input.applied) {
    for (const ruleId of route.ruleIds) {
      const list = owned.get(ruleId);
      if (list === undefined) owned.set(ruleId, [route.dst]);
      else if (list.length < PROTOCOL_LIMITS.maxAppliedDestinationsPerRule) list.push(route.dst);
    }
  }

  const rules: RuleState[] = input.config.rules.map((rule) => {
    const verdict = input.verdicts.get(rule.id);
    return {
      ruleId: rule.id,
      status: verdict?.status ?? 'error',
      reasonCode: verdict === undefined ? 'internal' : verdict.reasonCode,
      reason:
        verdict === undefined
          ? 'The rule was not evaluated'
          : verdict.reason === null
            ? null
            : clamp(verdict.reason, PROTOCOL_LIMITS.reasonMaxLength),
      appliedDestinations: owned.get(rule.id) ?? [],
      lastResolvedAt: verdict?.lastResolvedAt ?? null,
    };
  });

  return {
    helperVersion: input.helperVersion,
    seq: input.seq,
    configRevision: input.configRevision,
    enabled: input.config.enabled,
    interfaces: { ethernet: { ...input.wire.interfaces.ethernet }, wifi: { ...input.wire.interfaces.wifi } },
    adapters: input.wire.adapters.map((adapter) => ({ ...adapter })),
    rules,
    lastApplyAt: input.lastApplyAt,
    lastReconcileReason: input.lastReconcileReason,
  };
};

const disabledVerdict = (config: Config, rule: Rule): Verdict | null => {
  if (!rule.enabled) return { status: 'disabled', reasonCode: 'rule-disabled', reason: null };
  if (!config.enabled) return { status: 'disabled', reasonCode: 'globally-disabled', reason: null };
  return null;
};

const POSTPONED: Issue = {
  reasonCode: 'route-failed',
  reason: 'The route still uses its previous gateway; replacing it is postponed until the interfaces are detected reliably',
};

/**
 * The verdict of a rule whose route was held back by an untrusted detection.
 * `interface-down` is the closest code the closed protocol list has: the rule
 * waits for the state of the interfaces, and nothing is wrong with the rule.
 */
const DEFERRED: Verdict = {
  status: 'pending',
  reasonCode: 'interface-down',
  reason: 'Interface detection is unreliable right now; the route is added once the interfaces are detected reliably',
};

/** What the connected-subnet guard needs to know about one role. */
type GuardFacts = Pick<InterfaceInfo, 'role' | 'ip' | 'gateway' | 'subnet'>;

const guardFacts = (detected: DetectedInterfaces): GuardFacts[] =>
  ROLES.map((role) => {
    const { ip, gateway, subnet } = detected[role];
    return { role, ip, gateway, subnet };
  });

/** Every guard-relevant fact of both roles is positively known. */
const fullyKnown = (detected: DetectedInterfaces): boolean =>
  ROLES.every((role) => {
    const { up, ip, gateway, subnet } = detected[role];
    return up && ip !== null && gateway !== null && subnet !== null;
  });

const ACTIVE: Verdict = { status: 'active', reasonCode: null, reason: null };

const errorVerdict = (reasonCode: RuleReasonCode, reason: string): Verdict => ({ status: 'error', reasonCode, reason });

export const createEngine = (deps: EngineDeps): Engine => {
  const { netinfo, routes, helperVersion } = deps;
  const logger = deps.logger.child({ component: 'engine' });
  const now = deps.now ?? (() => new Date());
  const resolveDomain = deps.resolveDomain ?? unresolvedDomain;

  let config = deps.initialConfig;
  let configRevision = 0;
  let seq = 0;

  const applied = new Map<string, AppliedEntry>();
  const listeners = new Set<StateListener>();

  let wire: WireInterfaces = NO_INTERFACES;
  let degradedStreak = 0;
  let failureStreak = 0;
  let forceNextDetection = false;
  /** Rule id -> the problem logged for it in the previous pass, so a standing error is not repeated at `warn`. */
  let reportedIssues = new Map<string, string>();
  let reportedGuardSkips = '';
  /**
   * Guard facts of the last clean (non-degraded) detection. Replaced by every
   * clean detection and by nothing else: a degraded or failed detection must
   * never make the guard weaker than the last trusted one.
   */
  let trusted: readonly GuardFacts[] | null = null;

  const appliedSnapshot = (): AppliedRoute[] =>
    [...applied.values()].map(({ dst, gateway, ruleIds }) => ({ dst, gateway, ruleIds: [...ruleIds] }));

  const initialVerdicts = (): Map<string, Verdict & { lastResolvedAt: string | null }> =>
    new Map(
      config.rules.map((rule) => [
        rule.id,
        {
          ...(disabledVerdict(config, rule) ?? {
            status: 'pending' as const,
            reasonCode: 'interface-down' as const,
            reason: 'Waiting for the first reconcile',
          }),
          lastResolvedAt: null,
        },
      ]),
    );

  let state: EngineState = buildEngineState({
    helperVersion,
    seq,
    configRevision,
    config,
    wire,
    verdicts: initialVerdicts(),
    applied: [],
    lastApplyAt: null,
    lastReconcileReason: null,
  });

  const publish = (next: EngineState): void => {
    state = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        logger.error('state listener failed', { error: describeThrown(error) });
      }
    }
  };

  // -------------------------------------------------------------------------
  // Guarded calls into the other modules: a throw becomes a value.
  // -------------------------------------------------------------------------

  const detect = async (overrides: Config['ifaceOverrides'], force: boolean): Promise<DetectedInterfaces | null> => {
    try {
      return await netinfo.detectInterfaces({ overrides, force });
    } catch (error) {
      logger.error('interface detection threw', { error: describeThrown(error) });
      return null;
    }
  };

  const safeAdd = async (route: DesiredRoute): Promise<RouteAddResult | { readonly thrown: string }> => {
    try {
      return await routes.routeAdd({ dst: route.dst, gateway: route.gateway });
    } catch (error) {
      const thrown = describeThrown(error);
      logger.error('route add threw', { dst: route.dst, gateway: route.gateway, error: thrown });
      return { thrown };
    }
  };

  const safeDelete = async (route: AppliedEntry): Promise<RouteDeleteResult | { readonly thrown: string }> => {
    try {
      return await routes.routeDelete({ dst: route.dst, gateway: route.gateway });
    } catch (error) {
      const thrown = describeThrown(error);
      logger.error('route delete threw', { dst: route.dst, gateway: route.gateway, error: thrown });
      return { thrown };
    }
  };

  const safeResolve = async (rule: Rule): Promise<DomainTargets> => {
    try {
      return await resolveDomain(rule);
    } catch (error) {
      const thrown = describeThrown(error);
      logger.error('domain resolver threw', { ruleId: rule.id, error: thrown });
      return {
        destinations: [],
        status: 'error',
        reasonCode: 'internal',
        reason: `Resolver failed: ${thrown}`,
        lastResolvedAt: null,
      };
    }
  };

  // -------------------------------------------------------------------------
  // Desired set
  // -------------------------------------------------------------------------

  const recordIssue = (draft: Draft | undefined, reasonCode: RuleReasonCode, reason: string): void => {
    if (draft !== undefined && draft.issue === null) draft.issue = { reasonCode, reason };
  };

  const noteGuardSkips = (detected: DetectedInterfaces, anyDestination: boolean): void => {
    const skipped = anyDestination
      ? ROLES.map((role) => detected[role]).filter((info) => info.up && info.subnet === null)
      : [];
    const signature = skipped.map((info) => `${info.role}:${String(info.device)}:${String(info.ip)}`).join(',');
    for (const info of skipped) {
      // A static-IP interface stays like this for good: `warn` when it starts, `debug` while it lasts.
      logger.log(signature === reportedGuardSkips ? 'debug' : 'warn', 'connected subnet unknown; connected-subnet guard skipped', {
        role: info.role,
        device: info.device,
      });
    }
    reportedGuardSkips = signature;
  };

  interface Plan {
    readonly drafts: Map<string, Draft>;
    readonly desired: Map<string, DesiredRoute>;
    /**
     * What the config still asks for, whatever the interfaces look like: the
     * route keys of the enabled `ip` / `subnet` rules and the ids of the
     * enabled domain rules (whose destinations are not known from the config).
     */
    readonly wanted: { readonly keys: ReadonlySet<string>; readonly domainRuleIds: ReadonlySet<string> };
  }

  const buildPlan = async (
    snapshot: Config,
    detected: DetectedInterfaces | null,
    interfaces: readonly GuardFacts[],
  ): Promise<Plan> => {
    const drafts = new Map<string, Draft>();
    const desired = new Map<string, DesiredRoute>();
    let anyDestination = false;
    const wantedKeys = new Set<string>();
    const wantedDomainRuleIds = new Set<string>();

    const draftOf = (rule: Rule, base: Verdict, lastResolvedAt: string | null = null): Draft => {
      const draft: Draft = { rule, base, lastResolvedAt, issue: null, deferred: false };
      drafts.set(rule.id, draft);
      return draft;
    };

    for (const rule of snapshot.rules) {
      const disabled = disabledVerdict(snapshot, rule);
      if (disabled !== null) {
        draftOf(rule, disabled);
        continue;
      }
      if (rule.kind === 'domain') {
        wantedDomainRuleIds.add(rule.id);
      } else {
        const wantedDestination = parseIpv4Destination(rule.target);
        if (wantedDestination !== null) wantedKeys.add(routeKey(wantedDestination));
      }
      // Checked before anything else: a forbidden target is wrong whatever the interfaces do.
      if (rule.kind !== 'domain') {
        const forbidden = forbiddenDestinationReason(rule.target);
        if (forbidden !== null) {
          draftOf(rule, errorVerdict('forbidden-destination', `Destination must never be routed (${forbidden})`));
          continue;
        }
      }
      if (detected === null) {
        draftOf(rule, errorVerdict('internal', 'Interface detection failed'));
        continue;
      }
      const info = detected[rule.iface];
      if (!info.routable || info.gateway === null) {
        draftOf(
          rule,
          info.up
            ? { status: 'pending', reasonCode: 'no-gateway', reason: `The ${rule.iface} interface has no gateway` }
            : { status: 'pending', reasonCode: 'interface-down', reason: `The ${rule.iface} interface is not connected` },
        );
        continue;
      }
      const { gateway } = info;

      let targets: readonly string[] = [rule.target];
      let draft: Draft;
      if (rule.kind === 'domain') {
        const resolved = await safeResolve(rule);
        const reasonCode = resolved.reasonCode ?? (resolved.status === 'active' ? null : 'internal');
        draft = draftOf(rule, { status: resolved.status, reasonCode, reason: resolved.reason }, resolved.lastResolvedAt);
        targets = resolved.destinations.slice(0, PROTOCOL_LIMITS.maxAppliedDestinationsPerRule);
      } else {
        draft = draftOf(rule, ACTIVE);
      }

      for (const target of targets) {
        const forbidden = forbiddenDestinationReason(target);
        const destination = forbidden === null ? parseIpv4Destination(target) : null;
        if (destination === null) {
          recordIssue(draft, 'forbidden-destination', `Destination must never be routed (${forbidden ?? 'invalid-destination'})`);
          continue;
        }
        anyDestination = true;
        const dst = wireDestination(destination);
        const conflict = findConnectedConflict(destination, interfaces);
        if (conflict !== null) {
          recordIssue(draft, 'connected-network', `${dst} ${CONFLICT_TEXT[conflict.kind]} (${conflict.role})`);
          continue;
        }
        const key = routeKey(destination);
        const existing = desired.get(key);
        if (existing === undefined) {
          desired.set(key, { key, dst, gateway, role: rule.iface, ruleIds: [rule.id] });
        } else if (existing.gateway === gateway) {
          if (!existing.ruleIds.includes(rule.id)) existing.ruleIds.push(rule.id);
        } else {
          recordIssue(draft, 'route-failed', `${dst} is already routed through the ${existing.role} interface by another rule`);
        }
      }
    }

    // Only a clean detection can say "this interface really has no known subnet".
    if (detected !== null && !detected.degraded) noteGuardSkips(detected, anyDestination);
    return { drafts, desired, wanted: { keys: wantedKeys, domainRuleIds: wantedDomainRuleIds } };
  };

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  interface Counters {
    added: number;
    removed: number;
    failed: number;
    kept: number;
    /** Routes not added because the detection cannot be trusted. */
    deferred: number;
    changed: boolean;
  }

  const applyDiff = async (
    { drafts, desired, wanted }: Plan,
    mode: PassMode,
    allowAdds: boolean,
    reason: ReconcileReason,
  ): Promise<Counters> => {
    const holding = mode === 'hold' || mode === 'failed';
    const counters: Counters = { added: 0, removed: 0, failed: 0, kept: 0, deferred: 0, changed: false };
    const appliedAtStart = new Set(applied.keys());
    /** Routes that should have gone but are still there, with the problem their rules get. */
    const stuck = new Map<string, Issue>();

    const stale = [...applied].filter(([key, entry]) => desired.get(key)?.gateway !== entry.gateway);
    /**
     * Stale routes a degraded detection must not take away: the config still
     * asks for them, so they are stale only because of how the interfaces
     * look right now. A route no enabled rule asks for any more (rule removed
     * or disabled, global toggle off) is deleted even then: removing our own
     * route needs no interface information.
     */
    const held = new Set(
      holding
        ? stale
            .filter(([key, entry]) => wanted.keys.has(key) || entry.ruleIds.some((id) => wanted.domainRuleIds.has(id)))
            .map(([key]) => key)
        : [],
    );
    counters.kept = held.size;

    // Deletes first: a route whose gateway changed has to go before it is added again.
    for (const [key, entry] of stale) {
      if (held.has(key)) continue;
      const result = await safeDelete(entry);
      if ('thrown' in result) {
        counters.failed += 1;
        stuck.set(key, { reasonCode: 'internal', reason: `Removing the route for ${entry.dst} failed: ${result.thrown}` });
      } else if (result.ok) {
        applied.delete(key);
        counters.removed += 1;
        counters.changed = true;
      } else if (result.outcome === 'rejected') {
        // Unreachable for a route this engine added. A destination the wrapper
        // refuses can never be deleted by us, so it must not be retried forever.
        applied.delete(key);
        counters.failed += 1;
        counters.changed = true;
        logger.error('applied route refused by the route wrapper; forgotten', {
          reason,
          dst: entry.dst,
          gateway: entry.gateway,
          rejection: result.reason,
        });
      } else {
        counters.failed += 1;
        stuck.set(key, { reasonCode: 'route-failed', reason: `Could not remove the route for ${entry.dst}: ${result.message}` });
        logger.error('route delete failed; the route stays applied and is retried on the next reconcile', {
          reason,
          dst: entry.dst,
          gateway: entry.gateway,
          ruleIds: entry.ruleIds,
          error: result.message,
        });
      }
    }

    for (const [key, route] of desired) {
      const owners = route.ruleIds.map((ruleId) => drafts.get(ruleId));
      const fail = (reasonCode: RuleReasonCode, text: string): void => {
        for (const draft of owners) recordIssue(draft, reasonCode, text);
      };

      const current = applied.get(key);
      if (current !== undefined) {
        if (current.gateway === route.gateway) {
          current.ruleIds = [...route.ruleIds];
        } else {
          // Still there with the old gateway: its delete was held back or failed.
          const issue = stuck.get(key) ?? (held.has(key) ? POSTPONED : undefined);
          stuck.delete(key);
          current.ruleIds = [...new Set([...current.ruleIds, ...route.ruleIds])].slice(0, MAX_RULE_IDS_PER_ROUTE);
          fail(issue?.reasonCode ?? 'route-failed', issue?.reason ?? `The route for ${route.dst} could not be replaced`);
        }
        continue;
      }

      if (!allowAdds) {
        for (const draft of owners) if (draft !== undefined) draft.deferred = true;
        counters.deferred += 1;
        continue;
      }

      const result = await safeAdd(route);
      if ('thrown' in result) {
        counters.failed += 1;
        applied.delete(key);
        fail('internal', `Adding the route for ${route.dst} failed: ${result.thrown}`);
      } else if (result.ok) {
        applied.set(key, { dst: route.dst, gateway: route.gateway, ruleIds: [...route.ruleIds] });
        counters.added += 1;
        counters.changed = true;
        if (result.outcome === 'replaced' && !appliedAtStart.has(key)) {
          logger.warn('existing foreign route replaced', {
            reason,
            dst: route.dst,
            gateway: route.gateway,
            ruleIds: route.ruleIds,
          });
        }
      } else {
        counters.failed += 1;
        // Whatever failed, the route is not ours: after a failed `re-add` it is
        // gone from the table altogether (the old one was deleted first).
        applied.delete(key);
        if (result.outcome === 'rejected') {
          fail(
            result.field === 'dst' ? 'forbidden-destination' : 'route-failed',
            result.field === 'dst'
              ? `Destination must never be routed (${result.reason})`
              : `Gateway ${route.gateway} was refused (${result.reason})`,
          );
        } else {
          fail(
            'route-failed',
            result.step === 're-add'
              ? `Replacing the route for ${route.dst} failed, the route is now absent: ${result.message}`
              : `Could not add the route for ${route.dst}: ${result.message}`,
          );
        }
      }
    }

    // What is left in `stuck` are failed deletes of routes no rule wants any
    // more; a rule that is still in the config and owns one shows the failure.
    // Routes that were merely held back are not a fault of their rules.
    for (const [key, issue] of stuck) {
      for (const ruleId of applied.get(key)?.ruleIds ?? []) recordIssue(drafts.get(ruleId), issue.reasonCode, issue.reason);
    }
    return counters;
  };

  // -------------------------------------------------------------------------
  // One pass
  // -------------------------------------------------------------------------

  const logRuleIssues = (drafts: ReadonlyMap<string, Draft>, reason: ReconcileReason): void => {
    const next = new Map<string, string>();
    for (const [ruleId, { issue, rule }] of drafts) {
      if (issue === null) continue;
      const signature = `${issue.reasonCode}|${issue.reason}`;
      next.set(ruleId, signature);
      logger.log(reportedIssues.get(ruleId) === signature ? 'debug' : 'warn', 'rule cannot be applied', {
        reason,
        ruleId,
        target: rule.target,
        iface: rule.iface,
        reasonCode: issue.reasonCode,
        detail: issue.reason,
      });
    }
    reportedIssues = next;
  };

  const notifyApplied = async (): Promise<void> => {
    if (deps.onApplied === undefined) return;
    try {
      await deps.onApplied(appliedSnapshot());
    } catch (error) {
      logger.error('applied-routes listener failed', { error: describeThrown(error) });
    }
  };

  const requestRetry = (reason: ReconcileReason, attempt: number): void => {
    forceNextDetection = true;
    if (deps.scheduleRetry === undefined) return;
    try {
      deps.scheduleRetry({ reason, attempt });
    } catch (error) {
      logger.error('retry scheduler failed', { error: describeThrown(error) });
    }
  };

  /** Classifies the detection and keeps the streak counters. */
  const classify = (detected: DetectedInterfaces | null, reason: ReconcileReason): { mode: PassMode; retry: number | null } => {
    if (detected === null) {
      failureStreak += 1;
      return { mode: 'failed', retry: failureStreak < DEGRADED_ACCEPT_AFTER ? failureStreak : null };
    }
    failureStreak = 0;
    if (!detected.degraded) {
      degradedStreak = 0;
      return { mode: 'normal', retry: null };
    }
    degradedStreak += 1;
    if (degradedStreak >= DEGRADED_ACCEPT_AFTER) {
      logger.warn('interface detection is still degraded; accepting the result as it is', {
        reason,
        consecutive: degradedStreak,
      });
      return { mode: 'accepted', retry: null };
    }
    logger.warn('interface detection is degraded; no route is added, and none is removed because of interface state, in this reconcile', {
      reason,
      consecutive: degradedStreak,
      applied: applied.size,
    });
    return { mode: 'hold', retry: degradedStreak };
  };

  const pass = async (reason: ReconcileReason, force: boolean): Promise<ReconcileOutcome> => {
    const startedAt = now().getTime();
    // One consistent view for the whole pass: `setConfig` replaces the object, it never mutates it.
    const snapshot = config;
    const revision = configRevision;

    const detected = await detect(snapshot.ifaceOverrides, force || forceNextDetection);
    forceNextDetection = false;
    const { mode, retry } = classify(detected, reason);
    if (detected !== null) wire = toWireInterfaces(detected);

    const current = detected === null ? [] : guardFacts(detected);
    if (mode === 'normal') trusted = current;
    // An untrusted detection is checked together with the last trusted one: a
    // role it reports as down or without a subnet may only have failed to answer.
    const guardInterfaces = mode === 'normal' ? current : [...current, ...(trusted ?? [])];
    // Without any trusted detection to fall back on, an accepted degraded
    // detection may add routes only when it knows everything the guard needs.
    const allowAdds =
      mode === 'normal' || (mode === 'accepted' && detected !== null && (trusted !== null || fullyKnown(detected)));

    const plan = await buildPlan(snapshot, detected, guardInterfaces);
    const counters = await applyDiff(plan, mode, allowAdds, reason);
    const owning = new Set([...applied.values()].flatMap((entry) => entry.ruleIds));
    const verdictOf = (draft: Draft): Verdict => {
      if (draft.issue !== null) return errorVerdict(draft.issue.reasonCode, draft.issue.reason);
      // A rule that already has routes keeps its status; one with nothing applied waits.
      return draft.deferred && !owning.has(draft.rule.id) ? DEFERRED : draft.base;
    };

    logRuleIssues(plan.drafts, reason);
    if (counters.changed) await notifyApplied();
    if (retry !== null) requestRetry(reason, retry);

    const finishedAt = now();
    seq += 1;
    const next = buildEngineState({
      helperVersion,
      seq,
      configRevision: revision,
      config: snapshot,
      wire,
      verdicts: new Map(
        [...plan.drafts].map(([ruleId, draft]) => [
          ruleId,
          {
            ...verdictOf(draft),
            lastResolvedAt: draft.lastResolvedAt,
          },
        ]),
      ),
      applied: appliedSnapshot(),
      lastApplyAt: finishedAt.toISOString(),
      lastReconcileReason: reason,
    });

    const summary: ReconcileSummary = {
      added: counters.added,
      removed: counters.removed,
      failed: counters.failed,
      kept: counters.kept,
    };
    logger.info('reconcile finished', {
      reason,
      ...summary,
      deferred: counters.deferred,
      mode,
      rules: snapshot.rules.length,
      applied: applied.size,
      retryRequested: retry !== null,
      seq,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt),
    });
    publish(next);
    return { state: next, retryRequested: retry !== null, summary };
  };

  /** `pass` with a last line of defence: a bug in it must not reject or leave the engine stuck. */
  const guardedPass = async (reason: ReconcileReason, force: boolean): Promise<ReconcileOutcome> => {
    try {
      return await pass(reason, force);
    } catch (error) {
      const thrown = describeThrown(error);
      logger.error('reconcile failed unexpectedly', { reason, error: thrown });
      const snapshot = config;
      seq += 1;
      const next = buildEngineState({
        helperVersion,
        seq,
        configRevision,
        config: snapshot,
        wire,
        verdicts: new Map(
          snapshot.rules.map((rule) => [
            rule.id,
            {
              ...(disabledVerdict(snapshot, rule) ?? errorVerdict('internal', `Reconcile failed: ${thrown}`)),
              lastResolvedAt: null,
            },
          ]),
        ),
        applied: appliedSnapshot(),
        lastApplyAt: now().toISOString(),
        lastReconcileReason: reason,
      });
      publish(next);
      return { state: next, retryRequested: false, summary: { added: 0, removed: 0, failed: 0, kept: applied.size } };
    }
  };

  // -------------------------------------------------------------------------
  // Coalescing
  // -------------------------------------------------------------------------

  interface Pending {
    reason: ReconcileReason;
    force: boolean;
    readonly promise: Promise<ReconcileOutcome>;
    readonly resolve: (outcome: ReconcileOutcome) => void;
  }

  let running = false;
  let queued: Pending | null = null;

  const newPending = (reason: ReconcileReason, force: boolean): Pending => {
    let resolve: (outcome: ReconcileOutcome) => void = () => undefined;
    const promise = new Promise<ReconcileOutcome>((done) => {
      resolve = done;
    });
    return { reason, force, promise, resolve };
  };

  /** Used only when `guardedPass` itself fails; must not throw. */
  const lastResort = (reason: ReconcileReason, error: unknown): ReconcileOutcome => {
    try {
      logger.error('reconcile could not even report its failure', { reason, error: describeThrown(error) });
    } catch {
      // The logger isolates its sinks; if it throws anyway there is nowhere left to report to.
    }
    return { state, retryRequested: false, summary: { added: 0, removed: 0, failed: 0, kept: applied.size } };
  };

  const start = (request: Pending): void => {
    running = true;
    // Whatever happens to the pass, the engine becomes idle again, the queued
    // request starts and the caller is answered: a rejection here would
    // otherwise leave `running` set for good and every later call waiting.
    const settle = (outcome: ReconcileOutcome): void => {
      running = false;
      const next = queued;
      queued = null;
      request.resolve(outcome);
      if (next !== null) start(next);
    };
    guardedPass(request.reason, request.force).then(settle, (error: unknown) => {
      settle(lastResort(request.reason, error));
    });
  };

  const reconcile = (reason: ReconcileReason, options?: ReconcileOptions): Promise<ReconcileOutcome> => {
    const force = options?.force === true;
    if (!running) {
      const request = newPending(reason, force);
      start(request);
      return request.promise;
    }
    if (queued === null) {
      queued = newPending(reason, force);
    } else {
      queued.reason = reason;
      queued.force = queued.force || force;
    }
    return queued.promise;
  };

  // -------------------------------------------------------------------------
  // Config and applied-set accessors
  // -------------------------------------------------------------------------

  const setConfig = (next: Config): boolean => {
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    config = next;
    configRevision += 1;
    logger.info('config replaced', { configRevision, rules: next.rules.length, enabled: next.enabled });
    return true;
  };

  const setEnabled = (enabled: boolean): boolean => {
    if (config.enabled === enabled) return false;
    config = { ...config, enabled };
    configRevision += 1;
    logger.info('global toggle changed', { configRevision, enabled });
    return true;
  };

  const restoreApplied = (restored: readonly AppliedRoute[]): RestoreResult => {
    let accepted = 0;
    let dropped = 0;
    // Typed for the caller, but read as untrusted: the entries come from a file.
    const candidates: readonly unknown[] = restored;
    for (const candidate of candidates) {
      const { dst, gateway, ruleIds } = (typeof candidate === 'object' && candidate !== null ? candidate : {}) as Partial<
        Record<keyof AppliedRoute, unknown>
      >;
      const destination =
        typeof dst === 'string' && forbiddenDestinationReason(dst) === null ? parseIpv4Destination(dst) : null;
      const hop = typeof gateway === 'string' ? normalizeHostAddress(gateway) : null;
      const key = destination === null ? null : routeKey(destination);
      if (
        destination === null ||
        key === null ||
        hop === null ||
        !hop.ok ||
        applied.has(key) ||
        applied.size >= MAX_RESTORED_ROUTES
      ) {
        dropped += 1;
        continue;
      }
      const owners = Array.isArray(ruleIds)
        ? (ruleIds as readonly unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      applied.set(key, {
        dst: wireDestination(destination),
        gateway: hop.value,
        ruleIds: owners.slice(0, MAX_RULE_IDS_PER_ROUTE),
      });
      accepted += 1;
    }
    logger.log(dropped === 0 ? 'info' : 'warn', 'applied routes restored', { restored: accepted, dropped });
    return { restored: accepted, dropped };
  };

  return {
    reconcile,
    getState: () => state,
    getConfig: () => config,
    setConfig,
    setEnabled,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getApplied: appliedSnapshot,
    restoreApplied,
  };
};
