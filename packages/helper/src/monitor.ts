import type { ReconcileReason } from '@routeswitch/shared';

import { LOOKUP_TIMEOUT_MS, type ClearTimer, type DomainResolverService, type SetTimer } from './dns';
import type { AppliedRoute, DriftedRoute, Engine, ReconcileOptions } from './engine';
import { ALLOWED_BINARIES, type CommandRunner, type ProcessSpawner, type RunningProcess } from './exec';
import type { Logger } from './logger';
import { expandNetstatDestination, type NetInfo } from './netinfo';

/**
 * Network monitor of the daemon: notices that the network changed and has the
 * engine reconcile, and checks now and then that the routes the engine
 * applied are still in the table.
 *
 * Network changes. `route -n monitor` runs as a child process for as long as
 * the monitor runs (restarted with a growing delay when it dies). Of what it
 * prints, these messages are a network change:
 * - `RTM_IFINFO` (link up/down), `RTM_NEWADDR`, `RTM_DELADDR` — always;
 * - `RTM_ADD`, `RTM_DELETE`, `RTM_CHANGE` — only for a default route, and
 *   never while a pass runs or within `ROUTE_EVENT_QUIET_MS` after one: the
 *   engine's own route commands produce these messages, and it never touches
 *   a default route anyway. Interface messages are not blocked during a pass
 *   (the engine causes none of them), so a cable pulled during a pass is not
 *   lost: it is handled after the debounce.
 * Changes are debounced: `DEBOUNCE_MS` after the last message, at the latest
 * `DEBOUNCE_MAX_MS` after the first. Then, in this order: `netinfo.invalidate()`
 * (the interface cache is stale), `dns.refreshAll()` (the answers may depend
 * on the network) and `engine.reconcile('network-change')`. The same follows
 * a wake from sleep, which shows as a gap between two drift checks, and a
 * restart of the child (messages may have been missed meanwhile).
 *
 * `dns.refreshAll()` cancels and restarts every running lookup, so called more
 * often than a lookup may take (`LOOKUP_TIMEOUT_MS`) it would keep a hung DNS
 * server from ever being noticed, and the last known addresses would never
 * expire. It therefore runs at most once per `DNS_REFRESH_MIN_INTERVAL_MS`;
 * a change within that time gets one refresh when it is over.
 *
 * Drift check, every `DRIFT_INTERVAL_MS`. It never runs the interface
 * detection: one `netstat -rn -f inet` (none when nothing is applied), compared
 * with `engine.getApplied()`. A route that is missing, or that the table has
 * through another gateway or as a connected route, is reported with
 * `engine.forgetApplied` and a `reconcile('drift-check')` adds it again (the
 * route wrapper decides whether what is there may be replaced). Besides:
 * - every `RETRY_EVERY_DRIFT_CHECKS`-th check, a pass with `retryRefused`
 *   when routes are refused (connected route in the way) or failing, so that
 *   nothing stays refused for good on a network where nothing happens;
 * - while the last pass deferred routes (`summary.deferred > 0`: the detection
 *   could not be trusted and the engine's own retries are used up), a pass
 *   with a fresh detection, every check at first and then less often (up to
 *   every `DEFERRED_RETRY_MAX_CHECKS`-th);
 * - when learned addresses of wildcard rules have expired
 *   (`RetryNeeds.learnedExpired`), a pass that removes their routes.
 */

