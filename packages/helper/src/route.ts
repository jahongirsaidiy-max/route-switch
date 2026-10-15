import {
  cidrContains,
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
 *
 * What `routeAdd` may delete: when `route add` answers "File exists", the
 * entry that is in the way is read first (`route -n get`), and it is deleted
 * only when that output positively shows the exact entry for the destination
 * going through an IPv4 gateway. The kernel's own on-link entry for an
 * interface's subnet (a "connected" route) is never deleted, whatever the
 * caller believes about the network: removing it cuts that LAN until the
 * interface is brought up again. Anything the output does not settle is left
 * alone as well.
 *
 * `routeDelete` follows the same rule: it reads the entry first and deletes
 * only an exact entry through an IPv4 gateway -- and, when the caller says
 * which gateway its route used, only one through that gateway. The table may
 * have changed since the caller added its route: an interface may have joined
 * a subnet equal to the destination, or someone may have replaced the route.
 *
 * Residual risk (accepted): the table can still change between the lookup and
 * the delete, a few milliseconds apart. Nothing closes that window from user
 * space: `route delete` removes whatever entry is at the destination, and the
 * kernel does not compare a gateway given to it (verified on macOS 26 --
 * `route delete -net <dst> <another gateway>` removed the route), so no
 * gateway is passed to `route delete`.
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
   * The gateway the route was added with. When present, only an entry that
   * goes through exactly this gateway is deleted; an entry through another
   * gateway is somebody else's and is left alone (`not-ours`). When absent,
   * any exact entry through an IPv4 gateway is deleted. A connected route is
   * never deleted either way. It is not passed to `route delete`: the kernel
   * ignores a gateway there and removes the entry for `dst` whatever it is.
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
export type RouteFailureKind = CommandFailure | 'reported-error' | 'connected-route' | 'existing-route-unknown';

/**
 * `inspect` is the read-only `route -n get` that follows a "File exists"; a
 * failure at that step means nothing was deleted and the table is unchanged.
 * Its `failure` is one of:
 * - `connected-route` (`routeAdd` only) — the entry in the way is a connected
 *   / interface route (no `GATEWAY` flag, or a link-level gateway). It was
 *   left in place.
 * - `existing-route-unknown` — the entry could not be identified with
 *   certainty. For `routeAdd`: the lookup failed, its output was not
 *   understood, or it described another, wider entry. For `routeDelete`: the
 *   lookup failed or its output was not understood (a well-formed answer that
 *   describes a wider entry means there is nothing to delete: `not-found`).
 *   Whatever is there was left in place.
 */
export type RouteStep = 'add' | 'inspect' | 'delete' | 're-add' | 'get';

/** A `route` command ran (or was attempted) and did not do what was asked. */
export interface RouteFailed {
  readonly ok: false;
  readonly outcome: 'failed';
  /**
   * The command that failed. `inspect`, `delete` and `re-add` belong to the
   * "File exists" recovery of `routeAdd`; `inspect` and `delete` to `routeDelete`.
   */
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
  /**
   * - `replaced`: a route through another gateway existed, was deleted and added again.
   * - `exists`: the route was already there with exactly this gateway; nothing
   *   was deleted or added. The caller may treat it as its own from here on.
   */
  readonly outcome: 'added' | 'replaced' | 'exists';
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

/**
 * `routeDelete` found an entry at the destination that is not the caller's
 * route and deleted nothing. For the caller the goal "my route is gone" is met
 * (`ok: true`): its route is not in the table any more, something else is.
 * The caller should forget the route; it must not report it as deleted.
 */
export interface RouteNotOurs {
  readonly ok: true;
  readonly outcome: 'not-ours';
  readonly dst: string;
  readonly kind: RouteKind;
  /**
   * - `connected`: the entry is a connected / interface route (an interface
   *   has joined a subnet equal to the destination). Never deleted.
   * - `other-gateway`: the entry goes through another gateway than the one in
   *   the request, or is a reject / blackhole route: someone replaced ours.
   */
  readonly reason: 'connected' | 'other-gateway';
  /** One line for the log and for a rule's reason. */
  readonly message: string;
}

export type RouteAddResult = RouteAdded | RouteRejected | RouteFailed;
export type RouteDeleteResult = RouteDeleted | RouteNotOurs | RouteRejected | RouteFailed;

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
   * exists, the existing entry is read with `route -n get` first: one through
   * the same gateway is kept (`exists`), one through another IPv4 gateway is
   * deleted and added again, once (`replaced`), and a connected route or an
   * entry that cannot be identified is never deleted (`failed`, step `inspect`).
   */
  routeAdd(request: RouteAddRequest): Promise<RouteAddResult>;
  /**
   * `/sbin/route -n get -host|-net <dst>`, then `/sbin/route -n delete
   * -host|-net <dst>` only when the lookup shows the exact entry for `dst`
   * through an IPv4 gateway (the request's gateway, when it names one). No
   * exact entry -> `not-found`; a connected route or a route through another
   * gateway -> `not-ours`, nothing deleted; an answer that cannot be read ->
   * `failed` (step `inspect`), nothing deleted.
   */
  routeDelete(request: RouteDeleteRequest): Promise<RouteDeleteResult>;
  /**
   * `/sbin/route -n get -host <ip>`: which interface and gateway reach `target`.
   * With `private: true` (an address a user asked to diagnose) the target is
   * logged at `debug` only: every line at `info` and above, here and in the
   * command log, leaves it out. The lookup itself is the same.
   */
  routeGet(target: string, options?: RouteGetOptions): Promise<RouteGetResult>;
}

export interface RouteGetOptions {
  readonly private?: boolean;
}

/** Index of the target in the `route -n get -host <ip>` arguments: redacted from the command log of a private lookup. */
const GET_TARGET_ARG = 3;

export interface RouteDeps {
  readonly runner: CommandRunner;
  readonly logger: Logger;
}

interface ValidDestination {
  /** The exact argument for `route`: bare address for a host, CIDR for a net. */
  readonly dst: string;
  readonly kind: RouteKind;
  /** The address without the prefix: what `route -n get` prints as `route to` and `destination`. */
  readonly address: string;
  readonly prefix: number;
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
    value: {
      dst: parsed.isHost ? parsed.address : parsed.cidr,
      kind: parsed.isHost ? 'host' : 'net',
      address: parsed.address,
      prefix: parsed.prefix,
    },
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
  // `get`, `inspect` and `delete` all answer "not in table" for a missing entry.
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

interface GetFields {
  /** Key -> value; the first occurrence of a key wins. */
  readonly values: ReadonlyMap<string, string>;
  /** A key appeared more than once: the block is not one coherent answer. */
  readonly repeated: boolean;
}

const readGetFields = (stdout: string): GetFields => {
  const values = new Map<string, string>();
  let repeated = false;
  for (const line of stdout.split('\n')) {
    const parsed = parseGetLine(line);
    if (parsed === null) continue;
    if (values.has(parsed[0])) repeated = true;
    else values.set(parsed[0], parsed[1]);
  }
  return { values, repeated };
};

/** The names inside `<UP,GATEWAY,…>`; null when the value is not such a list. */
const parseFlagList = (value: string | undefined): readonly string[] | null => {
  const inner = value?.match(/^<(.*)>$/)?.[1];
  return inner === undefined ? null : inner === '' ? [] : inner.split(',');
};

/**
 * Parses the `key: value` block `route -n get` prints. Returns null when the
 * output has no usable `interface` line.
 */
export const parseRouteGetOutput = (target: string, stdout: string): RouteInfo | null => {
  const fields = readGetFields(stdout).values;
  const iface = fields.get('interface');
  const destination = fields.get('destination');
  if (iface === undefined || !INTERFACE_NAME.test(iface) || destination === undefined || destination === '') {
    return null;
  }
  const gateway = normalizeIpv4(fields.get('gateway') ?? '');
  return {
    target,
    destination,
    mask: fields.get('mask') ?? null,
    // A link-level gateway (`link#15`, a MAC address) is not a next hop the
    // caller can use, so only an IPv4 address is reported.
    gateway: gateway.ok ? gateway.value : null,
    iface,
    flags: parseFlagList(fields.get('flags')) ?? [],
  };
};

/**
 * What `route -n get -host|-net <dst>` says about the table entry for a
 * destination.
 *
 * - `gateway`: positively the exact entry for the destination, going through
 *   an IPv4 next hop. The only state in which the entry may be deleted.
 * - `connected`: the exact entry, and it is on-link (a connected subnet, an
 *   interface route, a neighbour entry). Never deleted.
 * - `absent`: a well-formed answer about another, strictly wider entry (a
 *   covering subnet or the default route): the lookup fell through, so the
 *   table holds no exact entry for the destination.
 * - `unknown`: anything else. Never deleted.
 */
export type InspectedRoute =
  | {
      readonly state: 'gateway';
      readonly gateway: string;
      readonly iface: string;
      /** False for a reject / blackhole route: it has a gateway, but it is not a plain route through it. */
      readonly plain: boolean;
    }
  | { readonly state: 'connected'; readonly iface: string; readonly detail: string }
  | { readonly state: 'absent'; readonly detail: string }
  | { readonly state: 'unknown'; readonly detail: string };

/**
 * What `route -n get -host|-net <dst>` says about the entry that made
 * `route add` answer "File exists". As `InspectedRoute`, except that a missing
 * exact entry is `unknown` here: `route add` has just said there is one.
 */
export type ExistingRoute =
  | {
      readonly state: 'gateway';
      readonly gateway: string;
      readonly iface: string;
      /** It already goes through the requested gateway and is not a reject / blackhole route. */
      readonly sameAsRequested: boolean;
    }
  | { readonly state: 'connected'; readonly iface: string; readonly detail: string }
  | { readonly state: 'unknown'; readonly detail: string };

const FLAG_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;
const LINK_GATEWAY = /^link#\d{1,10}$/;
const MAC_GATEWAY = /^[0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}$/i;
const HEX_MASK = /^0x([0-9a-f]{8})$/i;
const HOST_MASK_PREFIX = 32;
/** What `route -n get` prints as both `destination` and `mask` of the default route. */
const DEFAULT_KEYWORD = 'default';

/**
 * The prefix length of a netmask as `route -n get` prints it: dotted quad on
 * macOS (`255.255.255.0`); `0xffffff00` is accepted too because it cannot be
 * misread. Null for anything else, including a mask whose bits are not
 * contiguous.
 */
const maskPrefix = (mask: string): number | null => {
  let bits: number;
  const hex = mask.match(HEX_MASK)?.[1];
  if (hex !== undefined) {
    bits = Number.parseInt(hex, 16);
  } else {
    const dotted = normalizeIpv4(mask);
    if (!dotted.ok) return null;
    bits = dotted.value.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
  }
  let prefix = 0;
  while (prefix < HOST_MASK_PREFIX && Math.floor(bits / 2 ** (HOST_MASK_PREFIX - 1 - prefix)) % 2 === 1) prefix += 1;
  // Every bit after the leading run of ones has to be zero.
  return bits % 2 ** (HOST_MASK_PREFIX - prefix) === 0 ? prefix : null;
};

const unknownRoute = (detail: string): { readonly state: 'unknown'; readonly detail: string } => ({ state: 'unknown', detail });

const NOT_THE_DESTINATION = 'route get answered with another entry than the destination';

/**
 * Decides what a `route -n get` block says about the table entry for one
 * destination.
 *
 * `route -n get` is a lookup: without an exact entry it answers with the best
 * less specific one (the subnet that covers an address, or the default route).
 * Its flags say nothing about the destination then, so the block is first
 * matched against the destination and only an exact match is classified:
 *
 * - `route to` and `destination` are both the requested address, as strict
 *   dotted IPv4 (`default` or a shortened form never matches);
 * - for a host: no `mask` line together with the `HOST` flag, or a `mask` of
 *   exactly /32;
 * - for a subnet: a `mask` line that is exactly the requested prefix, and no
 *   `HOST` flag.
 *
 * Exact entry without the `GATEWAY` flag, or with a link-level gateway
 * (`link#15`, a MAC address) -> `connected`. Exact entry with `GATEWAY` and a
 * gateway that is a usable IPv4 address -> `gateway`.
 *
 * A block that is not the exact entry is `absent` only when it is positively
 * a fallen-through lookup: it answers about the requested address (`route
 * to`), and describes either the default route (`destination: default`) or a
 * subnet entry that is strictly wider than the destination and contains it
 * (a network address with a readable mask, no `HOST` flag). An exact entry
 * can never satisfy that: its prefix is the destination's own.
 *
 * Everything else -- a repeated key, a missing or malformed line, a gateway
 * that is neither kind, an entry that is narrower than the destination or
 * does not contain it -- is `unknown`.
 */
export const inspectRouteEntry = (
  wanted: { readonly kind: RouteKind; readonly address: string; readonly prefix: number },
  stdout: string,
): InspectedRoute => {
  const { values, repeated } = readGetFields(stdout);
  if (repeated) return unknownRoute('route get printed a field twice');

  const iface = values.get('interface');
  if (iface === undefined || !INTERFACE_NAME.test(iface)) return unknownRoute('route get printed no usable interface');
  const flags = parseFlagList(values.get('flags'));
  if (flags === null || flags.length === 0 || !flags.every((flag) => FLAG_NAME.test(flag))) {
    return unknownRoute('route get printed no usable flags');
  }
  if (values.get('route to') !== wanted.address) return unknownRoute('route get answered about another address');

  const destination = values.get('destination');
  const mask = values.get('mask');
  if (destination === DEFAULT_KEYWORD) {
    return mask === undefined || mask === DEFAULT_KEYWORD
      ? { state: 'absent', detail: 'the lookup fell through to the default route' }
      : unknownRoute('route get printed a mask that is not understood');
  }
  if (destination === undefined || !normalizeIpv4(destination).ok) return unknownRoute(NOT_THE_DESTINATION);
  const prefix = mask === undefined ? null : maskPrefix(mask);
  if (mask !== undefined && prefix === null) return unknownRoute('route get printed a mask that is not understood');
  const isHostEntry = flags.includes('HOST');

  const exact =
    destination === wanted.address &&
    (wanted.kind === 'host'
      ? prefix === null
        ? isHostEntry
        : prefix === HOST_MASK_PREFIX
      : prefix === wanted.prefix && !isHostEntry);
  if (!exact) {
    // A wider subnet entry that contains the destination: what a lookup
    // returns when the destination itself has no entry.
    const covering =
      prefix !== null &&
      !isHostEntry &&
      prefix < wanted.prefix &&
      parseIpv4Destination(`${destination}/${String(prefix)}`)?.address === destination &&
      cidrContains(`${destination}/${String(prefix)}`, `${wanted.address}/${String(wanted.prefix)}`);
    return covering
      ? { state: 'absent', detail: 'the lookup fell through to a wider route that covers the destination' }
      : unknownRoute(NOT_THE_DESTINATION);
  }

  if (!flags.includes('GATEWAY')) {
    return { state: 'connected', iface, detail: 'the existing entry has no GATEWAY flag' };
  }
  const gateway = values.get('gateway');
  if (gateway !== undefined && (LINK_GATEWAY.test(gateway) || MAC_GATEWAY.test(gateway))) {
    return { state: 'connected', iface, detail: 'the existing entry has a link-level gateway' };
  }
  const hop = gateway === undefined ? null : normalizeHostAddress(gateway);
  if (hop === null || !hop.ok) return unknownRoute('the existing entry has no usable IPv4 gateway');
  return { state: 'gateway', gateway: hop.value, iface, plain: !flags.includes('REJECT') && !flags.includes('BLACKHOLE') };
};

/**
 * `inspectRouteEntry` for the entry that made `route add` answer "File
 * exists", for the gateway the add asked for. `absent` becomes `unknown`:
 * `route add` said an entry exists, the lookup says none does, and nothing is
 * deleted on a contradiction.
 */
export const classifyExistingRoute = (
  wanted: { readonly kind: RouteKind; readonly address: string; readonly prefix: number },
  requestedGateway: string,
  stdout: string,
): ExistingRoute => {
  const entry = inspectRouteEntry(wanted, stdout);
  if (entry.state === 'absent') return unknownRoute(NOT_THE_DESTINATION);
  if (entry.state !== 'gateway') return entry;
  return {
    state: 'gateway',
    gateway: entry.gateway,
    iface: entry.iface,
    sameAsRequested: entry.gateway === requestedGateway && entry.plain,
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

  const logFailed = (
    op: string,
    failure: RouteFailed,
    dst: string,
    gateway: string | null,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    logger.error('route command failed', {
      op,
      dst,
      gateway,
      outcome: failure.outcome,
      step: failure.step,
      failure: failure.failure,
      exitCode: failure.exitCode,
      ...extra,
      error: failure.message,
    });
  };

  const runAdd = ({ dst, kind }: ValidDestination, gateway: string): Promise<CommandResult> =>
    runner.run(ALLOWED_BINARIES.route, ['-n', 'add', `-${kind}`, dst, gateway]);

  const runDelete = ({ dst, kind }: ValidDestination): Promise<CommandResult> =>
    runner.run(ALLOWED_BINARIES.route, ['-n', 'delete', `-${kind}`, dst]);

  const runGet = ({ dst, kind }: ValidDestination): Promise<CommandResult> =>
    runner.run(ALLOWED_BINARIES.route, ['-n', 'get', `-${kind}`, dst]);

  /** Reads the entry that made `route add` answer "File exists". Changes nothing. */
  const inspect = async (
    destination: ValidDestination,
    gateway: string,
  ): Promise<{ readonly lookup: CommandResult; readonly existing: ExistingRoute }> => {
    const lookup = await runGet(destination);
    const verdict = judge(lookup, 'inspect');
    if (verdict === 'ok') return { lookup, existing: classifyExistingRoute(destination, gateway, lookup.stdout) };
    const detail =
      verdict === 'not-in-table'
        ? 'route add reported an existing route, but route get found none'
        : `route get failed: ${reportedError(lookup) ?? lookup.error ?? lookup.failure ?? `exit code ${String(lookup.exitCode)}`}`;
    return { lookup, existing: unknownRoute(detail) };
  };

  interface AddReport {
    readonly result: RouteAdded | RouteFailed;
    /** What the "File exists" inspection found; null when there was none. */
    readonly existing: ExistingRoute | null;
  }

  const add = async (destination: ValidDestination, gateway: string): Promise<AddReport> => {
    const done = (outcome: RouteAdded['outcome']): RouteAdded => ({
      ok: true,
      outcome,
      dst: destination.dst,
      kind: destination.kind,
      gateway,
    });

    const first = await runAdd(destination, gateway);
    const verdict = judge(first, 'add');
    if (verdict === 'ok') return { result: done('added'), existing: null };
    if (verdict !== 'already-exists') return { result: failed('add', first), existing: null };

    // Something is in the way. Read it before touching it: only an entry that
    // is positively a route through an IPv4 gateway may be deleted.
    const { lookup, existing } = await inspect(destination, gateway);
    if (existing.state !== 'gateway') {
      const result: RouteFailed = {
        ok: false,
        outcome: 'failed',
        step: 'inspect',
        failure: existing.state === 'connected' ? 'connected-route' : 'existing-route-unknown',
        exitCode: lookup.exitCode,
        stdout: lookup.stdout,
        stderr: lookup.stderr,
        message:
          existing.state === 'connected'
            ? `a connected route for ${destination.dst} already exists on ${existing.iface} and was left in place (${existing.detail})`
            : `a route for ${destination.dst} already exists and was left in place: ${existing.detail}`,
      };
      return { result, existing };
    }
    // Already what was asked for: no reason to take it out of the table even for a moment.
    if (existing.sameAsRequested) return { result: done('exists'), existing };

    // A route through another gateway: replace it, once.
    const removal = await runDelete(destination);
    // `not-in-table` here means it vanished in between; adding again is still right.
    if (judge(removal, 'delete') === 'error') return { result: failed('delete', removal), existing };

    const second = await runAdd(destination, gateway);
    const secondVerdict = judge(second, 're-add');
    if (secondVerdict === 'ok') return { result: done('replaced'), existing };
    return {
      result: failed('re-add', second, secondVerdict === 'already-exists' ? 'route already exists' : undefined),
      existing,
    };
  };

  /** Log fields describing the "File exists" inspection; none when the first add settled it. */
  const inspectionFields = (existing: ExistingRoute | null): Record<string, string> => {
    if (existing === null) return {};
    if (existing.state === 'gateway') {
      return {
        existing: existing.sameAsRequested ? 'same-gateway' : 'gateway-route',
        existingGateway: existing.gateway,
        existingIface: existing.iface,
      };
    }
    return existing.state === 'connected'
      ? { existing: 'connected', existingIface: existing.iface }
      : { existing: 'unknown' };
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

    const { result, existing } = await add(destination.value, gateway.value);
    const inspection = inspectionFields(existing);
    if (result.ok) {
      logger.info(result.outcome === 'exists' ? 'route already present with this gateway' : 'route added', {
        op: 'add',
        dst: result.dst,
        gateway: result.gateway,
        kind: result.kind,
        outcome: result.outcome,
        ...inspection,
      });
    } else if (result.failure === 'connected-route') {
      // Not a failed command: the wrapper refused to delete the kernel's own route.
      logger.warn('existing connected route left in place; nothing was deleted', {
        op: 'add',
        dst: destination.value.dst,
        gateway: gateway.value,
        outcome: result.outcome,
        step: result.step,
        failure: result.failure,
        ...inspection,
        error: result.message,
      });
    } else {
      logFailed('add', result, destination.value.dst, gateway.value, inspection);
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
    // The table may have changed since the caller added its route, so the
    // entry is read before it is touched, exactly as in the `add` recovery.
    const lookup = await runGet(destination.value);
    const lookupVerdict = judge(lookup, 'inspect');
    const entry: InspectedRoute =
      lookupVerdict === 'ok'
        ? inspectRouteEntry(destination.value, lookup.stdout)
        : lookupVerdict === 'not-in-table'
          ? { state: 'absent', detail: 'route get found no route at all' }
          : unknownRoute(
              `route get failed: ${reportedError(lookup) ?? lookup.error ?? lookup.failure ?? `exit code ${String(lookup.exitCode)}`}`,
            );

    if (entry.state === 'unknown') {
      const failure: RouteFailed = {
        ok: false,
        outcome: 'failed',
        step: 'inspect',
        failure: 'existing-route-unknown',
        exitCode: lookup.exitCode,
        stdout: lookup.stdout,
        stderr: lookup.stderr,
        message: `the route for ${dst} could not be identified and was left in place: ${entry.detail}`,
      };
      logFailed('delete', failure, dst, gateway, { existing: 'unknown' });
      return failure;
    }
    if (entry.state === 'absent') {
      logger.info('route was not in the table', { op: 'delete', dst, gateway, kind, outcome: 'not-found', existing: 'none' });
      return { ok: true, outcome: 'not-found', dst, kind };
    }
    // Ours is a plain route through the gateway it was added with. Without a
    // gateway in the request the caller vouches for any gateway route there.
    const ours = entry.state === 'gateway' && (gateway === null || (entry.gateway === gateway && entry.plain));
    if (entry.state === 'connected' || !ours) {
      const notOurs: RouteNotOurs = {
        ok: true,
        outcome: 'not-ours',
        dst,
        kind,
        reason: entry.state === 'connected' ? 'connected' : 'other-gateway',
        message:
          entry.state === 'connected'
            ? `the entry for ${dst} is a connected route on ${entry.iface} and was left in place (${entry.detail})`
            : `the entry for ${dst} goes through ${entry.gateway} on ${entry.iface}, not through the expected gateway, and was left in place`,
      };
      logger.warn('entry at the destination is not the expected route; nothing was deleted', {
        op: 'delete',
        dst,
        gateway,
        kind,
        outcome: notOurs.outcome,
        existing: entry.state === 'connected' ? 'connected' : 'other-gateway',
        ...(entry.state === 'gateway' ? { existingGateway: entry.gateway } : {}),
        existingIface: entry.iface,
      });
      return notOurs;
    }

    const existing = { existing: 'gateway-route', existingGateway: entry.gateway, existingIface: entry.iface };
    const result = await runDelete(destination.value);
    const verdict = judge(result, 'delete');
    if (verdict === 'error') {
      const failure = failed('delete', result);
      logFailed('delete', failure, dst, gateway, existing);
      return failure;
    }
    // `not-in-table` here means it vanished between the lookup and the delete.
    const outcome = verdict === 'not-in-table' ? 'not-found' : 'deleted';
    logger.info(outcome === 'deleted' ? 'route deleted' : 'route was not in the table', {
      op: 'delete',
      dst,
      gateway,
      kind,
      outcome,
      ...existing,
    });
    return { ok: true, outcome, dst, kind };
  };

  const routeGet = async (target: string, options: RouteGetOptions = {}): Promise<RouteGetResult> => {
    const hidden = options.private === true;
    // A private lookup: the target only ever at debug. `dst` is left out of every louder line.
    const where = (dst: unknown): Record<string, unknown> => (hidden ? {} : { dst });
    // A lookup changes nothing, so the forbidden list does not apply (asking
    // how 127.0.0.1 is routed is harmless); the target still has to be a
    // strict IPv4 address so no keyword, host name or option reaches `route`.
    const raw: unknown = target;
    const address = typeof raw === 'string' ? normalizeIpv4(raw) : null;
    if (address === null || !address.ok) {
      const rejection = rejected('target', 'invalid-ipv4', REJECTION_MESSAGES.target);
      if (hidden) {
        logger.debug('route request rejected', { op: 'get', dst: describeInput(raw) });
        logger.warn('route request rejected', { op: 'get', outcome: rejection.outcome, field: rejection.field, reason: rejection.reason });
      } else {
        logRejected('get', rejection, raw, undefined);
      }
      return rejection;
    }

    const dst = address.value;
    if (hidden) logger.debug('private route lookup', { op: 'get', dst });
    // `-host` for the same reason as in `add`: `10.0.0.0` is an address here.
    const result = await runner.run(
      ALLOWED_BINARIES.route,
      ['-n', 'get', '-host', dst],
      hidden ? { redactArgsFrom: GET_TARGET_ARG } : {},
    );
    const verdict = judge(result, 'get');
    if (verdict === 'not-in-table') {
      logger.info('no route to target', { op: 'get', ...where(dst), gateway: null, outcome: 'not-found' });
      return { ok: false, outcome: 'not-found', target: dst };
    }
    const route = verdict === 'ok' ? parseRouteGetOutput(dst, result.stdout) : null;
    if (route === null) {
      const failure = failed('get', result, 'unrecognised output from route get');
      if (hidden) {
        // The message may quote what `route` printed about the target.
        logger.debug('route command failed', { op: 'get', dst, error: failure.message });
        logger.error('route command failed', {
          op: 'get',
          outcome: failure.outcome,
          step: failure.step,
          failure: failure.failure,
          exitCode: failure.exitCode,
        });
      } else {
        logFailed('get', failure, dst, null);
      }
      return failure;
    }
    logger.info('route looked up', {
      op: 'get',
      ...where(dst),
      gateway: route.gateway,
      iface: route.iface,
      outcome: 'found',
    });
    return { ok: true, outcome: 'found', route };
  };

  return { routeAdd, routeDelete, routeGet };
};
