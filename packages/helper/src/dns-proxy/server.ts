/**
 * The loopback DNS forwarding proxy (ADR-002): UDP and TCP on
 * `127.0.0.1:954` (`DNS_PROXY`). It forwards each query unchanged (only the
 * 2-byte ID is swapped) to one upstream server, and returns the reply byte for
 * byte with the client's ID restored. For a name a rule owns (a wildcard, or
 * an exact domain rule under a wildcard's base) it first hands the A answers
 * to `learn` and waits — at most `LEARN_WAIT_MS` — so the
 * host routes are in place before the client connects.
 *
 * Root runs this, and it is the helper's only network listener, so every
 * input is bounded (`limits.ts`) and the module never throws: a bind failure
 * is a status (`unavailable`, retried), a bad packet is dropped, a broken
 * upstream reply becomes SERVFAIL. Queried names and addresses are logged at
 * `debug` only.
 *
 * AAAA and every other type are forwarded and returned unchanged, never
 * learned: IPv6 routes are out of scope (an IPv6-preferring app may still
 * leave over the default route — ADR-002 §6).
 */

import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

import { DNS_PROXY } from '@routeswitch/shared';

import type { ClearTimer, SetTimer } from '../dns';
import type { Logger } from '../logger';
import {
  LEARN_WAIT_MS,
  MAX_CONCURRENT_UPSTREAM,
  MAX_QUERIES_PER_TCP_CONNECTION,
  MAX_QUERY_BYTES,
  MAX_TCP_CONNECTIONS,
  TCP_IDLE_MS,
  bindRetryDelay,
  createTokenBucket,
  isLoopbackSource,
} from './limits';
import {
  DNS_HEADER_BYTES,
  QCLASS_IN,
  QTYPE_A,
  RCODE_NOERROR,
  cnameChainAddresses,
  parseQuery,
  refused,
  servfail,
  withId,
  type ParsedQuery,
  type ParsedResponse,
} from './packet';
import {
  queryUpstream,
  tcpFrame,
  type QueryRoute,
  type SocketFactory,
  type TcpConnectionLike,
  type TcpServerLike,
  type Transport,
  type UdpSocketLike,
  type UpstreamCall,
} from './upstream';

export type DnsProxyState = 'stopped' | 'starting' | 'running' | 'unavailable';

export interface DnsProxyStats {
  /** Queries answered with an upstream reply. */
  readonly forwarded: number;
  /** SERVFAIL replies the proxy made (no server answered, or no server at all). */
  readonly servfail: number;
  /** REFUSED replies (name under no wildcard base, or over a TCP limit). */
  readonly refused: number;
  /** Packets dropped without a reply (malformed, not loopback, UDP over a limit). */
  readonly dropped: number;
  /** Replies sent before `learn` finished (`LEARN_WAIT_MS` passed). */
  readonly learnTimeouts: number;
}

export interface DnsProxyStatus {
  readonly state: DnsProxyState;
  readonly address: string;
  readonly port: number;
  /** Error code of the last failed bind (`EADDRINUSE`, …) while `unavailable`; null otherwise. */
  readonly lastError: string | null;
  readonly stats: DnsProxyStats;
}

/**
 * Hands learned addresses to the engine — the shape of TASK-DELTA-27
 * `engine.learn(ruleId, addresses, ttlSec)`, so the daemon passes it as is:
 * the promise settles once the routes are in place or refused; its result is
 * the engine's business. `ttlSec` is the smallest TTL of the records the
 * addresses came from (the engine clamps it). The queried name stays in the
 * proxy (debug log only).
 */
export type LearnFn = (ruleId: string, addresses: readonly string[], ttlSec: number) => Promise<unknown>;