/** Quiet time after the last network message before the reconcile. */
export const DEBOUNCE_MS = 1500;
/** A stream of messages that never pauses still gets its reconcile this long after the first one. */
export const DEBOUNCE_MAX_MS = 10_000;
/** Route messages are ignored for this long after a pass ends: the kernel may report our own commands late. */
export const ROUTE_EVENT_QUIET_MS = 1000;
/** `dns.refreshAll()` at most this often: never more often than one lookup may take. */
export const DNS_REFRESH_MIN_INTERVAL_MS = LOOKUP_TIMEOUT_MS;
export const DRIFT_INTERVAL_MS = 60_000;
/** Two drift checks further apart than `DRIFT_INTERVAL_MS` plus this: the machine slept (or the clock jumped). */
export const WAKE_GAP_SLACK_MS = 30_000;
/** Refused and failing routes are retried every this many drift checks (10 minutes). */
export const RETRY_EVERY_DRIFT_CHECKS = 10;
/** While routes are deferred, a fresh pass at most every this many drift checks (the gap doubles up to it). */
export const DEFERRED_RETRY_MAX_CHECKS = 10;
/** Restart delay of the monitor process: doubles from the first value up to the second. */
export const RESTART_MIN_DELAY_MS = 1000;
export const RESTART_MAX_DELAY_MS = 60_000;
/** A monitor process that ran this long before it died starts the restart delays from the beginning. */
export const RESTART_RESET_AFTER_MS = 60_000;
/** Bound of the routing table read by the drift check (≈ 20 600 routes of ours, `MAX_APPLIED_ROUTES`, plus the system's). */
export const DRIFT_MAX_TABLE_LINES = 40_000;
const DRIFT_MAX_LINE_LENGTH = 512;
const DRIFT_NETSTAT_TIMEOUT_MS = 10_000;
const DRIFT_NETSTAT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const MONITOR_ARGS: readonly string[] = ['-n', 'monitor'];
const NETSTAT_ROUTES_ARGS: readonly string[] = ['-rn', '-f', 'inet'];

/** Messages of `route -n monitor` that are a network change whatever they are about. */
const INTERFACE_MESSAGES: ReadonlySet<string> = new Set(['RTM_IFINFO', 'RTM_NEWADDR', 'RTM_DELADDR']);
/** Messages that are a network change only for a default route. */
const ROUTE_MESSAGES: ReadonlySet<string> = new Set(['RTM_ADD', 'RTM_DELETE', 'RTM_CHANGE']);
const SOCKADDRS_PREFIX = 'sockaddrs:';
const DEFAULT_DESTINATIONS: ReadonlySet<string> = new Set(['default', '0.0.0.0']);

// ---------------------------------------------------------------------------
// Parsing `route -n monitor`
// ---------------------------------------------------------------------------

/** A message of `route -n monitor` that is a network change. */
export interface NetworkEvent {
  /** `RTM_IFINFO`, `RTM_NEWADDR`, `RTM_DELADDR`, or `RTM_ADD` / `RTM_DELETE` / `RTM_CHANGE` of a default route. */
  readonly type: string;
  /** True for a route message (blocked while a pass runs). */
  readonly route: boolean;
}

/**
 * Reads the output of `route -n monitor` line by line. A message starts with
 * a line `RTM_<TYPE>: <text>`; for a route message, the line after
 * `sockaddrs: <DST,...>` holds the addresses, the destination first, printed
 * as `default` for a default route. Example:
 *
 *     got message of size 192 on Tue Oct 14 10:00:00 2026
 *     RTM_ADD: Add Route: len 192, pid: 0, seq 0, errno 0, flags:<UP,GATEWAY,DONE,STATIC>
 *     locks:  inits:
 *     sockaddrs: <DST,GATEWAY,NETMASK>
 *      default 192.0.2.1 default
 *
 * Lines are split into cells, never pattern-matched. Anything not understood
 * is ignored: a route message without a readable destination is not a change.
 */
export const createMonitorParser = (): { readonly push: (line: string) => NetworkEvent | null } => {
  /** A route message waiting for its address line: `sockaddrs` seen or not. */
  let pending: { readonly type: string; dstFirst: boolean | null } | null = null;

  return {
    push: (raw) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const cells = line.split(' ').filter((cell) => cell !== '');
      const [first] = cells;
      if (first === undefined) return null;

      if (first.startsWith('RTM_') && first.endsWith(':')) {
        const type = first.slice(0, -1);
        pending = null;
        if (INTERFACE_MESSAGES.has(type)) return { type, route: false };
        if (ROUTE_MESSAGES.has(type)) pending = { type, dstFirst: null };
        return null;
      }
      if (pending === null) return null;
      if (first === SOCKADDRS_PREFIX) {
        // `<DST,GATEWAY,NETMASK>`: the destination is printed first only when it is present.
        pending.dstFirst = (cells[1] ?? '').startsWith('<DST');
        return null;
      }
      if (pending.dstFirst === null) return null;
      const message = pending;
      pending = null;
      return message.dstFirst && DEFAULT_DESTINATIONS.has(first) ? { type: message.type, route: true } : null;
    },
  };
};

