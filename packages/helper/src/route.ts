import {
  forbiddenDestinationReason,
  normalizeHostAddress,
  normalizeIpv4,
  parseIpv4Destination,
  type ValidationCode,
} from '@routeswitch/shared';

import { ALLOWED_BINARIES, type CommandFailure, type CommandResult, type CommandRunner } from './exec';
import type { Logger } from './logger';

/**
 * The only module that runs `/sbin/route`.
 *
 * Every destination and gateway is re-parsed and re-serialised here, whatever
 * the caller already did, and checked against the shared forbidden list before
 * a command is built. A value that fails never reaches the runner.
 *
 * Error model:
 * - Anything wrong with the *values* (a forbidden, malformed or non-string
 *   destination or gateway) is returned as `{ ok: false, outcome: 'rejected' }`.
 *   Destinations are data — they come from the config and from DNS answers —
 *   so a bad one is a runtime condition, not a bug in the caller, and it must
 *   never take the daemon down.
 * - Everything that happens to a started command is returned as a value too
 *   (`'failed'`, with the exit code and stderr), following `CommandRunner`.
 * - The returned promise rejects only if the runner itself rejects, i.e. with
 *   `CommandRejectedError`. That cannot be triggered by a destination or a
 *   gateway (both are canonical IPv4 text by then) and would mean a bug here.
 */

/** `host` is a single address (`-host a.b.c.d`), `net` a subnet (`-net a.b.c.d/n`). */
export type RouteKind = 'host' | 'net';

export interface RouteAddRequest {
  /** A bare IPv4 address or an IPv4 CIDR. */
  readonly dst: string;
  /** Next hop: a plain IPv4 address. */
  readonly gateway: string;
}

export interface RouteDeleteRequest {
  readonly dst: string;
  /**
   * The gateway the route was added with. Validated when present and written
   * to the log; it is not passed to `route delete`, which removes the route
   * for `dst` whatever its gateway.
   */
  readonly gateway?: string | undefined;
}

/** The value was refused before any command was started. */
export interface RouteRejected {
  readonly ok: false;
  readonly outcome: 'rejected';
  /** Which input was refused. */
  readonly field: 'dst' | 'gateway' | 'target';
  readonly reason: ValidationCode;
  readonly message: string;
}

/**
 * `reported-error` — `route` exited with code 0 but printed an error. Seen on
 * macOS 26: `route -n get` for a destination without a route prints
 * "route: writing to routing socket: not in table" and exits 0.
 */
export type RouteFailureKind = CommandFailure | 'reported-error';

export type RouteStep = 'add' | 'delete' | 're-add' | 'get';

/** A `route` command ran (or was attempted) and did not do what was asked. */
export interface RouteFailed {
  readonly ok: false;
  readonly outcome: 'failed';
  /** The command that failed; `delete` and `re-add` belong to the "File exists" recovery. */
  readonly step: RouteStep;
  readonly failure: RouteFailureKind;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** One line describing the failure, taken from the command's own output where possible. */
  readonly message: string;
}

export interface RouteAdded {
  readonly ok: true;
  /** `replaced`: the route already existed, was deleted and added again. */
  readonly outcome: 'added' | 'replaced';
  /** Normalised destination as given to `route`: `10.1.2.3` or `10.0.0.0/8`. */
  readonly dst: string;
  readonly kind: RouteKind;
  readonly gateway: string;
}

export interface RouteDeleted {
  readonly ok: true;
  /** `not-found`: there was no such route; the caller can treat it as already gone. */
  readonly outcome: 'deleted' | 'not-found';
  readonly dst: string;
  readonly kind: RouteKind;
}

export type RouteAddResult = RouteAdded | RouteRejected | RouteFailed;
export type RouteDeleteResult = RouteDeleted | RouteRejected | RouteFailed;

/** What the kernel would use to reach an address, from `route -n get`. */
export interface RouteInfo {
  /** The address that was looked up (normalised). */
  readonly target: string;
  /** The matching table entry: an address, a network, or `default`. */
  readonly destination: string;
  readonly mask: string | null;
  /** Next hop as an IPv4 address; `null` for a directly reachable destination. */
  readonly gateway: string | null;
  /** Device name, e.g. `en0`. */
  readonly iface: string;
  readonly flags: readonly string[];
}

export interface RouteFound {
  readonly ok: true;
  readonly outcome: 'found';
  readonly route: RouteInfo;
}

/** The routing table has no entry (not even a default route) for the target. */
export interface RouteNotFound {
  readonly ok: false;
  readonly outcome: 'not-found';
  readonly target: string;
}

