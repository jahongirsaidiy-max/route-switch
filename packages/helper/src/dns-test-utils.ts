import type { DnsResolverFactory, DnsResolverOptions } from './dns';
import type {
  RemoteInfo,
  SocketFactory,
  TcpConnectionLike,
  TcpServerLike,
  UdpSocketLike,
} from './dns-proxy/upstream';

/**
 * Test doubles for the DNS module: a manual clock with timers and a resolver
 * factory that never touches the network. Not exported from `index.ts`.
 */

export interface FakeScheduler {
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly now: () => Date;
  /** Timers that are set and have neither fired nor been cleared. */
  pending(): number;
  /** Delays of the pending timers, relative to the current time, ascending. */
  delays(): number[];
  /** Every `setTimer` call so far. */
  readonly scheduled: number[];
  /** Moves the clock forward and fires every timer that falls due, in order. */
  advance(ms: number): void;
}

export const createFakeScheduler = (start: Date): FakeScheduler => {
  let current = start.getTime();
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  const scheduled: number[] = [];

  const earliest = (limit: number): number | null => {
    let found: number | null = null;
    for (const [id, timer] of timers) {
      if (timer.at > limit) continue;
      const best = found === null ? undefined : timers.get(found);
      if (best === undefined || timer.at < best.at) found = id;
    }
    return found;
  };

  return {
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      scheduled.push(delayMs);
      timers.set(id, { at: current + delayMs, callback });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
    now: () => new Date(current),
    pending: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.at - current).sort((a, b) => a - b),
    scheduled,
    advance: (ms) => {
      const target = current + ms;
      for (let id = earliest(target); id !== null; id = earliest(target)) {
        const timer = timers.get(id);
        timers.delete(id);
        if (timer === undefined) continue;
        current = Math.max(current, timer.at);
        timer.callback();
      }
      current = target;
    },
  };
};

/** Lets every promise callback that is ready run, and the ones they make ready. */
export const flush = async (rounds = 50): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
};

export const dnsError = (code: string): Error => Object.assign(new Error(`query${code}`), { code });

export interface FakeLookup {
  readonly hostname: string;
  /** What `setServers` was called with before the query; null when it was not called. */
  readonly servers: readonly string[] | null;
  readonly options: DnsResolverOptions;
  /** Index of the resolver instance that ran the query. */
  readonly resolver: number;
  cancelled: boolean;
  settled: boolean;
  answer(records: unknown): void;
  fail(code: string): void;
}

export interface FakeDns {
  readonly factory: DnsResolverFactory;
  /** Every query, in the order it was started. */
  readonly lookups: FakeLookup[];
  /** Resolver instances created. */
  created: number;
  /** Queries that are neither answered nor cancelled. */
  open(): FakeLookup[];
  /**
   * When set, a query is settled as soon as it starts: with the returned
   * records, or as a failure when an `Error` is returned. `undefined` leaves
   * the query open.
   */
  auto: ((hostname: string, servers: readonly string[] | null) => unknown) | null;
  /** When true, `cancel()` is recorded but the query stays open, so it can still answer late. */
  ignoreCancel: boolean;
}

export const createFakeDns = (): FakeDns => {
  const fake: FakeDns = {
    lookups: [],
    created: 0,
    auto: null,
    ignoreCancel: false,
    open: () => fake.lookups.filter((lookup) => !lookup.settled && !lookup.cancelled),
    factory: (options) => {
      const index = fake.created;
      fake.created += 1;
      let servers: readonly string[] | null = null;
      let running: FakeLookup | null = null;
      let rejectRunning: ((error: Error) => void) | null = null;
      return {
        setServers: (list) => {
          servers = [...list];
        },
        resolve4: (hostname) =>
          new Promise<unknown>((resolve, reject) => {
            const lookup: FakeLookup = {
              hostname,
              servers,
              options,
              resolver: index,
              cancelled: false,
              settled: false,
              answer: (records) => {
                lookup.settled = true;
                resolve(records);
              },
              fail: (code) => {
                lookup.settled = true;
                reject(dnsError(code));
              },
            };
            running = lookup;
            rejectRunning = reject;
            fake.lookups.push(lookup);
            const automatic = fake.auto?.(hostname, servers);
            if (automatic instanceof Error) {
              lookup.settled = true;
              reject(automatic);
            } else if (automatic !== undefined) {
              lookup.answer(automatic);
            }
          }),
        cancel: () => {
          if (running === null || running.settled) return;
          running.cancelled = true;
          if (!fake.ignoreCancel) rejectRunning?.(dnsError('ECANCELLED'));
        },
      };
    },
  };
  return fake;
};

// ---------------------------------------------------------------------------
// Fake sockets for the DNS proxy (`dns-proxy/*`): no real port is ever opened.

export interface FakeSent {
  readonly data: Buffer;
  readonly port: number;
  readonly address: string;
}

export interface FakeUdpSocket extends UdpSocketLike {
  /** Where `bind` succeeded; null when it was not called or failed. */
  bound: { readonly port: number; readonly address: string } | null;
  readonly sent: FakeSent[];
  closed: boolean;
  /** A datagram arrives at this socket. */
  deliver(message: Uint8Array, from: RemoteInfo): void;
  /** The socket reports an error. */
  fail(error: Error): void;
}

