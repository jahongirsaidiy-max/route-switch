import { describe, expect, it } from 'vitest';

import { createLogger, createMemorySink, type LogEntry } from './logger';
import {
  classifyExistingRoute,
  createRouteOperations,
  parseRouteGetOutput,
  type RouteAddRequest,
  type RouteDeleteRequest,
} from './route';
import { createFakeCommandRunner, type FakeCommandResponse } from './test-utils';

const ROUTE = '/sbin/route';
const GW = '10.20.4.1';

// Output shapes of route(8) on macOS. The `get` blocks and the "not in table"
// line were captured from a real machine (macOS 26) and anonymised; the
// add/delete lines follow route(8) and its documented diagnostics.
//
// Confirmed on a real machine with root: `route -n add` for a destination that
// is already in the table exits with code 0; only the text says "File exists".
const ADD_EXISTS: FakeCommandResponse = {
  exitCode: 0,
  stdout: 'add net 10.0.0.0: gateway 10.20.4.1: File exists\n',
  stderr: 'route: writing to routing socket: File exists\n',
};
/** Not what macOS does today; kept so a `route` that starts exiting non-zero is handled the same way. */
const ADD_EXISTS_NONZERO: FakeCommandResponse = { ...ADD_EXISTS, exitCode: 1 };
const DELETE_MISSING: FakeCommandResponse = {
  exitCode: 1,
  stdout: 'delete net 10.0.0.0: not in table\n',
  stderr: 'route: writing to routing socket: not in table\n',
};

const GET_VIA_GATEWAY = `   route to: 172.16.12.40
destination: 172.16.12.40
    gateway: 10.20.4.1
  interface: en5
      flags: <UP,GATEWAY,HOST,DONE,STATIC>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`;

const GET_VIA_DEFAULT = `   route to: 1.1.1.1
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`;

const GET_ON_LINK = `   route to: 192.168.1.20
destination: 192.168.1.20
  interface: en0
      flags: <UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE,IFREF>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500      1134
`;

// Captured with `route -n get -net <the subnet of an interface>`: the kernel's
// connected route prints no `gateway` line at all and has no GATEWAY flag
// (`netstat -rn` shows the same entry as `192.168.1  link#15  UCS  en0`).
const GET_CONNECTED_SUBNET = `   route to: 192.168.1.0
destination: 192.168.1.0
       mask: 255.255.255.0
  interface: en0
      flags: <UP,DONE,CLONING,STATIC>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500    -19346 
`;

// Captured with `route -n get -host <the gateway of an interface>`.
const GET_GATEWAY_NEIGHBOUR = `   route to: 192.168.1.1
destination: 192.168.1.1
  interface: en0
      flags: <UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE,IFREF,ROUTER>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500      1193 
`;

// Captured with `route -n get -host <the address of an interface>`.
const GET_OWN_ADDRESS = `   route to: 192.168.1.23
destination: 192.168.1.23
  interface: lo0
      flags: <UP,HOST,DONE,LLINFO,WASCLONED,LOCAL,IFSCOPE,IFREF>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0     16384         0 
`;

const OTHER_GW = '192.168.1.1';
const METRICS = ` recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0 
`;
/** Flags as captured: a connected route, a static host route and a static subnet route through a gateway. */
const CONNECTED_FLAGS = 'UP,DONE,CLONING,STATIC';
const HOST_GATEWAY_FLAGS = 'UP,GATEWAY,HOST,DONE,STATIC';
const NET_GATEWAY_FLAGS = 'UP,GATEWAY,DONE,STATIC,PRCLONING';

// A subnet route added through a gateway, captured on a real machine with a
// plain `route -n get <address inside it>`; here in the form the wrapper asks
// for it (`-net <cidr>`), where `route to` is the network address -- that form
// was observed on connected subnets only.
const GET_GATEWAY_SUBNET = `   route to: 198.51.100.0
destination: 198.51.100.0
       mask: 255.255.255.0
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>
${METRICS}`;

interface GetBlock {
  readonly to: string | undefined;
  readonly destination: string | undefined;
  readonly mask?: string | undefined;
  readonly gateway?: string | undefined;
  readonly iface: string | undefined;
  /** Without the angle brackets. */
  readonly flags: string | undefined;
}

/** A `route -n get` block in the layout of the captured ones; an undefined field leaves its line out. */
const getBlock = (block: GetBlock): string =>
  [
    block.to === undefined ? null : `   route to: ${block.to}`,
    block.destination === undefined ? null : `destination: ${block.destination}`,
    block.mask === undefined ? null : `       mask: ${block.mask}`,
    block.gateway === undefined ? null : `    gateway: ${block.gateway}`,
    block.iface === undefined ? null : `  interface: ${block.iface}`,
    block.flags === undefined ? null : `      flags: <${block.flags}>`,
  ]
    .filter((line) => line !== null)
    .join('\n') + `\n${METRICS}`;

/** What a lookup without an exact entry falls through to (captured). */
const DEFAULT_ROUTE: GetBlock = {
  to: '1.1.1.1',
  destination: 'default',
  mask: 'default',
  gateway: OTHER_GW,
  iface: 'en0',
  flags: 'UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL',
};

const setup = () => {
  const runner = createFakeCommandRunner();
  const memory = createMemorySink();
  const logger = createLogger({ sinks: [memory.sink] });
  const ops = createRouteOperations({ runner, logger });
  return { runner, ops, entries: memory.entries };
};

const argvOf = (runner: ReturnType<typeof createFakeCommandRunner>): readonly (readonly string[])[] =>
  runner.calls.map((call) => {
    expect(call.bin).toBe(ROUTE);
    return call.args;
  });

const only = (entries: readonly LogEntry[]): LogEntry => {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error('expected exactly one log entry');
  }
  return entry;
};

/** Passes a value of the wrong type the way untyped or corrupted data would arrive. */
const asAddRequest = (value: unknown): RouteAddRequest => value as RouteAddRequest;
const asDeleteRequest = (value: unknown): RouteDeleteRequest => value as RouteDeleteRequest;
const asTarget = (value: unknown): string => value as string;

const FORBIDDEN_DESTINATIONS: readonly (readonly [string, string])[] = [
  ['0.0.0.0/0', 'default-route'],
  ['default', 'default-route'],
  ['DEFAULT', 'default-route'],
  ['0.0.0.0', 'default-route'],
  ['10.0.0.0/0', 'default-route'],
  ['0.1.2.3', 'this-network'],
  ['127.0.0.1', 'loopback'],
  ['127.0.0.0/8', 'loopback'],
  ['127.1.0.0/16', 'loopback'],
  ['224.0.0.251', 'multicast'],
  ['224.0.0.0/4', 'multicast'],
  ['239.255.255.250/32', 'multicast'],
  ['10.0.0.0/7', 'prefix-too-wide'],
  ['128.0.0.0/1', 'prefix-too-wide'],
  ['169.254.1.1', 'link-local'],
  ['169.254.0.0/16', 'link-local'],
  ['255.255.255.255', 'broadcast'],
  ['255.255.255.255/32', 'broadcast'],
];

const UNPARSABLE_DESTINATIONS: readonly string[] = [
  '10.0.0.0/33',
  '10.0.0.0/-1',
  '10.0.0.0/8/8',
  '10.0.0.0/',
  '',
  'garbage',
  'corp.local',
  '10.0.0',
  '10.0.0.0.0',
  '256.1.1.1',
  '010.1.1.1',
  '0x0a.1.1.1',
  '::1',
  '::ffff:10.1.2.3',
  ' 10.1.2.3',
  '10.1.2.3 ',
  '10.1.2.3\n',
  '10.1.2.3\n-interface',
  '10.1.2.3 10.20.4.1',
  '10.1.2.3\t',
  '10.1.2.3\0',
  '-net',
  '-host',
  '-interface',
  '10.1.2.3;id',
  '$(id)',
];

