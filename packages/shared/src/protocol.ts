import { z } from 'zod';

import { normalizeHostAddress, normalizeIpv4, normalizeSubnet, type Normalised, type ValidationCode } from './cidr';
import { Config, DEVICE_NAME, IfaceRole, LIMITS, findDuplicateIds } from './schema';

/**
 * The IPC contract between the unprivileged app and the root helper.
 *
 * Transport: a unix domain socket carrying JSON lines (see `jsonl.ts`).
 * The app sends `Request`s; the helper answers each with one `Response`
 * carrying the same `id`, and also pushes unsolicited `Event`s.
 *
 * The helper parses untrusted bytes with these schemas while running as root,
 * so the request schema is a security boundary: the set of methods is closed,
 * every request object is strict (unknown keys are rejected), and there is no
 * method that takes a command, a path or code to run.
 *
 * Messages from the helper (`Response`, `Event`, results, `EngineState`) are
 * not strict: unknown keys are dropped, so an app keeps working when a newer
 * helper adds a field.
 *
 * Anything read from the socket must go through `parseRequest`,
 * `parseServerMessage` or `parseResult`, never through a schema directly:
 * those functions first run `findStructureViolation`, a cheap bounded walk.
 * The schemas alone do not stop early on an oversized array (zod validates
 * every element and collects an issue for each), so a single 4 MiB line could
 * otherwise pin the CPU for seconds and allocate gigabytes.
 */

/**
 * Version of this contract. Bumped on any change an older peer cannot
 * tolerate: a removed or retyped field, a new required field, a new method,
 * and also a new value in any closed enumeration (`RULE_STATUSES`,
 * `RULE_REASON_CODES`, `RECONCILE_REASONS`, `ERROR_CODES`,
 * `EVENT_LOG_LEVELS`) — an older peer validates those with the list it was
 * built with and would refuse the whole message.
 * Reported by `status`; the app offers to reinstall the helper on a mismatch.
 */
export const PROTOCOL_VERSION = 1;

/** Size bounds that keep every message serialisable within `MAX_LINE_BYTES`. */
export const PROTOCOL_LIMITS = {
  /** `error` of a failed response, in UTF-16 code units. */
  errorMessageMaxLength: 2000,
  /** `msg` of a `log` event. The helper truncates longer messages. */
  logMessageMaxLength: 2000,
  /** Human-readable `reason` of a rule state. */
  reasonMaxLength: 300,
  /** `route(8)` destinations reported for one rule: the resolved IPs plus the DNS server route. */
  maxAppliedDestinationsPerRule: LIMITS.maxIpsPerDomain + 1,
  /** Network adapters listed in `EngineState.adapters`. */
  maxAdapters: 32,
  /** Hardware port name of an adapter, e.g. `USB 10/100/1000 LAN`. */
  adapterPortMaxLength: 100,
  helperVersionMaxLength: 64,
} as const;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** `255.255.255.255/32` is the longest canonical IPv4 destination. */
const MAX_ADDRESS_LENGTH = 18;

const normalisedString = (normalise: (input: string) => Normalised) =>
  z
    .string()
    .max(MAX_ADDRESS_LENGTH)
    .transform((value, ctx) => {
      const result = normalise(value);
      if (result.ok) return result.value;
      ctx.issues.push({ code: 'custom', message: result.error.message, input: value, params: result.error });
      return z.NEVER;
    });

/** Any syntactically valid IPv4 address (an interface may hold a link-local one). */
const Ipv4Address = normalisedString(normalizeIpv4);

/** An IPv4 address that may be routed: not a forbidden destination (ADR-001). */
const RoutableAddress = normalisedString(normalizeHostAddress);

/** A destination the engine may hold a route for: a routable address or a routable subnet. */
const AppliedDestination = normalisedString((input) =>
  input.includes('/') ? normalizeSubnet(input) : normalizeHostAddress(input),
);

/**
 * UTC timestamp exactly as produced by `Date.prototype.toISOString()`:
 * millisecond precision and a `Z` suffix (`2026-10-12T08:30:00.000Z`), so its
 * length is fixed.
 */
const IsoTimestamp = z.iso.datetime({ precision: 3 });

/** BSD name of an Ethernet-like adapter (`en0`, `en5`): the only devices a role can be bound to. */
const EnDevice = z.string().regex(DEVICE_NAME);