// ---------------------------------------------------------------------------
// Reading the routing table for the drift check
// ---------------------------------------------------------------------------

/** One gateway-or-link row of the IPv4 table, keyed by the destination in the form `AppliedRoute.dst` uses. */
export interface TableRoute {
  readonly gateway: string;
  readonly flags: string;
}

const splitCells = (line: string): string[] => line.replaceAll('\t', ' ').replaceAll('\r', ' ').split(' ').filter((cell) => cell !== '');

/**
 * Parses `netstat -rn -f inet` into destination -> rows. Host rows (`H` flag)
 * are keyed by the bare address, network rows by canonical CIDR
 * (`expandNetstatDestination`). Interface-scoped rows (`I` flag) are left out:
 * the engine's routes are not scoped, and `route get` without a scope does not
 * pick a scoped one. Returns `null` when the output cannot be trusted (no IPv4
 * section with its column header, or more than `DRIFT_MAX_TABLE_LINES` lines);
 * the check then decides nothing.
 */
export const parseTableRoutes = (stdout: string): Map<string, TableRoute[]> | null => {
  const routes = new Map<string, TableRoute[]>();
  let inInet = false;
  let columns: { gateway: number; flags: number } | null = null;
  let sawHeader = false;
  let lines = 0;
  for (const raw of stdout.split('\n')) {
    lines += 1;
    if (lines > DRIFT_MAX_TABLE_LINES) return null;
    if (raw.length > DRIFT_MAX_LINE_LENGTH) continue;
    const cells = splitCells(raw);
    const [first] = cells;
    if (first === undefined) continue;
    if (cells.length === 1 && first.endsWith(':')) {
      inInet = first === 'Internet:';
      columns = null;
      continue;
    }
    if (first === 'Destination') {
      const gateway = cells.indexOf('Gateway');
      const flags = cells.indexOf('Flags');
      columns = inInet && gateway > 0 && flags > 0 ? { gateway, flags } : null;
      sawHeader ||= columns !== null;
      continue;
    }
    if (!inInet || columns === null) continue;
    const gateway = cells[columns.gateway];
    const flags = cells[columns.flags];
    if (gateway === undefined || flags === undefined || flags.includes('I')) continue;
    const key = flags.includes('H') ? hostKey(first) : expandNetstatDestination(first);
    if (key === null) continue;
    const list = routes.get(key);
    if (list === undefined) routes.set(key, [{ gateway, flags }]);
    else list.push({ gateway, flags });
  }
  return sawHeader ? routes : null;
};

/** A host row's destination as printed: four plain decimal octets. */
const hostKey = (destination: string): string | null => {
  const octets = destination.split('.');
  if (octets.length !== 4) return null;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255 || (octet.length > 1 && octet.startsWith('0'))) return null;
  }
  return destination;
};

/**
 * How the table shows an applied route: `null` when it is there as added (same
 * gateway, `G` flag, not reject/blackhole), otherwise what is there instead.
 */
export const driftOf = (route: Pick<AppliedRoute, 'dst' | 'gateway'>, table: ReadonlyMap<string, readonly TableRoute[]>): string | null => {
  const rows = table.get(route.dst) ?? [];
  if (rows.length === 0) return 'missing';
  const ours = rows.some(
    (row) => row.gateway === route.gateway && row.flags.includes('G') && !row.flags.includes('R') && !row.flags.includes('B'),
  );
  if (ours) return null;
  return rows.some((row) => row.gateway.startsWith('link#') || !row.flags.includes('G')) ? 'connected' : 'other-gateway';
};

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

