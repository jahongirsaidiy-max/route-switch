/**
 * Upstream side of the loopback DNS proxy (ADR-002 §2, §5): which servers a
 * query goes to, and one forwarded query with its timeouts and anti-spoofing
 * checks. The sockets are behind `SocketFactory`, so tests run on fakes and
 * never open a real port.
 */

import { DNS_PROXY, matchDomainRule, normalizeHostAddress, wildcardBase, type Rule } from '@routeswitch/shared';

import type { ClearTimer, SetTimer } from '../dns';
import type { Logger } from '../logger';
import {
  MAX_TCP_RESPONSE_BYTES,
  MAX_UDP_RESPONSE_BYTES,
  MAX_UPSTREAM_SERVERS,
  UPSTREAM_PORT,
  UPSTREAM_SERVER_TIMEOUT_MS,
  UPSTREAM_TOTAL_TIMEOUT_MS,
} from './limits';
import { parseResponse, withId, type ExpectedQuestion, type ParsedResponse } from './packet';

// ---------------------------------------------------------------------------
// Socket seam

export interface RemoteInfo {
  readonly address: string;
  readonly port: number;
}

/** The part of a UDP socket the proxy uses (`node:dgram`, `udp4`). */
export interface UdpSocketLike {
  /** Resolves once listening; rejects with the bind error (`EADDRINUSE`, `EACCES`, …). */
  bind(port: number, address: string): Promise<void>;
  send(data: Uint8Array, port: number, address: string, onSent: (error: Error | null) => void): void;
  onMessage(listener: (message: Buffer, from: RemoteInfo) => void): void;
  onError(listener: (error: Error) => void): void;
  close(): void;
}

/** One TCP connection, accepted or dialled (`node:net` `Socket`). */
export interface TcpConnectionLike {
  readonly remoteAddress: string | undefined;
  write(data: Uint8Array): void;
  onData(listener: (chunk: Buffer) => void): void;
  /** The connection is gone (closed by either side, or destroyed). */
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  destroy(): void;
}

/** A listening TCP socket (`node:net` `Server`). */
export interface TcpServerLike {
  /** Resolves once listening; rejects with the bind error. */
  listen(port: number, address: string): Promise<void>;
  onConnection(listener: (connection: TcpConnectionLike) => void): void;
  onError(listener: (error: Error) => void): void;
  close(): void;
}

export interface SocketFactory {
  udp: () => UdpSocketLike;
  tcpServer: () => TcpServerLike;
  tcpConnect: (address: string, port: number) => TcpConnectionLike;
}

// ---------------------------------------------------------------------------
// Upstream choice

/**
 * What the proxy does with one name:
 * - `learn`       — a domain rule owns it: a wildcard rule, or an exact domain
 *                   rule for this very name (also the base itself). Forward to
 *                   that rule's servers — its `dns`, else its role's DNS
 *                   servers (else the system's, for an exact rule: the
 *                   engine's own lookup for it) — and learn the A answers for
 *                   `ruleId`, so the addresses clients get are routed per the
 *                   winning rule even when the two servers answer differently
 *                   (split horizon, TASK-DELTA-30);
 * - `passthrough` — it lies under a wildcard base but no rule owns it (the
 *                   base itself with no exact rule for it, a name that is not
 *                   a plain hostname such as `_ldap._tcp.…`): forward to the
 *                   covering wildcard's `dns` (else the system's), learn
 *                   nothing — no rule routes such a name.
 * An exact rule's name may be an alias (CNAME) of another name under the
 * base; the proxy then answers that target the exact rule's way too, for the
 * alias's TTL (`server.ts`, TASK-DELTA-41) — `routeQuery` itself only looks
 * at rules.
 * `servers` are already filtered (`upstreamServers`); empty means SERVFAIL.
 * A name under no wildcard base at all gets no route (null → REFUSED).
 */
