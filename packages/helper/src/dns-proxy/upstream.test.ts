import { describe, expect, it } from 'vitest';

import { createFakeNetwork, createFakeScheduler, flush, tcpMessages, type FakeNetwork } from '../dns-test-utils';
import { createLogger } from '../logger';
import { aRecord, buildQuery, buildResponse, cnameRecord, encodeName, pointer } from './packet-fixtures';
import { parseQuery } from './packet';
import {
  queryUpstream,
  routeQuery,
  tcpFrame,
  upstreamServers,
  type ProxyRule,
  type RouteSources,
  type Transport,
  type UpstreamResult,
} from './upstream';

const RULE_A = '11111111-1111-4111-8111-111111111111';
const RULE_B = '22222222-2222-4222-8222-222222222222';
const RULE_C = '33333333-3333-4333-8333-333333333333';

const rule = (id: string, target: string, extra: Partial<ProxyRule> = {}): ProxyRule => ({
  id,
  enabled: true,
  kind: 'domain',
  target,
  iface: 'ethernet',
  ...extra,
});

const sources: RouteSources = {
  roleServers: (iface) => (iface === 'ethernet' ? ['10.1.0.53', '10.1.0.54'] : ['192.168.1.1']),
  systemServers: () => ['192.168.1.1', '1.1.1.1'],
};

describe('upstreamServers', () => {
  it('keeps routable IPv4 servers in order, without duplicates, at most 3', () => {
    expect(upstreamServers(['10.0.0.1', '10.0.0.2', '10.0.0.1', '10.0.0.3', '10.0.0.4'])).toEqual([
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
    ]);
  });

  it('never returns loopback (the proxy itself), an ADR-001 range or garbage', () => {
    expect(
      upstreamServers([
        '127.0.0.1',
        '127.0.0.53',
        '0.0.0.0',
        '169.254.1.1',
        '224.0.0.251',
        '255.255.255.255',
        'default',
        '::1',
        'fe80::1',
        '10.0.0.256',
        '',
        '8.8.8.8',
      ]),
    ).toEqual(['8.8.8.8']);
  });

  it('is empty for no usable server', () => {
    expect(upstreamServers([])).toEqual([]);
    expect(upstreamServers(['127.0.0.1'])).toEqual([]);
  });
});