/** BSD name of any network interface (`en5`, `utun3`, `lo0`, `bridge0`), as printed by `route -n get -host`. */
const InterfaceName = z.string().regex(/^[a-z]{1,12}\d{1,4}$/);

/** A counter: a non-negative safe integer. */
const Counter = z.int().min(0);

const HelperVersion = z
  .string()
  .max(PROTOCOL_LIMITS.helperVersionMaxLength)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

// ---------------------------------------------------------------------------
// EngineState
// ---------------------------------------------------------------------------

/**
 * What the engine knows about one interface role. `up` means the role has a
 * device with an IPv4 address; a role that is up may still lack a gateway.
 * A role without an adapter is `{ device: null, ip: null, gateway: null, up: false }`.
 */
export const InterfaceState = z
  .object({
    device: EnDevice.nullable(),
    ip: Ipv4Address.nullable(),
    gateway: Ipv4Address.nullable(),
    up: z.boolean(),
  })
  .check((ctx) => {
    const { up, device, ip } = ctx.value;
    if (!up) return;
    for (const [field, value] of [
      ['device', device],
      ['ip', ip],
    ] as const) {
      if (value === null) {
        ctx.issues.push({
          code: 'custom',
          message: `An interface that is up must have ${field === 'ip' ? 'an ip' : 'a device'}`,
          input: value,
          path: [field],
        });
      }
    }
  });
export type InterfaceState = z.infer<typeof InterfaceState>;

/**
 * One `en*` adapter present on the machine, whatever role it has. Lets the
 * settings screen offer a device override without a hard-coded name.
 */