const NON_STRINGS: readonly unknown[] = [
  undefined,
  null,
  0,
  167772160,
  true,
  {},
  [],
  ['10.1.2.3'],
  { toString: () => '10.1.2.3' },
  Symbol('10.1.2.3'),
];

const BAD_GATEWAYS: readonly (readonly [unknown, string])[] = [
  ['', 'invalid-ipv4'],
  ['garbage', 'invalid-ipv4'],
  ['10.20.4.1/32', 'invalid-ipv4'],
  ['10.20.4.0/24', 'invalid-ipv4'],
  ['10.20.4', 'invalid-ipv4'],
  ['010.20.4.1', 'invalid-ipv4'],
  [' 10.20.4.1', 'invalid-ipv4'],
  ['10.20.4.1\n', 'invalid-ipv4'],
  ['10.20.4.1 -interface', 'invalid-ipv4'],
  ['-interface', 'invalid-ipv4'],
  ['en0', 'invalid-ipv4'],
  ['default', 'invalid-ipv4'],
  ['::1', 'invalid-ipv4'],
  ['0.0.0.0', 'default-route'],
  ['0.1.2.3', 'this-network'],
  ['127.0.0.1', 'loopback'],
  ['169.254.1.1', 'link-local'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  [undefined, 'invalid-ipv4'],
  [null, 'invalid-ipv4'],
  [42, 'invalid-ipv4'],
  [{}, 'invalid-ipv4'],
  [['10.20.4.1'], 'invalid-ipv4'],
];

describe('routeAdd', () => {
  it('adds a subnet with -net and the canonical CIDR', async () => {
    const { runner, ops } = setup();
    runner.when(ROUTE, ['-n', 'add', '-net', '10.0.0.0/8', GW], {
      stdout: 'add net 10.0.0.0: gateway 10.20.4.1\n',
    });

    const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

    expect(result).toEqual({ ok: true, outcome: 'added', dst: '10.0.0.0/8', kind: 'net', gateway: GW });
    expect(argvOf(runner)).toEqual([['-n', 'add', '-net', '10.0.0.0/8', GW]]);
  });

  it.each([
    ['172.16.12.40', '172.16.12.40'],
    ['172.16.12.40/32', '172.16.12.40'],
    // A zero host part must not turn a single address into a network.
    ['10.0.0.0', '10.0.0.0'],
    ['10.0.0.0/32', '10.0.0.0'],
    ['192.168.5.0', '192.168.5.0'],
  ])('adds the single address %s with -host %s', async (dst, expected) => {
    const { runner, ops } = setup();
    runner.whenMatching(() => ({ stdout: `add host ${expected}: gateway ${GW}\n` }));

    const result = await ops.routeAdd({ dst, gateway: GW });

    expect(result).toEqual({ ok: true, outcome: 'added', dst: expected, kind: 'host', gateway: GW });
    expect(argvOf(runner)).toEqual([['-n', 'add', '-host', expected, GW]]);
  });

  it('clears host bits before the destination reaches the command', async () => {
    const { runner, ops } = setup();
    runner.whenMatching(() => ({}));

    const result = await ops.routeAdd({ dst: '10.1.2.3/8', gateway: GW });

    expect(result).toMatchObject({ ok: true, dst: '10.0.0.0/8', kind: 'net' });
    expect(argvOf(runner)).toEqual([['-n', 'add', '-net', '10.0.0.0/8', GW]]);
  });

  it('ignores extra request fields, including a caller-supplied host flag', async () => {
    const { runner, ops } = setup();
    runner.whenMatching(() => ({}));
    const request = { dst: '10.0.0.0/8', gateway: GW, isHost: true, kind: 'host', ruleId: 'r1' };

    await ops.routeAdd(request);

    expect(argvOf(runner)).toEqual([['-n', 'add', '-net', '10.0.0.0/8', GW]]);
  });

  it('logs one entry with component, dst, gateway and outcome', async () => {
    const { runner, ops, entries } = setup();
    runner.whenMatching(() => ({}));

    await ops.routeAdd({ dst: '172.16.12.40', gateway: GW });

    const entry = only(entries);
    expect(entry.level).toBe('info');
    expect(entry.context).toEqual({
      component: 'route',
      op: 'add',
      dst: '172.16.12.40',
      gateway: GW,
      kind: 'host',
      outcome: 'added',
    });
  });

  describe('when the route already exists', () => {
    const ADD = ['-n', 'add', '-net', '10.0.0.0/8', GW];
    const GET = ['-n', 'get', '-net', '10.0.0.0/8'];
    const DELETE = ['-n', 'delete', '-net', '10.0.0.0/8'];
    /** The entry in the way: 10.0.0.0/8 through the other interface's gateway. */
    const OTHER_GATEWAY = getBlock({
      to: '10.0.0.0',
      destination: '10.0.0.0',
      mask: '255.0.0.0',
      gateway: OTHER_GW,
      iface: 'en0',
      flags: NET_GATEWAY_FLAGS,
    });

    /** First `add` answers "File exists"; later ones answer `second`. Every `get` answers `lookup`. */
    const existing = (
      first: FakeCommandResponse,
      second: FakeCommandResponse,
      lookup: FakeCommandResponse = { stdout: OTHER_GATEWAY },
    ) => {
      const context = setup();
      let adds = 0;
      context.runner.whenMatching((_bin, args) => {
        if (args[1] === 'get') return lookup;
        if (args[1] !== 'add') return undefined;
        adds += 1;
        return adds === 1 ? first : second;
      });
      return context;
    };

    describe('and is a route through another gateway', () => {
      it.each([
        ['exit code 0 and the error only in the output (real)', ADD_EXISTS],
        ['a non-zero exit code', ADD_EXISTS_NONZERO],
        ['only the stderr line', { exitCode: 1, stderr: 'route: writing to routing socket: File exists\n' }],
        ['only the stdout line', { exitCode: 0, stdout: 'add net 10.0.0.0: gateway 10.20.4.1: File exists\n' }],
        ['the "route already in table" wording', { exitCode: 1, stderr: 'route: route already in table\n' }],
      ])('inspects it, deletes it and adds it again (%s)', async (_name, first) => {
        const { runner, ops, entries } = existing(first, { stdout: 'add net 10.0.0.0: gateway 10.20.4.1\n' });
        runner.when(ROUTE, DELETE, { stdout: 'delete net 10.0.0.0\n' });

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toEqual({ ok: true, outcome: 'replaced', dst: '10.0.0.0/8', kind: 'net', gateway: GW });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
        const entry = only(entries);
        expect(entry.level).toBe('info');
        expect(entry.context).toEqual({
          component: 'route',
          op: 'add',
          dst: '10.0.0.0/8',
          gateway: GW,
          kind: 'net',
          outcome: 'replaced',
          existing: 'gateway-route',
          existingGateway: OTHER_GW,
          existingIface: 'en0',
        });
      });

      it('uses -host for the lookup, the delete and the second add of a single address', async () => {
        const { runner, ops } = existing(
          ADD_EXISTS,
          {},
          {
            stdout: getBlock({
              to: '10.0.0.0',
              destination: '10.0.0.0',
              gateway: OTHER_GW,
              iface: 'en0',
              flags: HOST_GATEWAY_FLAGS,
            }),
          },
        );
        runner.when(ROUTE, ['-n', 'delete', '-host', '10.0.0.0'], {});

        const result = await ops.routeAdd({ dst: '10.0.0.0', gateway: GW });

        expect(result).toMatchObject({ ok: true, outcome: 'replaced', kind: 'host' });
        expect(argvOf(runner)).toEqual([
          ['-n', 'add', '-host', '10.0.0.0', GW],
          ['-n', 'get', '-host', '10.0.0.0'],
          ['-n', 'delete', '-host', '10.0.0.0'],
          ['-n', 'add', '-host', '10.0.0.0', GW],
        ]);
      });

      it('replaces the host route captured from a real table', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: GET_VIA_GATEWAY });
        runner.when(ROUTE, ['-n', 'delete', '-host', '172.16.12.40'], {});

        const result = await ops.routeAdd({ dst: '172.16.12.40', gateway: OTHER_GW });

        expect(result).toMatchObject({ ok: true, outcome: 'replaced', kind: 'host', gateway: OTHER_GW });
        expect(runner.calls.map((call) => call.args[1])).toEqual(['add', 'get', 'delete', 'add']);
      });

      it('replaces the subnet route captured from a real table', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: GET_GATEWAY_SUBNET });
        runner.when(ROUTE, ['-n', 'delete', '-net', '198.51.100.0/24'], { stdout: 'delete net 198.51.100.0\n' });

        const result = await ops.routeAdd({ dst: '198.51.100.0/24', gateway: GW });

        expect(result).toMatchObject({ ok: true, outcome: 'replaced', kind: 'net' });
        expect(argvOf(runner)).toEqual([
          ['-n', 'add', '-net', '198.51.100.0/24', GW],
          ['-n', 'get', '-net', '198.51.100.0/24'],
          ['-n', 'delete', '-net', '198.51.100.0/24'],
          ['-n', 'add', '-net', '198.51.100.0/24', GW],
        ]);
      });

      it('does not take the same block for the entry of an address inside that subnet', async () => {
        // What a plain lookup of 198.51.100.8 prints while only the /24 exists (captured).
        const covering = GET_GATEWAY_SUBNET.replace('route to: 198.51.100.0', 'route to: 198.51.100.8');
        const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: covering });

        const result = await ops.routeAdd({ dst: '198.51.100.8', gateway: GW });

        expect(result).toMatchObject({ ok: false, step: 'inspect', failure: 'existing-route-unknown' });
        expect(runner.calls.map((call) => call.args[1])).toEqual(['add', 'get']);
      });

      it('reports a second "File exists" that comes with exit code 0 as a failed re-add', async () => {
        const { runner, ops } = existing(ADD_EXISTS, ADD_EXISTS);
        runner.when(ROUTE, DELETE, {});

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toMatchObject({ ok: false, outcome: 'failed', step: 're-add', failure: 'reported-error', exitCode: 0 });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
      });

      it('still adds again when the route vanished before the delete', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {});
        runner.when(ROUTE, DELETE, DELETE_MISSING);

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toMatchObject({ ok: true, outcome: 'replaced' });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
      });

      it('fails after one retry when the second add reports "File exists" again', async () => {
        const { runner, ops, entries } = existing(ADD_EXISTS, ADD_EXISTS_NONZERO);
        runner.when(ROUTE, DELETE, {});

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toEqual({
          ok: false,
          outcome: 'failed',
          step: 're-add',
          failure: 'nonzero-exit',
          exitCode: 1,
          stdout: ADD_EXISTS.stdout,
          stderr: ADD_EXISTS.stderr,
          message: 'writing to routing socket: File exists',
        });
        // One lookup, one delete, one more add: no loop.
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
        const entry = only(entries);
        expect(entry.level).toBe('error');
        expect(entry.context).toMatchObject({
          component: 'route',
          op: 'add',
          dst: '10.0.0.0/8',
          gateway: GW,
          outcome: 'failed',
          step: 're-add',
          exitCode: 1,
          existing: 'gateway-route',
        });
      });

      it('fails when the second add fails for another reason', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {
          exitCode: 1,
          stderr: 'route: writing to routing socket: Network is unreachable\n',
        });
        runner.when(ROUTE, DELETE, {});

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toMatchObject({
          ok: false,
          outcome: 'failed',
          step: 're-add',
          message: 'writing to routing socket: Network is unreachable',
        });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
      });

      it('fails without a second add when the delete fails', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {});
        runner.when(ROUTE, DELETE, {
          exitCode: 77,
          stderr: 'route: must be root to alter routing table\n',
        });

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toMatchObject({
          ok: false,
          outcome: 'failed',
          step: 'delete',
          exitCode: 77,
          message: 'must be root to alter routing table',
        });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE]);
      });

      it.each(['REJECT', 'BLACKHOLE'])(
        'replaces a %s route even though it names the requested gateway',
        async (flag) => {
          const lookup = getBlock({
            to: '10.0.0.0',
            destination: '10.0.0.0',
            mask: '255.0.0.0',
            gateway: GW,
            iface: 'en5',
            flags: `${NET_GATEWAY_FLAGS},${flag}`,
          });
          const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: lookup });
          runner.when(ROUTE, DELETE, {});

          expect(await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW })).toMatchObject({ ok: true, outcome: 'replaced' });
          expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
        },
      );

      it('reads the block the same way with CRLF line endings, unknown lines and a hexadecimal mask', async () => {
        const lookup = `${getBlock({
          to: '10.0.0.0',
          destination: '10.0.0.0',
          mask: '0xff000000',
          gateway: OTHER_GW,
          iface: 'en0',
          flags: NET_GATEWAY_FLAGS,
        })}     ifscope: en0\nsomething new\n  made up key: 1\n`.replaceAll('\n', '\r\n');
        const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: lookup });
        runner.when(ROUTE, DELETE, {});

        expect(await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW })).toMatchObject({ ok: true, outcome: 'replaced' });
        expect(argvOf(runner)).toEqual([ADD, GET, DELETE, ADD]);
      });
    });

    describe('and already goes through the requested gateway', () => {
      it('keeps it: no delete, no second add, outcome "exists"', async () => {
        const lookup = getBlock({
          to: '10.0.0.0',
          destination: '10.0.0.0',
          mask: '255.0.0.0',
          gateway: GW,
          iface: 'en5',
          flags: NET_GATEWAY_FLAGS,
        });
        const { runner, ops, entries } = existing(ADD_EXISTS, {}, { stdout: lookup });

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toEqual({ ok: true, outcome: 'exists', dst: '10.0.0.0/8', kind: 'net', gateway: GW });
        expect(argvOf(runner)).toEqual([ADD, GET]);
        const entry = only(entries);
        expect(entry.level).toBe('info');
        expect(entry.msg).toBe('route already present with this gateway');
        expect(entry.context).toEqual({
          component: 'route',
          op: 'add',
          dst: '10.0.0.0/8',
          gateway: GW,
          kind: 'net',
          outcome: 'exists',
          existing: 'same-gateway',
          existingGateway: GW,
          existingIface: 'en5',
        });
      });

      it('keeps a host route too (the block captured from a real table)', async () => {
        const { runner, ops } = existing(ADD_EXISTS, {}, { stdout: GET_VIA_GATEWAY });

        const result = await ops.routeAdd({ dst: '172.16.12.40', gateway: GW });

        expect(result).toEqual({ ok: true, outcome: 'exists', dst: '172.16.12.40', kind: 'host', gateway: GW });
        expect(argvOf(runner)).toEqual([
          ['-n', 'add', '-host', '172.16.12.40', GW],
          ['-n', 'get', '-host', '172.16.12.40'],
        ]);
      });
    });

    describe('and is a connected (interface) route', () => {
      it('never deletes the connected subnet of an interface: [add, get], failed with its own kind, warn', async () => {
        const { runner, ops, entries } = existing(ADD_EXISTS, {}, { stdout: GET_CONNECTED_SUBNET });

        const result = await ops.routeAdd({ dst: '192.168.1.0/24', gateway: GW });

        expect(result).toEqual({
          ok: false,
          outcome: 'failed',
          step: 'inspect',
          failure: 'connected-route',
          exitCode: 0,
          stdout: GET_CONNECTED_SUBNET,
          stderr: '',
          message:
            'a connected route for 192.168.1.0/24 already exists on en0 and was left in place (the existing entry has no GATEWAY flag)',
        });
        expect(argvOf(runner)).toEqual([
          ['-n', 'add', '-net', '192.168.1.0/24', GW],
          ['-n', 'get', '-net', '192.168.1.0/24'],
        ]);
        const entry = only(entries);
        expect(entry.level).toBe('warn');
        expect(entry.context).toEqual({
          component: 'route',
          op: 'add',
          dst: '192.168.1.0/24',
          gateway: GW,
          outcome: 'failed',
          step: 'inspect',
          failure: 'connected-route',
          existing: 'connected',
          existingIface: 'en0',
          error: result.ok ? '' : result.message,
        });
      });

      it.each<[string, string, string]>([
        ["the neighbour entry of the interface's gateway (real)", '192.168.1.1', GET_GATEWAY_NEIGHBOUR],
        ["the interface's own address, on lo0 (real)", '192.168.1.23', GET_OWN_ADDRESS],
        ['an on-link neighbour (real)', '192.168.1.20', GET_ON_LINK],
        [
          'a /32 link entry printed with a mask (real shape)',
          '192.168.1.1',
          getBlock({ to: '192.168.1.1', destination: '192.168.1.1', mask: '255.255.255.255', iface: 'en0', flags: CONNECTED_FLAGS }),
        ],
        [
          'an interface route with a link#N gateway and no GATEWAY flag',
          '198.51.100.0/24',
          getBlock({ to: '198.51.100.0', destination: '198.51.100.0', mask: '255.255.255.0', gateway: 'link#15', iface: 'en0', flags: 'UP,DONE,STATIC' }),
        ],
        [
          'a link#N gateway even with the GATEWAY flag',
          '198.51.100.0/24',
          getBlock({ to: '198.51.100.0', destination: '198.51.100.0', mask: '255.255.255.0', gateway: 'link#15', iface: 'en0', flags: NET_GATEWAY_FLAGS }),
        ],
        [
          'a MAC-address gateway even with the GATEWAY flag',
          '198.51.100.7',
          getBlock({ to: '198.51.100.7', destination: '198.51.100.7', gateway: '0:0:5e:0:53:a', iface: 'en0', flags: HOST_GATEWAY_FLAGS }),
        ],
        [
          'no GATEWAY flag even though a gateway address is printed',
          '198.51.100.0/24',
          getBlock({ to: '198.51.100.0', destination: '198.51.100.0', mask: '255.255.255.0', gateway: OTHER_GW, iface: 'en0', flags: CONNECTED_FLAGS }),
        ],
        [
          'no GATEWAY flag even though the requested gateway itself is printed',
          '198.51.100.0/24',
          getBlock({ to: '198.51.100.0', destination: '198.51.100.0', mask: '255.255.255.0', gateway: GW, iface: 'en5', flags: CONNECTED_FLAGS }),
        ],
      ])('never deletes %s', async (_name, dst, stdout) => {
        const { runner, ops, entries } = existing(ADD_EXISTS, {}, { stdout });

        const result = await ops.routeAdd({ dst, gateway: GW });

        expect(result).toMatchObject({ ok: false, outcome: 'failed', step: 'inspect', failure: 'connected-route' });
        expect(runner.calls.map((call) => call.args[1])).toEqual(['add', 'get']);
        expect(only(entries).level).toBe('warn');
      });
    });

    describe('and cannot be identified with certainty', () => {
      const net = (extra: Partial<GetBlock>): string =>
        getBlock({
          to: '10.0.0.0',
          destination: '10.0.0.0',
          mask: '255.0.0.0',
          gateway: OTHER_GW,
          iface: 'en0',
          flags: NET_GATEWAY_FLAGS,
          ...extra,
        });
      const host = (extra: Partial<GetBlock>): string =>
        getBlock({ to: '10.1.2.3', destination: '10.1.2.3', gateway: OTHER_GW, iface: 'en0', flags: HOST_GATEWAY_FLAGS, ...extra });
      const SUBNET = '10.0.0.0/8';
      const ADDRESS = '10.1.2.3';

      it.each<[string, string, string]>([
        // `route -n get` answers with the best less specific entry when there is no exact one.
        ['the default route, for a subnet (real)', SUBNET, getBlock({ ...DEFAULT_ROUTE, to: '10.0.0.0' })],
        ['the default route, for an address (real)', ADDRESS, getBlock({ ...DEFAULT_ROUTE, to: '10.1.2.3' })],
        [
          'the connected subnet that covers the address (real)',
          '192.168.1.77',
          getBlock({ to: '192.168.1.77', destination: '192.168.1.0', mask: '255.255.255.0', iface: 'en0', flags: CONNECTED_FLAGS }),
        ],
        [
          'a gateway route for a wider block that covers the address',
          ADDRESS,
          host({ destination: '10.0.0.0', mask: '255.0.0.0', flags: NET_GATEWAY_FLAGS }),
        ],
        [
          'a gateway route for a wider block with the same network address',
          '10.0.0.0/16',
          net({ mask: '255.0.0.0' }),
        ],
        ['a gateway route for a narrower block with the same network address', SUBNET, net({ mask: '255.255.0.0' })],
        ['a block that starts elsewhere', '10.64.0.0/10', net({ to: '10.64.0.0', destination: '10.0.0.0', mask: '255.192.0.0' })],
        ['a subnet entry for a single address with a zero host part', '10.0.0.0', net({})],
        ['a host entry for a subnet', SUBNET, net({ mask: undefined, flags: HOST_GATEWAY_FLAGS })],
        ['a host entry printed with a subnet mask', SUBNET, net({ flags: HOST_GATEWAY_FLAGS })],
        ['an entry without a mask and without the HOST flag, for an address', ADDRESS, host({ flags: NET_GATEWAY_FLAGS })],
        ['an entry without a mask, for a subnet', SUBNET, net({ mask: undefined })],
        ['another address in "route to"', ADDRESS, host({ to: '10.1.2.4' })],
        ['another address in "destination"', ADDRESS, host({ destination: '10.1.2.4' })],
        ['no "route to" line', SUBNET, net({ to: undefined })],
        ['no "destination" line', SUBNET, net({ destination: undefined })],
        ['a shortened destination', SUBNET, net({ destination: '10' })],
        ['a destination printed as a CIDR', SUBNET, net({ destination: '10.0.0.0/8' })],
        ['a destination that is not canonical', SUBNET, net({ destination: '010.0.0.0' })],
        ['a mask without the 0x prefix', SUBNET, net({ mask: 'ff000000' })],
        ['a mask printed as a prefix length', SUBNET, net({ mask: '8' })],
        ['a mask printed as /8', SUBNET, net({ mask: '/8' })],
        ['a shortened mask', SUBNET, net({ mask: '255' })],
        ['a mask whose bits are not contiguous', SUBNET, net({ mask: '255.0.255.0' })],
        ['a hexadecimal mask whose bits are not contiguous', SUBNET, net({ mask: '0xff00ff00' })],
        ['a hexadecimal mask of the wrong length', SUBNET, net({ mask: '0xff0000' })],
        ['an empty mask', SUBNET, net({ mask: '' })],
        ['the word "default" as the mask', SUBNET, net({ mask: 'default' })],
        ['no flags line', SUBNET, net({ flags: undefined })],
        ['empty flags', SUBNET, net({ flags: '' })],
        ['flags that are not a list of names', SUBNET, net({ flags: 'UP,gateway,DONE' })],
        ['a flags line without brackets', SUBNET, net({}).replace(`<${NET_GATEWAY_FLAGS}>`, NET_GATEWAY_FLAGS)],
        ['the GATEWAY flag without a gateway line', SUBNET, net({ gateway: undefined })],
        ['an empty gateway', SUBNET, net({ gateway: '' })],
        ['a gateway that is not an address', SUBNET, net({ gateway: 'router.corp.local' })],
        ['a gateway with an octet out of range', SUBNET, net({ gateway: '999.1.1.1' })],
        ['a gateway in a shortened form', SUBNET, net({ gateway: '10.1' })],
        ['a loopback gateway', SUBNET, net({ gateway: '127.0.0.1' })],
        ['the gateway 0.0.0.0', SUBNET, net({ gateway: '0.0.0.0' })],
        ['a multicast gateway', SUBNET, net({ gateway: '224.0.0.1' })],
        ['an IPv6 gateway', SUBNET, net({ gateway: 'fe80::1%en0' })],
        ['a link gateway with trailing text', SUBNET, net({ gateway: 'link#15 extra' })],
        ['no interface line', SUBNET, net({ iface: undefined })],
        ['an interface that is not a device name', SUBNET, net({ iface: 'en0 en5' })],
        ['two destination lines', SUBNET, `${net({})}destination: 10.0.0.0\n`],
        ['two contradicting flags lines', SUBNET, `      flags: <UP,DONE,CLONING,STATIC>\n${net({})}`],
        ['two gateway lines', SUBNET, `${net({})}    gateway: ${OTHER_GW}\n`],
        ['two blocks, the second one for the default route', SUBNET, `${net({})}${getBlock({ ...DEFAULT_ROUTE, to: '10.0.0.0' })}`],
        ['empty output', SUBNET, ''],
        ['garbage', SUBNET, 'garbage\n\u0000\u0001: <<>>\n:::\n'],
        ['only the metrics table', SUBNET, METRICS],
        ['every line joined into one', SUBNET, net({}).replaceAll('\n', ' ')],
        ['lines separated by a bare carriage return', SUBNET, net({}).replaceAll('\n', '\r')],
      ])('never deletes when route get shows %s', async (_name, dst, stdout) => {
        const { runner, ops, entries } = existing(ADD_EXISTS, {}, { stdout });

        const result = await ops.routeAdd({ dst, gateway: GW });

        expect(result).toMatchObject({
          ok: false,
          outcome: 'failed',
          step: 'inspect',
          failure: 'existing-route-unknown',
          exitCode: 0,
          stdout,
        });
        expect(runner.calls.map((call) => call.args[1])).toEqual(['add', 'get']);
        const entry = only(entries);
        expect(entry.level).toBe('error');
        expect(entry.context).toMatchObject({ component: 'route', op: 'add', step: 'inspect', failure: 'existing-route-unknown', existing: 'unknown' });
      });

      // The lookup itself did not give an answer; whatever it printed is not read as one.
      it.each<[string, FakeCommandResponse, string]>([
        ['a timeout', { failure: 'timeout', error: 'Timed out after 10000 ms' }, 'route get failed: Timed out after 10000 ms'],
        [
          'a timeout that had already printed a complete gateway route',
          { failure: 'timeout', error: 'Timed out after 10000 ms', stdout: OTHER_GATEWAY },
          'route get failed: Timed out after 10000 ms',
        ],
        ['a spawn error', { failure: 'spawn-error', error: 'ENOENT: spawn /sbin/route ENOENT' }, 'route get failed: ENOENT: spawn /sbin/route ENOENT'],
        ['too much output', { failure: 'output-overflow', stdout: OTHER_GATEWAY }, 'route get failed: output-overflow'],
        ['a signal', { failure: 'signal', signal: 'SIGKILL', stdout: OTHER_GATEWAY }, 'route get failed: signal'],
        [
          'a non-zero exit with a diagnostic',
          { exitCode: 68, stderr: 'route: bad address: 10.0.0.0/8\n' },
          'route get failed: bad address: 10.0.0.0/8',
        ],
        ['a silent non-zero exit', { exitCode: 1, stdout: OTHER_GATEWAY }, 'route get failed: nonzero-exit'],
        [
          'exit code 0 with an error next to a complete gateway route',
          { exitCode: 0, stdout: OTHER_GATEWAY, stderr: 'route: writing to routing socket: Operation not permitted\n' },
          'route get failed: writing to routing socket: Operation not permitted',
        ],
        [
          '"not in table" with exit code 0 (real)',
          { exitCode: 0, stderr: 'route: writing to routing socket: not in table\n' },
          'route add reported an existing route, but route get found none',
        ],
        [
          '"not in table" with a non-zero exit code',
          { exitCode: 1, stderr: 'route: writing to routing socket: not in table\n' },
          'route add reported an existing route, but route get found none',
        ],
      ])('never deletes when route get ends in %s', async (_name, lookup, detail) => {
        const { runner, ops, entries } = existing(ADD_EXISTS, {}, lookup);

        const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

        expect(result).toMatchObject({
          ok: false,
          outcome: 'failed',
          step: 'inspect',
          failure: 'existing-route-unknown',
          message: `a route for 10.0.0.0/8 already exists and was left in place: ${detail}`,
        });
        expect(argvOf(runner)).toEqual([ADD, GET]);
        expect(only(entries).level).toBe('error');
      });
    });
  });

  describe('failures', () => {
    it.each<[string, FakeCommandResponse, Record<string, unknown>]>([
      [
        'a non-zero exit with stderr',
        { exitCode: 1, stderr: 'route: writing to routing socket: Network is unreachable\n' },
        { failure: 'nonzero-exit', exitCode: 1, message: 'writing to routing socket: Network is unreachable' },
      ],
      [
        'a non-zero exit without any output',
        { exitCode: 3 },
        { failure: 'nonzero-exit', exitCode: 3, message: 'route exited with code 3' },
      ],
      [
        'exit code 0 with an error on stderr',
        { exitCode: 0, stderr: 'route: writing to routing socket: Network is unreachable\n' },
        { failure: 'reported-error', exitCode: 0, message: 'writing to routing socket: Network is unreachable' },
      ],
      [
        'exit code 0 with an error only on stdout',
        { exitCode: 0, stdout: 'add host 172.16.12.40: gateway 10.20.4.1: Network is unreachable\n' },
        { failure: 'reported-error', exitCode: 0, message: 'Network is unreachable' },
      ],
      [
        'not being root',
        { exitCode: 77, stderr: 'route: must be root to alter routing table\n' },
        { failure: 'nonzero-exit', exitCode: 77, message: 'must be root to alter routing table' },
      ],
      [
        'a timeout',
        { failure: 'timeout', error: 'Timed out after 10000 ms' },
        { failure: 'timeout', exitCode: null, message: 'Timed out after 10000 ms' },
      ],
      [
        'a timeout whose partial output mentions "File exists"',
        { failure: 'timeout', error: 'Timed out after 10000 ms', stderr: 'route: writing to routing socket: File exists\n' },
        { failure: 'timeout', exitCode: null },
      ],
      [
        'a spawn error',
        { failure: 'spawn-error', error: 'ENOENT: spawn /sbin/route ENOENT' },
        { failure: 'spawn-error', exitCode: null, message: 'ENOENT: spawn /sbin/route ENOENT' },
      ],
    ])('returns a failure value for %s', async (_name, response, expected) => {
      const { runner, ops, entries } = setup();
      runner.whenMatching(() => response);

      const result = await ops.routeAdd({ dst: '172.16.12.40', gateway: GW });

      expect(result).toMatchObject({ ok: false, outcome: 'failed', step: 'add', ...expected });
      expect(runner.calls).toHaveLength(1);
      expect(only(entries).level).toBe('error');
    });

    it('does not mistake a successful line for an error', async () => {
      const { runner, ops } = setup();
      runner.whenMatching(() => ({ stdout: 'add host 172.16.12.40: gateway 10.20.4.1\n' }));

      expect(await ops.routeAdd({ dst: '172.16.12.40', gateway: GW })).toMatchObject({ ok: true });
    });
  });
});