export type RouteGetResult = RouteFound | RouteNotFound | RouteRejected | RouteFailed;

export interface RouteOperations {
  /**
   * `/sbin/route -n add -host|-net <dst> <gateway>`. If the route already
   * exists it is deleted and added again, once.
   */
  routeAdd(request: RouteAddRequest): Promise<RouteAddResult>;
  /** `/sbin/route -n delete -host|-net <dst>`. */
  routeDelete(request: RouteDeleteRequest): Promise<RouteDeleteResult>;
  /** `/sbin/route -n get -host <ip>`: which interface and gateway reach `target`. */
  routeGet(target: string): Promise<RouteGetResult>;
}

export interface RouteDeps {
  readonly runner: CommandRunner;
  readonly logger: Logger;
}

interface ValidDestination {
  /** The exact argument for `route`: bare address for a host, CIDR for a net. */
  readonly dst: string;
  readonly kind: RouteKind;
}

type Checked<T> = { readonly ok: true; readonly value: T } | RouteRejected;

const REJECTION_MESSAGES = {
  dst: 'Destination must be a string holding an IPv4 address or an IPv4 subnet in CIDR form',
  gateway: 'Gateway must be a string holding an IPv4 address',
  target: 'Target must be a string holding an IPv4 address',
} as const;

const rejected = (
  field: RouteRejected['field'],
  reason: ValidationCode,
  message: string,
): RouteRejected => ({ ok: false, outcome: 'rejected', field, reason, message });

/**
 * Host or net is derived from the parsed destination, never from a flag the
 * caller passes: a `/32` or a bare address is a host and is always given to
 * `route` as `-host <address>`, so an address whose host part is zero
 * (`10.0.0.0`) is not read as a network; everything else is `-net <cidr>`
 * with the host bits cleared.
 */
const checkDestination = (value: unknown): Checked<ValidDestination> => {
  if (typeof value !== 'string') {
    return rejected('dst', 'invalid-destination', REJECTION_MESSAGES.dst);
  }
  const reason = forbiddenDestinationReason(value);
  if (reason !== null) {
    return rejected('dst', reason, `Destination refused (${reason})`);
  }
  const parsed = parseIpv4Destination(value);
  // Checked again on the re-serialised form: that, not the input, is what runs.
  if (parsed === null || forbiddenDestinationReason(parsed.cidr) !== null) {
    return rejected('dst', 'invalid-destination', REJECTION_MESSAGES.dst);
  }
  return {
    ok: true,
    value: parsed.isHost ? { dst: parsed.address, kind: 'host' } : { dst: parsed.cidr, kind: 'net' },
  };
};

/** A gateway is a plain IPv4 address (no prefix) that is not itself forbidden. */
const checkGateway = (value: unknown): Checked<string> => {
  if (typeof value !== 'string') {
    return rejected('gateway', 'invalid-ipv4', REJECTION_MESSAGES.gateway);
  }
  const normalised = normalizeHostAddress(value);
  return normalised.ok
    ? { ok: true, value: normalised.value }
    : rejected('gateway', normalised.error.code, `Gateway refused (${normalised.error.code})`);
};

const LOGGED_INPUT_LIMIT = 64;

/** Refused input for the log: bounded, and only ever a string. */
const describeInput = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, LOGGED_INPUT_LIMIT) : `<${typeof value}>`;

/** Reads a request field without assuming the request is an object. */
const field = (request: unknown, name: 'dst' | 'gateway'): unknown =>
  typeof request === 'object' && request !== null
    ? (request as Readonly<Record<string, unknown>>)[name]
    : undefined;

// `route` reports a failed request twice: "route: writing to routing socket:
// <reason>" on stderr and "<cmd> host|net <dst>[: gateway <gw>]: <reason>" on
// stdout. Both wordings of each reason are accepted (errno text and the
// friendlier names route(8) documents).
const ALREADY_EXISTS = /File exists|already in table/i;
const NOT_IN_TABLE = /not in table|No such process/i;
const STDERR_DIAGNOSTIC = /^route: (.+)$/m;
const STDOUT_DIAGNOSTIC = /^(?:add|delete) (?:host|net) [^:\n]*(?:: gateway [^:\n]*)?: (?!gateway )(.+)$/m;

type Verdict = 'ok' | 'already-exists' | 'not-in-table' | 'error';