export type QueryRoute =
  | {
      readonly kind: 'learn';
      readonly ruleId: string;
      readonly servers: readonly string[];
      /**
       * Set for an exact domain rule (absent for a wildcard): the CNAME
       * targets of its answers under a wildcard base are bound to it
       * (`CnameBindings`, TASK-DELTA-41).
       */
      readonly exact?: true;
    }
  | { readonly kind: 'passthrough'; readonly servers: readonly string[] };

export type ProxyRule = Pick<Rule, 'id' | 'enabled' | 'kind' | 'target' | 'iface' | 'dns'>;

export interface RouteSources {
  /** DNS servers of a role's interface, from a trusted detection only (TASK-DELTA-06), in order. */
  readonly roleServers: (iface: Rule['iface']) => readonly string[];
  /** The system's primary resolvers (first `scutil --dns` resolver), in order. */
  readonly systemServers: () => readonly string[];
}

/**
 * The servers a query may go to: valid routable IPv4 addresses only — never
 * loopback (the proxy itself, so it cannot forward to itself), never an
 * ADR-001 range — without duplicates, at most `MAX_UPSTREAM_SERVERS`.
 */
export const upstreamServers = (candidates: readonly string[]): string[] => {
  const servers: string[] = [];
  for (const candidate of candidates) {
    const normalised = normalizeHostAddress(candidate);
    if (!normalised.ok) continue;
    if (normalised.value === DNS_PROXY.address || servers.includes(normalised.value)) continue;
    servers.push(normalised.value);
    if (servers.length === MAX_UPSTREAM_SERVERS) break;
  }
  return servers;
};

/**
 * Decides `QueryRoute` for a name the proxy received (ADR-002 §2, §3). The
 * owner comes from shared `matchDomainRule` (the one function the engine and
 * `diagnose` use too); both a `wildcard` and an exact (`domain`) win learn.
 * `qname` is the parser's form (lower case, no trailing dot).
 */
export const routeQuery = (qname: string, rules: readonly ProxyRule[], sources: RouteSources): QueryRoute | null => {
  let covering: { rule: ProxyRule; depth: number } | null = null;
  for (const rule of rules) {
    if (!rule.enabled || rule.kind !== 'domain') continue;
    const base = wildcardBase(rule.target);
    if (base === null || (qname !== base && !qname.endsWith(`.${base}`))) continue;
    const depth = base.split('.').length;
    if (covering === null || depth > covering.depth) covering = { rule, depth };
  }
  if (covering === null) return null;

  const match = matchDomainRule(qname, rules);
  if (match !== null) {
    const { rule } = match;
    const exact = match.via === 'domain';
    const learn = (servers: readonly string[]): QueryRoute =>
      exact ? { kind: 'learn', ruleId: rule.id, servers, exact: true } : { kind: 'learn', ruleId: rule.id, servers };
    if (rule.dns !== undefined) return learn(upstreamServers([rule.dns]));
    const servers = upstreamServers(sources.roleServers(rule.iface));
    // An exact rule's lookup falls back to the system resolvers when its role has no servers
    // (`dns.ts`); a wildcard has no lookup of its own and fails instead.
    if (servers.length === 0 && exact) return learn(upstreamServers(sources.systemServers()));
    return learn(servers);
  }
  const { dns } = covering.rule;
  return { kind: 'passthrough', servers: upstreamServers(dns === undefined ? sources.systemServers() : [dns]) };
};

// ---------------------------------------------------------------------------
// One forwarded query

export type Transport = 'udp' | 'tcp';

export interface UpstreamRequest {
  /** The client's query, as received (its ID is replaced on the wire). */
  readonly query: Uint8Array;
  readonly question: ExpectedQuestion;
  /** Tried in order, one at a time (failover). */
  readonly servers: readonly string[];
  readonly transport: Transport;
}

export interface UpstreamResult {
  /** The server's reply as received; its ID is the proxy's random one. */
  readonly reply: Buffer;
  readonly parsed: ParsedResponse;
  readonly server: string;
}