describe('routeDelete', () => {
  it('deletes a subnet with -net', async () => {
    const { runner, ops, entries } = setup();
    runner.when(ROUTE, ['-n', 'delete', '-net', '10.0.0.0/8'], { stdout: 'delete net 10.0.0.0\n' });

    const result = await ops.routeDelete({ dst: '10.0.0.0/8' });

    expect(result).toEqual({ ok: true, outcome: 'deleted', dst: '10.0.0.0/8', kind: 'net' });
    expect(runner.calls).toHaveLength(1);
    expect(only(entries).context).toEqual({
      component: 'route',
      op: 'delete',
      dst: '10.0.0.0/8',
      gateway: null,
      kind: 'net',
      outcome: 'deleted',
    });
  });

  it('deletes a single address with -host and does not pass the gateway to the command', async () => {
    const { runner, ops, entries } = setup();
    runner.when(ROUTE, ['-n', 'delete', '-host', '10.0.0.0'], {});

    const result = await ops.routeDelete({ dst: '10.0.0.0/32', gateway: GW });

    expect(result).toEqual({ ok: true, outcome: 'deleted', dst: '10.0.0.0', kind: 'host' });
    expect(argvOf(runner)).toEqual([['-n', 'delete', '-host', '10.0.0.0']]);
    expect(only(entries).context).toMatchObject({ dst: '10.0.0.0', gateway: GW });
  });

  it('accepts an explicitly undefined gateway', async () => {
    const { runner, ops } = setup();
    runner.whenMatching(() => ({}));

    expect(await ops.routeDelete({ dst: '172.16.12.40', gateway: undefined })).toMatchObject({ ok: true });
  });

  it.each<[string, FakeCommandResponse]>([
    ['a non-zero exit code', DELETE_MISSING],
    ['exit code 0 and the error only in the output', { ...DELETE_MISSING, exitCode: 0 }],
    ['only the stderr line', { exitCode: 0, stderr: 'route: writing to routing socket: not in table\n' }],
    ['only the stdout line', { exitCode: 0, stdout: 'delete net 10.0.0.0: not in table\n' }],
    ['the errno wording', { exitCode: 1, stderr: 'route: writing to routing socket: No such process\n' }],
  ])('reports a missing route as not-found (%s)', async (_name, response) => {
    const { runner, ops, entries } = setup();
    runner.whenMatching(() => response);

    const result = await ops.routeDelete({ dst: '10.0.0.0/8', gateway: GW });

    expect(result).toEqual({ ok: true, outcome: 'not-found', dst: '10.0.0.0/8', kind: 'net' });
    expect(runner.calls).toHaveLength(1);
    const entry = only(entries);
    expect(entry.level).toBe('info');
    expect(entry.context).toMatchObject({ component: 'route', op: 'delete', outcome: 'not-found', gateway: GW });
  });

  it.each<[string, FakeCommandResponse, Record<string, unknown>]>([
    [
      'not being root',
      { exitCode: 77, stderr: 'route: must be root to alter routing table\n' },
      { failure: 'nonzero-exit', exitCode: 77, message: 'must be root to alter routing table' },
    ],
    [
      'exit code 0 with another error',
      { exitCode: 0, stdout: 'delete net 10.0.0.0: entry in use\n' },
      { failure: 'reported-error', exitCode: 0, message: 'entry in use' },
    ],
    ['a timeout', { failure: 'timeout', error: 'Timed out after 10000 ms' }, { failure: 'timeout' }],
  ])('returns a failure value for %s', async (_name, response, expected) => {
    const { runner, ops, entries } = setup();
    runner.whenMatching(() => response);

    const result = await ops.routeDelete({ dst: '10.0.0.0/8' });

    expect(result).toMatchObject({ ok: false, outcome: 'failed', step: 'delete', ...expected });
    expect(only(entries).level).toBe('error');
  });
});

