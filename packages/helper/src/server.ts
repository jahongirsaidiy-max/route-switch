import * as nodeFs from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import {
  DiagnoseResult,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  TestResult,
  cidrContains,
  createJsonLinesDecoder,
  encodeJsonLine,
  errorResponse,
  parseRequest,
  type Config,
  type EngineState,
  type ErrorCode,
  type Event,
  type IfaceRole,
  type LogEvent,
  type Request,
  type RequestId,
  type Response,
  type ResultMap,
} from '@routeswitch/shared';

import { DIAGNOSE_LIMITS, createDiagnoseLimiter, runDiagnose, type DiagnoseLimits } from './diagnose';
import type { CachedDomain, ClearTimer, ProbeResult, SetTimer } from './dns';
import type { Engine, ReconcileOutcome } from './engine';
import type { LogEntry, LogSink, Logger } from './logger';
import type { RouteGetOptions, RouteGetResult } from './route';

/**
 * The helper's side of the IPC socket.
 *
 * Three parts, each testable on its own:
 * - `createSocketServer` — transport: the unix socket file (0660 root:staff),
 *   connections, JSON lines, limits. Every line goes through the shared
 *   decoder and `parseRequest` before anything else looks at it; a bad line
 *   is answered with an error, logged and dropped, and never takes the helper
 *   down. Events (`state`, `log`) go to every connection that has made at
 *   least one valid request.
 * - `createRequestHandler` — the eight methods, on top of the engine. There
 *   is no method that runs a command, takes a path or evaluates anything.
 *   Requests that change something (`setConfig`, `setEnabled`, `apply`,
 *   `uninstall`) are serialised; reads are answered at once. `diagnose`
 *   (`diagnose.ts`) is read-only and limited per connection and in total.
 * - `createLogForwarder` — the logger sink that turns user-relevant log
 *   entries into `log` events, with repeats rate-limited.
 */

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

/** Mode of the socket file: owner and group may connect, nobody else (`RouteSwitch.md` §Xavfsizlik). */
export const SOCKET_MODE = 0o660;
/** Group id of `staff` on macOS: every interactive user is in it. */
export const SOCKET_GROUP_GID = 20;

export interface ServerLimits {
  /** Connections at the same time; one more is closed at once. The app needs one. */
  readonly maxConnections: number;
  /** Requests a connection may have in flight; one more is refused (`operation-failed`). The app sends at most 32. */
  readonly maxPendingPerConnection: number;
  /** Unreadable or invalid lines in a row after which the connection is closed (the app gives up after the same number). */
  readonly maxConsecutiveInvalidLines: number;
  /** A connection must send its first valid request within this time, or it is closed. */
  readonly handshakeTimeoutMs: number;
  /** An unfinished line may not wait for its newline longer than this (a peer dribbling bytes holds a buffer). */
  readonly partialLineTimeoutMs: number;
  /** Bytes queued for a peer that does not read; beyond this it is disconnected instead of growing the queue. */
  readonly maxBufferedWriteBytes: number;
}

export const SERVER_LIMITS: ServerLimits = {
  maxConnections: 8,
  maxPendingPerConnection: 32,
  maxConsecutiveInvalidLines: 8,
  handshakeTimeoutMs: 10_000,
  partialLineTimeoutMs: 30_000,
  maxBufferedWriteBytes: 16 * 1024 * 1024,
};

/**
 * How long a mutating request waits for the reconcile it caused before it is
 * answered with the state known at that moment. Shorter than the app's 30 s
 * timeout, so the app gets an answer, never a timeout, for a change that was
 * stored: the pass goes on, and its state arrives as an event.
 */
export const MUTATION_REPLY_DEADLINE_MS = 25_000;
/** The same for `uninstall`, whose cleanup is sized for 60 s (`SHUTDOWN_EXIT_TIMEOUT_SEC`); the app waits 60 s. */
export const UNINSTALL_REPLY_DEADLINE_MS = 55_000;
/** `route -n get` lookups of `test` and `diagnose` running at the same time; more wait their turn. */
export const MAX_CONCURRENT_TESTS = 4;

const errorCodeOf = (error: unknown): string => {
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

const describeThrown = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : 'non-error thrown');

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What the server needs of the file system for the socket file; tests can inject failures. */
export interface SocketFs {
  readonly lstat: (path: string) => Promise<{ readonly ino: number; readonly dev: number; isSocket(): boolean }>;
  readonly unlink: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly chown: (path: string, uid: number, gid: number) => Promise<void>;
}

const realSocketFs: SocketFs = {
  lstat: (path) => nodeFs.lstat(path),
  unlink: (path) => nodeFs.unlink(path),
  rename: (from, to) => nodeFs.rename(from, to),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
  chown: (path, uid, gid) => nodeFs.chown(path, uid, gid),
};

/** What a handler gives back for one request: the response, and what to do once it has been written. */
export interface HandlerOutcome {
  readonly response: Response;
  /** Runs after the response was handed to the socket (or the connection is gone). */
  readonly afterWrite?: (() => void) | undefined;
}