/** An error `route` printed, whatever its exit code; `null` when it printed none. */
const reportedError = (result: CommandResult): string | null =>
  result.stderr.match(STDERR_DIAGNOSTIC)?.[1] ?? result.stdout.match(STDOUT_DIAGNOSTIC)?.[1] ?? null;

/**
 * Success needs exit code 0 AND no error in the output: `route` on macOS can
 * print an error and still exit 0, and may exit non-zero on other versions.
 */
const judge = (result: CommandResult, step: RouteStep): Verdict => {
  // Killed, overflowed or never started: the output is not a complete answer.
  if (result.failure !== null && result.failure !== 'nonzero-exit') return 'error';
  const output = `${result.stdout}\n${result.stderr}`;
  const adding = step === 'add' || step === 're-add';
  if (adding && ALREADY_EXISTS.test(output)) return 'already-exists';
  if (!adding && NOT_IN_TABLE.test(output)) return 'not-in-table';
  return result.ok && reportedError(result) === null ? 'ok' : 'error';
};

const failed = (step: RouteStep, result: CommandResult, fallback?: string): RouteFailed => ({
  ok: false,
  outcome: 'failed',
  step,
  failure: result.failure ?? 'reported-error',
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  message:
    reportedError(result) ??
    result.error ??
    fallback ??
    `route exited with code ${String(result.exitCode)}`,
});

const INTERFACE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;
const GET_KEY = /^[a-z][a-z ]*$/;
/** A value never spans lines; `split('\n')` leaves these behind when the output is malformed. */
const LINE_TERMINATOR = /[\r\u2028\u2029]/;

/**
 * Splits one `key: value` line of `route -n get` at its first colon. Done with
 * `indexOf` and `trim` instead of one pattern over the whole line: a lazy
 * `\s*(.*?)\s*$` backtracks in cubic time on a line holding a stray `\r`.
 */
const parseGetLine = (line: string): readonly [key: string, value: string] | null => {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const key = line.slice(0, colon).trimStart();
  const value = line.slice(colon + 1).trim();
  return GET_KEY.test(key) && !LINE_TERMINATOR.test(value) ? [key, value] : null;
};

/**
 * Parses the `key: value` block `route -n get` prints. Returns null when the
 * output has no usable `interface` line.
 */
export const parseRouteGetOutput = (target: string, stdout: string): RouteInfo | null => {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const parsed = parseGetLine(line);
    if (parsed !== null && !fields.has(parsed[0])) fields.set(parsed[0], parsed[1]);
  }
  const iface = fields.get('interface');
  const destination = fields.get('destination');
  if (iface === undefined || !INTERFACE_NAME.test(iface) || destination === undefined || destination === '') {
    return null;
  }
  const gateway = normalizeIpv4(fields.get('gateway') ?? '');
  const flags = (fields.get('flags') ?? '').match(/^<(.*)>$/)?.[1];
  return {
    target,
    destination,
    mask: fields.get('mask') ?? null,
    // A link-level gateway (`link#15`, a MAC address) is not a next hop the
    // caller can use, so only an IPv4 address is reported.
    gateway: gateway.ok ? gateway.value : null,
    iface,
    flags: flags === undefined || flags === '' ? [] : flags.split(','),
  };
};