describe('forbidden and invalid input never reaches a command', () => {
  describe.each([
    ['routeAdd', (ops: ReturnType<typeof setup>['ops'], dst: unknown) => ops.routeAdd(asAddRequest({ dst, gateway: GW }))],
    ['routeDelete', (ops: ReturnType<typeof setup>['ops'], dst: unknown) => ops.routeDelete(asDeleteRequest({ dst }))],
    [
      'routeDelete with a gateway',
      (ops: ReturnType<typeof setup>['ops'], dst: unknown) =>
        ops.routeDelete(asDeleteRequest({ dst, gateway: GW })),
    ],
  ])('%s', (_name, call) => {
    it.each(FORBIDDEN_DESTINATIONS)('rejects %j as %s', async (dst, reason) => {
      const { runner, ops, entries } = setup();

      const result = await call(ops, dst);

      expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'dst', reason });
      expect(runner.calls).toHaveLength(0);
      const entry = only(entries);
      expect(entry.level).toBe('warn');
      expect(entry.context).toMatchObject({ component: 'route', outcome: 'rejected', reason, dst });
    });

    it.each(UNPARSABLE_DESTINATIONS)('rejects %j as invalid', async (dst) => {
      const { runner, ops } = setup();

      const result = await call(ops, dst);

      expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'dst', reason: 'invalid-destination' });
      expect(runner.calls).toHaveLength(0);
    });

    it.each(NON_STRINGS)('rejects the non-string %o', async (dst) => {
      const { runner, ops, entries } = setup();

      const result = await call(ops, dst);

      expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'dst', reason: 'invalid-destination' });
      expect(runner.calls).toHaveLength(0);
      expect(only(entries).context).toMatchObject({ dst: `<${typeof dst}>` });
    });
  });

  it.each([undefined, null, 'x', 7])('rejects a request that is not an object (%o)', async (request) => {
    const { runner, ops } = setup();

    expect(await ops.routeAdd(asAddRequest(request))).toMatchObject({ outcome: 'rejected', field: 'dst' });
    expect(await ops.routeDelete(asDeleteRequest(request))).toMatchObject({
      outcome: 'rejected',
      field: 'dst',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it.each(BAD_GATEWAYS)('routeAdd rejects the gateway %j as %s', async (gateway, reason) => {
    const { runner, ops, entries } = setup();

    const result = await ops.routeAdd(asAddRequest({ dst: '10.0.0.0/8', gateway }));

    expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'gateway', reason });
    expect(runner.calls).toHaveLength(0);
    expect(only(entries).context).toMatchObject({ component: 'route', op: 'add', field: 'gateway' });
  });

  it.each(BAD_GATEWAYS.filter(([gateway]) => gateway !== undefined))(
    'routeDelete rejects the gateway %j as %s',
    async (gateway, reason) => {
      const { runner, ops } = setup();

      const result = await ops.routeDelete(asDeleteRequest({ dst: '10.0.0.0/8', gateway }));

      expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'gateway', reason });
      expect(runner.calls).toHaveLength(0);
    },
  );

  it('reports the destination first when both values are bad', async () => {
    const { runner, ops } = setup();

    const result = await ops.routeAdd({ dst: 'default', gateway: 'garbage' });

    expect(result).toMatchObject({ field: 'dst', reason: 'default-route' });
    expect(runner.calls).toHaveLength(0);
  });

  it('truncates a refused value in the log', async () => {
    const { ops, entries } = setup();

    await ops.routeAdd({ dst: 'x'.repeat(5000), gateway: GW });

    expect(only(entries).context).toMatchObject({ dst: 'x'.repeat(64) });
  });
});