/** Where a request came from: the transport's id of the connection, for the per-connection limits. */
export interface RequestOrigin {
  readonly connection: number;
}

export type RequestDispatcher = (request: Request, origin?: RequestOrigin) => Promise<HandlerOutcome>;

export interface SocketServerDeps {
  /** `PATHS.socket` in the daemon; a path in a temporary directory in tests. */
  readonly path: string;
  readonly logger: Logger;
  readonly dispatch: RequestDispatcher;
  /** Owner of the socket file: root:staff in the daemon; `null` (leave as created) in tests that do not run as root. */
  readonly owner: { readonly uid: number; readonly gid: number } | null;
  readonly limits?: Partial<ServerLimits> | undefined;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  readonly fs?: SocketFs | undefined;
  /** Monotonic milliseconds, for the window of the peer log budget; defaults to `performance.now`. */
  readonly monotonicNow?: (() => number) | undefined;
}

/** Mask in force while the socket is bound: the file is created 0600 at most, never reachable by others. */
export const BIND_UMASK = 0o177;
/** Log lines of one kind a peer can cause per window; the rest is counted and reported when the window ends. */
export const PEER_LOG_BUDGET = 20;
export const PEER_LOG_WINDOW_MS = 60 * 60_000;

export type SocketStartResult =
  | { readonly ok: true }
  /**
   * `in-use`: another process answers on the path (a second helper must not take it over);
   * `not-a-socket`: something else is there and is left alone; `failed`: listening or setting
   * the owner or mode failed (`detail` is a system error code).
   */
  | { readonly ok: false; readonly reason: 'in-use' | 'not-a-socket' | 'failed'; readonly detail: string };

export interface SocketServer {
  /** Takes the socket path over (a stale socket file is replaced) and starts listening. Never rejects. */
  start(): Promise<SocketStartResult>;
  /** Sends an event to every connection that has made a valid request. */
  broadcast(event: Event): void;
  /** Stops listening, closes every connection and removes the socket file if it is still ours. Idempotent, never rejects. */
  close(): Promise<void>;
  /** Open connections, for tests and diagnostics. */
  connectionCount(): number;
}

interface Connection {
  readonly socket: Socket;
  readonly id: number;
  readonly decoder: ReturnType<typeof createJsonLinesDecoder>;
  pending: number;
  invalidLines: number;
  /** True after the first valid request: from then on the connection receives events. */
  subscribed: boolean;
  handshakeTimer: unknown;
  partialLineTimer: unknown;
  closed: boolean;
}

/** Answers whether something accepts connections on `path` (a live helper). */
const probe = (path: string): Promise<'live' | 'stale' | 'unknown'> =>
  new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (verdict: 'live' | 'stale' | 'unknown'): void => {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
      resolve(verdict);
    };
    socket.once('connect', () => {
      done('live');
    });
    socket.once('error', (error) => {
      const code = errorCodeOf(error);
      done(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'stale' : 'unknown');
    });
  });

