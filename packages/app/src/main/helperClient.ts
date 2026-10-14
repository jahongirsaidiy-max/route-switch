// The app's only link to the root helper: a Unix domain socket carrying JSON
// lines (`@routeswitch/shared`). This module owns the connection, the
// request/response bookkeeping and the latest state the helper reported.
//
// Everything read from the socket is untrusted. Each line goes through the
// shared decoder and `parseServerMessage`, each result through `parseResult`
// for the method that was asked; nothing received is ever executed, and no
// input can make this module throw into the main process.
//
// All I/O is injected (how the socket is opened, timers), so the unit tests run
// against a fake socket and a fake scheduler.

import { createConnection } from 'node:net';

import {
  createJsonLinesDecoder,
  encodeJsonLine,
  HelperVersionInfo,
  MAX_LINE_BYTES,
  parseRequest,
  parseResult,
  parseServerMessage,
  PROTOCOL_VERSION,
  type Config,
  type EngineState,
  type ErrorCode,
  type JsonLinesDecoder,
  type LogEvent,
  type ParamsInputOf,
  type RequestMethod,
  type Response,
  type ResultOf,
  type SetConfigResult,
} from '@routeswitch/shared';

import type { Logger } from './logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why a request did not produce a result. The helper's own codes, plus the
 * ones this client adds:
 * - `not-connected` — there is no ready connection (see `HelperStatus`);
 * - `disconnected`  — the connection was lost while the request was pending;
 * - `timeout`       — no answer within the time allowed for the method;
 * - `busy`          — too many requests pending, or the socket is not draining;
 * - `unspecified`   — the helper refused without giving a code.
 */
export type HelperFailureCode = ErrorCode | 'not-connected' | 'disconnected' | 'timeout' | 'busy' | 'unspecified';

/**
 * Every request settles with one of these and never rejects: a helper error
 * is an ordinary outcome for the UI (`{ ok: false, error, code }`), not an
 * exception.
 */
export type HelperResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: HelperFailureCode; readonly error: string };

/** Why there is no connection although the helper appears to be installed. */
export type DisconnectReason =
  /** The socket file exists but nothing listens on it: installed, not running. */
  | 'not-running'
  /** The socket exists but this user may not open it. */
  | 'permission-denied'
  /** An established connection ended. */
  | 'connection-lost'
  /** The peer did not speak the protocol (bad handshake, oversized or repeated invalid lines). */
  | 'protocol-error'
  /** The connection or the handshake did not complete in time. */
  | 'timeout'
  /** Any other socket error. */
  | 'error';

export type HelperStatus =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly helperVersion: string }
  /** The socket file does not exist: the helper has never been installed (or was removed). */
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'disconnected'; readonly reason: DisconnectReason }
  /** A helper answered, but it speaks another version of the protocol and must be reinstalled. */
  | {
      readonly kind: 'incompatible';
      readonly helperVersion: string;
      readonly protocolVersion: number;
      readonly expectedProtocolVersion: number;
    };

/**
 * What the client currently knows. `state` and `config` are those of the
 * current connection only: both are `null` whenever the status is not
 * `connected`, and both are set from the moment it is.
 *
 * `configRevision` is the revision the helper read together with `config`
 * (`GetConfigResult.configRevision`, or the state of a `setConfig` result).
 * It may run ahead of `state.configRevision` (the config was read after a
 * change whose state has not arrived yet). Only a state whose revision is
 * strictly greater than `configRevision` starts a fetch; `onConfig` fires when
 * it lands — until then a rule of `state` may have no counterpart in `config`
 * (or the reverse).
 */
export interface HelperSnapshot {
  readonly status: HelperStatus;
  readonly state: EngineState | null;
  readonly config: Config | null;
  readonly configRevision: number | null;
}

type Unsubscribe = () => void;

type RequestArgs<M extends RequestMethod> =
  ParamsInputOf<M> extends Record<string, never> ? [params?: Record<string, never>] : [params: ParamsInputOf<M>];