describe('routeGet', () => {
  const GET = (ip: string): string[] => ['-n', 'get', '-host', ip];

  it('parses a route through a gateway', async () => {
    const { runner, ops, entries } = setup();
    runner.when(ROUTE, GET('172.16.12.40'), { stdout: GET_VIA_GATEWAY });

    const result = await ops.routeGet('172.16.12.40');

    expect(result).toEqual({
      ok: true,
      outcome: 'found',
      route: {
        target: '172.16.12.40',
        destination: '172.16.12.40',
        mask: null,
        gateway: '10.20.4.1',
        iface: 'en5',
        flags: ['UP', 'GATEWAY', 'HOST', 'DONE', 'STATIC'],
      },
    });
    expect(only(entries).context).toEqual({
      component: 'route',
      op: 'get',
      dst: '172.16.12.40',
      gateway: '10.20.4.1',
      iface: 'en5',
      outcome: 'found',
    });
  });

  it('parses a lookup that falls through to the default route', async () => {
    const { runner, ops } = setup();
    runner.when(ROUTE, GET('1.1.1.1'), { stdout: GET_VIA_DEFAULT });

    expect(await ops.routeGet('1.1.1.1')).toMatchObject({
      ok: true,
      route: { destination: 'default', mask: 'default', gateway: '192.168.1.1', iface: 'en0' },
    });
  });

  it('reports no gateway for a directly reachable address', async () => {
    const { runner, ops } = setup();
    runner.when(ROUTE, GET('192.168.1.20'), { stdout: GET_ON_LINK });

    expect(await ops.routeGet('192.168.1.20')).toMatchObject({
      ok: true,
      route: { gateway: null, iface: 'en0', mask: null },
    });
  });

  it('may look up an address that could never be added, and keeps -host for a zero host part', async () => {
    const { runner, ops } = setup();
    runner.whenMatching(() => ({ stdout: GET_VIA_DEFAULT }));

    expect(await ops.routeGet('127.0.0.1')).toMatchObject({ ok: true });
    expect(await ops.routeGet('10.0.0.0')).toMatchObject({ ok: true, route: { target: '10.0.0.0' } });
    expect(argvOf(runner)).toEqual([GET('127.0.0.1'), GET('10.0.0.0')]);
  });

  it.each<[string, FakeCommandResponse]>([
    // Real macOS 26 behaviour: the error is printed and the exit code is 0.
    ['exit code 0', { exitCode: 0, stderr: 'route: writing to routing socket: not in table\n' }],
    ['a non-zero exit code', { exitCode: 1, stderr: 'route: writing to routing socket: not in table\n' }],
  ])('reports "not in table" as not-found (%s)', async (_name, response) => {
    const { runner, ops, entries } = setup();
    runner.when(ROUTE, GET('172.16.12.40'), response);

    expect(await ops.routeGet('172.16.12.40')).toEqual({ ok: false, outcome: 'not-found', target: '172.16.12.40' });
    expect(only(entries).context).toMatchObject({ component: 'route', op: 'get', outcome: 'not-found' });
  });

  it.each<[string, FakeCommandResponse, Record<string, unknown>]>([
    [
      'a non-zero exit',
      { exitCode: 68, stderr: 'route: bad address: 172.16.12.40\n' },
      { failure: 'nonzero-exit', exitCode: 68, message: 'bad address: 172.16.12.40' },
    ],
    ['a timeout', { failure: 'timeout', error: 'Timed out after 10000 ms' }, { failure: 'timeout' }],
    ['empty output', {}, { failure: 'reported-error', message: 'unrecognised output from route get' }],
    [
      'output without an interface line',
      { stdout: '   route to: 172.16.12.40\ndestination: 172.16.12.40\n' },
      { failure: 'reported-error', exitCode: 0 },
    ],
    [
      'an interface value that is not a device name',
      { stdout: 'destination: default\n  interface: en0; id\n' },
      { failure: 'reported-error' },
    ],
  ])('returns a failure value for %s', async (_name, response, expected) => {
    const { runner, ops, entries } = setup();
    runner.whenMatching(() => response);

    expect(await ops.routeGet('172.16.12.40')).toMatchObject({ ok: false, outcome: 'failed', step: 'get', ...expected });
    expect(only(entries).level).toBe('error');
  });

  it.each([
    'default',
    '',
    'corp.local',
    '10.0.0.0/8',
    '172.16.12.40/32',
    '010.1.1.1',
    '10.1.2',
    '::1',
    ' 172.16.12.40',
    '172.16.12.40\n',
    '-net',
    '-ifscope',
    undefined,
    null,
    42,
    {},
    ['172.16.12.40'],
  ])('rejects the target %j without running a command', async (target) => {
    const { runner, ops, entries } = setup();

    const result = await ops.routeGet(asTarget(target));

    expect(result).toMatchObject({ ok: false, outcome: 'rejected', field: 'target', reason: 'invalid-ipv4' });
    expect(runner.calls).toHaveLength(0);
    expect(only(entries).level).toBe('warn');
  });
});