export interface FakeTcpConnection extends TcpConnectionLike {
  /** For a dialled connection: where it goes; null for an accepted one. */
  readonly target: RemoteInfo | null;
  readonly written: Buffer[];
  destroyed: boolean;
  /** Bytes arrive from the other side. */
  push(chunk: Uint8Array): void;
  /** The other side closes. */
  hangUp(): void;
  fail(error: Error): void;
  /** All bytes written so far, concatenated. */
  output(): Buffer;
}

export interface FakeTcpServer extends TcpServerLike {
  listening: { readonly port: number; readonly address: string } | null;
  closed: boolean;
  /** A client connects; returns the server's side of the connection. */
  accept(remoteAddress?: string): FakeTcpConnection;
}

export interface FakeNetwork {
  readonly factory: SocketFactory;
  /** Every UDP socket created, in order (the listener first, then one per upstream query). */
  readonly udpSockets: FakeUdpSocket[];
  readonly tcpServers: FakeTcpServer[];
  /** Upstream TCP connections, in order. */
  readonly dialled: FakeTcpConnection[];
  /** Error codes for the next `bind` / `listen` calls, consumed in order. */
  readonly bindErrors: string[];
  /** Error code for the next UDP `send` (consumed once). */
  sendError: string | null;
}

const errorWithCode = (code: string): Error => Object.assign(new Error(code), { code });

const createFakeConnection = (remoteAddress: string | undefined, target: RemoteInfo | null): FakeTcpConnection => {
  const dataListeners: ((chunk: Buffer) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const connection: FakeTcpConnection = {
    remoteAddress,
    target,
    written: [],
    destroyed: false,
    write: (data) => {
      if (!connection.destroyed) connection.written.push(Buffer.from(data));
    },
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onError: (listener) => {
      errorListeners.push(listener);
    },
    destroy: () => {
      if (connection.destroyed) return;
      connection.destroyed = true;
      for (const listener of closeListeners) listener();
    },
    push: (chunk) => {
      if (connection.destroyed) return;
      for (const listener of dataListeners) listener(Buffer.from(chunk));
    },
    hangUp: () => {
      connection.destroy();
    },
    fail: (error) => {
      for (const listener of errorListeners) listener(error);
    },
    output: () => Buffer.concat(connection.written),
  };
  return connection;
};

export const createFakeNetwork = (): FakeNetwork => {
  const network: FakeNetwork = {
    udpSockets: [],
    tcpServers: [],
    dialled: [],
    bindErrors: [],
    sendError: null,
    factory: {
      udp: () => {
        const messageListeners: ((message: Buffer, from: RemoteInfo) => void)[] = [];
        const errorListeners: ((error: Error) => void)[] = [];
        const socket: FakeUdpSocket = {
          bound: null,
          sent: [],
          closed: false,
          bind: (port, address) => {
            const code = network.bindErrors.shift();
            if (code !== undefined) return Promise.reject(errorWithCode(code));
            socket.bound = { port, address };
            return Promise.resolve();
          },
          send: (data, port, address, onSent) => {
            const code = network.sendError;
            network.sendError = null;
            if (code !== null) {
              onSent(errorWithCode(code));
              return;
            }
            socket.sent.push({ data: Buffer.from(data), port, address });
            onSent(null);
          },
          onMessage: (listener) => {
      messageListeners.push(listener);
    },
          onError: (listener) => {
      errorListeners.push(listener);
    },
          close: () => {
            socket.closed = true;
          },
          deliver: (message, from) => {
            if (socket.closed) return;
            for (const listener of messageListeners) listener(Buffer.from(message), from);
          },
          fail: (error) => {
            for (const listener of errorListeners) listener(error);
          },
        };
        network.udpSockets.push(socket);
        return socket;
      },
      tcpServer: () => {
        const connectionListeners: ((connection: TcpConnectionLike) => void)[] = [];
        const server: FakeTcpServer = {
          listening: null,
          closed: false,
          listen: (port, address) => {
            const code = network.bindErrors.shift();
            if (code !== undefined) return Promise.reject(errorWithCode(code));
            server.listening = { port, address };
            return Promise.resolve();
          },
          onConnection: (listener) => {
      connectionListeners.push(listener);
    },
          onError: () => undefined,
          close: () => {
            server.closed = true;
          },
          accept: (remoteAddress = '127.0.0.1') => {
            const connection = createFakeConnection(remoteAddress, null);
            for (const listener of connectionListeners) listener(connection);
            return connection;
          },
        };
        network.tcpServers.push(server);
        return server;
      },
      tcpConnect: (address, port) => {
        const connection = createFakeConnection(address, { address, port });
        network.dialled.push(connection);
        return connection;
      },
    },
  };
  return network;
};

/** Splits a TCP byte stream into its length-prefixed DNS messages (a trailing partial frame is left out). */
export const tcpMessages = (stream: Buffer): Buffer[] => {
  const messages: Buffer[] = [];
  let offset = 0;
  while (offset + 2 <= stream.length) {
    const length = stream.readUInt16BE(offset);
    if (offset + 2 + length > stream.length) break;
    messages.push(stream.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return messages;
};
