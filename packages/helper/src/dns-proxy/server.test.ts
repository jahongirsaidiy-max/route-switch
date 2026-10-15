import { describe, expect, it, vi } from 'vitest';

import { DNS_PROXY } from '@routeswitch/shared';

import {
  createFakeNetwork,
  createFakeScheduler,
  flush,
  tcpMessages,
  type FakeNetwork,
  type FakeTcpConnection,
  type FakeUdpSocket,
} from '../dns-test-utils';
import type { Engine } from '../engine';
import { createLogger, createMemorySink, type LogEntry } from '../logger';
import {
  MAX_CONCURRENT_UPSTREAM,
  MAX_QUERIES_PER_TCP_CONNECTION,
  MAX_QUERY_BYTES,
  MAX_TCP_CONNECTIONS,
  RATE_BURST,
} from './limits';
import { aRecord, buildQuery, buildResponse, cnameRecord, encodeName, header, pointer, question, rr } from './packet-fixtures';
import { RCODE_REFUSED, RCODE_SERVFAIL } from './packet';
import { createDnsProxy, createNodeSocketFactory, type DnsProxyStatus, type LearnFn } from './server';
import { tcpFrame, type QueryRoute } from './upstream';

// Test guard: no test in this file may open a real socket. The default
// (`node:dgram` / `node:net`) factory throws before touching the OS; the
// control tests below prove that the default path really reaches the trap.
vi.mock('node:dgram', () => {
  const trap = (): never => {
    throw Object.assign(new Error('ETESTNETGUARD: a test tried to open a real UDP socket'), { code: 'ETESTNETGUARD' });
  };
  return { createSocket: trap, default: { createSocket: trap } };
});
vi.mock('node:net', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:net')>();
  const trap = (): never => {
    throw Object.assign(new Error('ETESTNETGUARD: a test tried to open a real TCP socket'), { code: 'ETESTNETGUARD' });
  };
  return { ...original, createServer: trap, createConnection: trap, default: { ...original, createServer: trap, createConnection: trap } };
});

// Compile-time: the engine's `learn` (TASK-DELTA-27) plugs into the proxy as is.
const ENGINE_LEARN_FITS: Engine['learn'] extends LearnFn ? true : never = true;

const RULE = '11111111-1111-4111-8111-111111111111';
const NAME = 'app.corp.local';
const CLIENT = { address: '127.0.0.1', port: 50_000 } as const;
const UPSTREAM = '10.0.0.1';
const PORT = 15_354;

const defaultRoute = (qname: string): QueryRoute | null => {
  if (qname === 'corp.local') return { kind: 'passthrough', servers: ['192.168.1.1'] };
  if (qname.endsWith('.corp.local')) return { kind: 'learn', ruleId: RULE, servers: [UPSTREAM, '10.0.0.2'] };
  return null;
};

interface Harness {
  readonly network: FakeNetwork;
  readonly scheduler: ReturnType<typeof createFakeScheduler>;
  readonly proxy: ReturnType<typeof createDnsProxy>;
  readonly logs: readonly LogEntry[];
  readonly statuses: DnsProxyStatus[];
  readonly learnCalls: { ruleId: string; addresses: readonly string[]; ttl: number }[];
  readonly events: string[];
  /** The listening UDP socket. */
  listener(): FakeUdpSocket;
  advanceClock(ms: number): void;
}

const createHarness = (
  options: {
    resolveRule?: (qname: string) => QueryRoute | null;
    learn?: LearnFn;
    port?: number | undefined;
  } = {},
): Harness => {
  const network = createFakeNetwork();
  const scheduler = createFakeScheduler(new Date(0));
  const memory = createMemorySink();
  const statuses: DnsProxyStatus[] = [];
  const learnCalls: Harness['learnCalls'] = [];
  const events: string[] = [];
  let monotonic = 0;
  let nextId = 0x4000;
  const learn: LearnFn =
    options.learn ??
    ((ruleId, addresses, ttl) => {
      events.push('learn');
      learnCalls.push({ ruleId, addresses, ttl });
      return Promise.resolve({ outcome: 'applied' });
    });
  const proxy = createDnsProxy({
    logger: createLogger({ sinks: [memory.sink] }),
    resolveRule: options.resolveRule ?? defaultRoute,
    learn,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    monotonicNow: () => monotonic,
    sockets: network.factory,
    randomId: () => {
      nextId = (nextId + 0x101) & 0xffff;
      return nextId;
    },
    port: 'port' in options ? options.port : PORT,
    onStatus: (status) => statuses.push(status),
  });
  return {
    network,
    scheduler,
    proxy,
    logs: memory.entries,
    statuses,
    learnCalls,
    events,
    listener: () => {
      const socket = network.udpSockets[0];
      if (socket === undefined) throw new Error('not started');
      return socket;
    },
    advanceClock: (ms) => {
      monotonic += ms;
      scheduler.advance(ms);
    },
  };
};