export const createSocketServer = (deps: SocketServerDeps): SocketServer => {
  const limits: ServerLimits = { ...SERVER_LIMITS, ...deps.limits };
  const fs = deps.fs ?? realSocketFs;
  const logger = deps.logger.child({ component: 'server' });
  const { path, setTimer, clearTimer } = deps;
  const dir = path.slice(0, Math.max(1, path.lastIndexOf('/')));
  const base = path.slice(path.lastIndexOf('/') + 1);
  // Listened on under a name of our own, given its owner and mode, then renamed over the real path, so a
  // stale file is replaced in one step. Two layers keep the socket closed until its mode is 0660 and its
  // owner root:staff: it is bound under `BIND_UMASK` (created 0600, root only), and a connection accepted
  // before the socket is in place is closed at once (`ready`), whatever the umask was.
  const tempPath = `${dir}/.${base}.${String(process.pid)}.tmp`;

  const connections = new Set<Connection>();
  let server: Server | null = null;
  /** True once the socket has its mode, its owner and its real path: only then are connections served. */
  let ready = false;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  /** Inode of the socket file we put in place, so `close` removes only our own. */
  let ours: { ino: number; dev: number } | null = null;
  let closing: Promise<void> | null = null;
  let nextConnectionId = 1;
  /**
   * Log lines a peer can cause are limited per kind and window, so a peer cannot fill the log; a new
   * window starts the budget again (a daemon runs for weeks) and says how many lines were left out.
   */
  const peerLogBudget = new Map<string, { start: number; used: number; skipped: number }>();
  const peerLog = (kind: string, msg: string, context: Record<string, unknown>): void => {
    const now = monotonicNow();
    let budget = peerLogBudget.get(kind);
    if (budget === undefined || now - budget.start >= PEER_LOG_WINDOW_MS || now < budget.start) {
      const skipped = budget?.skipped ?? 0;
      budget = { start: now, used: 0, skipped: 0 };
      peerLogBudget.set(kind, budget);
      if (skipped > 0) logger.warn('client problems were left out of the log', { kind, skipped });
    }
    if (budget.used >= PEER_LOG_BUDGET) {
      budget.skipped += 1;
      return;
    }
    budget.used += 1;
    logger.warn(budget.used === PEER_LOG_BUDGET ? `${msg} (further ones of this kind are counted, not logged, for an hour)` : msg, context);
  };

  const stopTimer = (handle: unknown): void => {
    if (handle !== null) clearTimer(handle);
  };

  const drop = (connection: Connection, why: string): void => {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection);
    stopTimer(connection.handshakeTimer);
    stopTimer(connection.partialLineTimer);
    connection.handshakeTimer = null;
    connection.partialLineTimer = null;
    connection.socket.destroy();
    logger.debug('connection closed', { connection: connection.id, why });
  };

  const write = (connection: Connection, line: string, after?: () => void): void => {
    let ran = false;
    const runAfter = (): void => {
      if (ran || after === undefined) return;
      ran = true;
      after();
    };
    if (connection.closed) {
      runAfter();
      return;
    }
    if (connection.socket.writableLength + line.length > limits.maxBufferedWriteBytes) {
      peerLog('slow-reader', 'client does not read its messages; disconnected', { connection: connection.id });
      drop(connection, 'slow-reader');
      runAfter();
      return;
    }
    try {
      connection.socket.write(line, () => {
        runAfter();
      });
    } catch (error) {
      logger.warn('writing to a client failed; disconnected', { connection: connection.id, error: describeThrown(error) });
      drop(connection, 'write-failed');
      runAfter();
    }
  };

  const reply = (connection: Connection, response: Response, after?: () => void): void => {
    let line: string;
    try {
      line = encodeJsonLine(response);
    } catch (error) {
      logger.error('a response could not be encoded', { connection: connection.id, error: describeThrown(error) });
      line = encodeJsonLine(errorResponse(response.id, 'internal', 'Internal error'));
    }
    write(connection, line, after);
  };

  const refuseLine = (connection: Connection, id: RequestId | null, code: ErrorCode, message: string): void => {
    connection.invalidLines += 1;
    peerLog(`bad-line:${code}`, 'request refused', { connection: connection.id, code, error: message });
    reply(connection, errorResponse(id, code, message));
    if (connection.invalidLines >= limits.maxConsecutiveInvalidLines) {
      peerLog('too-many-bad-lines', 'client sent too many invalid lines in a row; disconnected', {
        connection: connection.id,
        lines: connection.invalidLines,
      });
      drop(connection, 'invalid-lines');
    }
  };

  const handleRequest = (connection: Connection, request: Request): void => {
    connection.invalidLines = 0;
    if (!connection.subscribed) {
      connection.subscribed = true;
      stopTimer(connection.handshakeTimer);
      connection.handshakeTimer = null;
    }
    if (connection.pending >= limits.maxPendingPerConnection) {
      peerLog('too-many-pending', 'client has too many requests in flight; request refused', { connection: connection.id });
      reply(connection, errorResponse(request.id, 'operation-failed', 'Too many requests in flight on this connection'));
      return;
    }
    connection.pending += 1;
    void (async (): Promise<void> => {
      let outcome: HandlerOutcome;
      try {
        outcome = await deps.dispatch(request, { connection: connection.id });
      } catch (error) {
        logger.error('request handler failed', { method: request.method, error: describeThrown(error) });
        outcome = { response: errorResponse(request.id, 'internal', 'Internal error') };
      }
      connection.pending -= 1;
      reply(connection, outcome.response, outcome.afterWrite);
    })();
  };

  /** Read through a call: a refusal inside the loop may close the connection, which narrowing cannot see. */
  const isClosed = (connection: Connection): boolean => connection.closed;

  const onData = (connection: Connection, chunk: Uint8Array): void => {
    if (isClosed(connection)) return;
    for (const line of connection.decoder.push(chunk)) {
      if (isClosed(connection)) return;
      if (!line.ok) {
        refuseLine(connection, null, line.error.code, line.error.message);
        continue;
      }
      const parsed = parseRequest(line.value);
      if (!parsed.ok) {
        refuseLine(connection, parsed.error.id, parsed.error.code, parsed.error.message);
        continue;
      }
      handleRequest(connection, parsed.value);
    }
    if (isClosed(connection)) return;
    const unfinished = connection.decoder.memory().pendingBytes > 0;
    if (unfinished && connection.partialLineTimer === null) {
      connection.partialLineTimer = setTimer(() => {
        connection.partialLineTimer = null;
        peerLog('partial-line', 'client left a line unfinished for too long; disconnected', { connection: connection.id });
        drop(connection, 'partial-line-timeout');
      }, limits.partialLineTimeoutMs);
    } else if (!unfinished && connection.partialLineTimer !== null) {
      clearTimer(connection.partialLineTimer);
      connection.partialLineTimer = null;
    }
  };

  const accept = (socket: Socket): void => {
    socket.on('error', () => undefined);
    if (closing !== null) {
      socket.destroy();
      return;
    }
    if (!ready) {
      // Connected while the socket was still being set up (mode, owner, path): never served.
      peerLog('early', 'connection made before the socket was ready; closed', {});
      socket.destroy();
      return;
    }
    if (connections.size >= limits.maxConnections) {
      peerLog('too-many-connections', 'too many clients connected; connection refused', { limit: limits.maxConnections });
      socket.destroy();
      return;
    }
    const connection: Connection = {
      socket,
      id: nextConnectionId,
      decoder: createJsonLinesDecoder(),
      pending: 0,
      invalidLines: 0,
      subscribed: false,
      handshakeTimer: null,
      partialLineTimer: null,
      closed: false,
    };
    nextConnectionId += 1;
    connections.add(connection);
    connection.handshakeTimer = setTimer(() => {
      connection.handshakeTimer = null;
      peerLog('silent', 'client sent no request in time; disconnected', { connection: connection.id });
      drop(connection, 'handshake-timeout');
    }, limits.handshakeTimeoutMs);
    socket.on('data', (chunk: Buffer) => {
      onData(connection, chunk);
    });
    socket.on('close', () => {
      drop(connection, 'peer-closed');
    });
    socket.on('end', () => {
      drop(connection, 'peer-ended');
    });
    logger.debug('client connected', { connection: connection.id, connections: connections.size });
  };

  const listen = (target: string): Promise<Server> =>
    new Promise((resolve, reject) => {
      const created = createServer({ allowHalfOpen: false, pauseOnConnect: false }, accept);
      const onError = (error: Error): void => {
        created.close();
        reject(error);
      };
      created.once('error', onError);
      // The bind happens inside `listen`, synchronously: the tighter mask is in force for exactly that call,
      // so no other file the process creates meanwhile is affected.
      let previous: number | null = null;
      try {
        previous = process.umask(BIND_UMASK);
      } catch (error) {
        // `process.umask` is not available in worker threads; `ready` still keeps early connections out.
        logger.warn('the umask could not be tightened for the socket', { error: describeThrown(error) });
      }
      try {
        created.listen({ path: target, exclusive: true }, () => {
          created.off('error', onError);
          created.on('error', (error) => {
            logger.error('socket server error', { error: describeThrown(error) });
          });
          resolve(created);
        });
      } finally {
        if (previous !== null) process.umask(previous);
      }
    });

  const closeServer = (target: Server): Promise<void> =>
    new Promise((resolve) => {
      target.close(() => {
        resolve();
      });
    });

  const start = async (): Promise<SocketStartResult> => {
    try {
      let existing: Awaited<ReturnType<SocketFs['lstat']>> | null = null;
      try {
        existing = await fs.lstat(path);
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
      }
      if (existing !== null) {
        if (!existing.isSocket()) {
          logger.error('the socket path holds something that is not a socket; it is left alone and the helper does not listen', { path });
          return { ok: false, reason: 'not-a-socket', detail: 'ENOTSOCK' };
        }
        const verdict = await probe(path);
        if (verdict !== 'stale') {
          logger.error('another process is listening on the socket; this helper does not take it over', { path, probe: verdict });
          return { ok: false, reason: 'in-use', detail: verdict === 'live' ? 'EADDRINUSE' : 'UNKNOWN' };
        }
        logger.info('replacing a stale socket file left by a previous helper', { path });
      }
      await fs.unlink(tempPath).catch((error: unknown) => {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
      });
      const listening = await listen(tempPath);
      try {
        await fs.chmod(tempPath, SOCKET_MODE);
        if (deps.owner !== null) await fs.chown(tempPath, deps.owner.uid, deps.owner.gid);
        await fs.rename(tempPath, path);
        const stats = await fs.lstat(path);
        ours = { ino: stats.ino, dev: stats.dev };
        // Mode, owner and path are in place: from now on connections are served.
        ready = true;
      } catch (error) {
        await closeServer(listening);
        await fs.unlink(tempPath).catch(() => undefined);
        throw error;
      }
      server = listening;
      logger.info('listening', { path, mode: '0660', group: deps.owner?.gid ?? null });
      return { ok: true };
    } catch (error) {
      const detail = errorCodeOf(error);
      logger.error('the socket could not be set up', { path, error: detail });
      return { ok: false, reason: 'failed', detail };
    }
  };

  const broadcast = (event: Event): void => {
    if (closing !== null) return;
    let line: string;
    try {
      line = encodeJsonLine(event);
    } catch (error) {
      logger.error('an event could not be encoded', { event: event.event, error: describeThrown(error) });
      return;
    }
    for (const connection of [...connections]) {
      if (connection.subscribed) write(connection, line);
    }
  };

  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      for (const connection of [...connections]) drop(connection, 'server-closing');
      if (server !== null) {
        await closeServer(server);
        server = null;
      }
      if (ours !== null) {
        const expected = ours;
        ours = null;
        try {
          const stats = await fs.lstat(path);
          if (stats.ino === expected.ino && stats.dev === expected.dev) await fs.unlink(path);
        } catch (error) {
          if (errorCodeOf(error) !== 'ENOENT') logger.warn('the socket file could not be removed', { path, error: errorCodeOf(error) });
        }
      }
      logger.info('socket closed', { path });
    })();
    return closing;
  };

  return { start, broadcast, close, connectionCount: () => connections.size };
};

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** What the methods need from the daemon. */
export interface RequestHandlerDeps {
  readonly engine: Pick<Engine, 'getState' | 'getConfig' | 'getConfigRevision' | 'getApplied' | 'setConfig' | 'setEnabled' | 'reconcile'>;
  readonly helperVersion: string;
  readonly logger: Logger;
  /** `route -n get -host <ip>`; the target has passed the request schema (a routable IPv4 address). */
  readonly routeGet: (target: string, options?: RouteGetOptions) => Promise<RouteGetResult>;
  /** Writes `config.json` atomically. */
  readonly saveConfig: (config: Config) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Resolves when the startup (cleanup of leftovers, first reconcile) is done; changes wait for it. */
  readonly started: Promise<unknown>;
  /**
   * Why the stored config could not be loaded at start, or null. While set, `getConfig`
   * and `setEnabled` fail (`operation-failed`) and only `setConfig` (which replaces the
   * file) clears it: the app must never be shown an empty config in place of the broken one.
   */
  readonly storedConfigProblem: string | null;
  /** `cleanupAll` (not final): what the global toggle off runs, before its reconcile. */
  readonly disableAll: () => Promise<{ readonly failed: number; readonly resolverFilesFailed: number }>;
  /** Stops events and every source of passes, then `cleanupAll({final: true})`. */
  readonly uninstall: () => Promise<{ readonly failed: number; readonly resolverFilesFailed: number }>;
  /** Runs once the `uninstall` answer has been written: the daemon closes the socket. */
  readonly afterUninstall: () => void;
  /** `diagnose`: the DNS module's cache of a rule, read-only (`DomainResolverService.peek`). */
  readonly peekDomain: (ruleId: string) => CachedDomain | null;
  /** `diagnose`: one A query to one server (`probeDns`). */
  readonly probeDns: (server: string, name: string) => Promise<ProbeResult>;
  /** Monotonic milliseconds, for the `diagnose` rate limit; defaults to `performance.now`. */
  readonly monotonicNow?: (() => number) | undefined;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  readonly limits?:
    | { readonly mutationReplyMs?: number; readonly uninstallReplyMs?: number; readonly diagnose?: Partial<DiagnoseLimits> }
    | undefined;
}