export interface UpstreamCall {
  /** The first accepted reply, or null when every server failed or the 5 s budget ran out. Never rejects. */
  readonly result: Promise<UpstreamResult | null>;
  /** Abandons the query: closes its socket and timers; `result` settles with null. */
  readonly cancel: () => void;
}

export interface UpstreamDeps {
  readonly sockets: SocketFactory;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  /** A fresh 16-bit message ID per upstream query. */
  readonly randomId: () => number;
  readonly logger: Logger;
}

interface Attempt {
  readonly done: Promise<UpstreamResult | null>;
  abort(): void;
}

const readId = (message: Uint8Array): number | null => {
  const hi = message[0];
  const lo = message[1];
  return hi === undefined || lo === undefined ? null : (hi << 8) | lo;
};

const frame = (message: Uint8Array): Buffer => {
  const out = Buffer.alloc(message.length + 2);
  out.writeUInt16BE(message.length, 0);
  out.set(message, 2);
  return out;
};

/** Frames a DNS message for TCP (2-byte length prefix, RFC 1035 §4.2.2). */
export const tcpFrame = frame;

/**
 * One server over UDP: a new socket (new random source port) and a new ID.
 * Only a datagram from `server:53` that carries this ID, fits in
 * `MAX_UDP_RESPONSE_BYTES` and parses with the same question is accepted;
 * anything else is dropped and the wait goes on (a spoofed or broken reply
 * cannot end the query early). Ends with null on timeout or socket error.
 */
const udpAttempt = (server: string, request: UpstreamRequest, timeoutMs: number, deps: UpstreamDeps): Attempt => {
  let finish: (value: UpstreamResult | null) => void = () => undefined;
  const done = new Promise<UpstreamResult | null>((resolve) => {
    finish = resolve;
  });
  const id = deps.randomId();
  const outgoing = withId(request.query, id);
  let socket: UdpSocketLike | null = null;
  let timer: unknown = null;
  let settled = false;

  const settle = (value: UpstreamResult | null): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) deps.clearTimer(timer);
    socket?.close();
    finish(value);
  };

  if (outgoing === null) {
    settle(null);
    return { done, abort: () => undefined };
  }
  try {
    socket = deps.sockets.udp();
  } catch (error) {
    deps.logger.error('DNS proxy could not open an upstream UDP socket', { error });
    settle(null);
    return { done, abort: () => undefined };
  }
  const opened = socket;
  timer = deps.setTimer(() => {
    deps.logger.debug('DNS upstream timed out', { server, transport: 'udp' });
    settle(null);
  }, timeoutMs);
  opened.onError((error) => {
    deps.logger.debug('DNS upstream UDP socket error', { server, error });
    settle(null);
  });
  opened.onMessage((message, from) => {
    if (settled) return;
    if (from.address !== server || from.port !== UPSTREAM_PORT) {
      deps.logger.debug('DNS upstream reply from an unexpected source dropped', { server });
      return;
    }
    if (message.length > MAX_UDP_RESPONSE_BYTES || readId(message) !== id) {
      deps.logger.debug('DNS upstream reply dropped (size or ID)', { server, bytes: message.length });
      return;
    }
    const parsed = parseResponse(message, request.question);
    if (parsed === null) {
      deps.logger.debug('DNS upstream reply dropped (malformed or other question)', { server });
      return;
    }
    settle({ reply: Buffer.from(message), parsed, server });
  });
  opened.send(outgoing, UPSTREAM_PORT, server, (error) => {
    if (error === null) return;
    deps.logger.debug('DNS upstream UDP send failed', { server, error });
    settle(null);
  });
  return {
    done,
    abort: () => {
      settle(null);
    },
  };
};

/**
 * One server over TCP: a new connection to `server:53` and a new ID. The
 * reply frame may arrive in any number of chunks; its ID and question must
 * match, otherwise this server has failed. At most `MAX_TCP_RESPONSE_BYTES`.
 */