export interface DnsProxyOptions {
  readonly logger: Logger;
  /** What to do with a name (`routeQuery` over the current config); null → REFUSED. */
  readonly resolveRule: (qname: string) => QueryRoute | null;
  readonly learn: LearnFn;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  /** Monotonic milliseconds for the rate limit; defaults to `performance.now`. */
  readonly monotonicNow?: (() => number) | undefined;
  /** Defaults to real `node:dgram` / `node:net` sockets; tests pass fakes. */
  readonly sockets?: SocketFactory | undefined;
  /** Upstream message IDs; defaults to `crypto.randomInt`. */
  readonly randomId?: (() => number) | undefined;
  /** Listening port; the address is always `DNS_PROXY.address` (loopback). Default `DNS_PROXY.port`. */
  readonly port?: number | undefined;
  /** Called on every state change (the engine marks wildcard rules `dns-proxy-unavailable`). */
  readonly onStatus?: ((status: DnsProxyStatus) => void) | undefined;
}

export interface DnsProxy {
  /** Binds UDP and TCP; on failure the state is `unavailable` and binding is retried. Never rejects. */
  start(): Promise<void>;
  /** Closes the listeners, every client connection and every upstream query; cancels the retry. Never rejects. */
  stop(): Promise<void>;
  status(): DnsProxyStatus;
}

const errorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'EUNKNOWN';
};

/** Smallest TTL of the A records whose address was learned. */
const learnTtl = (parsed: ParsedResponse, addresses: readonly string[]): number => {
  let ttl: number | null = null;
  for (const answer of parsed.answers) {
    if (answer.type === 'A' && addresses.includes(answer.data)) ttl = ttl === null ? answer.ttl : Math.min(ttl, answer.ttl);
  }
  return ttl ?? 0;
};