type HandlerResult<M extends keyof ResultMap> = { readonly ok: true; readonly result: ResultMap[M] } | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

const failed = (code: ErrorCode, message: string): { readonly ok: false; readonly code: ErrorCode; readonly message: string } => ({ ok: false, code, message });

/** Serialises async sections: each runs after the previous one has settled, whatever its outcome. */
const createSerialQueue = (): (<T>(section: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(section: () => Promise<T>): Promise<T> => {
    const run = tail.then(section, section);
    tail = run.catch(() => undefined);
    return run;
  };
};

/** The role a device currently has, from the latest state; null when it has neither. */
const roleOf = (state: EngineState, device: string): IfaceRole | null => {
  if (state.interfaces.ethernet.device === device) return 'ethernet';
  if (state.interfaces.wifi.device === device) return 'wifi';
  return null;
};

export interface RequestHandler {
  readonly dispatch: RequestDispatcher;
  /** True once `uninstall` started: every later request is refused. */
  isUninstalled(): boolean;
}

export const createRequestHandler = (deps: RequestHandlerDeps): RequestHandler => {
  const { engine } = deps;
  const logger = deps.logger.child({ component: 'server' });
  const mutationReplyMs = deps.limits?.mutationReplyMs ?? MUTATION_REPLY_DEADLINE_MS;
  const uninstallReplyMs = deps.limits?.uninstallReplyMs ?? UNINSTALL_REPLY_DEADLINE_MS;
  const serial = createSerialQueue();
  let configProblem = deps.storedConfigProblem;
  let uninstalled = false;
  let testsRunning = 0;
  const testWaiters: (() => void)[] = [];
  const diagnoseLimits: DiagnoseLimits = { ...DIAGNOSE_LIMITS, ...deps.limits?.diagnose };
  const diagnoseLimiter = createDiagnoseLimiter(diagnoseLimits, deps.monotonicNow ?? (() => performance.now()));

  /** Resolves with the value, or with `null` once `ms` have passed. */
  const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
    new Promise<T | null>((resolve) => {
      const timer = deps.setTimer(() => {
        resolve(null);
      }, ms);
      void work.then((value) => {
        deps.clearTimer(timer);
        resolve(value);
      });
    });

  /** The state after the pass a change caused, or the state known now if that pass takes too long. */
  const settledState = async (pass: Promise<ReconcileOutcome>, method: string): Promise<EngineState> => {
    const outcome = await withDeadline(pass, mutationReplyMs);
    if (outcome !== null) return outcome.state;
    logger.warn('the reconcile takes longer than a reply may wait; answering with the current state', { method, waitedMs: mutationReplyMs });
    return engine.getState();
  };

  const uninstalledFailure = failed('operation-failed', 'The helper has been uninstalled');

  const setConfig = async (config: Config): Promise<HandlerResult<'setConfig'>> => {
    const stored = await serial(async () => {
      await deps.started;
      if (uninstalled) return uninstalledFailure;
      const unchanged = configProblem === null && JSON.stringify(config) === JSON.stringify(engine.getConfig());
      if (!unchanged) {
        const saved = await deps.saveConfig(config);
        if (!saved.ok) return failed('operation-failed', `The config could not be saved (${saved.code})`);
        engine.setConfig(config);
        configProblem = null;
      }
      // Asked for inside the queue, so the passes run in the order of the changes.
      return { ok: true as const, pass: engine.reconcile('config-change') };
    });
    if (!stored.ok) return stored;
    return { ok: true, result: { config, state: await settledState(stored.pass, 'setConfig') } };
  };

  const setEnabled = async (enabled: boolean): Promise<HandlerResult<'setEnabled'>> => {
    const stored = await serial(async () => {
      await deps.started;
      if (uninstalled) return uninstalledFailure;
      if (configProblem !== null) {
        return failed('operation-failed', `The stored config could not be loaded (${configProblem}); send a new config first`);
      }
      const current = engine.getConfig();
      if (current.enabled !== enabled) {
        const saved = await deps.saveConfig({ ...current, enabled });
        if (!saved.ok) return failed('operation-failed', `The config could not be saved (${saved.code})`);
        engine.setEnabled(enabled);
        if (!enabled) {
          // Off means off even when the interfaces cannot be detected: everything goes without a detection.
          const cleanup = await deps.disableAll();
          if (cleanup.failed > 0 || cleanup.resolverFilesFailed > 0) {
            logger.warn('routing turned off, but not everything could be removed; the next pass tries again', { ...cleanup });
          }
        }
      }
      return { ok: true as const, pass: engine.reconcile('enabled-change') };
    });
    if (!stored.ok) return stored;
    return { ok: true, result: { state: await settledState(stored.pass, 'setEnabled') } };
  };

  const apply = async (): Promise<HandlerResult<'apply'>> => {
    const stored = await serial(async () => {
      await deps.started;
      if (uninstalled) return uninstalledFailure;
      return { ok: true as const, pass: engine.reconcile('manual', { force: true }) };
    });
    if (!stored.ok) return stored;
    return { ok: true, result: { state: await settledState(stored.pass, 'apply') } };
  };

  const uninstall = (): Promise<HandlerResult<'uninstall'>> =>
    serial(async () => {
      await deps.started;
      if (uninstalled) return uninstalledFailure;
      uninstalled = true;
      logger.info('uninstall requested: removing every route and resolver file');
      const cleanup = await withDeadline(deps.uninstall(), uninstallReplyMs);
      if (cleanup === null) return failed('operation-failed', 'The cleanup is still running; the helper finishes it before it stops');
      if (cleanup.failed > 0 || cleanup.resolverFilesFailed > 0) {
        return failed(
          'operation-failed',
          `The cleanup left ${String(cleanup.failed)} route(s) and ${String(cleanup.resolverFilesFailed)} resolver file(s) behind`,
        );
      }
      return { ok: true, result: {} };
    });

  const acquireTestSlot = async (): Promise<void> => {
    while (testsRunning >= MAX_CONCURRENT_TESTS) {
      await new Promise<void>((resolve) => {
        testWaiters.push(resolve);
      });
    }
    testsRunning += 1;
  };
  const releaseTestSlot = (): void => {
    testsRunning -= 1;
    testWaiters.shift()?.();
  };

  /** `route -n get` behind one semaphore for `test` and `diagnose`: never more than `MAX_CONCURRENT_TESTS` lookups at once. */
  const sharedRouteGet = async (address: string, options?: RouteGetOptions): Promise<RouteGetResult> => {
    await acquireTestSlot();
    try {
      return await (options === undefined ? deps.routeGet(address) : deps.routeGet(address, options));
    } finally {
      releaseTestSlot();
    }
  };

  const test = async (target: string): Promise<HandlerResult<'test'>> => {
    const found = await sharedRouteGet(target);
    if (found.outcome === 'not-found') return failed('operation-failed', 'No route to the target');
    if (!found.ok) return failed('operation-failed', 'The route lookup failed');
    const { route } = found;
    const state = engine.getState();
    // The rule whose own route the kernel picked: same table entry, same gateway, and it covers the target.
    const applied = engine
      .getApplied()
      .find(
        (entry) =>
          entry.gateway === route.gateway &&
          (entry.dst.split('/')[0] ?? entry.dst) === route.destination &&
          cidrContains(entry.dst, route.target),
      );
    const configured = new Set(engine.getConfig().rules.map((rule) => rule.id));
    const ruleId = applied?.ruleIds.find((id) => configured.has(id)) ?? null;
    const checked = TestResult.safeParse({
      target: route.target,
      destination: route.destination,
      gateway: route.gateway,
      device: route.iface,
      role: roleOf(state, route.iface),
      ruleId,
    });
    if (!checked.success) {
      logger.warn('a route lookup answer does not fit the protocol; not sent', { target, iface: route.iface.slice(0, 32) });
      return failed('operation-failed', 'The route lookup gave an answer that cannot be reported');
    }
    return { ok: true, result: checked.data };
  };

  const DIAGNOSE_REFUSALS = {
    'connection-busy': 'A diagnosis is already running on this connection',
    'connection-rate': 'Too many diagnoses on this connection; try again in a minute',
    busy: 'Too many diagnoses are running; try again shortly',
  } as const;

  const diagnose = async (target: string, origin: RequestOrigin | undefined): Promise<HandlerResult<'diagnose'>> => {
    // A caller without an origin (none in the daemon) shares one budget instead of escaping the limit.
    const slot = diagnoseLimiter.tryAcquire(origin?.connection ?? 0);
    if (!slot.ok) {
      logger.debug('diagnose refused', { reason: slot.reason });
      return failed('operation-failed', DIAGNOSE_REFUSALS[slot.reason]);
    }
    // The slot is held until the work is really over, also when the answer went out at the deadline.
    const work = runDiagnose(target, {
      getConfig: () => engine.getConfig(),
      getState: () => engine.getState(),
      getApplied: () => engine.getApplied(),
      peekDomain: deps.peekDomain,
      // The addresses a user diagnoses are theirs: logged at debug only, here and in the command log.
      routeGet: (address) => sharedRouteGet(address, { private: true }),
      probe: deps.probeDns,
      logger: deps.logger,
    });
    void work.then(slot.release, (error: unknown) => {
      slot.release();
      logger.error('diagnose failed', { error: describeThrown(error) });
    });
    const outcome = await withDeadline(
      work.catch(() => null),
      diagnoseLimits.deadlineMs,
    );
    if (outcome === null) return failed('operation-failed', 'The diagnosis did not finish in time or failed');
    const checked = DiagnoseResult.safeParse(outcome);
    if (!checked.success) {
      logger.warn('a diagnosis does not fit the protocol; not sent');
      return failed('operation-failed', 'The diagnosis gave an answer that cannot be reported');
    }
    return { ok: true, result: checked.data };
  };

  const run = async (request: Request, origin: RequestOrigin | undefined): Promise<HandlerResult<keyof ResultMap>> => {
    if (uninstalled) return uninstalledFailure;
    switch (request.method) {
      case 'status':
        return { ok: true, result: { protocolVersion: PROTOCOL_VERSION, helperVersion: deps.helperVersion, state: engine.getState() } };
      case 'getConfig':
        if (configProblem !== null) return failed('operation-failed', `The stored config could not be loaded (${configProblem})`);
        // Read together, synchronously: the revision is exactly the one of this config.
        return { ok: true, result: { config: engine.getConfig(), configRevision: engine.getConfigRevision() } };
      case 'setConfig':
        return setConfig(request.config);
      case 'setEnabled':
        return setEnabled(request.enabled);
      case 'apply':
        return apply();
      case 'test':
        return test(request.target);
      case 'uninstall':
        return uninstall();
      case 'diagnose':
        return diagnose(request.target, origin);
    }
  };

  const dispatch: RequestDispatcher = async (request, origin) => {
    let result: HandlerResult<keyof ResultMap>;
    try {
      result = await run(request, origin);
    } catch (error) {
      logger.error('request failed unexpectedly', { method: request.method, error: describeThrown(error) });
      result = failed('internal', 'Internal error');
    }
    if (!result.ok) {
      if (result.code !== 'operation-failed') logger.warn('request failed', { method: request.method, code: result.code });
      return { response: errorResponse(request.id, result.code, result.message) };
    }
    const response: Response = { id: request.id, ok: true, result: result.result };
    return request.method === 'uninstall' ? { response, afterWrite: deps.afterUninstall } : { response };
  };

  return { dispatch, isUninstalled: () => uninstalled };
};

// ---------------------------------------------------------------------------
// Log events
// ---------------------------------------------------------------------------

export interface LogForwarderLimits {
  /** Window in which the same info line is forwarded at most `infoPerWindow` times. */
  readonly infoWindowMs: number;
  readonly infoPerWindow: number;
  /** A warning or error repeating itself (same message, same subject) is forwarded once per window. */
  readonly repeatWindowMs: number;
  /** All log events together, per `infoWindowMs`; the rest is dropped and counted. */
  readonly totalPerWindow: number;
  /** Distinct lines remembered for the repeat check; the oldest is forgotten first. */
  readonly maxKeys: number;
}

export const LOG_FORWARDER_LIMITS: LogForwarderLimits = {
  infoWindowMs: 60_000,
  infoPerWindow: 5,
  repeatWindowMs: 10 * 60_000,
  totalPerWindow: 60,
  maxKeys: 512,
};

/** Components whose lines below `warn` are diagnostics of the log file only: every command run, every connection. */
const QUIET_COMPONENTS: ReadonlySet<string> = new Set(['exec', 'server']);

/** Context fields that say what a line is about; they become part of the event text. */
const SUBJECT_FIELDS = ['ruleId', 'dst', 'gateway', 'reason', 'code', 'outcome', 'existing', 'error', 'role'] as const;
/** Fields that make one warning a different one from another with the same message. */
const KEY_FIELDS = ['ruleId', 'dst', 'gateway', 'role', 'code', 'outcome'] as const;

const shortValue = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

const clampMessage = (text: string): string =>
  text.length <= PROTOCOL_LIMITS.logMessageMaxLength ? text : `${text.slice(0, PROTOCOL_LIMITS.logMessageMaxLength - 1)}…`;

export interface LogForwarderDeps {
  readonly send: (event: LogEvent) => void;
  /** Monotonic milliseconds (`performance.now` in the daemon). */
  readonly monotonicNow: () => number;
  readonly limits?: Partial<LogForwarderLimits> | undefined;
}

/**
 * The logger sink behind the `log` events of the journal screen.
 *
 * - `debug` never crosses the wire; `exec` (one line per command) and
 *   `server` (connections) only from `warn` up.
 * - A warning or error that repeats itself — same component, message and
 *   subject (rule, destination, gateway, …), such as `route` refusing the
 *   same connected route on every pass — is forwarded once per
 *   `repeatWindowMs`; the next one says how many were held back.
 * - Info lines of one kind: at most `infoPerWindow` per `infoWindowMs`.
 * - All events: at most `totalPerWindow` per `infoWindowMs`.
 * A persistent condition (a degraded detection, a rule that keeps failing)
 * therefore stays visible, once per window, without filling the journal.
 * Never throws; a line logged while an event is being sent is not forwarded.
 */
export const createLogForwarder = (deps: LogForwarderDeps): LogSink => {
  const limits: LogForwarderLimits = { ...LOG_FORWARDER_LIMITS, ...deps.limits };
  /** Key -> window start, events forwarded in it, events held back. Insertion order is the eviction order. */
  const seen = new Map<string, { start: number; sent: number; held: number }>();
  let totalStart = Number.NEGATIVE_INFINITY;
  let totalSent = 0;
  let totalHeld = 0;
  let sending = false;

  return (entry: LogEntry) => {
    if (sending || entry.level === 'debug') return;
    const context = entry.context ?? {};
    const component = typeof context['component'] === 'string' ? context['component'] : '';
    if (entry.level === 'info' && QUIET_COMPONENTS.has(component)) return;

    const now = deps.monotonicNow();
    const repeatable = entry.level !== 'info';
    const window = repeatable ? limits.repeatWindowMs : limits.infoWindowMs;
    const budget = repeatable ? 1 : limits.infoPerWindow;
    const keyParts = [entry.level, component, entry.msg];
    if (repeatable) for (const field of KEY_FIELDS) keyParts.push(shortValue(context[field]) ?? '');
    const key = keyParts.join('\u0000');

    let slot = seen.get(key);
    // A clock that went backwards, or a window that is over, starts a new window.
    if (slot !== undefined && (now - slot.start >= window || now < slot.start)) {
      seen.delete(key);
      slot = { start: now, sent: 0, held: slot.held };
    }
    slot ??= { start: now, sent: 0, held: 0 };
    seen.delete(key);
    seen.set(key, slot);
    while (seen.size > limits.maxKeys) {
      const oldest = seen.keys().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
    if (slot.sent >= budget) {
      slot.held += 1;
      return;
    }
    if (now - totalStart >= limits.infoWindowMs || now < totalStart) {
      totalStart = now;
      totalSent = 0;
    }
    if (totalSent >= limits.totalPerWindow) {
      totalHeld += 1;
      slot.held += 1;
      return;
    }

    const subject = SUBJECT_FIELDS.flatMap((field) => {
      const value = shortValue(context[field]);
      return value === null ? [] : [`${field}=${value}`];
    });
    const notes: string[] = [];
    if (slot.held > 0) notes.push(`${String(slot.held)} similar held back`);
    if (totalHeld > 0) notes.push(`${String(totalHeld)} log lines dropped while the journal was busy`);
    const text = [
      component === '' ? entry.msg : `${component}: ${entry.msg}`,
      subject.length > 0 ? ` (${subject.join(', ')})` : '',
      notes.length > 0 ? ` [${notes.join('; ')}]` : '',
    ].join('');
    slot.sent += 1;
    slot.held = 0;
    totalSent += 1;
    totalHeld = 0;

    sending = true;
    try {
      deps.send({ event: 'log', level: entry.level, msg: clampMessage(text), at: entry.at });
    } catch {
      // Sending is best effort: a failure to reach a client must never break logging, and logging it here would recurse.
    } finally {
      sending = false;
    }
  };
};