export interface NetworkMonitorDeps {
  readonly engine: Pick<
    Engine,
    'reconcile' | 'getApplied' | 'forgetApplied' | 'isReconciling' | 'getRetryNeeds' | 'subscribe' | 'getState'
  >;
  readonly netinfo: Pick<NetInfo, 'invalidate'>;
  /** The DNS module; without it (no domain rules wired) nothing is refreshed. */
  readonly dns?: Pick<DomainResolverService, 'refreshAll'> | undefined;
  /** For `netstat` (drift check). */
  readonly runner: CommandRunner;
  /** For `route -n monitor`. */
  readonly spawner: ProcessSpawner;
  readonly logger: Logger;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  /** Wall clock in milliseconds; a jump forward between two drift checks is how a wake from sleep shows. */
  readonly now?: (() => number) | undefined;
  /**
   * Monotonic clock in milliseconds (defaults to `performance.now`) for every
   * interval that must not depend on the wall clock: the DNS refresh window,
   * the quiet window after a pass, the debounce and the restart reset. Only the
   * wake detection reads `now`.
   */
  readonly monotonicNow?: (() => number) | undefined;
}

export interface NetworkMonitor {
  /** Starts the monitor process and the drift timer. Does not reconcile: the daemon's `startup` pass does. */
  start(): void;
  /** Stops the process and every timer; afterwards nothing reconciles. Safe to call more than once. */
  stop(): void;
}

type Trigger = 'network-change' | 'wake' | 'monitor-restart';