export const AdapterInfo = z.object({
  device: EnDevice,
  /** Hardware port name from `networksetup`, e.g. `Wi-Fi` or `USB 10/100/1000 LAN`. */
  port: z.string().min(1).max(PROTOCOL_LIMITS.adapterPortMaxLength),
  ip: Ipv4Address.nullable(),
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

/**
 * - `active`   — every route of the rule is in the routing table.
 * - `pending`  — nothing is wrong with the rule, but it cannot be applied now
 *                (interface down, no gateway, first DNS answer outstanding).
 * - `error`    — applying it failed; `reasonCode` and `reason` say why.
 *                Last known IPs of a domain rule may still be applied.
 * - `disabled` — switched off, by its own toggle or by the global one.
 */
export const RULE_STATUSES = ['active', 'pending', 'error', 'disabled'] as const;
export const RuleStatus = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof RuleStatus>;

/**
 * Why a rule is in its status; the UI translates the code and may show
 * `reason` as detail.
 *
 * disabled: `rule-disabled`, `globally-disabled`.
 * pending:  `interface-down`, `no-gateway`, `resolving`.
 * error:    `resolve-failed` (DNS query failed), `no-addresses` (no A records),
 *           `forbidden-destination` (a resolved address must never be routed),
 *           `connected-network` (the destination overlaps the subnet an
 *           interface is directly connected to, so no route is added),
 *           `route-failed` (`route add` failed), `resolver-conflict` (an
 *           `/etc/resolver` file exists that is not ours), `resolver-failed`
 *           (writing the resolver file failed), `internal`.
 * active:   `addresses-truncated` (more A records than the per-domain limit).
 */
export const RULE_REASON_CODES = [
  'rule-disabled',
  'globally-disabled',
  'interface-down',
  'no-gateway',
  'resolving',
  'resolve-failed',
  'no-addresses',
  'forbidden-destination',
  'connected-network',
  'route-failed',
  'resolver-conflict',
  'resolver-failed',
  'internal',
  'addresses-truncated',
] as const;
export const RuleReasonCode = z.enum(RULE_REASON_CODES);
export type RuleReasonCode = z.infer<typeof RuleReasonCode>;

/**
 * Runtime state of one rule of the config. Every rule of the config has
 * exactly one entry, disabled rules included.
 */
export const RuleState = z
  .object({
    /** `Rule.id`, compared as the exact string. */
    ruleId: z.uuid(),
    status: RuleStatus,
    /** Required for every status except `active`. */
    reasonCode: RuleReasonCode.nullable(),
    /** Human-readable detail in English, for the log and as a fallback. */
    reason: z.string().max(PROTOCOL_LIMITS.reasonMaxLength).nullable(),
    /**
     * Routes currently in the routing table on behalf of this rule: a bare
     * address for a host route, a CIDR for a subnet. For a domain rule these
     * are the resolved addresses plus, when the rule has `dns`, that server.
     */
    appliedDestinations: z.array(AppliedDestination).max(PROTOCOL_LIMITS.maxAppliedDestinationsPerRule),
    /** Last successful DNS answer of a domain rule; null for other kinds and before the first answer. */
    lastResolvedAt: IsoTimestamp.nullable(),
  })
  .check((ctx) => {
    const { status, reasonCode } = ctx.value;
    if (status !== 'active' && reasonCode === null) {
      ctx.issues.push({
        code: 'custom',
        message: `A rule that is ${status} must carry a reasonCode`,
        input: reasonCode,
        path: ['reasonCode'],
      });
    }
  });
export type RuleState = z.infer<typeof RuleState>;

/** What triggered a reconcile. */
export const RECONCILE_REASONS = [
  'startup',
  'config-change',
  'enabled-change',
  'manual',
  'network-change',
  'dns-refresh',
  'drift-check',
] as const;
export const ReconcileReason = z.enum(RECONCILE_REASONS);
export type ReconcileReason = z.infer<typeof ReconcileReason>;

/**
 * Everything the UI renders, computed by the helper's engine after each
 * reconcile. Sent in the `state` event, in the `status` result and in the
 * result of every mutating method.
 */
export const EngineState = z
  .object({
    /** Version of the running helper binary. */
    helperVersion: HelperVersion,
    /**
     * Order of this state among the states of one helper process. The engine
     * increments it every time it computes a state, so a higher `seq` is
     * newer. The app keeps the state with the highest `seq` it has seen on a
     * connection and drops any lower one (the state inside a response may be
     * older than a `state` event that arrived before it).
     * It restarts when the helper restarts: after a reconnect the app forgets
     * the `seq` it held and accepts the first state it receives, whatever its
     * `seq`.
     */
    seq: Counter,
    /**
     * Revision of the stored config. The helper increments it every time the
     * stored config changes (`setConfig`, `setEnabled`) and never otherwise;
     * like `seq` it restarts with the helper. `RuleState` carries no target,
     * kind or interface: when this value differs from the one the app last
     * fetched the config for, the app calls `getConfig` again and joins
     * `rules` with the config by `ruleId`.
     */
    configRevision: Counter,
    /** The global toggle (`Config.enabled`). */
    enabled: z.boolean(),
    /** Both roles are always present. */
    interfaces: z.object({ ethernet: InterfaceState, wifi: InterfaceState }),
    /** Every `en*` adapter of the machine, each device once. */
    adapters: z.array(AdapterInfo).max(PROTOCOL_LIMITS.maxAdapters),
    /** One entry per rule of the config, in config order. */
    rules: z.array(RuleState).max(LIMITS.maxRules),
    /** End of the last reconcile; null before the first one. */
    lastApplyAt: IsoTimestamp.nullable(),
    lastReconcileReason: ReconcileReason.nullable(),
  })
  .check((ctx) => {
    const { rules, adapters } = ctx.value;
    const seenDevices = new Set<string>();
    adapters.forEach((adapter, index) => {
      if (seenDevices.has(adapter.device)) {
        ctx.issues.push({
          code: 'custom',
          message: `Adapter ${adapter.device} is listed more than once`,
          input: adapter.device,
          path: ['adapters', index, 'device'],
        });
      }
      seenDevices.add(adapter.device);
    });
    for (const { first, second } of findDuplicateIds(rules.map((rule) => ({ id: rule.ruleId })))) {
      const ruleId = rules[second]?.ruleId ?? '';
      ctx.issues.push({
        code: 'custom',
        message: `Rule ${ruleId} already has a state entry at #${String(first + 1)}`,
        input: ruleId,
        path: ['rules', second, 'ruleId'],
      });
    }
  });
export type EngineState = z.infer<typeof EngineState>;

// ---------------------------------------------------------------------------
// Requests (app -> helper)
// ---------------------------------------------------------------------------

/**
 * The complete, closed set of methods. Adding one is a deliberate change of
 * the privilege boundary: it needs a new `PROTOCOL_VERSION` and a test update.
 */
export const REQUEST_METHODS = [
  'status',
  'getConfig',
  'setConfig',
  'apply',
  'setEnabled',
  'test',
  'uninstall',
] as const;
export const RequestMethod = z.enum(REQUEST_METHODS);
export type RequestMethod = z.infer<typeof RequestMethod>;

/**
 * Correlates a response with its request: a non-negative safe integer chosen
 * by the client, unique among the requests it has outstanding on a connection.
 */
export const RequestId = z.int().min(0);
export type RequestId = z.infer<typeof RequestId>;

/** Reads helper version, protocol version and the current state. Sent on connect. */
export const StatusRequest = z.strictObject({ id: RequestId, method: z.literal('status') });

/** Reads the stored config. */
export const GetConfigRequest = z.strictObject({ id: RequestId, method: z.literal('getConfig') });

/**
 * Replaces the whole config. The helper stores the normalised config and
 * reconciles. `config` is validated with the `Config` schema, so a parsed
 * request always holds normalised targets.
 */
export const SetConfigRequest = z.strictObject({ id: RequestId, method: z.literal('setConfig'), config: Config });

/** Forces a reconcile with fresh interface data (the "apply" button). */
export const ApplyRequest = z.strictObject({ id: RequestId, method: z.literal('apply') });

/** Sets the global toggle. Turning it off removes every applied route and managed resolver file. */
export const SetEnabledRequest = z.strictObject({
  id: RequestId,
  method: z.literal('setEnabled'),
  enabled: z.boolean(),
});

/**
 * Asks which route the kernel would use for an address (`route -n get -host <ip>`).
 * Read-only. `target` is a single routable IPv4 address; domains and subnets
 * are not accepted, the UI tests one of their addresses instead.
 */
export const TestRequest = z.strictObject({ id: RequestId, method: z.literal('test'), target: RoutableAddress });

/** Removes every applied route and managed resolver file, then the helper itself. */
export const UninstallRequest = z.strictObject({ id: RequestId, method: z.literal('uninstall') });

/** Any message the app may send to the helper. */
export const Request = z.discriminatedUnion('method', [
  StatusRequest,
  GetConfigRequest,
  SetConfigRequest,
  ApplyRequest,
  SetEnabledRequest,
  TestRequest,
  UninstallRequest,
]);
export type Request = z.infer<typeof Request>;
/** A request as the client builds it, before validation and defaults. */
export type RequestInput = z.input<typeof Request>;

/** The request of one method. */
export type RequestOf<M extends RequestMethod> = Extract<Request, { method: M }>;
type WithoutEnvelope<T> = keyof Omit<T, 'id' | 'method'> extends never
  ? Record<string, never>
  : Omit<T, 'id' | 'method'>;
/**
 * The parameters of one method: its request without `id` and `method`.
 * An empty object (`Record<string, never>`) for a method that takes none.
 */
export type ParamsOf<M extends RequestMethod> = WithoutEnvelope<RequestOf<M>>;
/** The parameters of one method as the client passes them, before defaults. */
export type ParamsInputOf<M extends RequestMethod> = WithoutEnvelope<Extract<RequestInput, { method: M }>>;

// ---------------------------------------------------------------------------
// Results (helper -> app, inside a successful response)
// ---------------------------------------------------------------------------

/**
 * The two version fields of a `status` result on their own. The app checks
 * these first: when `protocolVersion` differs from `PROTOCOL_VERSION` the rest
 * of the result may not parse, and the helper has to be reinstalled.
 */
export const HelperVersionInfo = z.object({
  protocolVersion: z.int().min(1),
  helperVersion: HelperVersion,
});
export type HelperVersionInfo = z.infer<typeof HelperVersionInfo>;

/** Result of `status`. `helperVersion` equals `state.helperVersion`. */
export const StatusResult = HelperVersionInfo.extend({ state: EngineState });
export type StatusResult = z.infer<typeof StatusResult>;

/** Result of `getConfig`: the stored config, or an empty one when none was saved yet. */
export const GetConfigResult = z.object({ config: Config });
export type GetConfigResult = z.infer<typeof GetConfigResult>;

/** Result of `setConfig`: the config as stored (normalised) and the state after the reconcile it caused. */
export const SetConfigResult = z.object({ config: Config, state: EngineState });
export type SetConfigResult = z.infer<typeof SetConfigResult>;

/** Result of `apply` and `setEnabled`: the state after the reconcile they caused. */
export const StateResult = z.object({ state: EngineState });
export type StateResult = z.infer<typeof StateResult>;

/**
 * Result of `test`: what `route -n get -host <target>` reported. A lookup that
 * finds no route at all is an error response (`operation-failed`) instead.
 */
export const TestResult = z.object({
  /** The address that was looked up, normalised. */
  target: RoutableAddress,
  /** The matching routing table entry: `default` or an address. */
  destination: z.string().min(1).max(64),
  /** Null for a directly connected destination or a gateway that is not IPv4. */
  gateway: Ipv4Address.nullable(),
  /** The interface the kernel would send through. */
  device: InterfaceName,
  /** The role that device currently has, or null when it has neither. */
  role: IfaceRole.nullable(),
  /** The rule whose applied route covers the target, or null when none does. */
  ruleId: z.uuid().nullable(),
});
export type TestResult = z.infer<typeof TestResult>;

/** Result of `uninstall`: sent after the cleanup, right before the helper exits. */
export const UninstallResult = z.object({});
export type UninstallResult = z.infer<typeof UninstallResult>;

/** Method -> result type. */
export interface ResultMap {
  status: StatusResult;
  getConfig: GetConfigResult;
  setConfig: SetConfigResult;
  apply: StateResult;
  setEnabled: StateResult;
  test: TestResult;
  uninstall: UninstallResult;
}
export type ResultOf<M extends RequestMethod> = ResultMap[M];

/** Method -> schema of its result. */
export const RESULT_SCHEMAS: { readonly [M in RequestMethod]: z.ZodType<ResultMap[M]> } = {
  status: StatusResult,
  getConfig: GetConfigResult,
  setConfig: SetConfigResult,
  apply: StateResult,
  setEnabled: StateResult,
  test: TestResult,
  uninstall: UninstallResult,
};

// ---------------------------------------------------------------------------
// Responses (helper -> app)
// ---------------------------------------------------------------------------

/**
 * Machine-readable cause of a failed request, next to the human message.
 *
 * - `invalid-json`      — the line was not JSON (response `id` is null).
 * - `line-too-long`     — the line exceeded `MAX_LINE_BYTES` (`id` is null).
 * - `invalid-request`   — not an object, bad `id`, missing or wrong parameters, unknown keys.
 * - `unknown-method`    — `method` is not one of `REQUEST_METHODS`.
 * - `invalid-config`    — the `config` of `setConfig` failed validation.
 * - `operation-failed`  — the request was valid but the helper could not carry it out.
 * - `not-implemented`   — the method exists but this helper build cannot perform it.
 * - `internal`          — an unexpected error inside the helper.
 * - `invalid-response`  — never sent: produced on the app side when a line
 *                         from the helper does not match this contract.
 */
export const ERROR_CODES = [
  'invalid-json',
  'line-too-long',
  'invalid-request',
  'unknown-method',
  'invalid-config',
  'operation-failed',
  'not-implemented',
  'internal',
  'invalid-response',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** A successful response. `result` is always a JSON object; its shape depends on the method (`RESULT_SCHEMAS`). */
export const OkResponse = z.object({
  id: RequestId,
  ok: z.literal(true),
  result: z.record(z.string(), z.unknown()),
});
export type OkResponse = z.infer<typeof OkResponse>;

/**
 * A failed response. `id` is null only when the helper could not read an id
 * from the request (unparseable line, missing or invalid `id`).
 */
export const ErrorResponse = z.object({
  id: RequestId.nullable(),
  ok: z.literal(false),
  /** Human-readable message in English. */
  error: z.string().min(1).max(PROTOCOL_LIMITS.errorMessageMaxLength),
  code: ErrorCode.optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** The helper's answer to one request. */
export const Response = z.discriminatedUnion('ok', [OkResponse, ErrorResponse]);
export type Response = z.infer<typeof Response>;

/** The successful response of one method, as the helper builds it. */
export interface OkResponseOf<M extends RequestMethod> {
  id: RequestId;
  ok: true;
  result: ResultOf<M>;
}
/** The response of one method, with its result typed. */
export type ResponseOf<M extends RequestMethod> = OkResponseOf<M> | ErrorResponse;

// ---------------------------------------------------------------------------
// Events (helper -> app, unsolicited)
// ---------------------------------------------------------------------------

/** Pushed to every connected client after each reconcile. */
export const StateEvent = z.object({ event: z.literal('state'), state: EngineState });
export type StateEvent = z.infer<typeof StateEvent>;

/**
 * Levels that cross the wire. The helper's own logger also has `debug`, which
 * stays in the log file: the UI journal only shows what concerns the user.
 */
export const EVENT_LOG_LEVELS = ['info', 'warn', 'error'] as const;
export const EventLogLevel = z.enum(EVENT_LOG_LEVELS);
export type EventLogLevel = z.infer<typeof EventLogLevel>;

/** A user-relevant log entry, pushed to every connected client for the journal screen. */
export const LogEvent = z.object({
  event: z.literal('log'),
  level: EventLogLevel,
  msg: z.string().max(PROTOCOL_LIMITS.logMessageMaxLength),
  at: IsoTimestamp,
});
export type LogEvent = z.infer<typeof LogEvent>;

/** Any unsolicited message from the helper. */
export const Event = z.discriminatedUnion('event', [StateEvent, LogEvent]);
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------
// Classifying incoming lines
// ---------------------------------------------------------------------------

export interface ProtocolError {
  readonly code: ErrorCode;
  readonly message: string;
  /** The request id the message carried, when one could be read. */
  readonly id: RequestId | null;
}

/** Outcome of parsing a decoded line: the typed message, or why it was refused. Never thrown. */
export type ProtocolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

/** A line from the helper: the answer to a request, or an unsolicited event. */
export type ServerMessage =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'event'; readonly event: Event };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (value: unknown): RequestId | null => {
  if (!isRecord(value)) return null;
  const id = RequestId.safeParse(value['id']);
  return id.success ? id.data : null;
};

const clamp = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

// ---------------------------------------------------------------------------
// Structural guard (runs before any schema)
// ---------------------------------------------------------------------------

/**
 * Bounds on the shape of any message, checked before a schema sees it.
 * Sized for the largest legitimate message (the `setConfig` response with
 * 500 rules: about 25 000 values, nesting depth 7) with room to spare.
 */
export const STRUCTURE_LIMITS = {
  /** Values in the whole message: every primitive, array and object counts as one. */
  maxNodes: 65_536,
  /** Elements of any one array. No array of the contract is longer than the rule list. */
  maxArrayLength: LIMITS.maxRules,
  /** Arrays and objects nested inside each other. */
  maxDepth: 12,
  /** UTF-16 code units of any one string value or object key. */
  maxStringLength: 4096,
} as const;

export type StructureViolationKind = 'too-many-values' | 'array-too-long' | 'too-deep' | 'string-too-long';

export interface StructureViolation {
  readonly kind: StructureViolationKind;
  /**
   * The top-level key the offending value sits under, or null for the root
   * itself. It is the sender's text: compare it, never print it.
   */
  readonly topLevelKey: string | null;
}

const STRUCTURE_MESSAGES: Record<StructureViolationKind, string> = {
  'too-many-values': `Message holds more than ${String(STRUCTURE_LIMITS.maxNodes)} values`,
  'array-too-long': `Message holds an array of more than ${String(STRUCTURE_LIMITS.maxArrayLength)} elements`,
  'too-deep': `Message is nested more than ${String(STRUCTURE_LIMITS.maxDepth)} levels deep`,
  'string-too-long': `Message holds a string of more than ${String(STRUCTURE_LIMITS.maxStringLength)} characters`,
};

interface Frame {
  readonly value: unknown;
  readonly depth: number;
  readonly topLevelKey: string | null;
}

/**
 * Checks a decoded JSON value against `STRUCTURE_LIMITS` and returns the
 * first violation, or null when it is within bounds.
 *
 * Iterative (no recursion, so nesting cannot exhaust the call stack) and it
 * stops at the first violation: it never visits more than `maxNodes` values,
 * whatever the size of the input. Run it on everything read from a socket
 * before handing the value to a schema.
 */
export const findStructureViolation = (root: unknown): StructureViolation | null => {
  const { maxNodes, maxArrayLength, maxDepth, maxStringLength } = STRUCTURE_LIMITS;
  const stack: Frame[] = [{ value: root, depth: 0, topLevelKey: null }];
  // Counted when a value is queued, so the stack never holds more than `maxNodes` frames.
  let nodes = 1;

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value, depth, topLevelKey } = frame;

    if (typeof value === 'string') {
      if (value.length > maxStringLength) return { kind: 'string-too-long', topLevelKey };
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (depth >= maxDepth) return { kind: 'too-deep', topLevelKey };

    if (Array.isArray(value)) {
      if (value.length > maxArrayLength) return { kind: 'array-too-long', topLevelKey };
      nodes += value.length;
      if (nodes > maxNodes) return { kind: 'too-many-values', topLevelKey };
      for (const item of value as unknown[]) stack.push({ value: item, depth: depth + 1, topLevelKey });
      continue;
    }

    const record = value as Record<string, unknown>;
    for (const key in record) {
      const childKey = depth === 0 ? key : topLevelKey;
      nodes += 1;
      if (nodes > maxNodes) return { kind: 'too-many-values', topLevelKey: childKey };
      if (key.length > maxStringLength) return { kind: 'string-too-long', topLevelKey: childKey };
      stack.push({ value: record[key], depth: depth + 1, topLevelKey: childKey });
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Describing a refusal without repeating the sender's text
// ---------------------------------------------------------------------------

/** Every field name of the contract. Only these may appear in a refusal message. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  // envelope
  'id',
  'method',
  'ok',
  'result',
  'error',
  'code',
  'event',
  // parameters, Config and Rule
  'config',
  'enabled',
  'target',
  'version',
  'ifaceOverrides',
  'rules',
  'kind',
  'iface',
  'dns',
  'refreshSec',
  'note',
  'ethernet',
  'wifi',
  // results and EngineState
  'protocolVersion',
  'helperVersion',
  'state',
  'seq',
  'configRevision',
  'interfaces',
  'adapters',
  'device',
  'port',
  'ip',
  'gateway',
  'up',
  'ruleId',
  'status',
  'reasonCode',
  'reason',
  'appliedDestinations',
  'lastResolvedAt',
  'lastApplyAt',
  'lastReconcileReason',
  'destination',
  'role',
  // log event
  'level',
  'msg',
  'at',
]);

/** What each kind of schema issue is called in a refusal. Fixed text only. */
const ISSUE_TEXT: Readonly<Record<string, string>> = {
  invalid_type: 'has the wrong type',
  invalid_value: 'is not one of the allowed values',
  invalid_format: 'has an invalid format',
  too_big: 'is too large',
  too_small: 'is too small',
  unrecognized_keys: 'has an unknown key',
  invalid_union: 'matches no known message',
  invalid_key: 'has an invalid key',
  invalid_element: 'has an invalid element',
  not_multiple_of: 'is not a multiple of the required step',
};

/** Codes our own validators attach to an issue (`params.code`). Listed in full so none is forgotten. */
const VALIDATION_CODES: Readonly<Record<ValidationCode | 'duplicate-id' | 'iface-conflict', true>> = {
  'invalid-ipv4': true,
  'invalid-cidr': true,
  'invalid-prefix': true,
  'prefix-too-wide': true,
  'invalid-domain': true,
  'invalid-destination': true,
  'default-route': true,
  'this-network': true,
  loopback: true,
  'link-local': true,
  multicast: true,
  broadcast: true,
  'duplicate-id': true,
  'iface-conflict': true,
};

const issueText = (issue: z.core.$ZodIssue): string => {
  if (issue.code !== 'custom') return Object.hasOwn(ISSUE_TEXT, issue.code) ? (ISSUE_TEXT[issue.code] ?? 'is invalid') : 'is invalid';
  const code: unknown = issue.params?.['code'];
  return typeof code === 'string' && Object.hasOwn(VALIDATION_CODES, code) ? `is invalid (${code})` : 'is invalid';
};

/** Known field names and numeric indexes pass; anything else becomes `?`. */
const pathText = (path: readonly PropertyKey[]): string =>
  path
    .map((segment) => {
      if (typeof segment === 'number') return String(segment);
      return typeof segment === 'string' && KNOWN_FIELDS.has(segment) ? segment : '?';
    })
    .join('.');

/**
 * Turns a schema error into one bounded line that is safe to log and to send
 * to the peer: `config.rules.3.target: is invalid (invalid-cidr) (+2 more)`.
 * Built only from fixed text, field names of this contract and numbers:
 * nothing the sender wrote (a key name, a value) is ever copied into it. A
 * path segment that is not a known field name is printed as `?`.
 */
export const describeIssues = (error: z.ZodError): string => {
  const [first] = error.issues;
  if (first === undefined) return 'Message is invalid';
  const where = first.path.length === 0 ? 'Message' : pathText(first.path);
  const rest = error.issues.length - 1;
  const more = rest === 0 ? '' : ` (+${String(rest)} more)`;
  return clamp(`${where}: ${issueText(first)}${more}`, PROTOCOL_LIMITS.errorMessageMaxLength);
};

const refuse = (code: ErrorCode, message: string, id: RequestId | null): ProtocolResult<never> => ({
  ok: false,
  error: { code, message, id },
});

/**
 * Helper side: validates one decoded line from a client as a `Request`.
 * Anything that is not exactly one of the seven requests is refused with a
 * code and, when it could be read, the request id to answer with.
 *
 * The message of a refusal is safe to log and to send back: it consists of
 * fixed text, field names of this contract and array indexes only, and never
 * contains anything the client wrote.
 *
 * The work done is bounded by `STRUCTURE_LIMITS`, not by the size of the line.
 */
export const parseRequest = (value: unknown): ProtocolResult<Request> => {
  if (!isRecord(value)) return refuse('invalid-request', 'A request must be a JSON object', null);
  const id = idOf(value);
  const method = value['method'];

  const violation = findStructureViolation(value);
  if (violation !== null) {
    const inConfig = method === 'setConfig' && violation.topLevelKey === 'config';
    return refuse(inConfig ? 'invalid-config' : 'invalid-request', STRUCTURE_MESSAGES[violation.kind], id);
  }

  const parsed = Request.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };

  if (typeof method !== 'string') return refuse('invalid-request', 'A request must name a method', id);
  if (!RequestMethod.safeParse(method).success) return refuse('unknown-method', 'Unknown method', id);

  const onlyConfig = parsed.error.issues.every((issue) => issue.path[0] === 'config');
  return refuse(onlyConfig ? 'invalid-config' : 'invalid-request', describeIssues(parsed.error), id);
};

/**
 * App side: classifies one decoded line from the helper as a response or an
 * event. A line that is neither is refused with `invalid-response`; the
 * message of the refusal never contains text taken from the line.
 */
export const parseServerMessage = (value: unknown): ProtocolResult<ServerMessage> => {
  if (!isRecord(value)) return refuse('invalid-response', 'A message must be a JSON object', null);

  const violation = findStructureViolation(value);
  if (violation !== null) return refuse('invalid-response', STRUCTURE_MESSAGES[violation.kind], idOf(value));

  if (Object.hasOwn(value, 'event')) {
    const event = Event.safeParse(value);
    if (event.success) return { ok: true, value: { kind: 'event', event: event.data } };
    return refuse('invalid-response', describeIssues(event.error), null);
  }

  const response = Response.safeParse(value);
  if (response.success) return { ok: true, value: { kind: 'response', response: response.data } };
  return refuse('invalid-response', describeIssues(response.error), idOf(value));
};

/**
 * App side: validates the `result` of a successful response against the
 * method the request was sent with.
 */
export const parseResult = <M extends RequestMethod>(method: M, result: unknown): ProtocolResult<ResultOf<M>> => {
  const violation = findStructureViolation(result);
  if (violation !== null) return refuse('invalid-response', STRUCTURE_MESSAGES[violation.kind], null);

  const schema: z.ZodType<ResultOf<M>> = RESULT_SCHEMAS[method];
  const parsed = schema.safeParse(result);
  if (parsed.success) return { ok: true, value: parsed.data };
  return refuse('invalid-response', describeIssues(parsed.error), null);
};

/** Builds a failed response, keeping the message within its length limit. */
export const errorResponse = (id: RequestId | null, code: ErrorCode, message: string): ErrorResponse => ({
  id,
  ok: false,
  error: clamp(message === '' ? code : message, PROTOCOL_LIMITS.errorMessageMaxLength),
  code,
});