export const createRouteOperations = (deps: RouteDeps): RouteOperations => {
  const { runner } = deps;
  const logger = deps.logger.child({ component: 'route' });

  const logRejected = (op: string, rejection: RouteRejected, dst: unknown, gateway: unknown): void => {
    logger.warn('route request rejected', {
      op,
      dst: describeInput(dst),
      gateway: gateway === undefined ? null : describeInput(gateway),
      outcome: rejection.outcome,
      field: rejection.field,
      reason: rejection.reason,
    });
  };

  const logFailed = (op: string, failure: RouteFailed, dst: string, gateway: string | null): void => {
    logger.error('route command failed', {
      op,
      dst,
      gateway,
      outcome: failure.outcome,
      step: failure.step,
      failure: failure.failure,
      exitCode: failure.exitCode,
      error: failure.message,
    });
  };

  const runAdd = ({ dst, kind }: ValidDestination, gateway: string): Promise<CommandResult> =>
    runner.run(ALLOWED_BINARIES.route, ['-n', 'add', `-${kind}`, dst, gateway]);

  const runDelete = ({ dst, kind }: ValidDestination): Promise<CommandResult> =>
    runner.run(ALLOWED_BINARIES.route, ['-n', 'delete', `-${kind}`, dst]);

  const add = async (destination: ValidDestination, gateway: string): Promise<RouteAdded | RouteFailed> => {
    const done = (outcome: RouteAdded['outcome']): RouteAdded => ({
      ok: true,
      outcome,
      dst: destination.dst,
      kind: destination.kind,
      gateway,
    });

    const first = await runAdd(destination, gateway);
    const verdict = judge(first, 'add');
    if (verdict === 'ok') return done('added');
    if (verdict !== 'already-exists') return failed('add', first);

    // The route is there, possibly with another gateway: replace it, once.
    const removal = await runDelete(destination);
    // `not-in-table` here means it vanished in between; adding again is still right.
    if (judge(removal, 'delete') === 'error') return failed('delete', removal);

    const second = await runAdd(destination, gateway);
    const secondVerdict = judge(second, 're-add');
    if (secondVerdict === 'ok') return done('replaced');
    return failed('re-add', second, secondVerdict === 'already-exists' ? 'route already exists' : undefined);
  };

  const routeAdd = async (request: RouteAddRequest): Promise<RouteAddResult> => {
    const rawDst = field(request, 'dst');
    const rawGateway = field(request, 'gateway');
    const destination = checkDestination(rawDst);
    if (!destination.ok) {
      logRejected('add', destination, rawDst, rawGateway);
      return destination;
    }
    const gateway = checkGateway(rawGateway);
    if (!gateway.ok) {
      logRejected('add', gateway, rawDst, rawGateway);
      return gateway;
    }

    const result = await add(destination.value, gateway.value);
    if (result.ok) {
      logger.info('route added', {
        op: 'add',
        dst: result.dst,
        gateway: result.gateway,
        kind: result.kind,
        outcome: result.outcome,
      });
    } else {
      logFailed('add', result, destination.value.dst, gateway.value);
    }
    return result;
  };

  const routeDelete = async (request: RouteDeleteRequest): Promise<RouteDeleteResult> => {
    const rawDst = field(request, 'dst');
    const rawGateway = field(request, 'gateway');
    const destination = checkDestination(rawDst);
    if (!destination.ok) {
      logRejected('delete', destination, rawDst, rawGateway);
      return destination;
    }
    let gateway: string | null = null;
    if (rawGateway !== undefined) {
      const checked = checkGateway(rawGateway);
      if (!checked.ok) {
        logRejected('delete', checked, rawDst, rawGateway);
        return checked;
      }
      gateway = checked.value;
    }

    const { dst, kind } = destination.value;
    const result = await runDelete(destination.value);
    const verdict = judge(result, 'delete');
    if (verdict === 'error') {
      const failure = failed('delete', result);
      logFailed('delete', failure, dst, gateway);
      return failure;
    }
    const outcome = verdict === 'not-in-table' ? 'not-found' : 'deleted';
    logger.info(outcome === 'deleted' ? 'route deleted' : 'route was not in the table', {
      op: 'delete',
      dst,
      gateway,
      kind,
      outcome,
    });
    return { ok: true, outcome, dst, kind };
  };

  const routeGet = async (target: string): Promise<RouteGetResult> => {
    // A lookup changes nothing, so the forbidden list does not apply (asking
    // how 127.0.0.1 is routed is harmless); the target still has to be a
    // strict IPv4 address so no keyword, host name or option reaches `route`.
    const raw: unknown = target;
    const address = typeof raw === 'string' ? normalizeIpv4(raw) : null;
    if (address === null || !address.ok) {
      const rejection = rejected('target', 'invalid-ipv4', REJECTION_MESSAGES.target);
      logRejected('get', rejection, raw, undefined);
      return rejection;
    }

    const dst = address.value;
    // `-host` for the same reason as in `add`: `10.0.0.0` is an address here.
    const result = await runner.run(ALLOWED_BINARIES.route, ['-n', 'get', '-host', dst]);
    const verdict = judge(result, 'get');
    if (verdict === 'not-in-table') {
      logger.info('no route to target', { op: 'get', dst, gateway: null, outcome: 'not-found' });
      return { ok: false, outcome: 'not-found', target: dst };
    }
    const route = verdict === 'ok' ? parseRouteGetOutput(dst, result.stdout) : null;
    if (route === null) {
      const failure = failed('get', result, 'unrecognised output from route get');
      logFailed('get', failure, dst, null);
      return failure;
    }
    logger.info('route looked up', {
      op: 'get',
      dst,
      gateway: route.gateway,
      iface: route.iface,
      outcome: 'found',
    });
    return { ok: true, outcome: 'found', route };
  };

  return { routeAdd, routeDelete, routeGet };
};