export interface HelperClient {
  /** Starts connecting in the background. Does nothing if already started. */
  readonly start: () => void;
  /** Closes the connection, settles every pending request and cancels every timer. Idempotent. */
  readonly stop: () => void;
  /** Tries to connect now instead of waiting for the next scheduled attempt (after an install, say). */
  readonly reconnectNow: () => void;
  readonly request: <M extends RequestMethod>(method: M, ...args: RequestArgs<M>) => Promise<HelperResult<ResultOf<M>>>;
  readonly snapshot: () => HelperSnapshot;
  /** Called on every change of status. */
  readonly onStatus: (listener: (status: HelperStatus) => void) => Unsubscribe;
  /** Called once for every state accepted (newer than any seen on this connection). */
  readonly onState: (listener: (state: EngineState) => void) => Unsubscribe;
  /** Called whenever a freshly fetched config replaces the remembered one. */
  readonly onConfig: (listener: (config: Config) => void) => Unsubscribe;
  /** Called for every `log` event of the helper, in order. Nothing is buffered here. */
  readonly onLog: (listener: (event: LogEvent) => void) => Unsubscribe;
}

/** The part of a `net.Socket` the client uses. */
export interface HelperSocket {
  on(event: 'connect' | 'close' | 'data' | 'error', listener: (...args: never[]) => void): unknown;
  /** False when the data was queued because the socket is not draining. */
  write(data: string): boolean;
  destroy(): void;
  /** Bytes queued for writing. */
  readonly writableLength: number;
}

export interface HelperClientOptions {
  /** The socket file. In the app this is always `PATHS.socket`. */
  readonly socketPath: string;
  readonly logger: Logger;
  /** Opens the socket. Defaults to `net.createConnection({ path })`. */
  readonly connect?: (socketPath: string) => HelperSocket;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly timeouts?: Partial<HelperTimeouts>;
}

// ---------------------------------------------------------------------------
// Limits and timing
// ---------------------------------------------------------------------------

export interface HelperTimeouts {
  /** Opening the socket. */
  readonly connectMs: number;
  /** `status`, `getConfig`: answered from memory. */
  readonly readMs: number;
  /** `test`: one `route get`. */
  readonly testMs: number;
  /** `setConfig`, `setEnabled`, `apply`: answered after a reconcile. */
  readonly mutateMs: number;
  /** `uninstall`: removes routes, resolver files and the daemon. */
  readonly uninstallMs: number;
}

export const DEFAULT_TIMEOUTS: HelperTimeouts = {
  connectMs: 5_000,
  readMs: 5_000,
  testMs: 10_000,
  mutateMs: 30_000,
  uninstallMs: 60_000,
};

const TIMEOUT_CLASS: Readonly<Record<RequestMethod, keyof HelperTimeouts>> = {
  status: 'readMs',
  getConfig: 'readMs',
  test: 'testMs',
  setConfig: 'mutateMs',
  setEnabled: 'mutateMs',
  apply: 'mutateMs',
  uninstall: 'uninstallMs',
};

/** Wait before reconnecting after a connection was lost, and between the first attempts. */
export const RECONNECT_DELAY_MS = 2_000;
/** After this many failed attempts in a row the wait doubles each time … */
export const RECONNECT_STEADY_ATTEMPTS = 5;
/** … up to this. A helper that is absent all day is not asked every two seconds. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Requests waiting for an answer at one time; one more is refused as `busy`. */
export const MAX_PENDING_REQUESTS = 32;
/** A request is refused as `busy` while more than this is queued unsent (two full-size lines). */
export const MAX_BUFFERED_BYTES = 2 * MAX_LINE_BYTES;
/** Lines in a row that are not valid messages before the connection is dropped. */
export const MAX_CONSECUTIVE_INVALID_LINES = 8;