const tcpAttempt = (server: string, request: UpstreamRequest, timeoutMs: number, deps: UpstreamDeps): Attempt => {
  let finish: (value: UpstreamResult | null) => void = () => undefined;
  const done = new Promise<UpstreamResult | null>((resolve) => {
    finish = resolve;
  });
  const id = deps.randomId();
  const outgoing = withId(request.query, id);
  let connection: TcpConnectionLike | null = null;
  let timer: unknown = null;
  let settled = false;
  let buffered = Buffer.alloc(0);

  const settle = (value: UpstreamResult | null): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) deps.clearTimer(timer);
    connection?.destroy();
    finish(value);
  };

  if (outgoing === null) {
    settle(null);
    return { done, abort: () => undefined };
  }
  try {
    connection = deps.sockets.tcpConnect(server, UPSTREAM_PORT);
  } catch (error) {
    deps.logger.error('DNS proxy could not open an upstream TCP connection', { error });
    settle(null);
    return { done, abort: () => undefined };
  }
  const opened = connection;
  timer = deps.setTimer(() => {
    deps.logger.debug('DNS upstream timed out', { server, transport: 'tcp' });
    settle(null);
  }, timeoutMs);
  opened.onError((error) => {
    deps.logger.debug('DNS upstream TCP error', { server, error });
    settle(null);
  });
  opened.onClose(() => {
    settle(null);
  });
  opened.onData((chunk) => {
    if (settled) return;
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 2) return;
    const length = buffered.readUInt16BE(0);
    if (length > MAX_TCP_RESPONSE_BYTES || buffered.length > length + 2) {
      deps.logger.debug('DNS upstream TCP reply has trailing or oversized data', { server });
      settle(null);
      return;
    }
    if (buffered.length < length + 2) return;
    const message = buffered.subarray(2);
    const parsed = readId(message) === id ? parseResponse(message, request.question) : null;
    if (parsed === null) {
      deps.logger.debug('DNS upstream TCP reply rejected (ID, malformed or other question)', { server });
      settle(null);
      return;
    }
    settle({ reply: Buffer.from(message), parsed, server });
  });
  opened.write(frame(outgoing));
  return {
    done,
    abort: () => {
      settle(null);
    },
  };
};

/**
 * Forwards one query: servers in order, all of them within
 * `UPSTREAM_TOTAL_TIMEOUT_MS`. Every server but the last gets at most
 * `UPSTREAM_SERVER_TIMEOUT_MS` before failover; the last one keeps waiting
 * for whatever is left of the total budget (a single slow server that answers
 * in 3-4 s is still an answer, not a SERVFAIL). The first accepted reply wins,
 * whatever its RCODE (NXDOMAIN is an answer, not a failure).
 */
export const queryUpstream = (request: UpstreamRequest, deps: UpstreamDeps): UpstreamCall => {
  let current: Attempt | null = null;
  // An object, not a `let`: the flag is set from timer and cancel callbacks.
  const flags = { stopped: false };

  // The total budget cuts whichever attempt is running; a server that fails
  // fast leaves the rest of the budget to the next one.
  const totalTimer = deps.setTimer(() => {
    flags.stopped = true;
    current?.abort();
  }, UPSTREAM_TOTAL_TIMEOUT_MS);

  const result = (async (): Promise<UpstreamResult | null> => {
    try {
      const last = request.servers.length - 1;
      for (const [index, server] of request.servers.entries()) {
        if (flags.stopped) break;
        // The last server has nothing to fail over to: its own timer is the
        // total budget, which `totalTimer` cuts at the real deadline.
        const timeoutMs = index === last ? UPSTREAM_TOTAL_TIMEOUT_MS : UPSTREAM_SERVER_TIMEOUT_MS;
        const attempt =
          request.transport === 'udp'
            ? udpAttempt(server, request, timeoutMs, deps)
            : tcpAttempt(server, request, timeoutMs, deps);
        current = attempt;
        const outcome = await attempt.done;
        current = null;
        if (outcome !== null) return outcome;
      }
      return null;
    } finally {
      deps.clearTimer(totalTimer);
    }
  })();

  return {
    result,
    cancel: () => {
      flags.stopped = true;
      current?.abort();
    },
  };
};