export const createDnsProxy = (options: DnsProxyOptions): DnsProxy => {
  const { logger, setTimer, clearTimer } = options;
  const log = logger.child({ component: 'dns-proxy' });
  const sockets = options.sockets ?? createNodeSocketFactory();
  const randomId = options.randomId ?? (() => randomInt(0, 0x1_0000));
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const address = DNS_PROXY.address;
  const port = options.port ?? DNS_PROXY.port;

  let state: DnsProxyState = 'stopped';
  let lastError: string | null = null;
  let failures = 0;
  let retryTimer: unknown = null;
  /** Bumped by `stop()`: work started under an older generation sends nothing. */
  let generation = 0;
  let udp: UdpSocketLike | null = null;
  let tcp: TcpServerLike | null = null;
  const connections = new Set<ClientConnection>();
  const upstreamCalls = new Set<UpstreamCall>();
  /** Replies waiting on `learn`: `stop()` releases them. */
  const learnWaits = new Set<() => void>();
  let bucket = createTokenBucket(monotonicNow);
  const stats = { forwarded: 0, servfail: 0, refused: 0, dropped: 0, learnTimeouts: 0 };

  const status = (): DnsProxyStatus => ({ state, address, port, lastError, stats: { ...stats } });

  const setState = (next: DnsProxyState, error: string | null): void => {
    if (state === next && lastError === error) return;
    state = next;
    lastError = error;
    try {
      options.onStatus?.(status());
    } catch (failure) {
      log.error('DNS proxy status listener failed', { error: failure });
    }
  };

  // -------------------------------------------------------------------------
  // One query, either transport

  /** Waits for `learn`, at most `LEARN_WAIT_MS`; never rejects. */
  const learnBeforeReply = async (ruleId: string, query: ParsedQuery, parsed: ParsedResponse): Promise<void> => {
    if (query.qtype !== QTYPE_A || query.qclass !== QCLASS_IN || parsed.rcode !== RCODE_NOERROR || parsed.tc) return;
    const addresses = cnameChainAddresses(query.qname, parsed.answers);
    if (addresses.length === 0) return;
    log.debug('DNS answer to learn', { ruleId, name: query.qname, addresses });

    let timer: unknown = null;
    let release: () => void = () => undefined;
    const outcome = await new Promise<'done' | 'failed' | 'timeout' | 'stopped'>((resolve) => {
      timer = setTimer(() => {
        resolve('timeout');
      }, LEARN_WAIT_MS);
      release = () => {
        resolve('stopped');
      };
      learnWaits.add(release);
      let pending: Promise<unknown>;
      try {
        pending = options.learn(ruleId, addresses, learnTtl(parsed, addresses));
      } catch (error) {
        pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      pending.then(
        () => {
          resolve('done');
        },
        (error: unknown) => {
          log.error('Learning routes for a DNS answer failed', { ruleId, error });
          resolve('failed');
        },
      );
    });
    clearTimer(timer);
    learnWaits.delete(release);
    if (outcome === 'timeout') {
      stats.learnTimeouts += 1;
      log.warn('DNS reply sent before its learned routes were in place', { ruleId, waitedMs: LEARN_WAIT_MS });
    }
  };

  /**
   * The reply for one raw query, or null for none. `transport` decides how
   * the limits answer: UDP drops silently, TCP says REFUSED. Never rejects.
   */
  const answer = async (raw: Buffer, transport: Transport): Promise<Buffer | null> => {
    const overLimit = (): Buffer | null => {
      if (transport === 'udp') {
        stats.dropped += 1;
        return null;
      }
      stats.refused += 1;
      return refused(raw);
    };

    if (!bucket.take()) {
      log.debug('DNS query over the rate limit', { transport });
      return overLimit();
    }
    const query = raw.length <= MAX_QUERY_BYTES ? parseQuery(raw) : null;
    if (query === null) {
      stats.dropped += 1;
      log.debug('Malformed or oversized DNS query dropped', { transport, bytes: raw.length });
      return null;
    }

    let route: QueryRoute | null;
    try {
      route = options.resolveRule(query.qname);
    } catch (error) {
      log.error('DNS proxy rule lookup failed', { error });
      stats.servfail += 1;
      return servfail(raw);
    }
    if (route === null) {
      log.debug('DNS query for a name outside every wildcard base refused', { name: query.qname });
      stats.refused += 1;
      return refused(raw);
    }
    if (route.servers.length === 0) {
      log.debug('No usable upstream DNS server', { name: query.qname, route: route.kind });
      stats.servfail += 1;
      return servfail(raw);
    }
    if (upstreamCalls.size >= MAX_CONCURRENT_UPSTREAM) {
      log.debug('DNS query over the concurrent upstream limit', { transport });
      return overLimit();
    }

    const call = queryUpstream(
      { query: raw, question: query, servers: route.servers, transport },
      { sockets, setTimer, clearTimer, randomId, logger: log },
    );
    upstreamCalls.add(call);
    const result = await call.result;
    upstreamCalls.delete(call);
    if (result === null) {
      log.debug('No upstream DNS answer', { name: query.qname });
      stats.servfail += 1;
      return servfail(raw);
    }
    if (route.kind === 'learn') await learnBeforeReply(route.ruleId, query, result.parsed);

    const reply = withId(result.reply, query.id);
    if (reply === null) {
      stats.servfail += 1;
      return servfail(raw);
    }
    stats.forwarded += 1;
    log.debug('DNS query forwarded', { name: query.qname, qtype: query.qtype, server: result.server, rcode: result.parsed.rcode });
    return reply;
  };

  const safeAnswer = (raw: Buffer, transport: Transport): Promise<Buffer | null> =>
    answer(raw, transport).catch((error: unknown) => {
      log.error('DNS proxy failed to answer a query', { error });
      return servfail(raw);
    });

  // -------------------------------------------------------------------------
  // UDP

  const onDatagram = (socket: UdpSocketLike, message: Buffer, from: { address: string; port: number }): void => {
    if (!isLoopbackSource(from.address)) {
      stats.dropped += 1;
      log.debug('DNS datagram from a non-loopback source dropped');
      return;
    }
    const started = generation;
    void safeAnswer(message, 'udp').then((reply) => {
      if (reply === null || started !== generation) return;
      socket.send(reply, from.port, from.address, (error) => {
        if (error !== null) log.debug('DNS reply could not be sent', { transport: 'udp', error });
      });
    });
  };

  // -------------------------------------------------------------------------
  // TCP

  interface ClientConnection {
    readonly socket: TcpConnectionLike;
    close(): void;
  }

  const onConnection = (socket: TcpConnectionLike): void => {
    if (!isLoopbackSource(socket.remoteAddress) || connections.size >= MAX_TCP_CONNECTIONS) {
      stats.dropped += 1;
      log.debug('DNS TCP connection refused', { reason: connections.size >= MAX_TCP_CONNECTIONS ? 'limit' : 'source' });
      socket.destroy();
      return;
    }
    const started = generation;
    let buffered = Buffer.alloc(0);
    let received = 0;
    let pending = 0;
    let draining = false;
    let closed = false;
    let idleTimer: unknown = null;

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (idleTimer !== null) clearTimer(idleTimer);
      idleTimer = null;
      connections.delete(client);
      socket.destroy();
    };
    const client: ClientConnection = { socket, close };

    /** Only a whole query or a reply counts as activity: trickled bytes do not keep a connection open. */
    const armIdle = (): void => {
      if (idleTimer !== null) clearTimer(idleTimer);
      idleTimer = setTimer(() => {
        idleTimer = null;
        if (pending > 0) {
          armIdle();
          return;
        }
        log.debug('Idle DNS TCP connection closed');
        close();
      }, TCP_IDLE_MS);
    };

    const handleFrame = (frame: Buffer): void => {
      pending += 1;
      void safeAnswer(frame, 'tcp').then((reply) => {
        pending -= 1;
        if (closed || started !== generation) return;
        if (reply !== null) {
          socket.write(tcpFrame(reply));
          armIdle();
        }
        if (draining && pending === 0) close();
      });
    };

    socket.onData((chunk) => {
      if (closed || draining) return;
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const length = buffered.readUInt16BE(0);
        if (length < DNS_HEADER_BYTES || length > MAX_QUERY_BYTES) {
          stats.dropped += 1;
          log.debug('DNS TCP frame out of bounds; connection closed', { bytes: length });
          close();
          return;
        }
        if (buffered.length < length + 2) break;
        const frame = Buffer.from(buffered.subarray(2, length + 2));
        buffered = buffered.subarray(length + 2);
        received += 1;
        if (received > MAX_QUERIES_PER_TCP_CONNECTION) {
          stats.dropped += 1;
          log.debug('DNS TCP connection reached its query limit');
          draining = true;
          buffered = Buffer.alloc(0);
          if (pending === 0) close();
          return;
        }
        armIdle();
        handleFrame(frame);
      }
    });
    socket.onError((error) => {
      log.debug('DNS TCP client connection error', { error });
      close();
    });
    socket.onClose(close);
    connections.add(client);
    armIdle();
  };

  // -------------------------------------------------------------------------
  // Lifecycle

  const closeListeners = (): void => {
    udp?.close();
    tcp?.close();
    udp = null;
    tcp = null;
  };

  const scheduleRetry = (): void => {
    const delay = bindRetryDelay(failures);
    retryTimer = setTimer(() => {
      retryTimer = null;
      void bind();
    }, delay);
  };

  const bind = async (): Promise<void> => {
    const started = generation;
    setState('starting', lastError);
    let udpSocket: UdpSocketLike | null = null;
    let tcpServer: TcpServerLike | null = null;
    try {
      udpSocket = sockets.udp();
      tcpServer = sockets.tcpServer();
      const boundUdp = udpSocket;
      const boundTcp = tcpServer;
      boundUdp.onMessage((message, from) => {
        onDatagram(boundUdp, message, from);
      });
      boundUdp.onError((error) => {
        log.error('DNS proxy UDP socket error', { error });
      });
      boundTcp.onConnection(onConnection);
      boundTcp.onError((error) => {
        log.error('DNS proxy TCP listener error', { error });
      });
      await boundUdp.bind(port, address);
      await boundTcp.listen(port, address);
    } catch (error) {
      udpSocket?.close();
      tcpServer?.close();
      if (started !== generation) return;
      failures += 1;
      const code = errorCode(error);
      const retryInMs = bindRetryDelay(failures);
      log.warn('DNS proxy could not listen; wildcard domains are unavailable', { code, port, retryInMs });
      setState('unavailable', code);
      scheduleRetry();
      return;
    }
    if (started !== generation) {
      udpSocket.close();
      tcpServer.close();
      return;
    }
    udp = udpSocket;
    tcp = tcpServer;
    failures = 0;
    bucket = createTokenBucket(monotonicNow);
    log.info('DNS proxy listening', { address, port });
    setState('running', null);
  };

  return {
    start: async () => {
      if (state !== 'stopped') return;
      await bind();
    },
    stop: () => {
      generation += 1;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      for (const release of [...learnWaits]) release();
      for (const call of upstreamCalls) call.cancel();
      upstreamCalls.clear();
      for (const connection of [...connections]) connection.close();
      const wasListening = udp !== null || tcp !== null;
      closeListeners();
      failures = 0;
      if (wasListening) log.info('DNS proxy stopped');
      setState('stopped', null);
      return Promise.resolve();
    },
    status,
  };
};