const started = async (options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> => {
  const harness = createHarness(options);
  await harness.proxy.start();
  return harness;
};

const query = (name = NAME, qtype = 1, id = 0xbeef): Buffer => buildQuery(name, qtype, { id });

const aAnswer = (id: number, name = NAME, address = '10.20.0.5', ttl = 300): Buffer =>
  buildResponse(name, [aRecord(pointer(12), address, ttl)], { id });

/** The newest upstream UDP socket (not the listener). */
const lastUpstream = (harness: Harness): FakeUdpSocket => {
  const socket = harness.network.udpSockets.at(-1);
  if (socket === undefined || socket === harness.listener()) throw new Error('no upstream socket');
  return socket;
};

const upstreamId = (socket: FakeUdpSocket): number => socket.sent[0]?.data.readUInt16BE(0) ?? -1;

/** Answers the newest upstream query with `make(id)` from `server:53`. */
const replyUpstream = async (harness: Harness, make: (id: number) => Buffer, server = UPSTREAM): Promise<Buffer> => {
  const socket = lastUpstream(harness);
  const reply = make(upstreamId(socket));
  socket.deliver(reply, { address: server, port: 53 });
  await flush();
  return reply;
};

const sendUdp = async (harness: Harness, message: Buffer, from: { address: string; port: number } = CLIENT): Promise<void> => {
  harness.listener().deliver(message, from);
  await flush();
};

const rcodeOf = (message: Buffer | undefined): number => (message === undefined ? -1 : message.readUInt16BE(2) & 0x0f);

/** Log entries above debug never carry the queried name or an answer address (ADR-002 §5). */
const expectPrivateLogs = (logs: readonly LogEntry[]): void => {
  for (const entry of logs) {
    if (entry.level === 'debug') continue;
    const text = JSON.stringify(entry);
    expect(text).not.toContain('corp.local');
    expect(text).not.toMatch(/10\.20\.0\.\d/);
  }
};

describe('createDnsProxy — lifecycle', () => {
  it('takes engine.learn as its learn dependency (type check)', () => {
    expect(ENGINE_LEARN_FITS).toBe(true);
  });

  it('listens on UDP and TCP at 127.0.0.1 only and reports running', async () => {
    const harness = await started();
    expect(harness.listener().bound).toEqual({ address: '127.0.0.1', port: PORT });
    expect(harness.network.tcpServers[0]?.listening).toEqual({ address: '127.0.0.1', port: PORT });
    expect(harness.proxy.status()).toMatchObject({ state: 'running', address: '127.0.0.1', port: PORT, lastError: null });
    expect(harness.statuses.map((status) => status.state)).toEqual(['starting', 'running']);
    expect(harness.logs.some((entry) => entry.level === 'info' && entry.msg === 'DNS proxy listening')).toBe(true);
  });

  it('defaults to DNS_PROXY (127.0.0.1:954)', async () => {
    const harness = await started({ port: undefined });
    expect(harness.listener().bound).toEqual({ address: DNS_PROXY.address, port: DNS_PROXY.port });
  });

  it('a second start while running does nothing', async () => {
    const harness = await started();
    await harness.proxy.start();
    expect(harness.network.udpSockets).toHaveLength(1);
    expect(harness.network.tcpServers).toHaveLength(1);
  });

  it('on a busy port: unavailable with the code, sockets closed, retried 5 s → 10 s → … and never throws', async () => {
    const harness = createHarness();
    harness.network.bindErrors.push('EADDRINUSE', 'EADDRINUSE');
    await expect(harness.proxy.start()).resolves.toBeUndefined();
    expect(harness.proxy.status()).toMatchObject({ state: 'unavailable', lastError: 'EADDRINUSE' });
    expect(harness.network.udpSockets[0]?.closed).toBe(true);
    expect(harness.network.tcpServers[0]?.closed).toBe(true);
    expect(harness.scheduler.delays()).toEqual([5_000]);
    const warn = harness.logs.find((entry) => entry.level === 'warn');
    expect(warn?.context).toMatchObject({ code: 'EADDRINUSE', retryInMs: 5_000 });

    harness.advanceClock(5_000);
    await flush();
    expect(harness.proxy.status().state).toBe('unavailable');
    expect(harness.scheduler.delays()).toEqual([10_000]);

    harness.advanceClock(10_000);
    await flush();
    expect(harness.proxy.status()).toMatchObject({ state: 'running', lastError: null });
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.statuses.map((status) => status.state)).toEqual([
      'starting',
      'unavailable',
      'starting',
      'unavailable',
      'starting',
      'running',
    ]);
  });

  it('closes the bound UDP socket when only TCP fails to listen', async () => {
    const harness = createHarness();
    const original = harness.network.factory.tcpServer;
    harness.network.factory.tcpServer = () => {
      const server = original();
      server.listen = () => Promise.reject(Object.assign(new Error('busy'), { code: 'EACCES' }));
      return server;
    };
    await harness.proxy.start();
    expect(harness.listener().bound).not.toBeNull();
    expect(harness.listener().closed).toBe(true);
    expect(harness.proxy.status()).toMatchObject({ state: 'unavailable', lastError: 'EACCES' });
  });

  it('stop cancels a pending bind retry', async () => {
    const harness = createHarness();
    harness.network.bindErrors.push('EADDRINUSE');
    await harness.proxy.start();
    await harness.proxy.stop();
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.proxy.status().state).toBe('stopped');
    harness.advanceClock(600_000);
    await flush();
    expect(harness.network.udpSockets).toHaveLength(1);
  });

  it('can start again after stop', async () => {
    const harness = await started();
    await harness.proxy.stop();
    await harness.proxy.start();
    expect(harness.proxy.status().state).toBe('running');
    expect(harness.network.udpSockets).toHaveLength(2);
  });

  it('a status listener that throws is logged, not raised', async () => {
    const network = createFakeNetwork();
    const scheduler = createFakeScheduler(new Date(0));
    const memory = createMemorySink();
    const proxy = createDnsProxy({
      logger: createLogger({ sinks: [memory.sink] }),
      resolveRule: defaultRoute,
      learn: () => Promise.resolve(),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      sockets: network.factory,
      port: PORT,
      onStatus: () => {
        throw new Error('listener broke');
      },
    });
    await expect(proxy.start()).resolves.toBeUndefined();
    expect(proxy.status().state).toBe('running');
    expect(memory.entries.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('createDnsProxy — test guard (no real port is ever opened)', () => {
  it('the real socket factory hits the trap in tests', () => {
    expect(() => createNodeSocketFactory().udp()).toThrow(/ETESTNETGUARD/);
    expect(() => createNodeSocketFactory().tcpServer()).toThrow(/ETESTNETGUARD/);
    expect(() => createNodeSocketFactory().tcpConnect('10.0.0.1', 53)).toThrow(/ETESTNETGUARD/);
  });

  it('a proxy without injected sockets reaches the trap and turns it into unavailable', async () => {
    const scheduler = createFakeScheduler(new Date(0));
    const proxy = createDnsProxy({
      logger: createLogger({ sinks: [] }),
      resolveRule: defaultRoute,
      learn: () => Promise.resolve(),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    await proxy.start();
    expect(proxy.status()).toMatchObject({ state: 'unavailable', lastError: 'ETESTNETGUARD' });
    await proxy.stop();
    expect(scheduler.pending()).toBe(0);
  });
});

describe('createDnsProxy — answering over UDP', () => {
  it('learns before replying, then returns the upstream reply byte for byte with the client ID', async () => {
    let releaseLearn: () => void = () => undefined;
    const harness = await started({
      learn: (ruleId, addresses, ttl) => {
        harness.learnCalls.push({ ruleId, addresses, ttl });
        return new Promise<void>((resolve) => {
          releaseLearn = resolve;
        });
      },
    });
    await sendUdp(harness, query());
    const upstream = lastUpstream(harness);
    expect(upstream.sent[0]?.address).toBe(UPSTREAM);
    expect(upstreamId(upstream)).not.toBe(0xbeef);
    const reply = await replyUpstream(harness, (id) => aAnswer(id));

    expect(harness.learnCalls).toEqual([{ ruleId: RULE, addresses: ['10.20.0.5'], ttl: 300 }]);
    expect(harness.listener().sent).toHaveLength(0);

    releaseLearn();
    await flush();
    const sent = harness.listener().sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.address).toBe(CLIENT.address);
    expect(sent[0]?.port).toBe(CLIENT.port);
    expect(sent[0]?.data.readUInt16BE(0)).toBe(0xbeef);
    expect(sent[0]?.data.subarray(2)).toEqual(reply.subarray(2));
    expect(harness.proxy.status().stats.forwarded).toBe(1);
    expectPrivateLogs(harness.logs);
  });

  it('replies anyway after 1.5 s when learning is slow, with a warn that names no host', async () => {
    const harness = await started({ learn: () => new Promise<void>(() => undefined) });
    await sendUdp(harness, query());
    await replyUpstream(harness, (id) => aAnswer(id));
    harness.advanceClock(1_499);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    harness.advanceClock(1);
    await flush();
    expect(harness.listener().sent).toHaveLength(1);
    expect(harness.proxy.status().stats.learnTimeouts).toBe(1);
    const warn = harness.logs.find((entry) => entry.level === 'warn');
    expect(warn?.context).toMatchObject({ ruleId: RULE });
    expectPrivateLogs(harness.logs);
    expect(harness.scheduler.pending()).toBe(0);
  });

  it('still replies when learn rejects or throws (logged as error)', async () => {
    for (const learn of [
      () => Promise.reject(new Error('engine down')),
      () => {
        throw new Error('sync failure');
      },
    ] as LearnFn[]) {
      const harness = await started({ learn });
      await sendUdp(harness, query());
      await replyUpstream(harness, (id) => aAnswer(id));
      expect(harness.listener().sent).toHaveLength(1);
      expect(harness.logs.some((entry) => entry.level === 'error')).toBe(true);
    }
  });

  it('learns the CNAME chain addresses with the smallest A TTL', async () => {
    const harness = await started();
    await sendUdp(harness, query());
    await replyUpstream(harness, (id) =>
      buildResponse(
        NAME,
        [
          cnameRecord(pointer(12), encodeName('edge.cdn.example'), 60),
          aRecord(encodeName('edge.cdn.example'), '10.20.0.7', 900),
          aRecord(encodeName('edge.cdn.example'), '10.20.0.8', 120),
          aRecord(encodeName('other.example'), '10.20.0.9', 5),
        ],
        { id },
      ),
    );
    expect(harness.learnCalls).toEqual([{ ruleId: RULE, addresses: ['10.20.0.7', '10.20.0.8'], ttl: 120 }]);
  });

  it('forwards AAAA (and any other type) unchanged and learns nothing', async () => {
    const harness = await started();
    await sendUdp(harness, query(NAME, 28));
    const aaaa = rr(pointer(12), 28, 1, 300, Buffer.alloc(16, 1));
    const reply = await replyUpstream(harness, (id) => buildResponse(NAME, [aaaa], { id, qtype: 28 }));
    expect(harness.learnCalls).toEqual([]);
    expect(harness.listener().sent[0]?.data.subarray(2)).toEqual(reply.subarray(2));

    await sendUdp(harness, query(NAME, 16));
    await replyUpstream(harness, (id) => buildResponse(NAME, [], { id, qtype: 16 }));
    expect(harness.learnCalls).toEqual([]);
    expect(harness.listener().sent).toHaveLength(2);
  });

  it('does not learn from NXDOMAIN, an empty answer, or a truncated reply (passed on with TC)', async () => {
    const harness = await started();
    await sendUdp(harness, query());
    await replyUpstream(harness, (id) => buildResponse(NAME, [], { id, flags: 0x8183 }));
    await sendUdp(harness, query());
    await replyUpstream(harness, (id) => buildResponse(NAME, [], { id }));
    await sendUdp(harness, query());
    const truncated = await replyUpstream(harness, (id) => buildResponse(NAME, [], { id, flags: 0x8380 }));
    expect(harness.learnCalls).toEqual([]);
    const sent = harness.listener().sent;
    expect(sent).toHaveLength(3);
    expect(rcodeOf(sent[0]?.data)).toBe(3);
    expect(sent[2]?.data.subarray(2)).toEqual(truncated.subarray(2));
    expect((sent[2]?.data.readUInt16BE(2) ?? 0) & 0x0200).toBe(0x0200);
  });

  it('learns only from a NOERROR answer to an A question, whatever the reply carries', async () => {
    const harness = await started();
    await sendUdp(harness, query(NAME, 16));
    await replyUpstream(harness, (id) => buildResponse(NAME, [aRecord(pointer(12), '10.20.0.5')], { id, qtype: 16 }));
    await sendUdp(harness, query());
    await replyUpstream(harness, (id) => buildResponse(NAME, [aRecord(pointer(12), '10.20.0.5')], { id, flags: 0x8183 }));
    expect(harness.learnCalls).toEqual([]);
    expect(harness.listener().sent).toHaveLength(2);
  });

  it('passes through without learning', async () => {
    const harness = await started();
    await sendUdp(harness, query('corp.local'));
    expect(lastUpstream(harness).sent[0]?.address).toBe('192.168.1.1');
    await replyUpstream(harness, (id) => aAnswer(id, 'corp.local'), '192.168.1.1');
    expect(harness.learnCalls).toEqual([]);
    expect(harness.listener().sent).toHaveLength(1);
  });

  it('REFUSES a name under no wildcard base without asking upstream', async () => {
    const harness = await started();
    await sendUdp(harness, query('www.example.com'));
    expect(harness.network.udpSockets).toHaveLength(1);
    expect(rcodeOf(harness.listener().sent[0]?.data)).toBe(RCODE_REFUSED);
    expect(harness.listener().sent[0]?.data.readUInt16BE(0)).toBe(0xbeef);
  });

  it('SERVFAILs when the route has no usable server or the rule lookup throws', async () => {
    const empty = await started({ resolveRule: () => ({ kind: 'learn', ruleId: RULE, servers: [] }) });
    await sendUdp(empty, query());
    expect(rcodeOf(empty.listener().sent[0]?.data)).toBe(RCODE_SERVFAIL);

    const broken = await started({
      resolveRule: () => {
        throw new Error('config gone');
      },
    });
    await sendUdp(broken, query());
    expect(rcodeOf(broken.listener().sent[0]?.data)).toBe(RCODE_SERVFAIL);
    expect(broken.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('SERVFAILs after the 5 s upstream budget', async () => {
    const harness = await started({
      resolveRule: () => ({ kind: 'learn', ruleId: RULE, servers: [UPSTREAM, '10.0.0.2', '10.0.0.3'] }),
    });
    await sendUdp(harness, query());
    harness.advanceClock(2_000);
    await flush();
    harness.advanceClock(2_000);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    harness.advanceClock(1_000);
    await flush();
    expect(rcodeOf(harness.listener().sent[0]?.data)).toBe(RCODE_SERVFAIL);
    expect(harness.scheduler.pending()).toBe(0);
  });

  it('delivers a single slow server reply at 3.4 s and learns it (Real-Mac 0.3.0)', async () => {
    const harness = await started({ resolveRule: () => ({ kind: 'learn', ruleId: RULE, servers: [UPSTREAM] }) });
    await sendUdp(harness, query());
    harness.advanceClock(3_400);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    await replyUpstream(harness, (id) => aAnswer(id));
    await flush();
    expect(harness.learnCalls).toEqual([{ ruleId: RULE, addresses: ['10.20.0.5'], ttl: 300 }]);
    const sent = harness.listener().sent;
    expect(sent).toHaveLength(1);
    expect(rcodeOf(sent[0]?.data)).toBe(0);
    expect(sent[0]?.data.readUInt16BE(0)).toBe(0xbeef);
    expect(harness.scheduler.pending()).toBe(0);
  });

  it('SERVFAILs a single silent server at 5 s, not 2 s', async () => {
    const harness = await started({ resolveRule: () => ({ kind: 'learn', ruleId: RULE, servers: [UPSTREAM] }) });
    await sendUdp(harness, query());
    harness.advanceClock(4_999);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    harness.advanceClock(1);
    await flush();
    expect(rcodeOf(harness.listener().sent[0]?.data)).toBe(RCODE_SERVFAIL);
    expect(harness.learnCalls).toEqual([]);
    expect(harness.scheduler.pending()).toBe(0);
  });

  it('never passes a reply the parser rejects to the client: SERVFAIL instead', async () => {
    const harness = await started({ resolveRule: () => ({ kind: 'learn', ruleId: RULE, servers: [UPSTREAM] }) });
    await sendUdp(harness, query());
    const broken = await replyUpstream(harness, (id) => {
      const good = aAnswer(id);
      // ANCOUNT says two answers, only one is there.
      good.writeUInt16BE(2, 6);
      return good;
    });
    harness.advanceClock(4_999);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    harness.advanceClock(1);
    await flush();
    const sent = harness.listener().sent;
    expect(sent).toHaveLength(1);
    expect(rcodeOf(sent[0]?.data)).toBe(RCODE_SERVFAIL);
    expect(sent[0]?.data.equals(broken)).toBe(false);
    expect(harness.learnCalls).toEqual([]);
  });

  it('drops a spoofed reply (wrong source, ID or question) and takes the real one', async () => {
    const harness = await started();
    await sendUdp(harness, query());
    const socket = lastUpstream(harness);
    const id = upstreamId(socket);
    socket.deliver(buildResponse(NAME, [aRecord(pointer(12), '6.6.6.6')], { id }), { address: '10.66.0.1', port: 53 });
    socket.deliver(buildResponse(NAME, [aRecord(pointer(12), '6.6.6.6')], { id: id ^ 0x8000 }), { address: UPSTREAM, port: 53 });
    socket.deliver(buildResponse('evil.corp.local', [aRecord(pointer(12), '6.6.6.6')], { id }), { address: UPSTREAM, port: 53 });
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    await replyUpstream(harness, (realId) => aAnswer(realId));
    expect(harness.learnCalls[0]?.addresses).toEqual(['10.20.0.5']);
  });

  it('drops datagrams from a non-loopback source, malformed queries and queries over 1232 bytes', async () => {
    const harness = await started();
    await sendUdp(harness, query(), { address: '10.0.0.7', port: 5000 });
    await sendUdp(harness, Buffer.from([1, 2, 3]));
    await sendUdp(harness, buildResponse(NAME, [], { id: 1 }));
    const padded = (size: number): Buffer => {
      const base = Buffer.concat([header({ id: 0xbeef, ar: 1 }), question(NAME)]);
      return Buffer.concat([base, Buffer.alloc(size - base.length)]);
    };
    await sendUdp(harness, padded(MAX_QUERY_BYTES + 1));
    expect(harness.network.udpSockets).toHaveLength(1);
    expect(harness.listener().sent).toHaveLength(0);
    expect(harness.proxy.status().stats.dropped).toBe(4);

    await sendUdp(harness, padded(MAX_QUERY_BYTES));
    expect(harness.network.udpSockets).toHaveLength(2);
  });
});

describe('createDnsProxy — limits', () => {
  it('rate: 400 at once, the 401st UDP query is dropped silently; one more after 5 ms', async () => {
    const harness = await started({ resolveRule: () => null });
    for (let i = 0; i < RATE_BURST; i += 1) harness.listener().deliver(query(NAME, 1, i), CLIENT);
    await flush();
    expect(harness.listener().sent).toHaveLength(RATE_BURST);
    await sendUdp(harness, query());
    expect(harness.listener().sent).toHaveLength(RATE_BURST);
    harness.advanceClock(5);
    await sendUdp(harness, query());
    expect(harness.listener().sent).toHaveLength(RATE_BURST + 1);
  });

  it('rate: over the limit a TCP query gets REFUSED', async () => {
    const harness = await started({ resolveRule: () => ({ kind: 'passthrough', servers: [UPSTREAM] }) });
    for (let i = 0; i < RATE_BURST; i += 1) harness.listener().deliver(query(NAME, 1, i), CLIENT);
    await flush();
    const connection = harness.network.tcpServers[0]?.accept();
    connection?.push(tcpFrame(query()));
    await flush();
    const [reply] = tcpMessages(connection?.output() ?? Buffer.alloc(0));
    expect(rcodeOf(reply)).toBe(RCODE_REFUSED);
    expect(harness.network.dialled).toHaveLength(0);
  });

  it('at most 64 upstream queries at once: UDP drops the 65th, TCP refuses it; room again after one finishes', async () => {
    const harness = await started();
    for (let i = 0; i < MAX_CONCURRENT_UPSTREAM; i += 1) harness.listener().deliver(query(NAME, 1, i), CLIENT);
    await flush();
    expect(harness.network.udpSockets).toHaveLength(1 + MAX_CONCURRENT_UPSTREAM);

    await sendUdp(harness, query());
    expect(harness.network.udpSockets).toHaveLength(1 + MAX_CONCURRENT_UPSTREAM);
    expect(harness.listener().sent).toHaveLength(0);

    const connection = harness.network.tcpServers[0]?.accept();
    connection?.push(tcpFrame(query()));
    await flush();
    expect(rcodeOf(tcpMessages(connection?.output() ?? Buffer.alloc(0))[0])).toBe(RCODE_REFUSED);
    expect(harness.network.dialled).toHaveLength(0);

    await replyUpstream(harness, (id) => aAnswer(id));
    await sendUdp(harness, query());
    expect(harness.network.udpSockets).toHaveLength(2 + MAX_CONCURRENT_UPSTREAM);
  });
});

describe('createDnsProxy — TCP', () => {
  const accept = (harness: Harness, remote?: string): FakeTcpConnection => {
    const connection = harness.network.tcpServers[0]?.accept(remote);
    if (connection === undefined) throw new Error('no TCP listener');
    return connection;
  };

  const answerDialled = async (harness: Harness, index: number): Promise<void> => {
    const upstream = harness.network.dialled[index];
    const [sent] = tcpMessages(upstream?.output() ?? Buffer.alloc(0));
    upstream?.push(tcpFrame(aAnswer(sent?.readUInt16BE(0) ?? -1)));
    await flush();
  };

  it('reads a query trickled byte by byte, forwards it over TCP and frames the reply', async () => {
    const harness = await started();
    const connection = accept(harness);
    for (const byte of tcpFrame(query())) connection.push(Buffer.from([byte]));
    await flush();
    expect(harness.network.dialled[0]?.target).toEqual({ address: UPSTREAM, port: 53 });
    await answerDialled(harness, 0);
    const replies = tcpMessages(connection.output());
    expect(replies).toHaveLength(1);
    expect(replies[0]?.readUInt16BE(0)).toBe(0xbeef);
    expect(harness.learnCalls).toHaveLength(1);
    expect(connection.destroyed).toBe(false);
  });

  it('handles two pipelined queries in one chunk', async () => {
    const harness = await started();
    const connection = accept(harness);
    connection.push(Buffer.concat([tcpFrame(query(NAME, 1, 1)), tcpFrame(query(NAME, 1, 2))]));
    await flush();
    expect(harness.network.dialled).toHaveLength(2);
    await answerDialled(harness, 1);
    await answerDialled(harness, 0);
    expect(tcpMessages(connection.output()).map((reply) => reply.readUInt16BE(0))).toEqual([2, 1]);
  });

  it('closes on a frame over 1232 bytes or under a header, before reading it', async () => {
    for (const length of [MAX_QUERY_BYTES + 1, 0xffff, 11, 0]) {
      const harness = await started();
      const connection = accept(harness);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(length, 0);
      connection.push(prefix);
      expect(connection.destroyed).toBe(true);
      expect(harness.network.dialled).toHaveLength(0);
    }
    const harness = await started();
    const connection = accept(harness);
    const base = Buffer.concat([header({ id: 0xbeef, ar: 1 }), question(NAME)]);
    connection.push(tcpFrame(Buffer.concat([base, Buffer.alloc(MAX_QUERY_BYTES - base.length)])));
    await flush();
    expect(connection.destroyed).toBe(false);
    expect(harness.network.dialled).toHaveLength(1);
  });

  it('accepts at most 16 connections; the 17th is closed at once, and a slot frees on close', async () => {
    const harness = await started();
    const open = Array.from({ length: MAX_TCP_CONNECTIONS }, () => accept(harness));
    expect(open.every((connection) => !connection.destroyed)).toBe(true);
    const extra = accept(harness);
    expect(extra.destroyed).toBe(true);
    open[0]?.hangUp();
    expect(accept(harness).destroyed).toBe(false);
  });

  it('closes a connection from a non-loopback address', async () => {
    const harness = await started();
    expect(accept(harness, '10.0.0.7').destroyed).toBe(true);
    expect(accept(harness, '::ffff:127.0.0.1').destroyed).toBe(false);
  });

  it('closes an idle connection after 10 s, and trickled bytes do not keep it open (slowloris)', async () => {
    const harness = await started();
    const idle = accept(harness);
    harness.advanceClock(9_999);
    expect(idle.destroyed).toBe(false);
    harness.advanceClock(1);
    expect(idle.destroyed).toBe(true);

    const slow = accept(harness);
    const frame = tcpFrame(query());
    for (let i = 0; i < 4; i += 1) {
      slow.push(frame.subarray(i, i + 1));
      harness.advanceClock(2_500);
    }
    expect(slow.destroyed).toBe(true);
    expect(harness.network.dialled).toHaveLength(0);
    expect(harness.scheduler.pending()).toBe(0);
  });

  it('a reply restarts the idle clock', async () => {
    const harness = await started();
    const connection = accept(harness);
    harness.advanceClock(9_000);
    connection.push(tcpFrame(query()));
    await flush();
    harness.advanceClock(1_500);
    await answerDialled(harness, 0);
    harness.advanceClock(9_999);
    expect(connection.destroyed).toBe(false);
    harness.advanceClock(1);
    expect(connection.destroyed).toBe(true);
  });

  it('a whole frame restarts the idle clock even when it gets no reply', async () => {
    const harness = await started();
    const connection = accept(harness);
    harness.advanceClock(9_000);
    connection.push(tcpFrame(Buffer.alloc(12, 0xff)));
    await flush();
    harness.advanceClock(9_999);
    expect(connection.destroyed).toBe(false);
    expect(tcpMessages(connection.output())).toHaveLength(0);
    harness.advanceClock(1);
    expect(connection.destroyed).toBe(true);
  });

  it('serves 32 queries per connection and closes it on the 33rd', async () => {
    const harness = await started({ resolveRule: () => null });
    const connection = accept(harness);
    for (let i = 0; i < MAX_QUERIES_PER_TCP_CONNECTION; i += 1) connection.push(tcpFrame(query(NAME, 1, i)));
    await flush();
    expect(tcpMessages(connection.output())).toHaveLength(MAX_QUERIES_PER_TCP_CONNECTION);
    expect(connection.destroyed).toBe(false);
    connection.push(tcpFrame(query(NAME, 1, 99)));
    await flush();
    expect(connection.destroyed).toBe(true);
    expect(tcpMessages(connection.output())).toHaveLength(MAX_QUERIES_PER_TCP_CONNECTION);
  });

  it('a connection error closes it', async () => {
    const harness = await started();
    const connection = accept(harness);
    connection.fail(new Error('ECONNRESET'));
    expect(connection.destroyed).toBe(true);
  });
});

describe('createDnsProxy — stop cleans everything', () => {
  it('closes listeners, client connections and upstream sockets; clears every timer; sends nothing late', async () => {
    const harness = await started({ learn: () => new Promise<void>(() => undefined) });
    await sendUdp(harness, query());
    const udpUpstream = lastUpstream(harness);
    const waiting = accept(harness);
    waiting.push(tcpFrame(query()));
    await flush();
    const tcpUpstream = harness.network.dialled[0];
    const learning = harness.network.tcpServers[0]?.accept();
    learning?.push(tcpFrame(query(NAME, 1, 7)));
    await flush();
    const second = harness.network.dialled[1];
    const [sent] = tcpMessages(second?.output() ?? Buffer.alloc(0));
    second?.push(tcpFrame(aAnswer(sent?.readUInt16BE(0) ?? -1)));
    await flush();
    expect(harness.scheduler.pending()).toBeGreaterThan(0);

    await harness.proxy.stop();
    await flush();
    expect(harness.listener().closed).toBe(true);
    expect(harness.network.tcpServers[0]?.closed).toBe(true);
    expect(udpUpstream.closed).toBe(true);
    expect(tcpUpstream?.destroyed).toBe(true);
    expect(waiting.destroyed).toBe(true);
    expect(learning?.destroyed).toBe(true);
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.proxy.status().state).toBe('stopped');

    udpUpstream.deliver(aAnswer(upstreamId(udpUpstream)), { address: UPSTREAM, port: 53 });
    harness.advanceClock(60_000);
    await flush();
    expect(harness.listener().sent).toHaveLength(0);
    expect(tcpMessages(waiting.output())).toHaveLength(0);
    expect(tcpMessages(learning?.output() ?? Buffer.alloc(0))).toHaveLength(0);
  });

  function accept(harness: Harness): FakeTcpConnection {
    const connection = harness.network.tcpServers[0]?.accept();
    if (connection === undefined) throw new Error('no TCP listener');
    return connection;
  }
});