describe('routeQuery', () => {
  it('learns for a subdomain a wildcard owns, using the rule dns', () => {
    const rules = [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' })];
    expect(routeQuery('app.corp.local', rules, sources)).toEqual({
      kind: 'learn',
      ruleId: RULE_A,
      servers: ['10.9.9.9'],
    });
  });

  it('uses the role interface servers when the rule has no dns', () => {
    expect(routeQuery('a.b.corp.local', [rule(RULE_A, '*.corp.local')], sources)).toEqual({
      kind: 'learn',
      ruleId: RULE_A,
      servers: ['10.1.0.53', '10.1.0.54'],
    });
    expect(routeQuery('x.corp.local', [rule(RULE_A, '*.corp.local', { iface: 'wifi' })], sources)).toEqual({
      kind: 'learn',
      ruleId: RULE_A,
      servers: ['192.168.1.1'],
    });
  });

  it('caps role servers at 3 and drops loopback ones', () => {
    const many: RouteSources = {
      roleServers: () => ['127.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
      systemServers: () => [],
    };
    expect(routeQuery('x.corp.local', [rule(RULE_A, '*.corp.local')], many)).toEqual({
      kind: 'learn',
      ruleId: RULE_A,
      servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
    });
  });

  it('gives the deepest wildcard the name', () => {
    const rules = [rule(RULE_A, '*.corp.local'), rule(RULE_B, '*.lab.corp.local', { dns: '10.2.2.2' })];
    expect(routeQuery('x.lab.corp.local', rules, sources)).toMatchObject({ kind: 'learn', ruleId: RULE_B });
    expect(routeQuery('x.corp.local', rules, sources)).toMatchObject({ kind: 'learn', ruleId: RULE_A });
  });

  it('passes the base itself through: the wildcard dns, else the system resolvers', () => {
    expect(routeQuery('corp.local', [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' })], sources)).toEqual({
      kind: 'passthrough',
      servers: ['10.9.9.9'],
    });
    expect(routeQuery('corp.local', [rule(RULE_A, '*.corp.local')], sources)).toEqual({
      kind: 'passthrough',
      servers: ['192.168.1.1', '1.1.1.1'],
    });
  });

  it('picks the first of equally deep covering wildcards for a pass-through', () => {
    const rules = [rule(RULE_A, '*.corp.local', { dns: '10.9.9.1' }), rule(RULE_B, '*.corp.local', { dns: '10.9.9.2' })];
    expect(routeQuery('corp.local', rules, sources)).toEqual({ kind: 'passthrough', servers: ['10.9.9.1'] });
  });

  // TASK-DELTA-30 (split horizon): clients must get the answer the exact rule's own lookup gets,
  // and what they get is learned for the exact rule, never left to the wildcard's server.
  it('learns for a name an exact domain rule owns, from its role servers (not the wildcard dns)', () => {
    const rules = [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' }), rule(RULE_C, 'www.corp.local', { iface: 'wifi' })];
    expect(routeQuery('www.corp.local', rules, sources)).toEqual({ kind: 'learn', ruleId: RULE_C, servers: ['192.168.1.1'], exact: true });
    // A sibling name stays the wildcard's.
    expect(routeQuery('app.corp.local', rules, sources)).toEqual({ kind: 'learn', ruleId: RULE_A, servers: ['10.9.9.9'] });
  });

  it('learns for an exact domain rule from its own dns when it has one', () => {
    const rules = [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' }), rule(RULE_C, 'www.corp.local', { iface: 'wifi', dns: '10.8.8.8' })];
    expect(routeQuery('www.corp.local', rules, sources)).toEqual({ kind: 'learn', ruleId: RULE_C, servers: ['10.8.8.8'], exact: true });
  });

  it('learns for an exact rule on the base itself', () => {
    const rules = [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' }), rule(RULE_C, 'corp.local', { iface: 'wifi' })];
    expect(routeQuery('corp.local', rules, sources)).toEqual({ kind: 'learn', ruleId: RULE_C, servers: ['192.168.1.1'], exact: true });
  });

  it("falls back to the system servers for an exact rule whose role has none (the engine's lookup does too)", () => {
    const none: RouteSources = { roleServers: () => [], systemServers: () => ['192.168.1.1', '127.0.0.1'] };
    const rules = [rule(RULE_A, '*.corp.local'), rule(RULE_C, 'www.corp.local', { iface: 'wifi' })];
    expect(routeQuery('www.corp.local', rules, none)).toEqual({ kind: 'learn', ruleId: RULE_C, servers: ['192.168.1.1'], exact: true });
    // A wildcard has no lookup of its own: no servers, SERVFAIL.
    expect(routeQuery('app.corp.local', rules, none)).toEqual({ kind: 'learn', ruleId: RULE_A, servers: [] });
  });

  it('lets the wildcard own a name whose exact rule is disabled', () => {
    const rules = [rule(RULE_A, '*.corp.local'), rule(RULE_C, 'www.corp.local', { iface: 'wifi', enabled: false })];
    expect(routeQuery('www.corp.local', rules, sources)).toMatchObject({ kind: 'learn', ruleId: RULE_A });
    expect(routeQuery('www.corp.local', rules, sources)).not.toHaveProperty('exact');
  });

  it('marks only an exact rule\'s route `exact` (CNAME targets bind to it, TASK-DELTA-41); a wildcard\'s and a passthrough never', () => {
    const rules = [rule(RULE_A, '*.corp.local'), rule(RULE_C, 'www.corp.local', { iface: 'wifi' })];
    expect(routeQuery('www.corp.local', rules, sources)).toHaveProperty('exact', true);
    expect(routeQuery('app.corp.local', rules, sources)).not.toHaveProperty('exact');
    expect(routeQuery('corp.local', rules, sources)).not.toHaveProperty('exact');
  });

  it('passes through a name that is not a hostname (SRV labels) under a base', () => {
    expect(routeQuery('_ldap._tcp.corp.local', [rule(RULE_A, '*.corp.local', { dns: '10.9.9.9' })], sources)).toEqual({
      kind: 'passthrough',
      servers: ['10.9.9.9'],
    });
  });

  it('has no route for a name under no wildcard base, disabled rules and non-domain rules', () => {
    const rules = [
      rule(RULE_A, '*.corp.local', { enabled: false }),
      rule(RULE_B, 'other.local'),
      rule(RULE_C, '10.0.0.0/8', { kind: 'subnet' }),
    ];
    expect(routeQuery('x.corp.local', rules, sources)).toBeNull();
    expect(routeQuery('other.local', rules, sources)).toBeNull();
    expect(routeQuery('xcorp.local', [rule(RULE_A, '*.corp.local')], sources)).toBeNull();
    expect(routeQuery('', [rule(RULE_A, '*.corp.local')], sources)).toBeNull();
  });

  it('never routes to the proxy itself even when a server list says so', () => {
    const loop: RouteSources = { roleServers: () => ['127.0.0.1'], systemServers: () => ['127.0.0.1'] };
    expect(routeQuery('x.corp.local', [rule(RULE_A, '*.corp.local')], loop)).toEqual({
      kind: 'learn',
      ruleId: RULE_A,
      servers: [],
    });
    expect(routeQuery('corp.local', [rule(RULE_A, '*.corp.local')], loop)).toEqual({
      kind: 'passthrough',
      servers: [],
    });
  });
});

// ---------------------------------------------------------------------------

const NAME = 'app.corp.local';
const CLIENT_QUERY = buildQuery(NAME, 1, { id: 0xbeef });
const QUESTION = (() => {
  const parsed = parseQuery(CLIENT_QUERY);
  if (parsed === null) throw new Error('fixture');
  return parsed;
})();

const answerFor = (id: number, address = '10.20.0.5'): Buffer =>
  buildResponse(NAME, [aRecord(pointer(12), address)], { id });

const setup = (
  servers: readonly string[] = ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
  transport: Transport = 'udp',
): {
  network: FakeNetwork;
  scheduler: ReturnType<typeof createFakeScheduler>;
  outcome: { value: UpstreamResult | null | undefined };
  cancel: () => void;
  ids: number[];
} => {
  const network = createFakeNetwork();
  const scheduler = createFakeScheduler(new Date(0));
  let next = 0x1000;
  const ids: number[] = [];
  const outcome: { value: UpstreamResult | null | undefined } = { value: undefined };
  const call = queryUpstream(
    { query: CLIENT_QUERY, question: QUESTION, servers, transport },
    {
      sockets: network.factory,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      randomId: () => {
        next += 0x111;
        ids.push(next);
        return next;
      },
      logger: createLogger({ sinks: [] }),
    },
  );
  void call.result.then((value) => {
    outcome.value = value;
  });
  return { network, scheduler, outcome, cancel: call.cancel, ids };
};

const idOf = (message: Buffer): number => message.readUInt16BE(0);

describe('queryUpstream over UDP', () => {
  it('sends the query unchanged but for a fresh random ID on a new socket, and accepts the matching reply', async () => {
    const { network, outcome, ids } = setup();
    const socket = network.udpSockets[0];
    expect(network.udpSockets).toHaveLength(1);
    const sent = socket?.sent[0];
    expect(sent?.address).toBe('10.0.0.1');
    expect(sent?.port).toBe(53);
    expect(idOf(sent?.data ?? Buffer.alloc(2))).toBe(ids[0]);
    expect(sent?.data.subarray(2)).toEqual(CLIENT_QUERY.subarray(2));
    expect(CLIENT_QUERY.readUInt16BE(0)).toBe(0xbeef);

    const reply = answerFor(ids[0] ?? 0);
    socket?.deliver(reply, { address: '10.0.0.1', port: 53 });
    await flush();
    expect(outcome.value?.reply).toEqual(reply);
    expect(outcome.value?.server).toBe('10.0.0.1');
    expect(outcome.value?.parsed.answers).toEqual([{ name: NAME, type: 'A', ttl: 300, data: '10.20.0.5' }]);
    expect(socket?.closed).toBe(true);
  });

  it('drops spoofed replies (other address, other port, wrong ID, other question, malformed) and keeps waiting', async () => {
    const { network, outcome, ids } = setup();
    const socket = network.udpSockets[0];
    const id = ids[0] ?? 0;
    socket?.deliver(answerFor(id), { address: '10.0.0.9', port: 53 });
    socket?.deliver(answerFor(id), { address: '10.0.0.1', port: 5353 });
    socket?.deliver(answerFor(id ^ 1), { address: '10.0.0.1', port: 53 });
    socket?.deliver(buildResponse('evil.corp.local', [aRecord(pointer(12), '6.6.6.6')], { id }), {
      address: '10.0.0.1',
      port: 53,
    });
    socket?.deliver(Buffer.concat([answerFor(id).subarray(0, 20)]), { address: '10.0.0.1', port: 53 });
    await flush();
    expect(outcome.value).toBeUndefined();
    expect(socket?.closed).toBe(false);

    socket?.deliver(answerFor(id), { address: '10.0.0.1', port: 53 });
    await flush();
    expect(outcome.value?.parsed.answers[0]?.data).toBe('10.20.0.5');
  });

  it('accepts a 4096-byte reply and drops a 4097-byte one', async () => {
    const pad = (base: Buffer, size: number): Buffer => Buffer.concat([base, Buffer.alloc(size - base.length)]);
    const first = setup();
    const id = first.ids[0] ?? 0;
    first.network.udpSockets[0]?.deliver(pad(answerFor(id), 4097), { address: '10.0.0.1', port: 53 });
    await flush();
    expect(first.outcome.value).toBeUndefined();
    first.network.udpSockets[0]?.deliver(pad(answerFor(id), 4096), { address: '10.0.0.1', port: 53 });
    await flush();
    expect(first.outcome.value?.reply).toHaveLength(4096);
  });

  it('fails over after 2 s per server, each with a new socket and ID', async () => {
    const { network, scheduler, outcome, ids } = setup();
    scheduler.advance(1999);
    await flush();
    expect(network.udpSockets).toHaveLength(1);
    scheduler.advance(1);
    await flush();
    expect(network.udpSockets[0]?.closed).toBe(true);
    expect(network.udpSockets).toHaveLength(2);
    expect(network.udpSockets[1]?.sent[0]?.address).toBe('10.0.0.2');
    expect(ids[1]).not.toBe(ids[0]);

    network.udpSockets[1]?.deliver(answerFor(ids[1] ?? 0), { address: '10.0.0.2', port: 53 });
    await flush();
    expect(outcome.value?.server).toBe('10.0.0.2');
    expect(scheduler.pending()).toBe(0);
  });

  it('gives up after 5 s in total (2 + 2 + 1) and closes everything', async () => {
    const { network, scheduler, outcome } = setup();
    scheduler.advance(2000);
    await flush();
    scheduler.advance(2000);
    await flush();
    expect(network.udpSockets).toHaveLength(3);
    scheduler.advance(999);
    await flush();
    expect(outcome.value).toBeUndefined();
    scheduler.advance(1);
    await flush();
    expect(outcome.value).toBeNull();
    expect(network.udpSockets.every((socket) => socket.closed)).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it('waits past 2 s on a single server: a reply at 3.4 s is the answer (Real-Mac 0.3.0)', async () => {
    const { network, scheduler, outcome, ids } = setup(['10.0.0.1']);
    scheduler.advance(3400);
    await flush();
    expect(network.udpSockets).toHaveLength(1);
    expect(network.udpSockets[0]?.closed).toBe(false);
    expect(outcome.value).toBeUndefined();
    // A spoofed reply is still dropped after the old 2 s mark.
    network.udpSockets[0]?.deliver(answerFor((ids[0] ?? 0) ^ 1), { address: '10.0.0.1', port: 53 });
    network.udpSockets[0]?.deliver(answerFor(ids[0] ?? 0), { address: '10.0.0.9', port: 53 });
    await flush();
    expect(outcome.value).toBeUndefined();
    network.udpSockets[0]?.deliver(answerFor(ids[0] ?? 0), { address: '10.0.0.1', port: 53 });
    await flush();
    expect(outcome.value?.server).toBe('10.0.0.1');
    expect(scheduler.pending()).toBe(0);
  });

  it('gives up on a single silent server at exactly 5 s', async () => {
    const { network, scheduler, outcome } = setup(['10.0.0.1']);
    scheduler.advance(4999);
    await flush();
    expect(outcome.value).toBeUndefined();
    scheduler.advance(1);
    await flush();
    expect(outcome.value).toBeNull();
    expect(network.udpSockets).toHaveLength(1);
    expect(network.udpSockets[0]?.closed).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it('with two servers, fails over at 2 s and gives the last one the remaining 3 s', async () => {
    const { network, scheduler, outcome, ids } = setup(['10.0.0.1', '10.0.0.2']);
    scheduler.advance(2000);
    await flush();
    expect(network.udpSockets[0]?.closed).toBe(true);
    expect(network.udpSockets).toHaveLength(2);
    scheduler.advance(2900);
    await flush();
    expect(network.udpSockets[1]?.closed).toBe(false);
    network.udpSockets[1]?.deliver(answerFor(ids[1] ?? 0), { address: '10.0.0.2', port: 53 });
    await flush();
    expect(outcome.value?.server).toBe('10.0.0.2');
    expect(scheduler.pending()).toBe(0);
  });

  it('with two silent servers, gives up at 5 s', async () => {
    const { scheduler, outcome } = setup(['10.0.0.1', '10.0.0.2']);
    scheduler.advance(4999);
    await flush();
    expect(outcome.value).toBeUndefined();
    scheduler.advance(1);
    await flush();
    expect(outcome.value).toBeNull();
    expect(scheduler.pending()).toBe(0);
  });

  it('moves on at once when a send fails or the socket errors', async () => {
    const network = createFakeNetwork();
    network.sendError = 'EHOSTUNREACH';
    const scheduler = createFakeScheduler(new Date(0));
    let value: UpstreamResult | null | undefined;
    const call = queryUpstream(
      { query: CLIENT_QUERY, question: QUESTION, servers: ['10.0.0.1', '10.0.0.2'], transport: 'udp' },
      {
        sockets: network.factory,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        randomId: () => 7,
        logger: createLogger({ sinks: [] }),
      },
    );
    void call.result.then((result) => {
      value = result;
    });
    await flush();
    expect(network.udpSockets).toHaveLength(2);
    network.udpSockets[1]?.fail(new Error('boom'));
    await flush();
    expect(value).toBeNull();
    expect(scheduler.pending()).toBe(0);
  });

  it('returns null at once for no servers', async () => {
    const { outcome, network, scheduler } = setup([]);
    await flush();
    expect(outcome.value).toBeNull();
    expect(network.udpSockets).toHaveLength(0);
    expect(scheduler.pending()).toBe(0);
  });

  it('cancel closes the socket and settles with null', async () => {
    const { network, scheduler, outcome, cancel } = setup();
    cancel();
    await flush();
    expect(outcome.value).toBeNull();
    expect(network.udpSockets).toHaveLength(1);
    expect(network.udpSockets[0]?.closed).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it('passes a truncated (TC) reply on as an answer', async () => {
    const { network, outcome, ids } = setup();
    const truncated = buildResponse(NAME, [], { id: ids[0] ?? 0, flags: 0x8380 });
    network.udpSockets[0]?.deliver(truncated, { address: '10.0.0.1', port: 53 });
    await flush();
    expect(outcome.value?.parsed.tc).toBe(true);
    expect(outcome.value?.reply).toEqual(truncated);
  });
});

describe('queryUpstream over TCP', () => {
  it('dials server:53, writes one framed query and reads a reply split in pieces', async () => {
    const { network, outcome, ids } = setup(['10.0.0.1'], 'tcp');
    const connection = network.dialled[0];
    expect(connection?.target).toEqual({ address: '10.0.0.1', port: 53 });
    const [written] = tcpMessages(connection?.output() ?? Buffer.alloc(0));
    expect(written?.readUInt16BE(0)).toBe(ids[0]);
    expect(written?.subarray(2)).toEqual(CLIENT_QUERY.subarray(2));

    const reply = buildResponse(
      NAME,
      [cnameRecord(pointer(12), encodeName('edge.corp.local')), aRecord(encodeName('edge.corp.local'), '10.3.3.3')],
      { id: ids[0] ?? 0 },
    );
    const framed = tcpFrame(reply);
    for (const byte of framed) connection?.push(Buffer.from([byte]));
    await flush();
    expect(outcome.value?.reply).toEqual(reply);
    expect(connection?.destroyed).toBe(true);
  });

  it('treats a wrong ID, a malformed reply, trailing bytes or a hang-up as that server failing', async () => {
    const cases: ((id: number) => Buffer | 'hangup')[] = [
      (id) => tcpFrame(answerFor(id ^ 0xffff)),
      (id) => tcpFrame(answerFor(id).subarray(0, 14)),
      (id) => Buffer.concat([tcpFrame(answerFor(id)), Buffer.from([0])]),
      () => 'hangup',
    ];
    for (const make of cases) {
      const { network, outcome, ids } = setup(['10.0.0.1', '10.0.0.2'], 'tcp');
      const action = make(ids[0] ?? 0);
      if (action === 'hangup') network.dialled[0]?.hangUp();
      else network.dialled[0]?.push(action);
      await flush();
      expect(network.dialled).toHaveLength(2);
      network.dialled[1]?.push(tcpFrame(answerFor(ids[1] ?? 0)));
      await flush();
      expect(outcome.value?.server).toBe('10.0.0.2');
    }
  });

  it('gives a single silent server the whole 5 s budget, then times out', async () => {
    const { network, scheduler, outcome } = setup(['10.0.0.1'], 'tcp');
    scheduler.advance(4999);
    await flush();
    expect(network.dialled[0]?.destroyed).toBe(false);
    expect(outcome.value).toBeUndefined();
    scheduler.advance(1);
    await flush();
    expect(outcome.value).toBeNull();
    expect(network.dialled[0]?.destroyed).toBe(true);
  });
});