describe('parseRouteGetOutput', () => {
  it('ignores the metrics table and unknown lines', () => {
    expect(parseRouteGetOutput('1.1.1.1', GET_VIA_DEFAULT)).toEqual({
      target: '1.1.1.1',
      destination: 'default',
      mask: 'default',
      gateway: '192.168.1.1',
      iface: 'en0',
      flags: ['UP', 'GATEWAY', 'DONE', 'STATIC', 'PRCLONING', 'GLOBAL'],
    });
  });

  it('reports a link-level gateway as no gateway and tolerates missing flags', () => {
    const output = 'destination: 192.168.1.0\n       mask: 255.255.255.0\n    gateway: link#15\n  interface: en0\n';

    expect(parseRouteGetOutput('192.168.1.20', output)).toEqual({
      target: '192.168.1.20',
      destination: '192.168.1.0',
      mask: '255.255.255.0',
      gateway: null,
      iface: 'en0',
      flags: [],
    });
  });

  it('keeps the first value when a key is repeated', () => {
    const output = 'destination: default\n  interface: en0\n  interface: en5\n      flags: <>\n';

    expect(parseRouteGetOutput('1.1.1.1', output)).toMatchObject({ iface: 'en0', flags: [] });
  });

  it.each(['', 'garbage', '  interface: en0\n', 'destination: default\n', 'destination: \n  interface: en0\n'])(
    'returns null for %j',
    (output) => {
      expect(parseRouteGetOutput('1.1.1.1', output)).toBeNull();
    },
  );

  it('accepts CRLF line endings and surrounding whitespace', () => {
    const output = 'destination: default\r\n    gateway:   192.168.1.1  \r\n\t interface:\ten0 \r\n      flags: <UP,DONE>\r\n';

    expect(parseRouteGetOutput('1.1.1.1', output)).toEqual({
      target: '1.1.1.1',
      destination: 'default',
      mask: null,
      gateway: '192.168.1.1',
      iface: 'en0',
      flags: ['UP', 'DONE'],
    });
  });

  it('splits a line at its first colon and keeps later colons in the value', () => {
    const output = 'destination: default\n    gateway: aa:bb:cc:dd:ee:ff\n  interface: en0\n';

    expect(parseRouteGetOutput('1.1.1.1', output)).toMatchObject({ gateway: null, iface: 'en0' });
  });

  it.each([
    ['a line terminator inside the value', 'destination: default\n  interface: en0\rx\n'],
    ['an upper-case key', 'destination: default\n  Interface: en0\n'],
    ['a key that does not start with a letter', 'destination: default\n  1interface: en0\n'],
    ['a line without a colon', 'destination: default\n  interface en0\n'],
  ])('ignores a line with %s', (_name, output) => {
    expect(parseRouteGetOutput('1.1.1.1', output)).toBeNull();
  });

  it('parses a line with a stray carriage return after a long run of spaces in linear time', () => {
    // The former `\s*(.*?)\s*$` pattern needed about 10 s for 4000 spaces here.
    const hostile = `destination: default\n  interface: en0\na:${' '.repeat(200_000)}x\ry\n`.repeat(5);

    const startedAt = performance.now();
    const route = parseRouteGetOutput('1.1.1.1', hostile);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(route).toMatchObject({ destination: 'default', iface: 'en0' });
  });
});

