import { describe, expect, it } from 'vitest';

import { createLogger, createMemorySink, type LogEntry } from './logger';
import {
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
const ADD_EXISTS: FakeCommandResponse = {
  exitCode: 1,
  stdout: 'add net 10.0.0.0: gateway 10.20.4.1: File exists\n',
  stderr: 'route: writing to routing socket: File exists\n',
};
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
    const DELETE = ['-n', 'delete', '-net', '10.0.0.0/8'];

    /** First `add` answers "File exists"; later ones answer `second`. */
    const existing = (first: FakeCommandResponse, second: FakeCommandResponse) => {
      const context = setup();
      let adds = 0;
      context.runner.whenMatching((_bin, args) => {
        if (args[1] !== 'add') return undefined;
        adds += 1;
        return adds === 1 ? first : second;
      });
      return context;
    };

    it.each([
      ['a non-zero exit code', ADD_EXISTS],
      ['exit code 0 and the error only in the output', { ...ADD_EXISTS, exitCode: 0 }],
      ['only the stderr line', { exitCode: 1, stderr: 'route: writing to routing socket: File exists\n' }],
      ['only the stdout line', { exitCode: 0, stdout: 'add net 10.0.0.0: gateway 10.20.4.1: File exists\n' }],
      ['the "route already in table" wording', { exitCode: 1, stderr: 'route: route already in table\n' }],
    ])('deletes it and adds it again (%s)', async (_name, first) => {
      const { runner, ops, entries } = existing(first, { stdout: 'add net 10.0.0.0: gateway 10.20.4.1\n' });
      runner.when(ROUTE, DELETE, { stdout: 'delete net 10.0.0.0\n' });

      const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

      expect(result).toEqual({ ok: true, outcome: 'replaced', dst: '10.0.0.0/8', kind: 'net', gateway: GW });
      expect(argvOf(runner)).toEqual([ADD, DELETE, ADD]);
      expect(only(entries).context).toMatchObject({ component: 'route', outcome: 'replaced' });
    });

    it('uses -host for the delete and the second add of a single address', async () => {
      const { runner, ops } = existing(ADD_EXISTS, {});
      runner.when(ROUTE, ['-n', 'delete', '-host', '10.0.0.0'], {});

      const result = await ops.routeAdd({ dst: '10.0.0.0', gateway: GW });

      expect(result).toMatchObject({ ok: true, outcome: 'replaced', kind: 'host' });
      expect(argvOf(runner)).toEqual([
        ['-n', 'add', '-host', '10.0.0.0', GW],
        ['-n', 'delete', '-host', '10.0.0.0'],
        ['-n', 'add', '-host', '10.0.0.0', GW],
      ]);
    });

    it('still adds again when the route vanished before the delete', async () => {
      const { runner, ops } = existing(ADD_EXISTS, {});
      runner.when(ROUTE, DELETE, DELETE_MISSING);

      const result = await ops.routeAdd({ dst: '10.0.0.0/8', gateway: GW });

      expect(result).toMatchObject({ ok: true, outcome: 'replaced' });
      expect(argvOf(runner)).toEqual([ADD, DELETE, ADD]);
    });

    it('fails after one retry when the second add reports "File exists" again', async () => {
      const { runner, ops, entries } = existing(ADD_EXISTS, ADD_EXISTS);
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
      expect(argvOf(runner)).toEqual([ADD, DELETE, ADD]);
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
      expect(runner.calls).toHaveLength(3);
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
      expect(argvOf(runner)).toEqual([ADD, DELETE]);
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