export function reconnectDelay(failedAttempts: number): number {
  const doublings = Math.max(0, failedAttempts - RECONNECT_STEADY_ATTEMPTS);
  return Math.min(RECONNECT_DELAY_MS * 2 ** Math.min(doublings, 10), RECONNECT_MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const failure = (code: HelperFailureCode, error: string): { ok: false; code: HelperFailureCode; error: string } => ({
  ok: false,
  code,
  error,
});

interface Pending {
  readonly method: RequestMethod;
  readonly timer: unknown;
  /** Settles the request from the helper's response; true when the response honoured the contract. */
  readonly complete: (response: Response) => boolean;
  readonly fail: (code: HelperFailureCode, error: string) => void;
}

interface Connection {
  readonly socket: HelperSocket;
  readonly decoder: JsonLinesDecoder;
  readonly pending: Map<number, Pending>;
  nextId: number;
  /** True once the socket is open. */
  opened: boolean;
  /** True once the handshake is done and callers may send requests. */
  ready: boolean;
  /** Highest `seq` accepted on this connection. */
  seq: number | null;
  invalidLines: number;
  configFetchInFlight: boolean;
  connectTimer: unknown;
  configRetryTimer: unknown;
}

const statusOfSocketError = (error: unknown): HelperStatus => {
  const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return { kind: 'not-installed' };
  if (code === 'ECONNREFUSED') return { kind: 'disconnected', reason: 'not-running' };
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'disconnected', reason: 'permission-denied' };
  return { kind: 'disconnected', reason: 'error' };
};

const sameStatus = (a: HelperStatus, b: HelperStatus): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createHelperClient(options: HelperClientOptions): HelperClient {
  const { socketPath, logger } = options;
  const connect = options.connect ?? ((path: string): HelperSocket => createConnection({ path }));
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const timeouts: HelperTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  // Lines a peer can cause at will share one budget each. That includes status
  // changes: a peer that connects and misbehaves makes the status flap.
  const statusLog = logger.limited('helper-status');
  const configFetchLog = logger.limited('helper-config-fetch');
  const invalidLineLog = logger.limited('helper-invalid-line');
  const strayResponseLog = logger.limited('helper-stray-response');
  const listenerLog = logger.limited('helper-listener-failed');

  let started = false;
  let status: HelperStatus = { kind: 'stopped' };
  let state: EngineState | null = null;
  let config: Config | null = null;
  let configRevision: number | null = null;
  /**
   * The state names a config newer than the one held. Revisions only grow on
   * one connection, so a config read ahead of the state (a higher revision)
   * is current, not stale: comparing with `!==` re-fetched it back to back.
   */
  const configBehind = (stateRevision: number): boolean => configRevision === null || stateRevision > configRevision;
  let connection: Connection | null = null;
  let reconnectTimer: unknown = null;
  let failedAttempts = 0;

  // -- subscriptions --------------------------------------------------------
  //
  // A subscriber is foreign code running in the middle of the client's own
  // work, and it may call back in: `stop()`, `stop()` then `start()`,
  // `reconnectNow()`, `request()`, or unsubscribe itself or others. So nothing
  // may be assumed after a subscriber ran. Rather than re-checking at every
  // place that notifies, the check lives in the few primitives through which
  // the client has any effect at all — each asks `alive(active)` (is `active`
  // still the connection?) itself:
  //
  // - `publish` delivers a value only while it is still current: it asks
  //   before each subscriber and stops as soon as the answer is no;
  // - `exchange` — the only place that writes to the socket or arms a request
  //   timer — refuses a connection that is over;
  // - `scheduleReconnect` and the config-retry timer are armed only for a
  //   started client, and never twice;
  // - incoming data is read only for the live connection, line by line.
  //
  // `stop()` removes the connection, so everything the old one was in the
  // middle of ends at the next primitive; `stop()` + `start()` creates a new
  // connection object, so nothing of the old one can reach the new. A channel
  // added later inherits this by publishing through `publish`.

  /**
   * True while `active` is the client's connection. A stopped client has no
   * connection — `stop()` removes it before anything else can run — so this
   * also means "started".
   */
  const alive = (active: Connection): boolean => connection === active;

  const channel = <T>(name: string) => {
    // One entry per subscription, so subscribing the same function twice gives
    // two independent subscriptions.
    const subscriptions = new Set<{ readonly listener: (value: T) => void }>();
    return {
      subscribe: (listener: (value: T) => void): Unsubscribe => {
        const subscription = { listener };
        subscriptions.add(subscription);
        return () => {
          subscriptions.delete(subscription);
        };
      },
      /**
       * Calls the subscribers that existed when the call began, skipping any
       * that unsubscribed meanwhile, and stops as soon as `current()` is false.
       */
      publish: (value: T, current: () => boolean): void => {
        for (const subscription of [...subscriptions]) {
          if (!current()) return;
          if (!subscriptions.has(subscription)) continue;
          try {
            subscription.listener(value);
          } catch (error) {
            listenerLog.error('A helper-client listener threw', { channel: name, detail: error });
          }
        }
      },
    };
  };
  const statusChannel = channel<HelperStatus>('status');
  const stateChannel = channel<EngineState>('state');
  const configChannel = channel<Config>('config');
  const logChannel = channel<LogEvent>('log');

  /** Subscribers may have changed anything by the time this returns. */
  const setStatus = (next: HelperStatus): void => {
    if (sameStatus(status, next)) return;
    status = next;
    // A helper that is not installed is the normal first-run state, not a fault.
    const level = next.kind === 'incompatible' || (next.kind === 'disconnected' && next.reason !== 'not-running') ? 'warn' : 'info';
    statusLog[level]('Helper connection status changed', { ...next, kind: undefined, status: next.kind });
    statusChannel.publish(next, () => status === next);
  };

  /** Arms the one reconnect timer — unless the client is stopped, connected again, or already waiting. */
  const scheduleReconnect = (): void => {
    if (!started || connection !== null || reconnectTimer !== null) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      open();
    }, reconnectDelay(failedAttempts));
  };

  // -- state and config -----------------------------------------------------

  const acceptState = (active: Connection, next: EngineState): void => {
    if (active.seq !== null && next.seq <= active.seq) return;
    active.seq = next.seq;
    state = next;
    // Until the handshake is done nothing is published: subscribers see the
    // first state together with its config, when the status turns `connected`.
    if (!active.ready) return;
    stateChannel.publish(next, () => alive(active));
    if (configBehind(next.configRevision)) fetchConfig(active);
  };

  const acceptConfig = (active: Connection, next: Config, revision: number): void => {
    config = next;
    configRevision = revision;
    if (active.ready) configChannel.publish(next, () => alive(active));
  };

  /** Fetches the config for the revision the latest state names. One fetch at a time; changes meanwhile cause one more. */
  const fetchConfig = (active: Connection): void => {
    if (active.configFetchInFlight || state === null) return;
    active.configFetchInFlight = true;
    // A fetch replaces a retry that was waiting: there is never more than one retry timer.
    clearTimer(active.configRetryTimer);
    active.configRetryTimer = null;
    void send(active, 'getConfig', {}).then((result) => {
      active.configFetchInFlight = false;
      if (!alive(active)) return;
      if (!result.ok) {
        configFetchLog.warn('Could not fetch the config after it changed', { code: result.code });
        if (active.configRetryTimer !== null) return;
        active.configRetryTimer = setTimer(() => {
          active.configRetryTimer = null;
          if (state !== null && configBehind(state.configRevision)) fetchConfig(active);
        }, RECONNECT_DELAY_MS);
        return;
      }
      // The helper reads the config and its revision together (`GetConfigResult.configRevision`).
      // Revisions only grow on one connection: an answer older than a config
      // already taken (from a `setConfig` result) is not applied.
      const revision = result.value.configRevision;
      if (configRevision === null || revision >= configRevision) acceptConfig(active, result.value.config, revision);
      if (state !== null && configBehind(state.configRevision)) fetchConfig(active);
    });
  };

  // -- requests -------------------------------------------------------------

  /**
   * Writes one request line and waits for the response with its id.
   * `interpret` turns the response into the caller's result and says whether
   * the response honoured the contract.
   */
  const exchange = <T>(
    active: Connection,
    method: RequestMethod,
    buildLine: (id: number) => string | HelperResult<never>,
    interpret: (response: Response) => { readonly result: HelperResult<T>; readonly valid: boolean },
  ): Promise<HelperResult<T>> => {
    // Nothing is written to, and no timer is armed for, a connection that is over.
    if (!alive(active)) return Promise.resolve(failure('disconnected', 'The connection to the helper is closed'));
    if (active.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve(failure('busy', 'Too many requests are waiting for the helper'));
    }
    if (active.socket.writableLength > MAX_BUFFERED_BYTES) {
      return Promise.resolve(failure('busy', 'The helper is not reading requests'));
    }
    const id = active.nextId;
    const line = buildLine(id);
    if (typeof line !== 'string') return Promise.resolve(line);
    active.nextId += 1;

    return new Promise((resolve) => {
      /** Takes the request out of the pending map; false when it was settled already. */
      const take = (): boolean => {
        if (!active.pending.delete(id)) return false;
        clearTimer(entry.timer);
        return true;
      };
      const settle = (result: HelperResult<T>): void => {
        if (take()) resolve(result);
      };
      const entry: Pending = {
        method,
        timer: setTimer(() => {
          settle(failure('timeout', 'The helper did not answer in time'));
        }, timeouts[TIMEOUT_CLASS[method]]),
        complete: (response) => {
          // Taken out first: interpreting a result can publish a state, and a
          // subscriber that stops the client must not turn this answer into a
          // `disconnected`.
          if (!take()) return true;
          const { result, valid } = interpret(response);
          resolve(result);
          return valid;
        },
        fail: (code, error) => {
          settle(failure(code, error));
        },
      };
      active.pending.set(id, entry);
      try {
        active.socket.write(line);
      } catch {
        settle(failure('disconnected', 'The connection to the helper is closed'));
      }
    });
  };

  const refusal = (response: Extract<Response, { ok: false }>): HelperResult<never> =>
    failure(response.code ?? 'unspecified', response.error);

  const send = <M extends RequestMethod>(
    active: Connection,
    method: M,
    params: Record<string, unknown>,
  ): Promise<HelperResult<ResultOf<M>>> =>
    exchange<ResultOf<M>>(
      active,
      method,
      (id) => {
        // Validated before it is sent: the helper would refuse it anyway, and
        // the line that goes out is built from the parsed value, not the input.
        const request = parseRequest({ ...params, id, method });
        if (!request.ok) return failure(request.error.code, request.error.message);
        const line = encodeJsonLine(request.value);
        return Buffer.byteLength(line) - 1 > MAX_LINE_BYTES
          ? failure('line-too-long', 'The request is too large to send')
          : line;
      },
      (response) => {
        if (!response.ok) return { result: refusal(response), valid: true };
        // Against the method that was asked — not whatever the response looks like.
        const result = parseResult(method, response.result);
        if (!result.ok) return { result: failure('invalid-response', result.error.message), valid: false };
        const carried = result.value as Partial<SetConfigResult>;
        // `setConfig` is the one result that pairs a config with its revision.
        // Taken before the state, so that the state finds its config in place
        // and no second round trip is made for it.
        if (method === 'setConfig' && carried.config !== undefined && carried.state !== undefined) {
          if (configRevision === null || carried.state.configRevision >= configRevision) {
            acceptConfig(active, carried.config, carried.state.configRevision);
          }
        }
        // A state inside a result obeys the same `seq` rule as a state event.
        if (carried.state !== undefined) acceptState(active, carried.state);
        return { result: { ok: true, value: result.value }, valid: true };
      },
    );

  /** `status` with its result left unvalidated: the handshake reads the version fields first. */
  const sendStatusRaw = (active: Connection): Promise<HelperResult<Record<string, unknown>>> =>
    exchange<Record<string, unknown>>(
      active,
      'status',
      (id) => encodeJsonLine({ id, method: 'status' }),
      (response) => ({ result: response.ok ? { ok: true, value: response.result } : refusal(response), valid: true }),
    );

  // -- incoming lines -------------------------------------------------------

  const invalidLine = (active: Connection, code: string, message: string): void => {
    active.invalidLines += 1;
    invalidLineLog.warn('Dropped a line from the helper that is not a valid message', { code, reason: message });
    // An oversized line, or nothing but invalid ones, is not our helper talking.
    if (code === 'line-too-long' || active.invalidLines >= MAX_CONSECUTIVE_INVALID_LINES) {
      drop(active, { kind: 'disconnected', reason: 'protocol-error' });
    }
  };

  const onData = (active: Connection, chunk: Uint8Array | string): void => {
    for (const line of active.decoder.push(chunk)) {
      if (!alive(active)) return;
      if (!line.ok) {
        invalidLine(active, line.error.code, line.error.message);
        continue;
      }
      const message = parseServerMessage(line.value);
      if (!message.ok) {
        // A refused line that carries the id of a pending request still answers it.
        const answered = message.error.id === null ? undefined : active.pending.get(message.error.id);
        answered?.fail('invalid-response', message.error.message);
        invalidLine(active, message.error.code, message.error.message);
        continue;
      }
      if (message.value.kind === 'event') {
        active.invalidLines = 0;
        const { event } = message.value;
        if (event.event === 'state') acceptState(active, event.state);
        else logChannel.publish(event, () => alive(active));
        continue;
      }
      const { response } = message.value;
      const entry = response.id === null ? undefined : active.pending.get(response.id);
      if (entry === undefined) {
        // `id: null` — the helper could not read a line of ours; an unknown id
        // — usually the answer to a request that already timed out.
        active.invalidLines = 0;
        strayResponseLog.warn('Ignored a response that matches no pending request', {
          id: response.id,
          ok: response.ok,
          code: response.ok ? undefined : response.code,
        });
        continue;
      }
      if (entry.complete(response)) active.invalidLines = 0;
      else invalidLine(active, 'invalid-response', 'The result does not match the method that was called');
    }
  };

  // -- connection lifecycle -------------------------------------------------

  /** Ends `active` for good: nothing it does afterwards is listened to. */
  const drop = (active: Connection, next: HelperStatus): void => {
    if (connection !== active) return;
    connection = null;
    clearTimer(active.connectTimer);
    clearTimer(active.configRetryTimer);
    for (const entry of [...active.pending.values()]) {
      entry.fail('disconnected', 'The connection to the helper was lost');
    }
    try {
      active.socket.destroy();
    } catch (error) {
      logger.warn('Closing the helper socket failed', { detail: error });
    }
    state = null;
    config = null;
    configRevision = null;
    if (!started) return;
    if (active.ready) failedAttempts = 0;
    else failedAttempts += 1;
    setStatus(next);
    scheduleReconnect();
  };

  const handshake = async (active: Connection): Promise<void> => {
    // 1. `status`, read leniently first: a helper of another protocol version
    //    must be recognised as such, not as a pile of malformed answers.
    const raw = await sendStatusRaw(active);
    if (!alive(active)) return;
    if (!raw.ok) {
      drop(active, { kind: 'disconnected', reason: raw.code === 'timeout' ? 'timeout' : 'protocol-error' });
      return;
    }
    const version = HelperVersionInfo.safeParse(raw.value);
    if (!version.success) {
      drop(active, { kind: 'disconnected', reason: 'protocol-error' });
      return;
    }
    if (version.data.protocolVersion !== PROTOCOL_VERSION) {
      drop(active, {
        kind: 'incompatible',
        helperVersion: version.data.helperVersion,
        protocolVersion: version.data.protocolVersion,
        expectedProtocolVersion: PROTOCOL_VERSION,
      });
      return;
    }
    const statusResult = parseResult('status', raw.value);
    if (!statusResult.ok) {
      drop(active, { kind: 'disconnected', reason: 'protocol-error' });
      return;
    }
    acceptState(active, statusResult.value.state);

    // 2. `getConfig`, on every connection: the helper may have restarted, and
    //    a restarted helper can reach the same revision with another config.
    const fetched = await send(active, 'getConfig', {});
    if (!alive(active)) return;
    if (!fetched.ok) {
      drop(active, { kind: 'disconnected', reason: fetched.code === 'timeout' ? 'timeout' : 'protocol-error' });
      return;
    }
    // The revision the helper read together with this config — not the one of
    // the status state, which a change in between would leave behind.
    acceptConfig(active, fetched.value.config, fetched.value.configRevision);

    // Read before any subscriber runs: what is published below is what this
    // connection delivered, whatever a subscriber does in between.
    const firstState = state;
    const firstConfig = fetched.value.config;
    active.ready = true;
    failedAttempts = 0;
    setStatus({ kind: 'connected', helperVersion: statusResult.value.helperVersion });
    if (firstState === null) return;
    stateChannel.publish(firstState, () => alive(active));
    configChannel.publish(firstConfig, () => alive(active));
    // A state event may have moved the revision on while the config was in flight.
    if (configBehind(firstState.configRevision)) fetchConfig(active);
  };

  const open = (): void => {
    if (!started || connection !== null) return;
    let socket: HelperSocket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      failedAttempts += 1;
      setStatus(statusOfSocketError(error));
      scheduleReconnect();
      return;
    }
    const active: Connection = {
      socket,
      decoder: createJsonLinesDecoder(),
      pending: new Map(),
      nextId: 0,
      opened: false,
      ready: false,
      seq: null,
      invalidLines: 0,
      configFetchInFlight: false,
      connectTimer: null,
      configRetryTimer: null,
    };
    connection = active;
    active.connectTimer = setTimer(() => {
      active.connectTimer = null;
      drop(active, { kind: 'disconnected', reason: 'timeout' });
    }, timeouts.connectMs);

    // A socket outlives its connection object: every listener first checks
    // that it still speaks for the current one.
    socket.on('connect', () => {
      // For a connection that is over this does nothing: `exchange` refuses it.
      clearTimer(active.connectTimer);
      active.connectTimer = null;
      active.opened = true;
      void handshake(active);
    });
    socket.on('data', (chunk: Uint8Array | string) => {
      onData(active, chunk);
    });
    socket.on('error', (error: unknown) => {
      drop(active, active.opened ? { kind: 'disconnected', reason: 'connection-lost' } : statusOfSocketError(error));
    });
    socket.on('close', () => {
      drop(active, { kind: 'disconnected', reason: active.opened ? 'connection-lost' : 'error' });
    });
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      failedAttempts = 0;
      setStatus({ kind: 'connecting' });
      open();
    },
    stop: () => {
      if (!started) return;
      started = false;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      if (connection !== null) drop(connection, { kind: 'stopped' });
      setStatus({ kind: 'stopped' });
    },
    reconnectNow: () => {
      if (!started || connection !== null) return;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      open();
    },
    request: (method, ...args) => {
      const active = connection;
      if (active === null || !active.ready) {
        return Promise.resolve(failure('not-connected', 'There is no connection to the helper'));
      }
      return send(active, method, args[0] ?? {});
    },
    snapshot: () =>
      status.kind === 'connected'
        ? { status, state, config, configRevision }
        : { status, state: null, config: null, configRevision: null },
    onStatus: statusChannel.subscribe,
    onState: stateChannel.subscribe,
    onConfig: configChannel.subscribe,
    onLog: logChannel.subscribe,
  };
}