describe('classifyExistingRoute', () => {
  const dotted = (prefix: number): string => {
    const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return [24, 16, 8, 0].map((shift) => String((bits >>> shift) & 0xff)).join('.');
  };
  const block = (mask: string | undefined, flags = NET_GATEWAY_FLAGS): string =>
    getBlock({ to: '10.0.0.0', destination: '10.0.0.0', mask, gateway: OTHER_GW, iface: 'en0', flags });
  const PREFIXES = Array.from({ length: 33 }, (_unused, prefix) => prefix);

  it('builds the masks the tests rely on', () => {
    expect([0, 8, 12, 24, 26, 32].map(dotted)).toEqual([
      '0.0.0.0',
      '255.0.0.0',
      '255.240.0.0',
      '255.255.255.0',
      '255.255.255.192',
      '255.255.255.255',
    ]);
  });

  it.each(PREFIXES.filter((prefix) => prefix >= 8 && prefix < 32))(
    'takes a /%i subnet entry as exact only for the dotted mask of that very prefix',
    (prefix) => {
      const wanted = { kind: 'net', address: '10.0.0.0', prefix } as const;
      for (const other of PREFIXES) {
        const verdict = classifyExistingRoute(wanted, GW, block(dotted(other)));
        expect([other, verdict.state]).toEqual([other, other === prefix ? 'gateway' : 'unknown']);
      }
    },
  );

  it('takes a hexadecimal mask the same way', () => {
    const wanted = { kind: 'net', address: '10.0.0.0', prefix: 12 } as const;
    expect(classifyExistingRoute(wanted, GW, block('0xfff00000')).state).toBe('gateway');
    expect(classifyExistingRoute(wanted, GW, block('0xFFF00000')).state).toBe('gateway');
    expect(classifyExistingRoute(wanted, GW, block('0xffe00000')).state).toBe('unknown');
    expect(classifyExistingRoute(wanted, GW, block('0xfff80000')).state).toBe('unknown');
  });

  it('takes a host entry as exact without a mask (HOST flag) or with a /32 mask, and with nothing else', () => {
    const wanted = { kind: 'host', address: '10.0.0.0', prefix: 32 } as const;
    expect(classifyExistingRoute(wanted, GW, block(undefined, HOST_GATEWAY_FLAGS)).state).toBe('gateway');
    expect(classifyExistingRoute(wanted, GW, block('255.255.255.255')).state).toBe('gateway');
    expect(classifyExistingRoute(wanted, GW, block('255.255.255.255', HOST_GATEWAY_FLAGS)).state).toBe('gateway');
    expect(classifyExistingRoute(wanted, GW, block(undefined)).state).toBe('unknown');
    for (const prefix of PREFIXES.filter((value) => value < 32)) {
      expect(classifyExistingRoute(wanted, GW, block(dotted(prefix), HOST_GATEWAY_FLAGS)).state).toBe('unknown');
    }
  });

  it('reports the gateway, the interface and whether it is the requested gateway', () => {
    const wanted = { kind: 'net', address: '10.0.0.0', prefix: 8 } as const;
    expect(classifyExistingRoute(wanted, GW, block('255.0.0.0'))).toEqual({
      state: 'gateway',
      gateway: OTHER_GW,
      iface: 'en0',
      sameAsRequested: false,
    });
    expect(classifyExistingRoute(wanted, OTHER_GW, block('255.0.0.0'))).toEqual({
      state: 'gateway',
      gateway: OTHER_GW,
      iface: 'en0',
      sameAsRequested: true,
    });
  });

  it('classifies the captured blocks', () => {
    expect(
      classifyExistingRoute({ kind: 'net', address: '192.168.1.0', prefix: 24 }, GW, GET_CONNECTED_SUBNET),
    ).toEqual({ state: 'connected', iface: 'en0', detail: 'the existing entry has no GATEWAY flag' });
    expect(classifyExistingRoute({ kind: 'host', address: '192.168.1.1', prefix: 32 }, GW, GET_GATEWAY_NEIGHBOUR).state).toBe('connected');
    expect(classifyExistingRoute({ kind: 'host', address: '192.168.1.23', prefix: 32 }, GW, GET_OWN_ADDRESS)).toMatchObject({
      state: 'connected',
      iface: 'lo0',
    });
    expect(classifyExistingRoute({ kind: 'host', address: '172.16.12.40', prefix: 32 }, GW, GET_VIA_GATEWAY)).toMatchObject({
      state: 'gateway',
      gateway: GW,
      iface: 'en5',
      sameAsRequested: true,
    });
    // The same blocks asked about another destination describe an entry that is not the one in the way.
    expect(classifyExistingRoute({ kind: 'net', address: '192.168.1.0', prefix: 25 }, GW, GET_CONNECTED_SUBNET).state).toBe('unknown');
    expect(classifyExistingRoute({ kind: 'host', address: '192.168.1.0', prefix: 32 }, GW, GET_CONNECTED_SUBNET).state).toBe('unknown');
    expect(classifyExistingRoute({ kind: 'host', address: '1.1.1.1', prefix: 32 }, GW, GET_VIA_DEFAULT).state).toBe('unknown');
  });

  it('reads a megabyte of hostile output in linear time and settles on "unknown"', () => {
    const hostile = `destination:${' '.repeat(500_000)}x\ry\n${'flags: <'.repeat(60_000)}`;
    const startedAt = performance.now();

    const verdict = classifyExistingRoute({ kind: 'net', address: '10.0.0.0', prefix: 8 }, GW, hostile);

    expect(verdict.state).toBe('unknown');
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