// ---------------------------------------------------------------------------
// Real sockets

const listenOnce = (
  target: { once(event: 'error', listener: (error: Error) => void): unknown; removeListener(event: 'error', listener: (error: Error) => void): unknown },
  start: (onListening: () => void) => void,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    target.once('error', onError);
    start(() => {
      target.removeListener('error', onError);
      resolve();
    });
  });

const wrapConnection = (socket: Socket): TcpConnectionLike => ({
  get remoteAddress() {
    return socket.remoteAddress;
  },
  write: (data) => {
    socket.write(data);
  },
  onData: (listener) => {
    socket.on('data', listener);
  },
  onClose: (listener) => {
    socket.on('close', listener);
  },
  onError: (listener) => {
    socket.on('error', listener);
  },
  destroy: () => {
    socket.destroy();
  },
});

/** `node:dgram` / `node:net` behind `SocketFactory`. Only the helper process calls this. */
export const createNodeSocketFactory = (): SocketFactory => ({
  udp: () => {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    let open = true;
    socket.on('close', () => {
      open = false;
    });
    return {
      bind: (bindPort, bindAddress) =>
        listenOnce(socket, (onListening) => {
          socket.bind({ port: bindPort, address: bindAddress, exclusive: true }, onListening);
        }),
      send: (data, sendPort, sendAddress, onSent) => {
        socket.send(data, sendPort, sendAddress, (error) => {
          onSent(error ?? null);
        });
      },
      onMessage: (listener) => {
        socket.on('message', (message, from) => {
          listener(message, { address: from.address, port: from.port });
        });
      },
      onError: (listener) => {
        socket.on('error', listener);
      },
      close: () => {
        // `close()` throws ERR_SOCKET_DGRAM_NOT_RUNNING on a socket that is already closed: nothing is left to release then.
        if (open) {
          open = false;
          socket.close();
        }
      },
    };
  },
  tcpServer: () => {
    const server = createServer({ pauseOnConnect: false });
    return {
      listen: (listenPort, listenAddress) =>
        listenOnce(server, (onListening) => {
          server.listen({ port: listenPort, host: listenAddress, exclusive: true }, onListening);
        }),
      onConnection: (listener) => {
        server.on('connection', (socket) => {
          listener(wrapConnection(socket));
        });
      },
      onError: (listener) => {
        server.on('error', listener);
      },
      close: () => {
        server.close();
      },
    };
  },
  tcpConnect: (connectAddress, connectPort) => wrapConnection(createConnection({ host: connectAddress, port: connectPort })),
});