export const createNetworkMonitor = (deps: NetworkMonitorDeps): NetworkMonitor => {
  const { engine, netinfo, dns, runner, spawner, setTimer, clearTimer } = deps;
  const logger = deps.logger.child({ component: 'monitor' });
  const now = deps.now ?? (() => Date.now());
  const clock = deps.monotonicNow ?? (() => performance.now());
  /** Time since `since` on the monotonic clock; a negative value (a clock that should not go back did) counts as long ago. */
  const elapsedSince = (since: number): number => {
    const elapsed = clock() - since;
    return elapsed < 0 ? Infinity : elapsed;
  };

  let started = false;
  let stopped = false;
  let child: RunningProcess | null = null;
  let childStartedAt = 0;
  let restartDelay = RESTART_MIN_DELAY_MS;
  let restartTimer: unknown = null;

  let debounceTimer: unknown = null;
  let firstEventAt = 0;
  let eventTypes = new Set<string>();

  let lastDnsRefreshAt: number | null = null;
  let dnsTimer: unknown = null;

  let driftTimer: unknown = null;
  let lastTickAt = 0;
  let driftChecks = 0;
  let checking = false;
  /** Drift checks since the last pass that was run because routes were deferred, and the gap now required. */
  let deferredWait = 0;
  let deferredGap = 1;
  /** When the last pass ended (any reason), for `ROUTE_EVENT_QUIET_MS`. */
  let lastPassEndAt: number | null = null;
  let unsubscribe: (() => void) | null = null;

  /** Read through a function where an `await` may have let `stop()` run. */
  const isStopped = (): boolean => stopped;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const reconcile = (reason: ReconcileReason, options: ReconcileOptions, context: Record<string, unknown>): void => {
    if (stopped) return;
    void engine.reconcile(reason, options).then(
      (outcome) => {
        logger.debug('reconcile requested by the monitor finished', { reason, ...context, ...outcome.summary });
      },
      (error: unknown) => {
        // `reconcile` never rejects; if it does anyway, the next event or check tries again.
        logger.error('reconcile requested by the monitor failed', { reason, error: describe(error) });
      },
    );
  };

  // --- DNS refresh, rate limited ------------------------------------------

  const refreshDnsNow = (): void => {
    lastDnsRefreshAt = clock();
    try {
      dns?.refreshAll();
    } catch (error) {
      logger.error('DNS refresh failed', { error: describe(error) });
    }
  };

  const refreshDns = (): void => {
    if (dns === undefined || dnsTimer !== null) return;
    const since = lastDnsRefreshAt === null ? Infinity : elapsedSince(lastDnsRefreshAt);
    if (since >= DNS_REFRESH_MIN_INTERVAL_MS) {
      refreshDnsNow();
      return;
    }
    // A refresh ran moments ago: one more when the minimum interval is over, for this change and every
    // other one until then. A lookup is never restarted before it could time out.
    const delay = DNS_REFRESH_MIN_INTERVAL_MS - since;
    logger.debug('DNS refresh postponed', { delayMs: delay });
    dnsTimer = setTimer(() => {
      dnsTimer = null;
      if (!stopped) refreshDnsNow();
    }, delay);
  };

  // --- Network change -------------------------------------------------------

  const networkChanged = (trigger: Trigger, context: Record<string, unknown> = {}): void => {
    if (stopped) return;
    logger.info('network changed; reconciling', { trigger, ...context });
    netinfo.invalidate();
    refreshDns();
    reconcile('network-change', {}, { trigger });
  };

  const fireDebounce = (): void => {
    debounceTimer = null;
    const types = [...eventTypes].sort();
    eventTypes = new Set();
    networkChanged('network-change', { events: types });
  };

  const noteEvent = (event: NetworkEvent): void => {
    if (event.route) {
      const quiet = lastPassEndAt !== null && elapsedSince(lastPassEndAt) < ROUTE_EVENT_QUIET_MS;
      if (engine.isReconciling() || quiet) {
        logger.debug('route message ignored while the engine is reconciling', { type: event.type });
        return;
      }
    }
    const at = clock();
    if (debounceTimer === null) {
      firstEventAt = at;
    } else {
      clearTimer(debounceTimer);
    }
    eventTypes.add(event.type);
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, firstEventAt + DEBOUNCE_MAX_MS - at));
    debounceTimer = setTimer(fireDebounce, delay);
  };

  // --- The monitor process --------------------------------------------------

  const spawnChild = (afterRestart: boolean): void => {
    if (stopped) return;
    const parser = createMonitorParser();
    // An object, not a `let`: the handlers below change it, possibly before `spawn` returns.
    const life = { exited: false };
    childStartedAt = clock();
    try {
      const running = spawner.spawn(ALLOWED_BINARIES.route, MONITOR_ARGS, {
        onLine: (line) => {
          if (stopped || life.exited) return;
          const event = parser.push(line);
          if (event !== null) noteEvent(event);
        },
        onExit: (exit) => {
          life.exited = true;
          child = null;
          if (stopped || exit.stopped) return;
          scheduleRestart(exit);
        },
      });
      if (!life.exited) child = running;
    } catch (error) {
      // A refused call is a bug here (constant binary and arguments); retried like a crash all the same.
      logger.error('monitor process could not be started', { error: describe(error) });
      life.exited = true;
      scheduleRestart({ exitCode: null, signal: null, error: describe(error), stopped: false });
      return;
    }
    if (afterRestart && !life.exited) networkChanged('monitor-restart');
  };

  const scheduleRestart = (exit: { exitCode: number | null; signal: string | null; error: string | null; stopped: boolean }): void => {
    if (stopped || restartTimer !== null) return;
    if (elapsedSince(childStartedAt) >= RESTART_RESET_AFTER_MS) restartDelay = RESTART_MIN_DELAY_MS;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_DELAY_MS);
    logger.warn('monitor process ended; restarting', {
      exitCode: exit.exitCode,
      signal: exit.signal,
      error: exit.error,
      delayMs: delay,
    });
    restartTimer = setTimer(() => {
      restartTimer = null;
      spawnChild(true);
    }, delay);
  };

  // --- Drift check ----------------------------------------------------------

  const armDrift = (): void => {
    if (stopped) return;
    driftTimer = setTimer(() => {
      driftTimer = null;
      void driftTick().finally(armDrift);
    }, DRIFT_INTERVAL_MS);
  };

  /** Applied routes that the table does not have as added; `null` when the check could not decide. */
  const findDrift = async (): Promise<DriftedRoute[] | null> => {
    const before = engine.getApplied();
    if (before.length === 0) return [];
    const seq = engine.getState().seq;
    const result = await runner.run(ALLOWED_BINARIES.netstat, NETSTAT_ROUTES_ARGS, {
      timeoutMs: DRIFT_NETSTAT_TIMEOUT_MS,
      maxOutputBytes: DRIFT_NETSTAT_MAX_OUTPUT_BYTES,
    });
    if (stopped) return null;
    if (!result.ok) {
      logger.warn('drift check skipped: netstat failed', { failure: result.failure, exitCode: result.exitCode });
      return null;
    }
    // A pass that ran meanwhile changed what is applied: what netstat saw may be half of it.
    if (engine.isReconciling() || engine.getState().seq !== seq) {
      logger.debug('drift check skipped: a reconcile ran meanwhile');
      return null;
    }
    const table = parseTableRoutes(result.stdout);
    if (table === null) {
      logger.warn('drift check skipped: unexpected output from netstat', { outputLength: result.stdout.length });
      return null;
    }
    const drifted: DriftedRoute[] = [];
    for (const route of before) {
      const found = driftOf(route, table);
      if (found !== null) drifted.push({ dst: route.dst, gateway: route.gateway, found });
    }
    return drifted;
  };

  const driftTick = async (): Promise<void> => {
    if (stopped || checking) return;
    const at = now();
    const gap = at - lastTickAt;
    lastTickAt = at;
    if (gap > DRIFT_INTERVAL_MS + WAKE_GAP_SLACK_MS || gap < 0) {
      // Asleep (or the clock was set): interfaces, leases and the table may all be different now.
      networkChanged('wake', { gapMs: gap });
      return;
    }
    driftChecks += 1;
    if (engine.isReconciling()) {
      logger.debug('drift check skipped: a reconcile is running');
      return;
    }
    checking = true;
    try {
      const drifted = await findDrift();
      if (isStopped()) return;
      const needs = engine.getRetryNeeds();
      const options: { force?: boolean; retryRefused?: boolean } = {};
      const why: string[] = [];

      if (drifted !== null && drifted.length > 0 && !engine.isReconciling()) {
        const forgotten = engine.forgetApplied(drifted);
        if (forgotten > 0) why.push('drift');
        logger.warn('route drift detected', {
          drifted: drifted.length,
          forgotten,
          missing: drifted.filter((route) => route.found === 'missing').length,
        });
      }
      if (driftChecks % RETRY_EVERY_DRIFT_CHECKS === 0 && (needs.refused > 0 || needs.failing > 0)) {
        options.retryRefused = true;
        why.push('retry-refused');
      }
      if (needs.learnedExpired > 0) {
        // Wildcard rules: learned addresses whose lifetime is over lose their routes in the pass.
        why.push('learned-expired');
      }
      if (needs.deferred > 0) {
        deferredWait += 1;
        if (deferredWait >= deferredGap) {
          deferredWait = 0;
          deferredGap = Math.min(deferredGap * 2, DEFERRED_RETRY_MAX_CHECKS);
          options.force = true;
          why.push('deferred');
        }
      } else {
        deferredWait = 0;
        deferredGap = 1;
      }
      if (why.length > 0) reconcile('drift-check', options, { why });
    } catch (error) {
      logger.error('drift check failed', { error: describe(error) });
    } finally {
      checking = false;
    }
  };

  // --- Lifecycle --------------------------------------------------------------

  const start = (): void => {
    // Once stopped, a monitor stays stopped: no process, no timer, no subscription.
    if (started || stopped) return;
    started = true;
    lastTickAt = now();
    // Every pass end counts, also those of `dns-learned` passes whose announcement the engine coalesces.
    unsubscribe = engine.subscribe(
      () => {
        lastPassEndAt = clock();
      },
      { everyPass: true },
    );
    logger.info('network monitor started', { driftIntervalMs: DRIFT_INTERVAL_MS, debounceMs: DEBOUNCE_MS });
    spawnChild(false);
    armDrift();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const timer of [debounceTimer, dnsTimer, driftTimer, restartTimer]) if (timer !== null) clearTimer(timer);
    debounceTimer = null;
    dnsTimer = null;
    driftTimer = null;
    restartTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    const running = child;
    child = null;
    running?.stop();
    if (started) logger.info('network monitor stopped');
  };

  return { start, stop };
};
