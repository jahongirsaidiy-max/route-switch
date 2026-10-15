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
 * - It deletes only routes that are in its own `applied` map, and `route.ts`
 *   deletes one only while the table entry is still that route (same
 *   destination, through the gateway it was added with). An entry that has
 *   become something else -- a connected route, a route through another
 *   gateway -- is left alone and forgotten.
 * - Every destination passes `forbiddenDestinationReason` here, before
 *   `route.ts` checks it again.
 * - `reconcile` never rejects and never throws: whatever happens ends up in
 *   the returned `EngineState` (a rule in `error`) and in the log.
 * - One pass at a time; calls that arrive during a pass share one follow-up.
 *
 * Seams for the modules that come later (none of them is implemented here):
 * - config changes: `EngineDeps.onConfigChanged` is told about every real
 *   change, so a module that tracks the rules (DNS) cannot miss one.
 * - domain rules: `EngineDeps.resolveDomain` supplies the destinations of a
 *   domain rule (the resolved addresses and, once scoped DNS exists, the
 *   rule's DNS server). The default resolves nothing and reports `resolving`.
 * - `/etc/resolver` files: synchronised between `applyDiff` and the state
 *   computation in `runPass`, reporting per-rule problems the way
 *   `recordIssue` does.
 * - network monitor (`monitor.ts`): calls `netinfo.invalidate()` and then
 *   `reconcile('network-change')`; `scheduleRetry` is the timer hook. Its
 *   drift check reads the table itself and reports routes that are gone with
 *   `forgetApplied`; `isReconciling` and `getRetryNeeds` tell it when to hold
 *   back and when a periodic pass is worth running.
 * - `state.json`: `onApplied` receives the applied routes whenever the set
 *   changed, `getApplied()` reads them and `restoreApplied()` seeds them after
 *   a restart. `clear()` removes every applied route without detecting the
 *   interfaces (shutdown, uninstall, global toggle off, recovery at start).
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

/**
 * What the engine knows about the interfaces when it asks for a domain rule.
 * The two fields follow different rules, on purpose:
 * - whom to ask (`dnsServers`) comes from trusted (clean) detections only;
 * - what never to route (`interfaceDnsServers`) is collected from every
 *   detection, trusted or not, and always holds the servers of `dnsServers`.
 *   An address excluded too many only goes by the default route; routing the
 *   DNS server of an interface because a name resolved to it is worse.
 */
export interface DomainContext {
  /**
   * DNS servers of the interface that plays the rule's role, from the last
   * trusted detection.
   * - a list: known; empty when the interface has none.
   * - `null`: not known yet, and a trustworthy detection is expected shortly
   *   (the current one is being held back). The resolver should wait rather
   *   than ask a server that is probably the wrong one.
   * - `undefined`: not known and nothing better is coming (the detection was
   *   accepted as it is, its lookup failed, or the `NetInfo` does not report
   *   DNS servers).
   */
  readonly dnsServers: readonly string[] | null | undefined;
  /**
   * Every DNS server the detections have reported, as far as remembered: those
   * of both roles' interfaces and the other ones of the system's DNS
   * configuration (supplemental resolvers, other interfaces). A resolver never
   * returns them as destinations. At most `MAX_EXCLUDED_DNS_SERVERS`, the
   * servers of `dnsServers` first.
   */
  readonly interfaceDnsServers: readonly string[];
}

/** Supplies the destinations of a domain rule. May be asynchronous; a throw makes the rule `error`/`internal`. */
export type DomainResolver = (rule: Rule, context: DomainContext) => DomainTargets | Promise<DomainTargets>;

/** The resolver used until the DNS module exists: nothing is routed, the rule waits. */
export const unresolvedDomain: (rule: Rule) => DomainTargets = () => ({
  destinations: [],
  status: 'pending',
  reasonCode: 'resolving',
  reason: 'Domain rules are not resolved yet',
  lastResolvedAt: null,
});

export interface ReconcileOptions {
  /** Bypass the interface cache for this pass (the "apply" button). */
  readonly force?: boolean | undefined;
  /**
   * Run again, in this pass, the route commands a periodic pass would skip:
   * adds refused because of a connected route (`REFUSAL_RETRY_REASONS`) and
   * commands that are backed off after failing again and again
   * (`FAILURE_BACKOFF_AFTER`). The monitor sets it every few drift checks, so
   * that nothing stays refused for good on a network where nothing happens.
   */
  readonly retryRefused?: boolean | undefined;
}

/** What is waiting for a later pass; see `Engine.getRetryNeeds`. */
export interface RetryNeeds {
  /** `summary.deferred` of the last pass: routes not added because the detection could not be trusted. */
  readonly deferred: number;
  /** Wanted routes whose add was refused because a connected route is in the way. */
  readonly refused: number;
  /** Routes whose last add or delete failed (and that are still wanted, or still applied). */
  readonly failing: number;
}

/** A route the drift check found missing from the table, or no longer through our gateway. */
export interface DriftedRoute {
  readonly dst: string;
  /** The gateway it was applied with; an entry applied with another gateway is not forgotten. */
  readonly gateway: string;
  /** What the table shows instead, for the log (`missing`, `other-gateway`, ...). */
  readonly found: string;
}

export interface ReconcileSummary {
  readonly added: number;
  /**
   * Routes of ours that are gone from the table: deleted, or already absent.
   * A route that was forgotten because the entry at its destination is no
   * longer ours is not counted here (nothing was removed).
   */
  readonly removed: number;
  /** Route commands that failed, were refused or threw. */
  readonly failed: number;
  /** Stale routes left in place because the interface detection was degraded. */
  readonly kept: number;
  /**
   * Routes that are wanted but were not added in this pass because the
   * interface detection could not be trusted (one per destination, the number
   * the `reconcile finished` log line carries). They are not retried by
   * `retryRequested` once the bounded attempts are used up, so a caller that
   * sees a non-zero value should reconcile again later on its own.
   */
  readonly deferred: number;
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

/** What `Engine.clear` did. */
export interface ClearResult {
  /** Routes deleted, or already gone from the table. */
  readonly removed: number;
  /** Routes forgotten because the entry at the destination is no longer ours (nothing deleted). */
  readonly forgotten: number;
  /** Routes whose delete failed; they stay applied (and in `state.json`) for a later attempt. */
  readonly failed: number;
}

export interface ClearOptions {
  /**
   * The engine is shutting down (SIGTERM, uninstall): after this clear no pass
   * runs any more. A pass queued meanwhile and every later `reconcile` resolve
   * at once with the current state, so nothing adds a route after the cleanup.
   */
  readonly final?: boolean | undefined;
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
  /**
   * Called with the new config whenever `setConfig` or `setEnabled` really
   * changed it, before the call returns (so before the reconcile the caller
   * follows up with). The DNS module hangs its `syncConfig` here. A throw is
   * logged and changes nothing.
   */
  readonly onConfigChanged?: ((config: Config) => void) | undefined;
  /**
   * Brings the scoped-DNS files (`/etc/resolver/<domain>`) in line with the
   * config, once per pass, before the plan; the result's problems make the
   * rules `error`. The daemon passes `resolverFiles.sync`. A throw or a
   * rejection is logged and makes every rule that needs a file `error` /
   * `resolver-failed`.
   */
  readonly syncResolvers?: ((config: Config) => ResolverSync | Promise<ResolverSync>) | undefined;
}

/** What `EngineDeps.syncResolvers` reports: rule id -> why its resolver file is not in place. */
export interface ResolverSync {
  readonly issues: ReadonlyMap<string, { readonly reasonCode: RuleReasonCode; readonly reason: string }>;
}

export interface Engine {
  /**
   * Brings the routing table in line with the config. Never rejects. A call
   * made while a pass is running is merged with every other such call into
   * one follow-up pass, which runs with the latest reason; each caller gets
   * the outcome of a pass that started after its call. A merged event reason
   * (`REFUSAL_RETRY_REASONS`) or `retryRefused` keeps the follow-up urgent:
   * it runs as if `retryRefused` were set.
   */
  reconcile(reason: ReconcileReason, options?: ReconcileOptions): Promise<ReconcileOutcome>;
  /** The state computed last; before the first reconcile, a state with nothing applied. */
  getState(): EngineState;
  getConfig(): Config;
  /**
   * Revision of the config `getConfig` returns right now: it goes up exactly
   * when `setConfig` or `setEnabled` changes the config. The published state
   * carries it only after the next pass; the socket server pairs it with
   * `getConfig` so the app can tell which revision a config belongs to.
   */
  getConfigRevision(): number;
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
   * Forgets applied routes the routing table no longer has as we added them
   * (deleted by someone, replaced through another gateway, taken over by a
   * connected route). Nothing is deleted: the next reconcile adds them again
   * through `routeAdd`, whose checks decide what may be replaced. An entry is
   * forgotten only while it is still applied with the given gateway. Returns
   * how many were forgotten. Call it between passes (`isReconciling()` false).
   */
  forgetApplied(routes: readonly DriftedRoute[]): number;
  /** True while a pass runs (or one is queued behind it). */
  isReconciling(): boolean;
  /** What a periodic pass could make progress on; the monitor reads it every drift check. */
  getRetryNeeds(): RetryNeeds;
  /**
   * Removes every applied route through `routes.routeDelete` (which checks the
   * table entry first and deletes only our own route), at most
   * `CLEAR_CONCURRENCY` at a time. Runs no interface detection and never
   * adds. Waits for a running pass and keeps the next one waiting until it is
   * done. Routes whose delete fails stay applied. Publishes a state and tells
   * `onApplied` when something changed. Never rejects.
   */
  clear(options?: ClearOptions): Promise<ClearResult>;
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
/**
 * How many clean detections in a row may report "no DNS server" for a role
 * that had one before the engine believes it. A DHCP renewal can leave the
 * lease without the option for a moment; switching servers on that would throw
 * the resolved addresses, and their routes, away for nothing.
 */
export const DNS_LOSS_GRACE = 2;
/**
 * DNS-server addresses remembered per role for the exclusion; the one not
 * reported for longest goes first. The servers being asked are excluded on top
 * of these, whatever the cap.
 */
export const MAX_EXCLUDED_DNS_PER_ROLE = 8;
/**
 * The other DNS servers of the system (`DetectedInterfaces.otherDnsServers`)
 * remembered for the exclusion, by the same rules as those of a role.
 */
export const MAX_EXCLUDED_OTHER_DNS = 32;
/**
 * Bound of `DomainContext.interfaceDnsServers`: per role the asked servers
 * and the remembered ones, then the other ones. It is the length the DNS
 * module reads of that list, so nothing is cut there.
 */
export const MAX_EXCLUDED_DNS_SERVERS = 2 * (2 * MAX_EXCLUDED_DNS_PER_ROLE) + MAX_EXCLUDED_OTHER_DNS;

/**
 * A rule whose route the wrapper refused because a connected route is in the
 * way stays refused until something that could change that happens. Its
 * `route add` is attempted again only in a pass with one of these reasons, or
 * when the detected interface facts differ from those at the refusal; the
 * periodic reasons (`drift-check`, `dns-refresh`) do not re-run the command,
 * unless the pass runs with `ReconcileOptions.retryRefused` (the monitor's
 * periodic retry, so a refusal does not last for good on a quiet network).
 */
export const REFUSAL_RETRY_REASONS: ReadonlySet<ReconcileReason> = new Set<ReconcileReason>([
  'startup',
  'config-change',
  'enabled-change',
  'network-change',
  'manual',
]);
/**
 * A route command (an add, or the delete of a route of ours, each with its
 * `route get` check) that failed this many passes in a row is no longer run
 * in every periodic pass (`drift-check`, `dns-refresh`) but after a growing
 * delay: `FAILURE_BACKOFF_BASE_MS` doubling up to `FAILURE_BACKOFF_MAX_MS`.
 * Passes with a reason of `REFUSAL_RETRY_REASONS`, and those run with
 * `retryRefused`, always try. A lookup that never works would otherwise run,
 * and log an error, in every pass forever.
 */
/** Route deletes `clear()` runs at the same time; each one's `route get` -> `route delete` stays in order. */
export const CLEAR_CONCURRENCY = 8;
export const FAILURE_BACKOFF_AFTER = 3;
export const FAILURE_BACKOFF_BASE_MS = 60_000;
export const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
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
  /** Route keys of resolved addresses (not the rule's own DNS server) planned for this rule. */
  readonly routedAnswers: Set<string>;
  /**
   * Resolved addresses left to an explicit rule or to another rule's DNS
   * server on another interface: a warning, not an error, while some other
   * address of the rule is routed (`overridden-by-rule`).
   */
  readonly overridden: Map<string, string>;
}

interface DesiredRoute {
  readonly key: string;
  readonly dst: string;
  readonly gateway: string;
  readonly role: IfaceRole;
  /** Wanted by an `ip` / `subnet` rule, as opposed to only by addresses a domain resolved to. */
  readonly explicit: boolean;
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
 *   checked against this detection and the last trusted one, clears them, and
 *   only when every role is covered by one of the two (`guardCoversEveryRole`).
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
export type GuardFacts = Pick<InterfaceInfo, 'role' | 'ip' | 'gateway' | 'subnet'>;

const guardFacts = (detected: DetectedInterfaces): GuardFacts[] =>
  ROLES.map((role) => {
    const { ip, gateway, subnet } = detected[role];
    return { role, ip, gateway, subnet };
  });

/** Address, gateway and subnet are all positively known. */
const knowsEverything = ({ ip, gateway, subnet }: Pick<GuardFacts, 'ip' | 'gateway' | 'subnet'>): boolean =>
  ip !== null && gateway !== null && subnet !== null;

/**
 * Whether an accepted degraded detection gives the connected-subnet guard
 * enough to work with, decided per role: each role is either fully known in
 * the detection itself, or the last trusted detection knew its address,
 * gateway and subnet. A role that is unknown now and was down (or partly
 * unknown) when last seen reliably may have joined any network since -- the
 * guard would have nothing to compare against, so nothing is added.
 */
export const guardCoversEveryRole = (detected: DetectedInterfaces, trusted: readonly GuardFacts[] | null): boolean =>
  ROLES.every((role) => {
    const current = detected[role];
    if (current.up && knowsEverything(current)) return true;
    return trusted?.some((facts) => facts.role === role && knowsEverything(facts)) ?? false;
  });

const ACTIVE: Verdict = { status: 'active', reasonCode: null, reason: null };

const connectedRouteText = (dst: string): string =>
  `${dst} is a network an interface is directly connected to; its route was left in place`;

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
  /** The same for rules that work with an `overridden-by-rule` warning. */
  let reportedWarnings = new Map<string, string>();
  let reportedGuardSkips = '';
  /** Per role, the DNS servers outside the connected subnet that were warned about last ('' = none). */
  const warnedOutsideDns: Record<IfaceRole, string> = { ethernet: '', wifi: '' };
  /**
   * Guard facts of the last clean (non-degraded) detection. Replaced by every
   * clean detection and by nothing else: a degraded or failed detection must
   * never make the guard weaker than the last trusted one.
   */
  let trusted: readonly GuardFacts[] | null = null;
  /**
   * Whom to ask: DNS servers per role from clean detections only (same rule
   * as `trusted`). A role is missing until a clean detection has reported it.
   */
  let trustedDns: Partial<Record<IfaceRole, readonly string[]>> = {};
  /**
   * What never to route: every DNS server any detection has reported for a
   * role, clean or not. A clean detection that reports the role replaces the
   * role's list; an untrusted one adds to it (a value reported again moves to
   * the end) and the cap drops the one not reported for longest. The servers
   * in `trustedDns` are excluded besides this list (`excludedServers`).
   */
  let excludedDns: Record<IfaceRole, readonly string[]> = { ethernet: [], wifi: [] };
  /** The same for the DNS servers of the system that belong to no role; never asked. */
  let excludedOtherDns: readonly string[] = [];
  /** Clean detections in a row that reported no DNS server for a role that had one. */
  let dnsLossStreak: Record<IfaceRole, number> = { ethernet: 0, wifi: 0 };
  /** The detection whose DNS servers were taken in last; a cached result is not counted twice. */
  let lastDnsDetection: DetectedInterfaces | null = null;
  /** What a rule is told when its role's DNS servers are not known: wait (`null`) or give up waiting (`undefined`). */
  let unknownDns: null | undefined;
  /**
   * Route key -> what the refusal was made under (gateway and interface
   * facts), for every wanted route the wrapper refused as `connected-route`
   * and that is still wanted. See `REFUSAL_RETRY_REASONS`.
   */
  const refusedAdds = new Map<string, string>();
  /** Route key -> consecutive failures of its add or delete, and when a periodic pass may try again. */
  const failing = new Map<string, { count: number; nextAt: number; issue: Issue }>();
  /** `summary.deferred` of the last pass. */
  let lastDeferred = 0;
  /** `applied` changed outside a pass (`forgetApplied`): the next pass reports it to `onApplied`. */
  let appliedDirty = false;

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

  const detect = async (
    overrides: Config['ifaceOverrides'],
    force: boolean,
    wantDns: boolean,
  ): Promise<DetectedInterfaces | null> => {
    try {
      // The DNS servers cost one more command per role, so they are asked for only when a rule needs them.
      return await netinfo.detectInterfaces({ overrides, force, ...(wantDns ? { dns: true } : {}) });
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

  /**
   * What a resolver must never route: per role, the servers it is asked
   * (`trustedDns`) and then the remembered ones. The asked ones do not depend on
   * the cap of `excludedDns`: untrusted detections can push them out of that
   * list, never out of the exclusion.
   */
  const excludedServers = (): string[] => [
    ...new Set([...ROLES.flatMap((role) => [...(trustedDns[role] ?? []), ...excludedDns[role]]), ...excludedOtherDns]),
  ];

  const safeResolve = async (rule: Rule): Promise<DomainTargets> => {
    try {
      return await resolveDomain(rule, {
        dnsServers: trustedDns[rule.iface] ?? unknownDns,
        interfaceDnsServers: excludedServers(),
      });
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

  const safeSyncResolvers = async (snapshot: Config): Promise<ResolverSync['issues']> => {
    if (deps.syncResolvers === undefined) return new Map();
    try {
      return (await deps.syncResolvers(snapshot)).issues;
    } catch (error) {
      const thrown = describeThrown(error);
      logger.error('resolver file sync threw', { error: thrown });
      const failed = { reasonCode: 'resolver-failed' as const, reason: `Resolver files could not be synced: ${thrown}` };
      return new Map(
        snapshot.rules.filter((rule) => rule.kind === 'domain' && rule.dns !== undefined).map((rule) => [rule.id, failed]),
      );
    }
  };

  /**
   * A rule without `dns` asks the servers of its interface, and that query
   * leaves through the interface only when the server is in its connected
   * subnet; no route is ever added for such a server. Said once per role and
   * set of servers, so the user knows to set `dns` before a lookup times out.
   */
  const noteOutsideDns = (role: IfaceRole, info: InterfaceInfo): void => {
    const servers = trustedDns[role] ?? [];
    const subnet = info.subnet;
    if (subnet === null || servers.length === 0) return;
    const outside = servers.filter((server) => !cidrContains(subnet, server));
    const signature = outside.length === 0 ? '' : `${subnet}|${outside.join(',')}`;
    if (signature !== '' && signature !== warnedOutsideDns[role]) {
      logger.warn('a DNS server of the interface is outside its connected subnet; set `dns` in the rule to route it', {
        role,
        subnet,
        servers: outside,
      });
    }
    warnedOutsideDns[role] = signature;
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
    resolverIssues: ResolverSync['issues'],
  ): Promise<Plan> => {
    const drafts = new Map<string, Draft>();
    const desired = new Map<string, DesiredRoute>();
    let anyDestination = false;
    const wantedKeys = new Set<string>();
    const wantedDomainRuleIds = new Set<string>();

    const draftOf = (rule: Rule, base: Verdict, lastResolvedAt: string | null = null): Draft => {
      const draft: Draft = {
        rule,
        base,
        lastResolvedAt,
        issue: null,
        deferred: false,
        routedAnswers: new Set(),
        overridden: new Map(),
      };
      drafts.set(rule.id, draft);
      return draft;
    };

    // Explicit rules are planned first, whatever their place in the config: a
    // destination the user named in an `ip` / `subnet` rule belongs to that
    // rule, and an address a domain happens to resolve to never takes it over.
    // Among themselves, rules keep the config order (the first one wins).
    const planned = [
      ...snapshot.rules.filter((rule) => rule.kind !== 'domain'),
      ...snapshot.rules.filter((rule) => rule.kind === 'domain'),
    ];
    for (const rule of planned) {
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
      /** The destination that is the rule's own DNS server: routed like an explicit rule. */
      let serverTarget: string | null = null;
      if (rule.kind === 'domain') {
        if (rule.dns === undefined) noteOutsideDns(rule.iface, info);
        const resolved = await safeResolve(rule);
        const reasonCode = resolved.reasonCode ?? (resolved.status === 'active' ? null : 'internal');
        draft = draftOf(rule, { status: resolved.status, reasonCode, reason: resolved.reason }, resolved.lastResolvedAt);
        // The rule's own server goes first: its route is what lets the lookups (and the
        // resolver file) reach it. The resolver never returns it among the destinations.
        serverTarget = rule.dns ?? null;
        const answers = resolved.destinations.filter((target) => target !== serverTarget);
        targets = [...(serverTarget === null ? [] : [serverTarget]), ...answers].slice(
          0,
          PROTOCOL_LIMITS.maxAppliedDestinationsPerRule,
        );
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
        const dst = wireDestination(destination);
        if (target === serverTarget && info.subnet !== null && cidrContains(info.subnet, dst)) {
          // The rule's own DNS server on the interface's own link is reached directly: no route.
          continue;
        }
        anyDestination = true;
        const conflict = findConnectedConflict(destination, interfaces);
        if (conflict !== null && target === serverTarget && conflict.role === rule.iface) continue;
        if (conflict !== null) {
          recordIssue(draft, 'connected-network', `${dst} ${CONFLICT_TEXT[conflict.kind]} (${conflict.role})`);
          continue;
        }
        const key = routeKey(destination);
        const existing = desired.get(key);
        const explicit = rule.kind !== 'domain' || target === serverTarget;
        const isAnswer = rule.kind === 'domain' && target !== serverTarget;
        if (existing === undefined) {
          desired.set(key, { key, dst, gateway, role: rule.iface, explicit, ruleIds: [rule.id] });
          if (isAnswer) draft.routedAnswers.add(key);
        } else if (existing.gateway === gateway) {
          if (!existing.ruleIds.includes(rule.id)) existing.ruleIds.push(rule.id);
          if (isAnswer) draft.routedAnswers.add(key);
        } else if (explicit && !existing.explicit) {
          // Only a rule's own DNS server gets here (explicit rules are planned before every domain
          // rule): it takes the destination over from the addresses other domains resolved to.
          desired.set(key, { key, dst, gateway, role: rule.iface, explicit, ruleIds: [rule.id] });
          for (const ruleId of existing.ruleIds) {
            const owner = drafts.get(ruleId);
            owner?.routedAnswers.delete(key);
            owner?.overridden.set(
              key,
              `${dst} is routed through the ${rule.iface} interface as the DNS server of another rule, which takes precedence over a resolved address`,
            );
          }
        } else if (existing.explicit && !explicit) {
          draft.overridden.set(
            key,
            `${dst} is routed through the ${existing.role} interface by an explicit rule, which takes precedence over a resolved address`,
          );
        } else {
          recordIssue(draft, 'route-failed', `${dst} is already routed through the ${existing.role} interface by another rule`);
        }
      }
    }

    // A resolver file that is not in place is the problem a rule shows, whatever else it has,
    // and also while its interface is down: the file does not depend on the interface.
    for (const [ruleId, issue] of resolverIssues) {
      const draft = drafts.get(ruleId);
      if (draft !== undefined && draft.base.status !== 'disabled') draft.issue = { reasonCode: issue.reasonCode, reason: issue.reason };
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
    /** The guard-relevant interface facts of this pass, as one comparable string. */
    facts: string,
    retryRefused: boolean,
  ): Promise<Counters> => {
    const nowMs = now().getTime();
    const urgent = retryRefused || REFUSAL_RETRY_REASONS.has(reason);
    /** False while a command that keeps failing is backed off and this is a periodic pass. */
    const mayTry = (key: string): boolean => {
      const entry = failing.get(key);
      return entry === undefined || entry.count < FAILURE_BACKOFF_AFTER || urgent || nowMs >= entry.nextAt;
    };
    const noteFailure = (key: string, dst: string, issue: Issue): void => {
      const count = (failing.get(key)?.count ?? 0) + 1;
      const delay =
        count < FAILURE_BACKOFF_AFTER
          ? 0
          : Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(count - FAILURE_BACKOFF_AFTER, 16), FAILURE_BACKOFF_MAX_MS);
      failing.set(key, { count, nextAt: nowMs + delay, issue });
      if (count === FAILURE_BACKOFF_AFTER) {
        logger.warn('route command keeps failing; periodic passes retry it less often from now on', {
          reason,
          dst,
          failures: count,
          retryInMs: delay,
        });
      }
    };
    const backedOff = (key: string, dst: string): Issue | null => {
      if (mayTry(key)) return null;
      const entry = failing.get(key);
      if (entry === undefined) return null;
      logger.debug('route command backed off after repeated failures', {
        reason,
        dst,
        failures: entry.count,
        retryInMs: Math.max(0, entry.nextAt - nowMs),
      });
      return entry.issue;
    };
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
      const waiting = backedOff(key, entry.dst);
      if (waiting !== null) {
        stuck.set(key, waiting);
        continue;
      }
      const result = await safeDelete(entry);
      if (!('thrown' in result) && (result.ok || result.outcome === 'rejected')) failing.delete(key);
      if ('thrown' in result) {
        counters.failed += 1;
        const issue: Issue = { reasonCode: 'internal', reason: `Removing the route for ${entry.dst} failed: ${result.thrown}` };
        stuck.set(key, issue);
        noteFailure(key, entry.dst, issue);
      } else if (result.ok && result.outcome === 'not-ours') {
        // The entry at the destination is no longer the route this engine
        // added (an interface joined that very subnet, or someone replaced the
        // route). The wrapper deleted nothing; the route is not ours to track.
        applied.delete(key);
        counters.changed = true;
        logger.warn('applied route is no longer ours; forgotten, nothing was deleted', {
          reason,
          dst: entry.dst,
          gateway: entry.gateway,
          ruleIds: entry.ruleIds,
          found: result.reason,
          detail: result.message,
        });
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
        const issue: Issue = { reasonCode: 'route-failed', reason: `Could not remove the route for ${entry.dst}: ${result.message}` };
        stuck.set(key, issue);
        noteFailure(key, entry.dst, issue);
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

      const refusal = `${route.gateway}|${facts}`;
      if (refusedAdds.get(key) === refusal && !urgent) {
        // Refused before, nothing relevant changed and this is a periodic
        // pass: the rule keeps its verdict without `route add` running again.
        fail('connected-network', connectedRouteText(route.dst));
        continue;
      }
      refusedAdds.delete(key);
      const waiting = backedOff(key, route.dst);
      if (waiting !== null) {
        fail(waiting.reasonCode, waiting.reason);
        continue;
      }

      const result = await safeAdd(route);
      // Failures that are retried in every pass count towards the backoff; a refusal has its own rule.
      if ('thrown' in result || !(result.ok || result.outcome === 'rejected' || result.failure === 'connected-route')) {
        const issue: Issue =
          'thrown' in result
            ? { reasonCode: 'internal', reason: `Adding the route for ${route.dst} failed: ${result.thrown}` }
            : {
                reasonCode: 'route-failed',
                reason:
                  result.failure === 'existing-route-unknown' || result.step !== 're-add'
                    ? `Could not add the route for ${route.dst}: ${result.message}`
                    : `Replacing the route for ${route.dst} failed, the route is now absent: ${result.message}`,
              };
        noteFailure(key, route.dst, issue);
      } else {
        failing.delete(key);
      }
      if ('thrown' in result) {
        counters.failed += 1;
        applied.delete(key);
        fail('internal', `Adding the route for ${route.dst} failed: ${result.thrown}`);
      } else if (result.ok) {
        // `exists` is adopted like a route we added: it is exactly what the
        // rule asks for, and from here on the engine keeps and removes it.
        applied.set(key, { dst: route.dst, gateway: route.gateway, ruleIds: [...route.ruleIds] });
        counters.added += 1;
        counters.changed = true;
        if (result.outcome !== 'added' && !appliedAtStart.has(key)) {
          logger.warn(result.outcome === 'replaced' ? 'existing foreign route replaced' : 'existing foreign route adopted', {
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
        } else if (result.failure === 'connected-route') {
          // The wrapper found the kernel's connected route in the way and left
          // it alone: the guard here did not know that subnet (static IP, or a
          // detection that has gone stale). Same verdict as the guard's own.
          refusedAdds.set(key, refusal);
          fail('connected-network', connectedRouteText(route.dst));
        } else if (result.failure === 'existing-route-unknown') {
          fail('route-failed', `Could not add the route for ${route.dst}: ${result.message}`);
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
    // A refusal is remembered only while its route is still wanted; a failure while
    // its route is wanted or still ours.
    for (const key of refusedAdds.keys()) if (!desired.has(key)) refusedAdds.delete(key);
    for (const key of failing.keys()) if (!desired.has(key) && !applied.has(key)) failing.delete(key);
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

  /**
   * `active` + `overridden-by-rule` for a working domain rule some of whose
   * resolved addresses another rule routes; `null` when that does not apply.
   * Its warnings keep their order of precedence: `overridden-by-rule` first,
   * then what the resolver reported (`dns-server-excluded`,
   * `addresses-truncated`), all counted in `reason`.
   */
  const partlyApplied = (draft: Draft): Verdict | null => {
    if (draft.base.status !== 'active' || draft.overridden.size === 0 || draft.routedAnswers.size === 0) return null;
    const count = draft.overridden.size;
    const own = `${String(count)} resolved ${count === 1 ? 'address is' : 'addresses are'} routed by another rule, which takes precedence`;
    return {
      status: 'active',
      reasonCode: 'overridden-by-rule',
      reason: draft.base.reason === null ? own : `${own}; ${draft.base.reason}`,
    };
  };

  /** A rule that works with warnings is said once when that changes, then only at `debug`. */
  const logRuleWarnings = (
    drafts: ReadonlyMap<string, Draft>,
    reason: ReconcileReason,
    /** The verdict that is published: the log never says what the state does not. */
    published: (draft: Draft) => Verdict,
  ): void => {
    const next = new Map<string, string>();
    for (const [ruleId, draft] of drafts) {
      const verdict = published(draft);
      // Only an `active` verdict carries this code (`partlyApplied`).
      if (verdict.reasonCode !== 'overridden-by-rule') continue;
      const signature = `${verdict.reasonCode}|${String(verdict.reason)}`;
      next.set(ruleId, signature);
      logger.log(reportedWarnings.get(ruleId) === signature ? 'debug' : 'info', 'rule partly applied', {
        reason,
        ruleId,
        target: draft.rule.target,
        iface: draft.rule.iface,
        reasonCode: verdict.reasonCode,
        overridden: draft.overridden.size,
        routed: draft.routedAnswers.size,
        detail: verdict.reason,
      });
    }
    reportedWarnings = next;
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

  /**
   * Takes in the DNS servers a detection reports. Nothing here decides about a
   * route: a failed lookup (`null` for a role) or a missing report leaves what
   * is known as it is.
   */
  const noteDnsServers = (detected: DetectedInterfaces | null, mode: PassMode, wanted: boolean): void => {
    if (!wanted) {
      // No domain rule, no lookups: what was known would only go stale.
      trustedDns = {};
      excludedDns = { ethernet: [], wifi: [] };
      excludedOtherDns = [];
      dnsLossStreak = { ethernet: 0, wifi: 0 };
      lastDnsDetection = null;
      unknownDns = undefined;
      return;
    }
    // While a detection is held back, a clean one is expected with the retry: a rule can wait for it.
    unknownDns = mode === 'hold' ? null : undefined;
    const reported = detected?.dnsServers;
    if (detected === null || reported === undefined || detected === lastDnsDetection) return;
    lastDnsDetection = detected;
    // A value reported again moves to the end: the one not seen for longest goes first.
    const remember = (known: readonly string[], servers: readonly string[], cap: number): string[] => {
      const fresh = new Set(servers);
      return [...known.filter((server) => !fresh.has(server)), ...fresh].slice(-cap);
    };
    const other = detected.otherDnsServers;
    if (other !== undefined && other !== null) {
      excludedOtherDns =
        mode === 'normal'
          ? other.slice(0, MAX_EXCLUDED_OTHER_DNS)
          : remember(excludedOtherDns, other.slice(0, MAX_EXCLUDED_OTHER_DNS), MAX_EXCLUDED_OTHER_DNS);
    }
    const nextTrusted = { ...trustedDns };
    const nextExcluded = { ...excludedDns };
    for (const role of ROLES) {
      const reportedServers = reported[role];
      if (reportedServers === null) continue;
      // Bounded whatever the `NetInfo`: the exclusion list must fit `MAX_EXCLUDED_DNS_SERVERS`.
      const servers = reportedServers.slice(0, MAX_EXCLUDED_DNS_PER_ROLE);
      if (mode !== 'normal') {
        nextExcluded[role] = remember(excludedDns[role], servers, MAX_EXCLUDED_DNS_PER_ROLE);
        continue;
      }
      if (servers.length === 0 && (trustedDns[role]?.length ?? 0) > 0) {
        dnsLossStreak[role] += 1;
        if (dnsLossStreak[role] <= DNS_LOSS_GRACE) continue;
      }
      dnsLossStreak[role] = 0;
      nextTrusted[role] = servers;
      nextExcluded[role] = servers;
    }
    trustedDns = nextTrusted;
    excludedDns = nextExcluded;
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

  const pass = async (reason: ReconcileReason, force: boolean, retryRefused: boolean): Promise<ReconcileOutcome> => {
    const startedAt = now().getTime();
    // One consistent view for the whole pass: `setConfig` replaces the object, it never mutates it.
    const snapshot = config;
    const revision = configRevision;

    // Wanted for every enabled domain rule, also one with its own `dns`: the
    // servers of the interfaces must be known to keep them out of its answers.
    const wantDns = snapshot.enabled && snapshot.rules.some((rule) => rule.enabled && rule.kind === 'domain');
    const detected = await detect(snapshot.ifaceOverrides, force || forceNextDetection, wantDns);
    forceNextDetection = false;
    const { mode, retry } = classify(detected, reason);
    if (detected !== null) wire = toWireInterfaces(detected);

    const current = detected === null ? [] : guardFacts(detected);
    if (mode === 'normal') trusted = current;
    noteDnsServers(detected, mode, wantDns);
    // An untrusted detection is checked together with the last trusted one: a
    // role it reports as down or without a subnet may only have failed to answer.
    const guardInterfaces = mode === 'normal' ? current : [...current, ...(trusted ?? [])];
    // An accepted degraded detection may add routes only when, for each role,
    // either it or the last trusted detection knows everything the guard needs.
    const allowAdds = mode === 'normal' || (mode === 'accepted' && detected !== null && guardCoversEveryRole(detected, trusted));

    // The files depend on the config only, so they are kept in line whatever the detection is like.
    const resolverIssues = await safeSyncResolvers(snapshot);
    const plan = await buildPlan(snapshot, detected, guardInterfaces, resolverIssues);
    const counters = await applyDiff(plan, mode, allowAdds, reason, JSON.stringify(current), retryRefused);
    lastDeferred = counters.deferred;
    const owning = new Set([...applied.values()].flatMap((entry) => entry.ruleIds));
    const verdictOf = (draft: Draft): Verdict => {
      if (draft.issue !== null) return errorVerdict(draft.issue.reasonCode, draft.issue.reason);
      // A rule that already has routes keeps its status; one with nothing applied waits.
      // A rule that is waiting anyway (a domain still resolving) keeps its own reason.
      if (draft.deferred && !owning.has(draft.rule.id) && draft.base.status !== 'pending') return DEFERRED;
      return partlyApplied(draft) ?? draft.base;
    };

    // Resolved addresses left to other rules are a warning only while some address of the rule is
    // routed; with none left the rule does not work at all, as before.
    for (const draft of plan.drafts.values()) {
      const [first] = draft.overridden.values();
      if (first !== undefined && draft.routedAnswers.size === 0) recordIssue(draft, 'route-failed', first);
    }
    logRuleIssues(plan.drafts, reason);
    logRuleWarnings(plan.drafts, reason, verdictOf);
    if (counters.changed || appliedDirty) {
      appliedDirty = false;
      await notifyApplied();
    }
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
      deferred: counters.deferred,
    };
    logger.info('reconcile finished', {
      reason,
      ...summary,
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
  const guardedPass = async (reason: ReconcileReason, force: boolean, retryRefused: boolean): Promise<ReconcileOutcome> => {
    try {
      return await pass(reason, force, retryRefused);
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
      return { state: next, retryRequested: false, summary: { added: 0, removed: 0, failed: 0, kept: applied.size, deferred: 0 } };
    }
  };

  // -------------------------------------------------------------------------
  // Coalescing
  // -------------------------------------------------------------------------

  interface Pending {
    reason: ReconcileReason;
    force: boolean;
    retryRefused: boolean;
    readonly promise: Promise<ReconcileOutcome>;
    readonly resolve: (outcome: ReconcileOutcome) => void;
  }

  let running = false;
  let queued: Pending | null = null;
  /** Set by a final `clear()`: no pass runs any more. */
  let shutDown = false;
  /** Resolved when no pass runs and none is queued (`clear()` waits for that). */
  let idleWaiters: (() => void)[] = [];

  const releaseIdleWaiters = (): void => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const newPending = (reason: ReconcileReason, force: boolean, retryRefused: boolean): Pending => {
    let resolve: (outcome: ReconcileOutcome) => void = () => undefined;
    const promise = new Promise<ReconcileOutcome>((done) => {
      resolve = done;
    });
    return { reason, force, retryRefused, promise, resolve };
  };

  /** Used only when `guardedPass` itself fails; must not throw. */
  const lastResort = (reason: ReconcileReason, error: unknown): ReconcileOutcome => {
    try {
      logger.error('reconcile could not even report its failure', { reason, error: describeThrown(error) });
    } catch {
      // The logger isolates its sinks; if it throws anyway there is nowhere left to report to.
    }
    return { state, retryRequested: false, summary: { added: 0, removed: 0, failed: 0, kept: applied.size, deferred: 0 } };
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
      // A final `clear()` that is waiting has set `shutDown`: what queued up meanwhile does not run.
      if (next !== null && !shutDown) start(next);
      else {
        next?.resolve(idleOutcome());
        releaseIdleWaiters();
      }
    };
    guardedPass(request.reason, request.force, request.retryRefused).then(settle, (error: unknown) => {
      settle(lastResort(request.reason, error));
    });
  };

  const idleOutcome = (): ReconcileOutcome => ({
    state,
    retryRequested: false,
    summary: { added: 0, removed: 0, failed: 0, kept: applied.size, deferred: 0 },
  });

  const reconcile = (reason: ReconcileReason, options?: ReconcileOptions): Promise<ReconcileOutcome> => {
    if (shutDown) {
      logger.debug('reconcile ignored: the engine has shut down', { reason });
      return Promise.resolve(idleOutcome());
    }
    const force = options?.force === true;
    const retryRefused = options?.retryRefused === true;
    if (!running) {
      const request = newPending(reason, force, retryRefused);
      start(request);
      return request.promise;
    }
    if (queued === null) {
      queued = newPending(reason, force, retryRefused);
    } else {
      // The merged pass runs with the latest reason; an event reason it replaces keeps its
      // urgency: refused and backed-off commands are still tried in that pass.
      queued.retryRefused = queued.retryRefused || retryRefused || REFUSAL_RETRY_REASONS.has(queued.reason);
      queued.reason = reason;
      queued.force = queued.force || force;
    }
    return queued.promise;
  };

  // -------------------------------------------------------------------------
  // Config and applied-set accessors
  // -------------------------------------------------------------------------

  const notifyConfigChanged = (): void => {
    if (deps.onConfigChanged === undefined) return;
    try {
      deps.onConfigChanged(config);
    } catch (error) {
      logger.error('config-change listener failed', { error: describeThrown(error) });
    }
  };

  const setConfig = (next: Config): boolean => {
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    config = next;
    configRevision += 1;
    logger.info('config replaced', { configRevision, rules: next.rules.length, enabled: next.enabled });
    notifyConfigChanged();
    return true;
  };

  const setEnabled = (enabled: boolean): boolean => {
    if (config.enabled === enabled) return false;
    config = { ...config, enabled };
    configRevision += 1;
    logger.info('global toggle changed', { configRevision, enabled });
    notifyConfigChanged();
    return true;
  };

  const forgetApplied = (routes: readonly DriftedRoute[]): number => {
    let forgotten = 0;
    // Read as untrusted like `restoreApplied`: only exact, valid destinations are matched.
    for (const { dst, gateway, found } of routes) {
      const destination = typeof dst === 'string' ? parseIpv4Destination(dst) : null;
      const key = destination === null ? null : routeKey(destination);
      const entry = key === null ? undefined : applied.get(key);
      if (key === null || entry === undefined || entry.gateway !== gateway) continue;
      applied.delete(key);
      failing.delete(key);
      forgotten += 1;
      logger.warn('applied route is not in the routing table as it was added; forgotten, the next reconcile adds it again', {
        dst: entry.dst,
        gateway: entry.gateway,
        ruleIds: entry.ruleIds,
        found: typeof found === 'string' ? clamp(found, 40) : null,
      });
    }
    if (forgotten > 0) appliedDirty = true;
    return forgotten;
  };

  /** One delete of `clear()`; the same verdicts as a stale route in a pass, without the rule bookkeeping. */
  const clearOne = async (key: string, entry: AppliedEntry): Promise<'removed' | 'forgotten' | 'failed'> => {
    const result = await safeDelete(entry);
    if ('thrown' in result) return 'failed';
    if (result.ok && result.outcome === 'not-ours') {
      applied.delete(key);
      logger.warn('applied route is no longer ours; forgotten, nothing was deleted', {
        reason: 'cleanup',
        dst: entry.dst,
        gateway: entry.gateway,
        ruleIds: entry.ruleIds,
        found: result.reason,
        detail: result.message,
      });
      return 'forgotten';
    }
    if (result.ok) {
      applied.delete(key);
      return 'removed';
    }
    if (result.outcome === 'rejected') {
      applied.delete(key);
      logger.error('applied route refused by the route wrapper; forgotten', {
        reason: 'cleanup',
        dst: entry.dst,
        gateway: entry.gateway,
        rejection: result.reason,
      });
      return 'forgotten';
    }
    logger.error('route delete failed during cleanup; the route stays applied', {
      reason: 'cleanup',
      dst: entry.dst,
      gateway: entry.gateway,
      ruleIds: entry.ruleIds,
      error: result.message,
    });
    return 'failed';
  };

  const runClear = async (): Promise<ClearResult> => {
    const startedAt = now().getTime();
    const counts = { removed: 0, forgotten: 0, failed: 0 };
    const work = [...applied];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next; index < work.length; index = next) {
        next += 1;
        const item = work[index];
        if (item === undefined) continue;
        counts[await clearOne(item[0], item[1])] += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CLEAR_CONCURRENCY, work.length) }, worker));
    refusedAdds.clear();
    failing.clear();
    if (counts.removed + counts.forgotten > 0 || appliedDirty) {
      appliedDirty = false;
      await notifyApplied();
    }
    // The rules keep their verdicts (a disabled config shows them disabled); only what is applied changed.
    const snapshot = config;
    const previous = new Map(state.rules.map((rule) => [rule.ruleId, rule]));
    seq += 1;
    const finishedAt = now();
    publish(
      buildEngineState({
        helperVersion,
        seq,
        configRevision,
        config: snapshot,
        wire,
        verdicts: new Map(
          snapshot.rules.map((rule) => {
            const before = previous.get(rule.id);
            const verdict: Verdict = disabledVerdict(snapshot, rule) ??
              (before === undefined
                ? { status: 'pending', reasonCode: 'interface-down', reason: 'Waiting for the first reconcile' }
                : { status: before.status, reasonCode: before.reasonCode, reason: before.reason });
            return [rule.id, { ...verdict, lastResolvedAt: before?.lastResolvedAt ?? null }];
          }),
        ),
        applied: appliedSnapshot(),
        lastApplyAt: finishedAt.toISOString(),
        lastReconcileReason: state.lastReconcileReason,
      }),
    );
    logger.info('applied routes cleared', { ...counts, left: applied.size, durationMs: Math.max(0, finishedAt.getTime() - startedAt) });
    return counts;
  };

  const clear = async (options?: ClearOptions): Promise<ClearResult> => {
    const final = options?.final === true;
    // Set before waiting: a stream of `reconcile` calls (socket requests, monitor events) must not
    // keep the final cleanup waiting. The running pass finishes; whatever queues up behind it does not run.
    if (final) shutDown = true;
    // Exclusive with the passes: wait until none runs or is queued, then hold the slot.
    while (running) {
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    }
    running = true;
    try {
      return await runClear();
    } catch (error) {
      logger.error('clearing the applied routes failed unexpectedly', { error: describeThrown(error) });
      return { removed: 0, forgotten: 0, failed: applied.size };
    } finally {
      running = false;
      const waiting = queued;
      queued = null;
      if (waiting !== null && !shutDown) start(waiting);
      else {
        waiting?.resolve(idleOutcome());
        releaseIdleWaiters();
      }
    }
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
    getConfigRevision: () => configRevision,
    setConfig,
    setEnabled,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getApplied: appliedSnapshot,
    forgetApplied,
    isReconciling: () => running,
    getRetryNeeds: () => ({ deferred: lastDeferred, refused: refusedAdds.size, failing: failing.size }),
    clear,
    restoreApplied,
  };
};
