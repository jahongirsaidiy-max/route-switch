import { AdapterInfo, InterfaceState, PROTOCOL_LIMITS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import type { CommandRunner } from './exec';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import {
  createNetInfo,
  expandNetstatDestination,
  NETINFO_CACHE_TTL_MS,
  NETINFO_COMMAND_TIMEOUT_MS,
  NETSTAT_MAX_LINE_LENGTH,
  NETSTAT_MAX_LINES,
  netmaskToPrefix,
  parseHardwarePorts,
  parseRoutingTable,
  toInterfaceState,
  toWireInterfaces,
  type DetectOptions,
  type IfaceOverrides,
} from './netinfo';
import { createFakeCommandRunner, type FakeCommandResponse, type FakeCommandRunner } from './test-utils';

const NETWORKSETUP = '/usr/sbin/networksetup';
const IPCONFIG = '/usr/sbin/ipconfig';
const LIST_PORTS = ['-listallhardwareports'];
const NETSTAT = '/usr/sbin/netstat';
const ROUTES = ['-rn', '-f', 'inet'];

const ROUTES_HEADER = [
  'Routing tables',
  '',
  'Internet:',
  'Destination        Gateway            Flags               Netif Expire',
];

/** A `netstat -rn -f inet` output with the given rows under the usual header. */
const routes = (...rows: string[]): string => [...ROUTES_HEADER, ...rows, ''].join('\n');

// What the table looks like when no en* device has a route: only loopback.
const LOOPBACK_ROUTES = routes(
  '127                127.0.0.1          UCS                   lo0       ',
  '127.0.0.1          127.0.0.1          UH                    lo0       ',
);

// Shape captured from `networksetup -listallhardwareports` on macOS 26.3.1 and
// anonymised: generic port names and devices, documentation MAC addresses.
// Note the leading blank line, the non-`en` bridge device, the Wi-Fi port in
// the middle of the list and the trailing VLAN section.
const PORTS = `
Hardware Port: USB 10/100/1000 LAN
Device: en5
Ethernet Address: 00:00:5e:00:53:05

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 00:00:5e:00:53:b0

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 00:00:5e:00:53:00

Hardware Port: Thunderbolt 1
Device: en1
Ethernet Address: 00:00:5e:00:53:01

Hardware Port: USB 10/100 LAN
Device: en7
Ethernet Address: 00:00:5e:00:53:07

VLAN Configurations
===================
`;

const WIFI_ONLY_PORTS = `
Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 00:00:5e:00:53:00

VLAN Configurations
===================
`;

interface FakeIface {
  readonly ip?: string;
  readonly router?: string;
  readonly mask?: string;
}

const WIFI: FakeIface = { ip: '192.168.1.23', router: '192.168.1.1', mask: '255.255.255.0' };
const ETHERNET: FakeIface = { ip: '10.20.4.57', router: '10.20.4.1', mask: '255.255.252.0' };

// What `ipconfig` does without a value (no address, no lease, unknown device):
// exit code 1, nothing on stdout or stderr. Observed on macOS 26.3.1.
const NO_VALUE: FakeCommandResponse = { exitCode: 1 };
const USAGE: FakeCommandResponse = {
  exitCode: 1,
  stderr: 'usage: /usr/sbin/ipconfig <command> <args>\nwhere <command> is one of waitall, getifaddr\n',
};

const FAILURES: readonly (readonly [string, FakeCommandResponse])[] = [
  ['an unexpected exit code', { exitCode: 2, stderr: 'boom\n' }],
  ['a timeout', { failure: 'timeout', signal: 'SIGKILL', error: 'Timed out after 5000 ms' }],
  ['a spawn error', { failure: 'spawn-error', error: 'ENOENT: spawn failed' }],
  ['an output overflow', { failure: 'output-overflow', error: 'Output exceeded 1048576 bytes' }],
  ['a foreign signal', { failure: 'signal', signal: 'SIGTERM', error: 'Terminated by SIGTERM' }],
];

const value = (text: string | undefined): FakeCommandResponse =>
  text === undefined ? NO_VALUE : { stdout: `${text}\n` };

const setup = (ports: string = PORTS, ifaces: Readonly<Record<string, FakeIface>> = {}) => {
  const runner = createFakeCommandRunner();
  runner.when(NETWORKSETUP, LIST_PORTS, { stdout: ports });
  // Consulted only when a lease has no router or mask; tests of the fallback replace it.
  runner.when(NETSTAT, ROUTES, { stdout: LOOPBACK_ROUTES });
  runner.whenMatching((bin, args) => {
    if (bin !== IPCONFIG) return undefined;
    const [command, device = '', option] = args;
    const iface = ifaces[device] ?? {};
    if (command === 'getifaddr' && args.length === 2) return value(iface.ip);
    if (command === 'getoption' && args.length === 3 && option === 'router') return value(iface.router);
    if (command === 'getoption' && args.length === 3 && option === 'subnet_mask') return value(iface.mask);
    return undefined;
  });
  const memory = createMemorySink();
  const logger = createLogger({ sinks: [memory.sink] });
  const clock = { ms: 1_000 };
  const netinfo = createNetInfo({ runner, logger, now: () => clock.ms });
  return { runner, netinfo, clock, entries: memory.entries };
};

const BOTH = { en0: WIFI, en5: ETHERNET };

const argvOf = (runner: FakeCommandRunner): string[] =>
  runner.calls.map((call) => [call.bin.split('/').at(-1) ?? '', ...call.args].join(' '));

const summaries = (entries: readonly LogEntry[]): LogEntry[] =>
  entries.filter((entry) => entry.msg === 'interfaces detected');

const warnings = (entries: readonly LogEntry[]): LogEntry[] =>
  entries.filter((entry) => entry.level === 'warn' || entry.level === 'error');

describe('parseHardwarePorts', () => {
  it('reads every port block and stops at the VLAN section', () => {
    expect(parseHardwarePorts(PORTS)).toEqual([
      { port: 'USB 10/100/1000 LAN', device: 'en5' },
      { port: 'Thunderbolt Bridge', device: 'bridge0' },
      { port: 'Wi-Fi', device: 'en0' },
      { port: 'Thunderbolt 1', device: 'en1' },
      { port: 'USB 10/100 LAN', device: 'en7' },
    ]);
  });

  it('tolerates CRLF, trailing whitespace and indentation', () => {
    const text = 'Hardware Port: Wi-Fi  \r\nDevice: en0\t\r\nEthernet Address: 00:00:5e:00:53:00\r\n\r\n  Hardware Port:USB LAN\r\n  Device:   en5  \r\n';

    expect(parseHardwarePorts(text)).toEqual([
      { port: 'Wi-Fi', device: 'en0' },
      { port: 'USB LAN', device: 'en5' },
    ]);
  });

  it('skips blocks with a missing field, repeated devices and unknown blocks', () => {
    const text = [
      'Device: en9', // no port name before it
      '',
      'Hardware Port: No Device Here',
      'Ethernet Address: 00:00:5e:00:53:aa',
      '',
      'Device: en8', // the blank line ended the block above
      '',
      'Hardware Port:',
      'Device: en3', // empty port name
      '',
      'Hardware Port: Empty Device',
      'Device:',
      '',
      'Something Else: value',
      'Hardware Port: Wi-Fi',
      'Unexpected: line',
      'Device: en0',
      'Device: en6', // only the first device of a block counts
      '',
      'Hardware Port: Duplicate',
      'Device: en0',
      '',
      'VLAN Configurations',
      'Hardware Port: After VLAN',
      'Device: en4',
    ].join('\n');

    expect(parseHardwarePorts(text)).toEqual([{ port: 'Wi-Fi', device: 'en0' }]);
  });

  it('returns nothing for empty or garbled output', () => {
    expect(parseHardwarePorts('')).toEqual([]);
    expect(parseHardwarePorts('\n\n\r\n')).toEqual([]);
    expect(parseHardwarePorts('\u0000\u0001 not what we expect �')).toEqual([]);
    expect(parseHardwarePorts('Hardware Port Wi-Fi Device en0')).toEqual([]);
  });

  it('handles a pathological line in linear time', () => {
    const line = `Hardware Port:${' \r'.repeat(200_000)}`;
    const startedAt = performance.now();

    expect(parseHardwarePorts(`${line}\nDevice: en0\n`)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('netmaskToPrefix', () => {
  it.each([
    ['255.255.255.0', 24],
    ['255.255.252.0', 22],
    ['255.0.0.0', 8],
    ['128.0.0.0', 1],
    ['255.255.255.254', 31],
    ['255.255.255.255', 32],
  ])('%s -> /%i', (mask, prefix) => {
    expect(netmaskToPrefix(mask)).toBe(prefix);
  });

  it.each([
    '255.0.255.0',
    '255.255.255.1',
    '0.255.255.255',
    '255.255.0.255',
    '127.255.255.255',
    '0.0.0.0',
    '255.255.255',
    '255.255.255.0/24',
    '0xffffff00',
    '255.255.255.00',
    '255.255.255.256',
    ' 255.255.255.0',
    '',
    'ffff:ff00::',
  ])('rejects %j', (mask) => {
    expect(netmaskToPrefix(mask)).toBeNull();
  });
});

describe('detectInterfaces: roles', () => {
  it('reports both interfaces with address, gateway and connected subnet', async () => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toEqual({
      role: 'ethernet',
      device: 'en5',
      port: 'USB 10/100/1000 LAN',
      ip: '10.20.4.57',
      gateway: '10.20.4.1',
      netmask: '255.255.252.0',
      subnet: '10.20.4.0/22',
      up: true,
      routable: true,
      reason: null,
      overridden: false,
    });
    expect(result.wifi).toEqual({
      role: 'wifi',
      device: 'en0',
      port: 'Wi-Fi',
      ip: '192.168.1.23',
      gateway: '192.168.1.1',
      netmask: '255.255.255.0',
      subnet: '192.168.1.0/24',
      up: true,
      routable: true,
      reason: null,
      overridden: false,
    });
    expect(result.degraded).toBe(false);
    // 1 listing + one address query per en* port + router and mask per role.
    expect(argvOf(runner)).toEqual([
      'networksetup -listallhardwareports',
      'ipconfig getifaddr en5',
      'ipconfig getifaddr en0',
      'ipconfig getifaddr en1',
      'ipconfig getifaddr en7',
      'ipconfig getoption en5 router',
      'ipconfig getoption en5 subnet_mask',
      'ipconfig getoption en0 router',
      'ipconfig getoption en0 subnet_mask',
    ]);
    expect(warnings(entries)).toEqual([]);
  });

  it('marks every ipconfig call with the expected "no value" exit code and a timeout', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);

    await netinfo.detectInterfaces();

    const [listing, ...queries] = runner.calls;
    expect(listing?.options).toEqual({ timeoutMs: NETINFO_COMMAND_TIMEOUT_MS });
    expect(queries.length).toBeGreaterThan(0);
    for (const call of queries) {
      expect(call.bin).toBe(IPCONFIG);
      expect(call.options).toEqual({ timeoutMs: NETINFO_COMMAND_TIMEOUT_MS, expectedExitCodes: [1] });
    }
  });

  it('reports only Wi-Fi when there is no other en* port', async () => {
    const { netinfo, entries } = setup(WIFI_ONLY_PORTS, { en0: WIFI });

    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({ device: 'en0', up: true, routable: true, reason: null });
    expect(result.ethernet).toEqual({
      role: 'ethernet',
      device: null,
      port: null,
      ip: null,
      gateway: null,
      netmask: null,
      subnet: null,
      up: false,
      routable: false,
      reason: 'no-device',
      overridden: false,
    });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it('reports Ethernet as down, not as an error, when no candidate has an address (cable unplugged)', async () => {
    const { netinfo, runner, entries } = setup(PORTS, { en0: WIFI });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({
      device: null,
      ip: null,
      gateway: null,
      subnet: null,
      up: false,
      routable: false,
      reason: 'no-address',
    });
    expect(result.wifi).toMatchObject({ device: 'en0', routable: true });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
    // No router or mask query for a device without an address.
    expect(argvOf(runner).filter((argv) => argv.includes('getoption'))).toEqual([
      'ipconfig getoption en0 router',
      'ipconfig getoption en0 subnet_mask',
    ]);
  });

  it('reports Wi-Fi as down when it has no address', async () => {
    const { netinfo } = setup(PORTS, { en5: ETHERNET });

    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({ device: 'en0', port: 'Wi-Fi', ip: null, up: false, reason: 'no-address' });
    expect(result.ethernet).toMatchObject({ device: 'en5', routable: true });
  });

  it('reports no Wi-Fi device when there is no Wi-Fi port', async () => {
    const ports = 'Hardware Port: USB 10/100/1000 LAN\nDevice: en5\n';
    const { netinfo } = setup(ports, { en5: ETHERNET });

    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({ device: null, up: false, reason: 'no-device' });
    expect(result.ethernet).toMatchObject({ device: 'en5', routable: true });
  });

  it('recognises the Wi-Fi port whatever its letter case, and never by a partial name', async () => {
    const ports = 'Hardware Port: Wi-Fi Dongle\nDevice: en8\n\nHardware Port: WI-FI\nDevice: en2\n';
    const { netinfo } = setup(ports, { en2: WIFI, en8: ETHERNET });

    const result = await netinfo.detectInterfaces();

    expect(result.wifi.device).toBe('en2');
    expect(result.ethernet.device).toBe('en8');
  });

  it('reports Ethernet with an address but no gateway as up and not routable', async () => {
    const { netinfo, entries } = setup(PORTS, { en0: WIFI, en5: { ip: '10.20.4.57', mask: '255.255.252.0' } });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({
      device: 'en5',
      ip: '10.20.4.57',
      gateway: null,
      subnet: '10.20.4.0/22',
      up: true,
      routable: false,
      reason: 'no-gateway',
    });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it('picks the first Ethernet candidate that has an address, in listing order', async () => {
    const second = { ip: '10.30.0.9', router: '10.30.0.1', mask: '255.255.0.0' };

    const both = await setup(PORTS, { en5: ETHERNET, en7: second }).netinfo.detectInterfaces();
    expect(both.ethernet).toMatchObject({ device: 'en5', gateway: '10.20.4.1' });

    const onlySecond = await setup(PORTS, { en7: second }).netinfo.detectInterfaces();
    expect(onlySecond.ethernet).toMatchObject({
      device: 'en7',
      port: 'USB 10/100 LAN',
      gateway: '10.30.0.1',
      subnet: '10.30.0.0/16',
    });

    // Port names are not interpreted: an en* Thunderbolt port with an address qualifies.
    const thunderbolt = await setup(PORTS, { en1: second, en7: ETHERNET }).netinfo.detectInterfaces();
    expect(thunderbolt.ethernet).toMatchObject({ device: 'en1', port: 'Thunderbolt 1' });
  });

  it('never considers a device that is not en<digits>', async () => {
    const ports = [
      'Hardware Port: Thunderbolt Bridge\nDevice: bridge0\n',
      'Hardware Port: Odd\nDevice: en5;reboot\n',
      'Hardware Port: Odd 2\nDevice: en5 -x\n',
      'Hardware Port: Odd 3\nDevice: -en5\n',
      'Hardware Port: Odd 4\nDevice: EN5\n',
      'Hardware Port: Odd 5\nDevice: en\n',
      'Hardware Port: Odd 6\nDevice: en12345678901234567\n',
      'Hardware Port: Loopback\nDevice: lo0\n',
      'Hardware Port: Wi-Fi\nDevice: en0\n',
    ].join('\n');
    const { netinfo, runner } = setup(ports, { en0: WIFI });

    const result = await netinfo.detectInterfaces();

    expect(result.adapters).toEqual([{ device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' }]);
    expect(result.ethernet.reason).toBe('no-device');
    for (const call of runner.calls.slice(1)) expect(call.args[1]).toBe('en0');
  });

  it('reports both interfaces in one subnet as they are', async () => {
    const { netinfo } = setup(PORTS, {
      en0: WIFI,
      en5: { ip: '192.168.1.77', router: '192.168.1.1', mask: '255.255.255.0' },
    });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ device: 'en5', subnet: '192.168.1.0/24', gateway: '192.168.1.1' });
    expect(result.wifi).toMatchObject({ device: 'en0', subnet: '192.168.1.0/24', gateway: '192.168.1.1' });
    expect(result.ethernet.routable && result.wifi.routable).toBe(true);
  });

  it('clears the host bits of the connected subnet', async () => {
    const { netinfo } = setup(PORTS, { en0: { ip: '172.16.200.9', router: '172.16.0.1', mask: '255.240.0.0' } });

    expect((await netinfo.detectInterfaces()).wifi.subnet).toBe('172.16.0.0/12');
  });
});

describe('detectInterfaces: overrides', () => {
  it('uses the overridden device even when the heuristic would pick another', async () => {
    const second = { ip: '10.30.0.9', router: '10.30.0.1', mask: '255.255.0.0' };
    const { netinfo } = setup(PORTS, { ...BOTH, en7: second });

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en7' } });

    expect(result.ethernet).toMatchObject({
      device: 'en7',
      port: 'USB 10/100 LAN',
      gateway: '10.30.0.1',
      routable: true,
      overridden: true,
    });
    expect(result.wifi).toMatchObject({ device: 'en0', overridden: false });
  });

  it('keeps the overridden device when it has no address, instead of falling back', async () => {
    const { netinfo } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en7' } });

    expect(result.ethernet).toMatchObject({
      device: 'en7',
      ip: null,
      up: false,
      routable: false,
      reason: 'no-address',
      overridden: true,
    });
  });

  it('can pin Wi-Fi to another device; the Wi-Fi port is still not an Ethernet candidate', async () => {
    const { netinfo } = setup(PORTS, { en0: WIFI, en7: ETHERNET });

    const result = await netinfo.detectInterfaces({ overrides: { wifi: 'en7' } });

    expect(result.wifi).toMatchObject({ device: 'en7', routable: true, overridden: true });
    // en7 is taken by wifi, en0 is the Wi-Fi port, en5/en1 have no address.
    expect(result.ethernet).toMatchObject({ device: null, reason: 'no-address' });
  });

  it('reports an overridden device that is not a hardware port as down, with a reason', async () => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en42' } });

    expect(result.ethernet).toEqual({
      role: 'ethernet',
      device: 'en42',
      port: null,
      ip: null,
      gateway: null,
      netmask: null,
      subnet: null,
      up: false,
      routable: false,
      reason: 'override-not-found',
      overridden: true,
    });
    expect(result.wifi).toMatchObject({ device: 'en0', routable: true });
    expect(argvOf(runner).some((argv) => argv.includes('en42'))).toBe(false);
    expect(warnings(entries).map((entry) => entry.msg)).toEqual(['overridden device is not a hardware port']);
  });

  it('gives a device overridden for both roles to ethernet and reports wifi as a conflict', async () => {
    const { netinfo } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en5', wifi: 'en5' } });

    expect(result.ethernet).toMatchObject({ device: 'en5', routable: true, reason: null, overridden: true });
    expect(result.wifi).toMatchObject({
      device: 'en5',
      ip: null,
      gateway: null,
      up: false,
      routable: false,
      reason: 'override-conflict',
      overridden: true,
    });
  });

  it('does not give the Wi-Fi port to wifi when ethernet is overridden to it', async () => {
    const { netinfo } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en0' } });

    expect(result.ethernet).toMatchObject({ device: 'en0', port: 'Wi-Fi', routable: true, overridden: true });
    expect(result.wifi).toMatchObject({ device: null, up: false, reason: 'override-conflict', overridden: false });
  });

  it.each([
    ['a shell-looking name', 'en5; rm -rf /'],
    ['an option-looking name', '-en5'],
    ['a trailing newline', 'en5\n'],
    ['a leading space', ' en5'],
    ['a second argument', 'en5 en7'],
    ['another interface family', 'bridge0'],
    ['upper case', 'EN5'],
    ['no number', 'en'],
    ['a path', '../en5'],
    ['an over-long name', 'en12345678901234567'],
    ['an empty string', ''],
    ['a number', 5],
    ['null', null],
    ['an object', { toString: () => 'en5' }],
  ])('never puts a malformed override (%s) into an argv', async (_label, override) => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    const overrides = { ethernet: override } as unknown as IfaceOverrides;

    const result = await netinfo.detectInterfaces({ overrides });

    expect(result.ethernet).toEqual({
      role: 'ethernet',
      device: null,
      port: null,
      ip: null,
      gateway: null,
      netmask: null,
      subnet: null,
      up: false,
      routable: false,
      reason: 'invalid-override',
      overridden: true,
    });
    expect(result.wifi).toMatchObject({ device: 'en0', routable: true });
    const queried = runner.calls.slice(1).map((call) => call.args[1]);
    expect(queried.every((device) => device !== undefined && /^en\d+$/.test(device))).toBe(true);
    expect(new Set(queried)).toEqual(new Set(['en5', 'en0', 'en1', 'en7']));
  });

  it('ignores overrides that are not an object, and undefined entries', async () => {
    const plain = await setup(PORTS, BOTH).netinfo.detectInterfaces();

    for (const overrides of [undefined, null, 'en7', 7, {}, { ethernet: undefined }]) {
      const result = await setup(PORTS, BOTH).netinfo.detectInterfaces({ overrides: overrides as IfaceOverrides });
      expect(result).toEqual(plain);
    }
  });
});

describe('detectInterfaces: failures', () => {
  it.each(FAILURES)('reports both roles down when networksetup fails with %s', async (_label, response) => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);
    runner.when(NETWORKSETUP, LIST_PORTS, response);

    const result = await netinfo.detectInterfaces();

    for (const role of ['ethernet', 'wifi'] as const) {
      expect(result[role]).toEqual({
        role,
        device: null,
        port: null,
        ip: null,
        gateway: null,
        netmask: null,
        subnet: null,
        up: false,
        routable: false,
        reason: 'hardware-ports-unavailable',
        overridden: false,
      });
    }
    expect(result.adapters).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(warnings(entries).map((entry) => entry.msg)).toEqual(['could not list hardware ports']);
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \r\n\r\n'],
    ['garbled', 'Hardwar Prt Wi-Fi\nDevic en0\n\u0000\u0007'],
    ['only a VLAN section', 'VLAN Configurations\n===================\n'],
    ['an error message', 'networksetup: Unable to commit changes to network database.\n'],
  ])('reports both roles down for %s networksetup output', async (_label, stdout) => {
    const { netinfo, runner } = setup(stdout, BOTH);

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en5' } });

    expect(result.ethernet).toMatchObject({ device: null, up: false, reason: 'hardware-ports-unavailable' });
    expect(result.wifi).toMatchObject({ device: null, up: false, reason: 'hardware-ports-unavailable' });
    expect(result.adapters).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });

  type Answer = readonly [string, FakeCommandResponse];
  /** Ways any single-value query can go wrong, plus the ones specific to a field. */
  const badAnswers = (specific: readonly Answer[]): Answer[] => [
    ...FAILURES,
    ['exit 1 with a usage message', USAGE],
    ['exit 0 with no output', { stdout: '' }],
    ['two lines', { stdout: '192.168.1.23\n192.168.1.24\n' }],
    ...specific,
  ];

  it.each(
    badAnswers([
      ['text that is not an address', { stdout: 'not-an-address\n' }],
      ['an IPv6 address', { stdout: 'fe80::1\n' }],
      ['an octal-looking address', { stdout: '010.1.1.1\n' }],
      ['an address with a prefix', { stdout: '192.168.1.23/24\n' }],
    ]),
  )('treats the address query answering with %s as "lookup failed"', async (_label, response) => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);
    runner.when(IPCONFIG, ['getifaddr', 'en0'], response);

    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({
      device: 'en0',
      ip: null,
      gateway: null,
      subnet: null,
      up: false,
      routable: false,
      reason: 'address-lookup-failed',
    });
    expect(result.adapters.find((adapter) => adapter.device === 'en0')?.ip).toBeNull();
    expect(result.ethernet).toMatchObject({ device: 'en5', routable: true });
    expect(result.degraded).toBe(true);
    expect(warnings(entries)).toHaveLength(1);
    expect(warnings(entries)[0]?.context).toMatchObject({ component: 'netinfo', device: 'en0' });
  });

  it('skips an Ethernet candidate whose address query failed and uses the next one', async () => {
    const { netinfo, runner } = setup(PORTS, { en0: WIFI, en7: ETHERNET });
    runner.when(IPCONFIG, ['getifaddr', 'en5'], { failure: 'timeout', error: 'Timed out' });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ device: 'en7', routable: true });
    expect(result.degraded).toBe(true);
  });

  it.each(
    badAnswers([
      ['text that is not an address', { stdout: 'gateway.local\n' }],
      ['an octal-looking address', { stdout: '010.20.4.1\n' }],
      ['a short address', { stdout: '10.20.4\n' }],
      ['an IPv6 address', { stdout: 'fe80::1\n' }],
      ['a loopback address', { stdout: '127.0.0.1\n' }],
      ['the unspecified address', { stdout: '0.0.0.0\n' }],
      ['a multicast address', { stdout: '224.0.0.1\n' }],
      ['an address followed by an option', { stdout: '10.20.4.1 -interface\n' }],
    ]),
  )('reports no gateway when the router query answers with %s', async (_label, response) => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);
    runner.when(IPCONFIG, ['getoption', 'en5', 'router'], response);

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({
      device: 'en5',
      ip: '10.20.4.57',
      gateway: null,
      subnet: '10.20.4.0/22',
      up: true,
      routable: false,
      reason: 'gateway-lookup-failed',
    });
    expect(result.wifi).toMatchObject({ routable: true });
    expect(result.degraded).toBe(true);
    expect(warnings(entries)).toHaveLength(1);
  });

  it.each(
    badAnswers([
      ['a non-contiguous mask', { stdout: '255.0.255.0\n' }],
      ['a mask with a hole at the end', { stdout: '255.255.255.1\n' }],
      ['an all-zero mask', { stdout: '0.0.0.0\n' }],
      ['a hexadecimal mask', { stdout: '0xffffff00\n' }],
      ['text', { stdout: 'subnet_mask\n' }],
    ]),
  )('reports no subnet, but keeps the role routable, when the mask query answers with %s', async (_label, response) => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);
    runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], response);

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({
      device: 'en5',
      ip: '10.20.4.57',
      gateway: '10.20.4.1',
      netmask: null,
      subnet: null,
      up: true,
      routable: true,
      reason: null,
    });
    expect(result.degraded).toBe(true);
    expect(warnings(entries)).toHaveLength(1);
  });

  it('reports no subnet without a warning when there is simply no mask', async () => {
    const { netinfo, entries } = setup(PORTS, { en0: WIFI, en5: { ip: '10.20.4.57', router: '10.20.4.1' } });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ netmask: null, subnet: null, routable: true });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it('tolerates CRLF and surrounding whitespace in ipconfig output', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    runner.when(IPCONFIG, ['getifaddr', 'en5'], { stdout: '  10.20.4.57 \r\n' });
    runner.when(IPCONFIG, ['getoption', 'en5', 'router'], { stdout: '10.20.4.1\r\n\r\n' });
    runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], { stdout: '\n255.255.252.0\t\n' });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ ip: '10.20.4.57', gateway: '10.20.4.1', subnet: '10.20.4.0/22' });
    expect(result.degraded).toBe(false);
  });

  it('does not reject when the runner itself rejects', async () => {
    const memory = createMemorySink();
    const runner: CommandRunner = { run: () => Promise.reject(new Error('runner is broken')) };
    const netinfo = createNetInfo({ runner, logger: createLogger({ sinks: [memory.sink] }) });

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: 'en5' } });

    expect(result.ethernet).toMatchObject({ device: null, up: false, reason: 'hardware-ports-unavailable' });
    expect(result.wifi).toMatchObject({ device: null, up: false, reason: 'hardware-ports-unavailable' });
    expect(result.degraded).toBe(true);
    expect(memory.entries.some((entry) => entry.level === 'error' && entry.msg === 'command could not be started')).toBe(
      true,
    );
  });

  it('does not reject when only the ipconfig calls are refused', async () => {
    const fake = createFakeCommandRunner().when(NETWORKSETUP, LIST_PORTS, { stdout: PORTS });
    const netinfo = createNetInfo({ runner: fake, logger: createLogger({ sinks: [] }) });

    // No ipconfig stub: the fake rejects every such call.
    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({ device: 'en0', up: false, reason: 'address-lookup-failed' });
    expect(result.ethernet).toMatchObject({ device: null, up: false, reason: 'no-address' });
    expect(result.adapters.map((adapter) => adapter.ip)).toEqual([null, null, null, null]);
    expect(result.degraded).toBe(true);
  });
});

describe('detectInterfaces: adapters', () => {
  it('lists every en* hardware port with its name and address, in listing order', async () => {
    const { netinfo } = setup(PORTS, BOTH);

    const result = await netinfo.detectInterfaces();

    expect(result.adapters).toEqual([
      { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.57' },
      { device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' },
      { device: 'en1', port: 'Thunderbolt 1', ip: null },
      { device: 'en7', port: 'USB 10/100 LAN', ip: null },
    ]);
  });

  const manyPorts = (count: number): string =>
    Array.from({ length: count }, (_unused, index) => `Hardware Port: Port ${String(index)}\nDevice: en${String(index)}\n`).join(
      '\n',
    );

  it('caps the list at the protocol limit and ignores the ports beyond it', async () => {
    const count = PROTOCOL_LIMITS.maxAdapters + 8;
    const last = `en${String(count - 1)}`;
    const { netinfo, runner, entries } = setup(manyPorts(count), { [last]: ETHERNET });

    const result = await netinfo.detectInterfaces();

    expect(result.adapters).toHaveLength(PROTOCOL_LIMITS.maxAdapters);
    expect(result.adapters.at(-1)?.device).toBe(`en${String(PROTOCOL_LIMITS.maxAdapters - 1)}`);
    expect(runner.calls).toHaveLength(1 + PROTOCOL_LIMITS.maxAdapters);
    expect(result.ethernet).toMatchObject({ device: null, reason: 'no-address' });
    expect(warnings(entries).map((entry) => entry.context)).toEqual([
      { component: 'netinfo', ports: count, limit: PROTOCOL_LIMITS.maxAdapters },
    ]);
  });

  it('still honours an override naming a port beyond the cap', async () => {
    const count = PROTOCOL_LIMITS.maxAdapters + 8;
    const last = `en${String(count - 1)}`;
    const { netinfo, runner } = setup(manyPorts(count), { [last]: ETHERNET });

    const result = await netinfo.detectInterfaces({ overrides: { ethernet: last } });

    expect(result.ethernet).toMatchObject({ device: last, port: `Port ${String(count - 1)}`, routable: true });
    expect(result.adapters).toHaveLength(PROTOCOL_LIMITS.maxAdapters);
    // The listing, 32 + 1 address queries, router and mask for the one role.
    expect(runner.calls).toHaveLength(1 + PROTOCOL_LIMITS.maxAdapters + 1 + 2);
  });

  it('truncates an over-long port name to the protocol limit', async () => {
    const name = 'P'.repeat(PROTOCOL_LIMITS.adapterPortMaxLength + 50);
    const { netinfo } = setup(`Hardware Port: ${name}\nDevice: en5\n`, { en5: ETHERNET });

    const result = await netinfo.detectInterfaces();

    expect(result.adapters[0]?.port).toBe('P'.repeat(PROTOCOL_LIMITS.adapterPortMaxLength));
  });
});

describe('wire mapping', () => {
  it('maps every result to values the protocol schema accepts unchanged', async () => {
    const cases: readonly (readonly [Readonly<Record<string, FakeIface>>, IfaceOverrides | undefined])[] = [
      [BOTH, undefined],
      [{ en0: WIFI }, undefined],
      [{ en0: WIFI, en5: { ip: '169.254.10.20', mask: '255.255.0.0' } }, undefined],
      [BOTH, { ethernet: 'en42', wifi: 'en42' }],
      [BOTH, { ethernet: 'bogus' }],
    ];
    for (const [ifaces, overrides] of cases) {
      const result = await setup(PORTS, ifaces).netinfo.detectInterfaces({ overrides });
      const wire = toWireInterfaces(result);

      expect(InterfaceState.parse(wire.interfaces.ethernet)).toEqual(wire.interfaces.ethernet);
      expect(InterfaceState.parse(wire.interfaces.wifi)).toEqual(wire.interfaces.wifi);
      expect(wire.adapters.map((adapter) => AdapterInfo.parse(adapter))).toEqual(wire.adapters);
      expect(Object.keys(wire.interfaces.ethernet).sort()).toEqual(['device', 'gateway', 'ip', 'up']);
    }
  });

  it('keeps the wire meaning of `up`: a device with an address, gateway or not', async () => {
    const { netinfo } = setup(PORTS, { en0: WIFI, en5: { ip: '169.254.10.20', mask: '255.255.0.0' } });

    const result = await netinfo.detectInterfaces();

    expect(toInterfaceState(result.ethernet)).toEqual({ device: 'en5', ip: '169.254.10.20', gateway: null, up: true });
    expect(result.ethernet).toMatchObject({ routable: false, reason: 'no-gateway', subnet: '169.254.0.0/16' });
    expect(toInterfaceState(result.wifi)).toEqual({
      device: 'en0',
      ip: '192.168.1.23',
      gateway: '192.168.1.1',
      up: true,
    });
  });

  it('returns copies of the adapters, and frozen results', async () => {
    const result = await setup(PORTS, BOTH).netinfo.detectInterfaces();

    expect(toWireInterfaces(result).adapters[0]).not.toBe(result.adapters[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ethernet)).toBe(true);
    expect(Object.isFrozen(result.wifi)).toBe(true);
    expect(Object.isFrozen(result.adapters)).toBe(true);
    expect(Object.isFrozen(result.adapters[0])).toBe(true);
  });
});

describe('cache', () => {
  const COMMANDS_PER_DETECTION = 9;

  it('serves a result from the cache for five seconds, then detects again', async () => {
    const { netinfo, runner, clock } = setup(PORTS, BOTH);

    const first = await netinfo.detectInterfaces();
    expect(runner.calls).toHaveLength(COMMANDS_PER_DETECTION);

    clock.ms += NETINFO_CACHE_TTL_MS - 1;
    expect(await netinfo.detectInterfaces()).toBe(first);
    expect(runner.calls).toHaveLength(COMMANDS_PER_DETECTION);

    clock.ms += 1;
    const second = await netinfo.detectInterfaces();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
  });

  it('bypasses the cache with force, and caches the forced result', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    await netinfo.detectInterfaces();

    runner.when(IPCONFIG, ['getoption', 'en5', 'router'], { stdout: '10.20.4.254\n' });
    const forced = await netinfo.detectInterfaces({ force: true });

    expect(forced.ethernet.gateway).toBe('10.20.4.254');
    expect(runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
    expect(await netinfo.detectInterfaces()).toBe(forced);
    expect(runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
  });

  it('drops the cache on invalidate()', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    await netinfo.detectInterfaces();

    netinfo.invalidate();
    await netinfo.detectInterfaces();

    expect(runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
  });

  it('shares one in-flight detection between concurrent callers', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);

    const first = netinfo.detectInterfaces();
    const second = netinfo.detectInterfaces();
    const forced = netinfo.detectInterfaces({ force: true });

    expect(second).toBe(first);
    expect(forced).toBe(first);
    const results = await Promise.all([first, second, forced]);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(runner.calls).toHaveLength(COMMANDS_PER_DETECTION);
    expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(1);
  });

  it('does not share or keep a detection that invalidate() overtook', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);

    const stale = netinfo.detectInterfaces();
    netinfo.invalidate();
    runner.when(IPCONFIG, ['getoption', 'en0', 'router'], { stdout: '192.168.1.254\n' });
    const fresh = netinfo.detectInterfaces();

    expect(fresh).not.toBe(stale);
    const [, freshResult] = await Promise.all([stale, fresh]);
    expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(2);
    // Whatever order they finished in, the cache holds the newer detection.
    expect(await netinfo.detectInterfaces()).toBe(freshResult);
    expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(2);
  });

  it('does not let a detection that finishes after invalidate() overwrite the newer one', async () => {
    const { runner: fake, entries } = setup(PORTS, BOTH);
    let release: (() => void) | undefined;
    let held = false;
    // Holds back the first hardware-port listing until `release()` is called.
    const runner: CommandRunner = {
      run: async (bin, args, options) => {
        if (bin === NETWORKSETUP && !held) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return fake.run(bin, args, options);
      },
    };
    const netinfo = createNetInfo({ runner, logger: createLogger({ sinks: [] }), now: () => 0 });

    const stale = netinfo.detectInterfaces();
    netinfo.invalidate();
    const fresh = await netinfo.detectInterfaces();
    fake.when(IPCONFIG, ['getoption', 'en0', 'router'], { stdout: '192.168.1.254\n' });
    release?.();
    const staleResult = await stale;

    expect(staleResult.wifi.gateway).toBe('192.168.1.254');
    expect(fresh.wifi.gateway).toBe('192.168.1.1');
    const callsBefore = fake.calls.length;
    expect(await netinfo.detectInterfaces()).toBe(fresh);
    expect(fake.calls).toHaveLength(callsBefore);
    expect(entries).toEqual([]);
  });

  it('keeps separate answers for separate overrides', async () => {
    const { netinfo, runner } = setup(PORTS, { ...BOTH, en7: { ip: '10.30.0.9', router: '10.30.0.1' } });

    const plain = await netinfo.detectInterfaces();
    const pinned = await netinfo.detectInterfaces({ overrides: { ethernet: 'en7' } });

    expect(plain.ethernet.device).toBe('en5');
    expect(pinned.ethernet.device).toBe('en7');
    expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(2);
    // The same overrides again, as a new object: a cache hit.
    expect(await netinfo.detectInterfaces({ overrides: { ethernet: 'en7' } })).toBe(pinned);
    expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(2);
  });

  it('caches a failed detection too, so a broken tool is not hammered', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    runner.when(NETWORKSETUP, LIST_PORTS, { failure: 'timeout', error: 'Timed out' });

    const first = await netinfo.detectInterfaces();
    const second = await netinfo.detectInterfaces();

    expect(second).toBe(first);
    expect(runner.calls).toHaveLength(1);
  });

  it('does not trust a cache entry when the clock went backwards', async () => {
    const { netinfo, runner, clock } = setup(PORTS, BOTH);
    await netinfo.detectInterfaces();

    clock.ms -= 10;
    await netinfo.detectInterfaces();

    expect(runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
  });

  it('keeps no state between instances', async () => {
    const shared = setup(PORTS, BOTH);
    const other = createNetInfo({ runner: shared.runner, logger: createLogger({ sinks: [] }), now: () => 0 });

    await shared.netinfo.detectInterfaces();
    await other.detectInterfaces();

    expect(shared.runner.calls).toHaveLength(2 * COMMANDS_PER_DETECTION);
  });

  it('works with the default clock', async () => {
    const runner = createFakeCommandRunner().when(NETWORKSETUP, LIST_PORTS, { stdout: WIFI_ONLY_PORTS });
    runner.whenMatching((bin) => (bin === IPCONFIG ? NO_VALUE : undefined));
    const netinfo = createNetInfo({ runner, logger: createLogger({ sinks: [] }) });

    const first = await netinfo.detectInterfaces();

    expect(await netinfo.detectInterfaces()).toBe(first);
    expect(runner.calls).toHaveLength(2);
  });
});

describe('logging', () => {
  it('writes one summary per actual detection: info when the outcome changed, debug when it did not', async () => {
    const { netinfo, runner, entries, clock } = setup(PORTS, BOTH);

    await netinfo.detectInterfaces();
    expect(summaries(entries)).toHaveLength(1);
    expect(summaries(entries)[0]).toMatchObject({
      level: 'info',
      context: {
        component: 'netinfo',
        ethernet: { device: 'en5', ip: '10.20.4.57', gateway: '10.20.4.1', subnet: '10.20.4.0/22', reason: null },
        wifi: { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', subnet: '192.168.1.0/24', reason: null },
        adapters: 4,
        degraded: false,
        durationMs: 0,
      },
    });

    // Cache hit: nothing is logged.
    await netinfo.detectInterfaces();
    expect(summaries(entries)).toHaveLength(1);

    // Same outcome again (the 60 s drift check): debug.
    clock.ms += 60_000;
    await netinfo.detectInterfaces();
    expect(summaries(entries).map((entry) => entry.level)).toEqual(['info', 'debug']);

    // The cable is unplugged: info, with the reason.
    runner.when(IPCONFIG, ['getifaddr', 'en5'], NO_VALUE);
    await netinfo.detectInterfaces({ force: true });
    expect(summaries(entries).map((entry) => entry.level)).toEqual(['info', 'debug', 'info']);
    expect(summaries(entries)[2]?.context).toMatchObject({ ethernet: { device: null, reason: 'no-address' } });
  });

  it('logs nothing above debug/info for an ordinary "not connected" answer', async () => {
    const { netinfo, entries } = setup(PORTS, {});

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet.reason).toBe('no-address');
    expect(result.wifi.reason).toBe('no-address');
    expect(warnings(entries)).toEqual([]);
  });

  it('bounds what it logs about a refused override', async () => {
    const { netinfo, entries } = setup(PORTS, BOTH);

    await netinfo.detectInterfaces({ overrides: { wifi: `en5${'x'.repeat(500)}` } });

    const [entry] = warnings(entries);
    expect(entry?.msg).toBe('interface override is not a device name');
    expect(String(entry?.context?.['value'])).toHaveLength(64);
  });
});

// Shape captured from `netstat -rn -f inet` on macOS 26.3.1 and anonymised:
// generic devices, RFC 1918 addresses, documentation MAC addresses. en0 is the
// primary interface (plain `default`), en5 the secondary one (its `default`
// carries the interface-scope flag `I`). Note the abbreviated destinations
// (`127`, `169.254`, `192.168.1`, `10.20.4/22`, `224.0.0/4`), the `/32` and
// bare-address host rows next to the network rows, the `link#N` host row, the
// rule-style host route through the gateway and the optional Expire column.
const ROUTING_TABLE = routes(
  'default            192.168.1.1        UGScg                 en0       ',
  'default            10.20.4.1          UGScIg                en5       ',
  '127                127.0.0.1          UCS                   lo0       ',
  '127.0.0.1          127.0.0.1          UH                    lo0       ',
  '169.254            link#15            UCS                   en0      !',
  '169.254            link#13            UCSI                  en5      !',
  '10.20.4/22         link#13            UCS                   en5      !',
  '10.20.4.1/32       link#13            UCS                   en5      !',
  '10.20.4.1          0:0:5e:0:53:a1     UHLWIir               en5   1060',
  '10.20.4.57/32      link#13            UCS                   en5      !',
  '10.20.4.57         0:0:5e:0:53:5      UHLWI                 lo0       ',
  '10.20.4.60         link#13            UHLWI                 en5      !',
  '172.16.12.40       10.20.4.1          UGHS                  en5       ',
  '192.168.1          link#15            UCS                   en0      !',
  '192.168.1.1/32     link#15            UCS                   en0      !',
  '192.168.1.1        0:0:5e:0:53:1      UHLWIir               en0   1197',
  '192.168.1.23/32    link#15            UCS                   en0      !',
  '192.168.1.23       0:0:5e:0:53:0      UHLWI                 lo0       ',
  '192.168.1.255      ff:ff:ff:ff:ff:ff  UHLWbI                en0      !',
  '224.0.0/4          link#15            UmCS                  en0      !',
  '224.0.0/4          link#13            UmCSI                 en5      !',
  '255.255.255.255/32 link#15            UCS                   en0      !',
  '255.255.255.255/32 link#13            UCSI                  en5      !',
);

/** An interface with a manually configured address: the lease has neither router nor mask. */
const STATIC_ETHERNET: FakeIface = { ip: '10.20.4.57' };
const STATIC_WIFI: FakeIface = { ip: '192.168.1.23' };

const netstatCalls = (runner: FakeCommandRunner): number => runner.calls.filter((call) => call.bin === NETSTAT).length;

/** Detection with en5 on a static address and the given routing table. */
const detectStatic = async (table: string, ethernet: FakeIface = STATIC_ETHERNET) => {
  const context = setup(PORTS, { en0: WIFI, en5: ethernet });
  context.runner.when(NETSTAT, ROUTES, { stdout: table });
  const result = await context.netinfo.detectInterfaces();
  return { ...context, result };
};

describe('expandNetstatDestination', () => {
  it.each([
    ['192.168.1', '192.168.1.0/24'],
    ['10', '10.0.0.0/8'],
    ['127', '127.0.0.0/8'],
    ['169.254', '169.254.0.0/16'],
    ['172.20', '172.20.0.0/16'],
    ['223.255.255', '223.255.255.0/24'],
    ['172.16/12', '172.16.0.0/12'],
    ['10.20.4/22', '10.20.4.0/22'],
    ['10.20/16', '10.20.0.0/16'],
    ['10/8', '10.0.0.0/8'],
    ['192.168/16', '192.168.0.0/16'],
    ['192.168.1.64/26', '192.168.1.64/26'],
    ['192.168.1.0/24', '192.168.1.0/24'],
    ['10.20.4.57/32', '10.20.4.57/32'],
    ['224.0.0/4', '224.0.0.0/4'],
    ['0/0', '0.0.0.0/0'],
  ])('%s -> %s', (destination, cidr) => {
    expect(expandNetstatDestination(destination)).toBe(cidr);
  });

  it.each([
    'default',
    '',
    '10.20.4.57', // four octets without a prefix: a host route
    '10.20.4', // not how a class A network is printed: /24 would be a guess
    '10.20',
    '192.168', // class C needs three octets
    '172', // class B needs two
    '224.0.0', // no classful prefix beyond class C
    '240',
    '0',
    '10.20.4.1/22', // host bits set
    '10.20.5/22',
    '172.17/12',
    '10.20.4/33',
    '10.20.4/022',
    '10.20.4/',
    '10.20.4/22/1',
    '10.20.4/-1',
    '10.20.4/2x',
    '010.20.4/22',
    '10.256.4/22',
    '10..4/22',
    '10.20.4.0.0/24',
    '.10/8',
    '10./8',
    '0x0a/8',
    '10.20.4&0xffff00ff',
    ' 10',
    '10 ',
    'link#13',
    'fe80::/64',
    '1e1/8',
    '+10/8',
    `10${'0'.repeat(10_000)}`,
  ])('refuses %j', (destination) => {
    expect(expandNetstatDestination(destination)).toBeNull();
  });
});

describe('parseRoutingTable', () => {
  it('keeps the default rows and the link rows of en* devices, in table order', () => {
    expect(parseRoutingTable(ROUTING_TABLE)).toEqual({
      defaults: [
        { destination: 'default', gateway: '192.168.1.1', flags: 'UGScg', device: 'en0' },
        { destination: 'default', gateway: '10.20.4.1', flags: 'UGScIg', device: 'en5' },
      ],
      connected: [
        { destination: '169.254', gateway: 'link#15', flags: 'UCS', device: 'en0' },
        { destination: '169.254', gateway: 'link#13', flags: 'UCSI', device: 'en5' },
        { destination: '10.20.4/22', gateway: 'link#13', flags: 'UCS', device: 'en5' },
        { destination: '10.20.4.1/32', gateway: 'link#13', flags: 'UCS', device: 'en5' },
        { destination: '10.20.4.57/32', gateway: 'link#13', flags: 'UCS', device: 'en5' },
        { destination: '10.20.4.60', gateway: 'link#13', flags: 'UHLWI', device: 'en5' },
        { destination: '192.168.1', gateway: 'link#15', flags: 'UCS', device: 'en0' },
        { destination: '192.168.1.1/32', gateway: 'link#15', flags: 'UCS', device: 'en0' },
        { destination: '192.168.1.23/32', gateway: 'link#15', flags: 'UCS', device: 'en0' },
        { destination: '224.0.0/4', gateway: 'link#15', flags: 'UmCS', device: 'en0' },
        { destination: '224.0.0/4', gateway: 'link#13', flags: 'UmCSI', device: 'en5' },
        { destination: '255.255.255.255/32', gateway: 'link#15', flags: 'UCS', device: 'en0' },
        { destination: '255.255.255.255/32', gateway: 'link#13', flags: 'UCSI', device: 'en5' },
      ],
    });
  });

  it('tolerates CRLF, tabs, indentation and trailing whitespace', () => {
    const text = ROUTING_TABLE.split('\n')
      .map((line) => `  ${line.replace('link#13 ', 'link#13\t')}  \r`)
      .join('\n');

    expect(parseRoutingTable(text)).toEqual(parseRoutingTable(ROUTING_TABLE));
  });

  it('finds the columns from the header: no Expire column, or the wide form', () => {
    const narrow = [
      'Internet:',
      'Destination Gateway Flags Netif',
      'default 10.20.4.1 UGScIg en5',
      '10.20.4/22 link#13 UCS en5',
    ].join('\n');
    const wide = [
      'Routing tables',
      '',
      'Internet:',
      'Destination        Gateway            RT_IFA             Flags        Refs      Use    Mtu          Netif Expire',
      'default            10.20.4.1          10.20.4.57         UGScIg          2        0   1500            en5       ',
      '10.20.4/22         link#13            10.20.4.57         UCS             0        0   1500            en5      !',
    ].join('\n');
    const expected = {
      defaults: [{ destination: 'default', gateway: '10.20.4.1', flags: 'UGScIg', device: 'en5' }],
      connected: [{ destination: '10.20.4/22', gateway: 'link#13', flags: 'UCS', device: 'en5' }],
    };

    expect(parseRoutingTable(narrow)).toEqual(expected);
    expect(parseRoutingTable(wide)).toEqual(expected);
  });

  it('reads only the IPv4 section, and only after its column header', () => {
    const text = [
      'Routing tables',
      'default 10.9.9.1 UGSc en5', // before any section
      'Internet:',
      'default 10.9.9.2 UGSc en5', // before the column header
      'Destination Gateway Flags Netif Expire',
      'default 10.20.4.1 UGScIg en5',
      '',
      'Internet6:',
      'Destination Gateway Flags Netif Expire',
      'default 10.9.9.3 UGSc en5',
      'default fe80::1%en5 UGcIg en5',
      'Something:',
      'default 10.9.9.4 UGSc en5',
    ].join('\n');

    expect(parseRoutingTable(text)).toEqual({
      defaults: [{ destination: 'default', gateway: '10.20.4.1', flags: 'UGScIg', device: 'en5' }],
      connected: [],
    });
  });

  it('skips rows of other interfaces, short rows and rows that are neither default nor link', () => {
    const table = parseRoutingTable(
      routes(
        'default 10.9.9.1 UGSc utun3',
        'default 10.9.9.2 UGSc bridge0',
        'default 10.9.9.3 UGSc EN5',
        'default 10.9.9.4 UGSc en5;reboot',
        'default 10.9.9.5 UGSc en123456789012345', // 15 digits: not a device name
        'default 10.9.9.6 UGSc',
        'default 10.9.9.7',
        'default',
        '10.20.4/22 link#13 UCS lo0',
        '10.20.4/22 link# UCS en5',
        '10.20.4/22 link#x UCS en5',
        '10.20.4/22 link#13x UCS en5',
        '10.20.4/22 link#12345678901 UCS en5',
        '10.20.4/22 link#013 UCS en5',
        '10.20.4/22 xlink#13 UCS en5',
        '10.20.4/22 10.20.4.1 UGS en5',
        '10.30/16 link#9 UCS en12345678901234', // 14 digits: the longest device name
      ),
    );

    expect(table).toEqual({
      defaults: [],
      connected: [{ destination: '10.30/16', gateway: 'link#9', flags: 'UCS', device: 'en12345678901234' }],
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \r\n\r\n\t'],
    ['garbled', 'Routng tbles\n\u0000\u0007 Internet\nDestnation Gatewy\ndefault 10.20.4.1 UGSc en5\n'],
    ['rows without a header', 'default 10.20.4.1 UGSc en5\n10.20.4/22 link#13 UCS en5\n'],
    ['a header without a section', 'Destination Gateway Flags Netif Expire\ndefault 10.20.4.1 UGSc en5\n'],
    ['a header without a Netif column', 'Internet:\nDestination Gateway Flags\ndefault 10.20.4.1 UGSc en5\n'],
    ['only another section', 'Internet6:\nDestination Gateway Flags Netif Expire\ndefault fe80::1 UGc en5\n'],
    ['an error message', 'netstat: kvm not available\n'],
  ])('does not trust %s output', (_label, stdout) => {
    expect(parseRoutingTable(stdout)).toBeNull();
  });

  it('accepts a table without any usable row', () => {
    expect(parseRoutingTable(LOOPBACK_ROUTES)).toEqual({ defaults: [], connected: [] });
  });

  it('skips an over-long line and does not trust an output with too many lines', () => {
    const longRow = `default 10.9.9.1 UGSc en5${' '.repeat(NETSTAT_MAX_LINE_LENGTH)}`;
    expect(parseRoutingTable(routes(longRow, 'default 10.20.4.1 UGScIg en5'))?.defaults).toEqual([
      { destination: 'default', gateway: '10.20.4.1', flags: 'UGScIg', device: 'en5' },
    ]);

    const row = '10.20.4/22 link#13 UCS en5';
    const atLimit = [...ROUTES_HEADER, ...Array.from({ length: NETSTAT_MAX_LINES - ROUTES_HEADER.length }, () => row)];
    expect(parseRoutingTable(atLimit.join('\n'))?.connected).toHaveLength(NETSTAT_MAX_LINES - ROUTES_HEADER.length);
    expect(parseRoutingTable([...atLimit, row].join('\n'))).toBeNull();
  });

  it.each([
    ['one megabyte of whitespace on one line', ' \r\t'.repeat(350_000)],
    ['one megabyte of newlines', '\n'.repeat(1_000_000)],
    ['a megabyte row', `${ROUTES_HEADER.join('\n')}\ndefault ${'1.'.repeat(500_000)} UGSc en5\n`],
    ['a megabyte of short rows', `${ROUTES_HEADER.join('\n')}\n${'d l U en5\n'.repeat(19_000)}`],
    ['a megabyte of section titles', 'Internet:\n'.repeat(19_000)],
  ])('handles %s in bounded time', (_label, stdout) => {
    const startedAt = performance.now();

    parseRoutingTable(stdout);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('detectInterfaces: routing-table fallback (static address)', () => {
  it('takes gateway and subnet of a static Ethernet from the routing table (scoped default row)', async () => {
    const { result, runner, entries } = await detectStatic(ROUTING_TABLE);

    expect(result.ethernet).toEqual({
      role: 'ethernet',
      device: 'en5',
      port: 'USB 10/100/1000 LAN',
      ip: '10.20.4.57',
      gateway: '10.20.4.1',
      netmask: '255.255.252.0',
      subnet: '10.20.4.0/22',
      up: true,
      routable: true,
      reason: null,
      overridden: false,
    });
    expect(result.wifi).toMatchObject({ device: 'en0', gateway: '192.168.1.1', subnet: '192.168.1.0/24' });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
    // The DHCP-case commands, then exactly one routing-table read.
    expect(argvOf(runner)).toEqual([
      'networksetup -listallhardwareports',
      'ipconfig getifaddr en5',
      'ipconfig getifaddr en0',
      'ipconfig getifaddr en1',
      'ipconfig getifaddr en7',
      'ipconfig getoption en5 router',
      'ipconfig getoption en5 subnet_mask',
      'ipconfig getoption en0 router',
      'ipconfig getoption en0 subnet_mask',
      'netstat -rn -f inet',
    ]);
    expect(runner.calls.at(-1)?.options).toEqual({ timeoutMs: NETINFO_COMMAND_TIMEOUT_MS });
  });

  it('takes gateway and subnet of a static primary interface from the plain default row', async () => {
    const { netinfo, runner, entries } = setup(PORTS, { en0: STATIC_WIFI, en5: ETHERNET });
    runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });

    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({
      device: 'en0',
      ip: '192.168.1.23',
      gateway: '192.168.1.1',
      netmask: '255.255.255.0',
      subnet: '192.168.1.0/24',
      up: true,
      routable: true,
      reason: null,
    });
    expect(result.ethernet).toMatchObject({ gateway: '10.20.4.1', subnet: '10.20.4.0/22' });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
    expect(netstatCalls(runner)).toBe(1);
  });

  it('reads the routing table once when both roles need it', async () => {
    const { netinfo, runner } = setup(PORTS, { en0: STATIC_WIFI, en5: STATIC_ETHERNET });
    runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ gateway: '10.20.4.1', subnet: '10.20.4.0/22', routable: true });
    expect(result.wifi).toMatchObject({ gateway: '192.168.1.1', subnet: '192.168.1.0/24', routable: true });
    expect(netstatCalls(runner)).toBe(1);
    expect(runner.calls).toHaveLength(9 + 1);
  });

  it('does not read the routing table when DHCP has router and mask for every role', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    // Would change the answer if it were consulted.
    runner.when(NETSTAT, ROUTES, { stdout: routes('default 10.99.0.1 UGSc en5', 'default 10.99.0.2 UGSc en0') });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ gateway: '10.20.4.1', subnet: '10.20.4.0/22' });
    expect(result.wifi).toMatchObject({ gateway: '192.168.1.1', subnet: '192.168.1.0/24' });
    expect(netstatCalls(runner)).toBe(0);
    expect(runner.calls).toHaveLength(9);
  });

  it('does not read the routing table for a role without an address', async () => {
    const { netinfo, runner } = setup(PORTS, { en0: WIFI });
    runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });

    await netinfo.detectInterfaces();

    expect(netstatCalls(runner)).toBe(0);
  });

  it('fills only what the lease lacks', async () => {
    const table = routes('default 10.99.0.1 UGScI en5', '10.20/16 link#13 UCS en5');

    const noRouter = await detectStatic(table, { ip: '10.20.4.57', mask: '255.255.252.0' });
    expect(noRouter.result.ethernet).toMatchObject({
      gateway: '10.99.0.1',
      netmask: '255.255.252.0',
      subnet: '10.20.4.0/22',
      routable: true,
    });
    expect(netstatCalls(noRouter.runner)).toBe(1);

    const noMask = await detectStatic(table, { ip: '10.20.4.57', router: '10.20.4.1' });
    expect(noMask.result.ethernet).toMatchObject({
      gateway: '10.20.4.1',
      netmask: '255.255.0.0',
      subnet: '10.20.0.0/16',
      routable: true,
    });
    expect(netstatCalls(noMask.runner)).toBe(1);
  });

  it('does not fall back when a lease query failed, as opposed to having no value', async () => {
    const { netinfo, runner } = setup(PORTS, BOTH);
    runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });
    runner.when(IPCONFIG, ['getoption', 'en5', 'router'], { failure: 'timeout', error: 'Timed out' });
    runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], { stdout: '255.0.255.0\n' });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ gateway: null, subnet: null, reason: 'gateway-lookup-failed' });
    expect(result.degraded).toBe(true);
    expect(netstatCalls(runner)).toBe(0);
  });

  it('never puts a value from the routing table into an argv', async () => {
    const { runner } = await detectStatic(
      routes('default 10.20.4.1 UGScI en5', 'default 10.9.9.9 UGSc en9', '10.20.4/22 link#13 UCS en5', '10.50/16 link#20 UCS en9'),
    );

    const args = runner.calls.flatMap((call) => call.args);
    for (const fromTable of ['10.20.4.1', '10.9.9.9', 'en9', 'link#13', '10.20.4/22']) {
      expect(args).not.toContain(fromTable);
    }
  });

  it.each([
    ['192.168.1', '192.168.1.77', '192.168.1.0/24', '255.255.255.0'],
    ['10', '10.20.4.57', '10.0.0.0/8', '255.0.0.0'],
    ['172.16/12', '172.20.1.9', '172.16.0.0/12', '255.240.0.0'],
    ['10.20.4/22', '10.20.7.254', '10.20.4.0/22', '255.255.252.0'],
    ['192.168.1.64/26', '192.168.1.70', '192.168.1.64/26', '255.255.255.192'],
    ['172.20', '172.20.3.4', '172.20.0.0/16', '255.255.0.0'],
    ['169.254', '169.254.10.20', '169.254.0.0/16', '255.255.0.0'],
    ['10.20.4.56/31', '10.20.4.57', '10.20.4.56/31', '255.255.255.254'],
    ['64/2', '100.64.0.9', '64.0.0.0/2', '192.0.0.0'],
  ])('derives the subnet from the connected row %s', async (destination, ip, subnet, netmask) => {
    const { result, entries } = await detectStatic(routes(`${destination} link#13 UCS en5 !`), { ip });

    expect(result.ethernet).toMatchObject({ ip, netmask, subnet, up: true });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it.each([
    ['a network that does not contain the address', '10.30/16 link#13 UCS en5'],
    ['only the link-local and multicast rows', '169.254 link#13 UCSI en5\n224.0.0/4 link#13 UmCSI en5'],
    ['only host rows', '10.20.4.57/32 link#13 UCS en5\n10.20.4.57 link#13 UHLWI en5\n255.255.255.255/32 link#13 UCS en5'],
    ['a row of another device', '10.20.4/22 link#15 UCS en0'],
    ['a row that is not a link row', '10.20.4/22 10.20.4.1 UGS en5'],
    ['an ambiguous abbreviation', '10.20.4 link#13 UCS en5'],
    ['a destination with host bits', '10.20.4.57/22 link#13 UCS en5'],
    ['a /0 row', '0/0 link#13 UCS en5'],
    ['a non-contiguous mask', '10.20.4&0xffff00ff link#13 UCS en5'],
    ['garbage in the destination', 'ten.twenty/22 link#13 UCS en5'],
    ['no row at all', ''],
  ])('reports no subnet, without an error, for %s', async (_label, rows) => {
    const { result, entries } = await detectStatic(routes('default 10.20.4.1 UGScI en5', ...rows.split('\n')));

    expect(result.ethernet).toMatchObject({
      ip: '10.20.4.57',
      gateway: '10.20.4.1',
      netmask: null,
      subnet: null,
      routable: true,
      reason: null,
    });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it('picks the most specific connected row that contains the address', async () => {
    const { result } = await detectStatic(
      routes('10 link#13 UCS en5', '10.20.4/22 link#13 UCS en5', '10.20/16 link#13 UCS en5', '10.20.8/24 link#13 UCS en5'),
    );

    expect(result.ethernet).toMatchObject({ subnet: '10.20.4.0/22', netmask: '255.255.252.0' });
  });

  it.each([
    ['prefers the unscoped row over a scoped one', ['default 10.20.4.2 UGScIg en5', 'default 10.20.4.1 UGScg en5'], '10.20.4.1'],
    ['takes the first of two unscoped rows', ['default 10.20.4.1 UGSc en5', 'default 10.20.4.2 UGSc en5'], '10.20.4.1'],
    ['takes the first of two scoped rows', ['default 10.20.4.2 UGScI en5', 'default 10.20.4.1 UGScI en5'], '10.20.4.2'],
    ['skips an unusable row for a usable one', ['default 127.0.0.1 UGSc en5', 'default 10.20.4.1 UGScI en5'], '10.20.4.1'],
    ['skips an on-link row for a usable one', ['default link#13 UCS en5', 'default 10.20.4.1 UGScI en5'], '10.20.4.1'],
    ['ignores the rows of other devices', ['default 192.168.1.1 UGScg en0', 'default 10.20.4.1 UGScIg en5'], '10.20.4.1'],
  ])('with several default rows: %s', async (_label, rows, gateway) => {
    const { result, entries } = await detectStatic(routes(...rows));

    expect(result.ethernet).toMatchObject({ gateway, routable: true, reason: null });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it.each([
    ['only another device has a default row', ['default 192.168.1.1 UGScg en0', 'default 10.9.9.1 UGSc utun3']],
    ['there is no default row', ['10.20.4/22 link#13 UCS en5']],
    ['the default row is on-link', ['default link#13 UCScI en5']],
    ['the device name only resembles it', ['default 10.20.4.1 UGSc en50', 'default 10.20.4.1 UGSc en']],
  ])('reports no gateway, without an error, when %s', async (_label, rows) => {
    const { result, entries } = await detectStatic(routes(...rows));

    expect(result.ethernet).toMatchObject({
      device: 'en5',
      ip: '10.20.4.57',
      gateway: null,
      up: true,
      routable: false,
      reason: 'no-gateway',
    });
    expect(result.degraded).toBe(false);
    expect(warnings(entries)).toEqual([]);
  });

  it.each([
    ['a loopback address', '127.0.0.1'],
    ['the unspecified address', '0.0.0.0'],
    ['a link-local address', '169.254.1.1'],
    ['a multicast address', '224.0.0.1'],
    ['the broadcast address', '255.255.255.255'],
    ['an octal-looking address', '010.20.4.1'],
    ['a short address', '10.20.4'],
    ['an address with a prefix', '10.20.4.1/32'],
    ['a MAC address', '0:0:5e:0:53:a1'],
    ['an IPv6 address', 'fe80::1%en5'],
    ['a host name', 'gateway.corp.local'],
    ['something link-like', 'link#13x'],
  ])('reports a failed gateway lookup when the default row carries %s', async (_label, gateway) => {
    const { result, entries, runner } = await detectStatic(
      routes(`default ${gateway} UGScI en5`, '10.20.4/22 link#13 UCS en5'),
    );

    expect(result.ethernet).toMatchObject({
      gateway: null,
      subnet: '10.20.4.0/22',
      up: true,
      routable: false,
      reason: 'gateway-lookup-failed',
    });
    expect(result.wifi).toMatchObject({ routable: true });
    expect(result.degraded).toBe(true);
    expect(warnings(entries).map((entry) => entry.msg)).toEqual(['the routing table has an unusable default gateway']);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain(gateway);
  });

  it('bounds what it logs about an unusable gateway', async () => {
    const { entries } = await detectStatic(routes(`default ${'9'.repeat(400)} UGScI en5`));

    expect(String(warnings(entries)[0]?.context?.['value'])).toHaveLength(64);
  });

  it.each([...FAILURES, ['an exit code 1 without output', { exitCode: 1 }] as const])(
    'leaves gateway and subnet empty, and does not reject, when netstat fails with %s',
    async (_label, response) => {
      const { netinfo, runner, entries } = setup(PORTS, { en0: STATIC_WIFI, en5: STATIC_ETHERNET });
      runner.when(NETSTAT, ROUTES, response);

      const result = await netinfo.detectInterfaces();

      for (const role of ['ethernet', 'wifi'] as const) {
        expect(result[role]).toMatchObject({
          gateway: null,
          netmask: null,
          subnet: null,
          up: true,
          routable: false,
          reason: 'gateway-lookup-failed',
        });
      }
      expect(result.ethernet.ip).toBe('10.20.4.57');
      expect(result.degraded).toBe(true);
      expect(netstatCalls(runner)).toBe(1);
      expect(warnings(entries).map((entry) => entry.msg)).toEqual(['could not read the routing table']);
    },
  );

  it.each([
    ['empty', ''],
    ['whitespace', ' \r\n\r\n'],
    ['garbled', 'Routng tbles\n\u0000\u0007\ndefault 10.20.4.1 UGSc en5\n'],
    ['an error message', 'netstat: sysctl: net.route.0.0.dump estimate: Cannot allocate memory\n'],
    ['too many lines', `${routes('default 10.20.4.1 UGScI en5')}${'\n'.repeat(NETSTAT_MAX_LINES)}`],
    ['one megabyte of noise', 'default 10.20.4.1 UGSc en5 \r'.repeat(36_000)],
  ])('treats %s netstat output as a failed lookup', async (_label, stdout) => {
    const startedAt = performance.now();
    const { result, entries } = await detectStatic(stdout);

    expect(result.ethernet).toMatchObject({
      gateway: null,
      subnet: null,
      up: true,
      routable: false,
      reason: 'gateway-lookup-failed',
    });
    expect(result.wifi).toMatchObject({ routable: true });
    expect(result.degraded).toBe(true);
    expect(warnings(entries).map((entry) => entry.msg)).toEqual(['unexpected output from netstat']);
    expect(warnings(entries)[0]?.context).toEqual({ component: 'netinfo', outputLength: stdout.length });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('uses a huge but well-formed table', async () => {
    const hosts = Array.from(
      { length: 15_000 },
      (_unused, index) => `10.${String(100 + (index >> 8))}.${String(index & 255)}.7 10.20.4.1 UGHS en5`,
    );
    const table = routes('default 10.20.4.1 UGScI en5', ...hosts, '10.20.4/22 link#13 UCS en5 !');
    const startedAt = performance.now();

    const { result } = await detectStatic(table);

    expect(result.ethernet).toMatchObject({ gateway: '10.20.4.1', subnet: '10.20.4.0/22', routable: true });
    expect(result.degraded).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('does not reject when the netstat call is refused by the runner', async () => {
    const fake = createFakeCommandRunner().when(NETWORKSETUP, LIST_PORTS, { stdout: WIFI_ONLY_PORTS });
    fake.when(IPCONFIG, ['getifaddr', 'en0'], { stdout: '192.168.1.23\n' });
    fake.whenMatching((bin) => (bin === IPCONFIG ? NO_VALUE : undefined));
    const memory = createMemorySink();
    const netinfo = createNetInfo({ runner: fake, logger: createLogger({ sinks: [memory.sink] }) });

    // No netstat stub: the fake rejects the call.
    const result = await netinfo.detectInterfaces();

    expect(result.wifi).toMatchObject({ ip: '192.168.1.23', gateway: null, subnet: null, reason: 'gateway-lookup-failed' });
    expect(result.degraded).toBe(true);
    expect(memory.entries.some((entry) => entry.level === 'error' && entry.msg === 'command could not be started')).toBe(
      true,
    );
  });

  it('says in the summary where gateway and subnet came from', async () => {
    const { entries } = await detectStatic(ROUTING_TABLE);

    expect(summaries(entries)[0]?.context).toMatchObject({
      ethernet: { gateway: '10.20.4.1', gatewaySource: 'routing-table', subnetSource: 'routing-table' },
      wifi: { gateway: '192.168.1.1', gatewaySource: 'dhcp', subnetSource: 'dhcp' },
    });

    const none = await detectStatic(LOOPBACK_ROUTES);
    expect(summaries(none.entries)[0]?.context).toMatchObject({
      ethernet: { gateway: null, gatewaySource: null, subnetSource: null, reason: 'no-gateway' },
    });
  });

  it('caches a result that came from the routing table like any other', async () => {
    const { netinfo, runner } = setup(PORTS, { en0: WIFI, en5: STATIC_ETHERNET });
    runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });

    const first = await netinfo.detectInterfaces();
    expect(await netinfo.detectInterfaces()).toBe(first);
    expect(netstatCalls(runner)).toBe(1);

    await netinfo.detectInterfaces({ force: true });
    expect(netstatCalls(runner)).toBe(2);
  });
});

describe('detectInterfaces: QA observations of TASK-101', () => {
  const DOWN = {
    device: null,
    port: null,
    ip: null,
    gateway: null,
    netmask: null,
    subnet: null,
    up: false,
    routable: false,
    reason: 'invalid-override',
    overridden: false,
  };

  const throwingOverrides = (): unknown => {
    const overrides = {};
    Object.defineProperty(overrides, 'ethernet', {
      enumerable: true,
      get: () => {
        throw new Error('getter exploded');
      },
    });
    return { overrides };
  };
  const throwingOptions = (): unknown => {
    const options = {};
    Object.defineProperty(options, 'overrides', {
      enumerable: true,
      get: () => {
        throw new Error('getter exploded');
      },
    });
    return options;
  };
  const throwingProxy = (): unknown =>
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap exploded');
        },
      },
    );

  it.each([
    ['null', (): unknown => null],
    ['a string', (): unknown => 'en5'],
    ['a number', (): unknown => 7],
    ['a boolean', (): unknown => true],
    ['a function', (): unknown => () => ({})],
    ['a symbol', (): unknown => Symbol('options')],
    ['an overrides object with a throwing getter', throwingOverrides],
    ['options with a throwing getter', throwingOptions],
    ['a proxy with a throwing trap', throwingProxy],
    ['overrides that are a proxy with a throwing trap', (): unknown => ({ overrides: throwingProxy() })],
  ])('neither throws nor rejects for %s as options: both roles are down', async (_label, make) => {
    const { netinfo, runner, entries } = setup(PORTS, BOTH);
    let returned: unknown;

    expect(() => {
      returned = netinfo.detectInterfaces(make() as DetectOptions);
    }).not.toThrow();
    expect(returned).toBeInstanceOf(Promise);
    const result = await (returned as ReturnType<typeof netinfo.detectInterfaces>);

    expect(result.ethernet).toEqual({ role: 'ethernet', ...DOWN });
    expect(result.wifi).toEqual({ role: 'wifi', ...DOWN });
    expect(result.adapters).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(Object.isFrozen(result) && Object.isFrozen(result.ethernet)).toBe(true);
    // Nothing ran, the refusal is logged once, and it is not cached.
    expect(runner.calls).toHaveLength(0);
    expect(warnings(entries).map((entry) => [entry.level, entry.msg])).toEqual([
      ['error', 'detection options could not be read'],
    ]);
    expect((await netinfo.detectInterfaces()).ethernet).toMatchObject({ device: 'en5', routable: true });
  });

  it('still takes undefined, an empty object and an array as "no options"', async () => {
    const plain = await setup(PORTS, BOTH).netinfo.detectInterfaces();

    for (const options of [undefined, {}, [], { overrides: undefined, force: undefined }]) {
      const { netinfo } = setup(PORTS, BOTH);
      expect(await netinfo.detectInterfaces(options as DetectOptions)).toEqual(plain);
    }
  });

  it('reads each getter of the options exactly once', async () => {
    const { netinfo } = setup(PORTS, { ...BOTH, en7: { ip: '10.30.0.9', router: '10.30.0.1', mask: '255.255.0.0' } });
    let reads = 0;
    const overrides = {
      get ethernet(): string {
        reads += 1;
        // A second read would name a different device.
        return reads === 1 ? 'en7' : 'en1';
      },
    };

    const result = await netinfo.detectInterfaces({ overrides });

    expect(reads).toBe(1);
    expect(result.ethernet).toMatchObject({ device: 'en7', overridden: true });
  });

  it('does not reject when the clock throws', async () => {
    const { runner } = setup(PORTS, BOTH);
    const memory = createMemorySink();
    const netinfo = createNetInfo({
      runner,
      logger: createLogger({ sinks: [memory.sink] }),
      now: () => {
        throw new Error('clock exploded');
      },
    });

    const result = await netinfo.detectInterfaces();

    expect(result.ethernet).toMatchObject({ device: null, reason: 'hardware-ports-unavailable' });
    expect(result.degraded).toBe(true);
    expect(memory.entries.some((entry) => entry.level === 'error' && entry.msg === 'interface detection failed')).toBe(true);
  });

  it('ignores inherited properties: a polluted prototype cannot inject an override or force', async () => {
    const plain = await setup(PORTS, { ...BOTH, en7: ETHERNET }).netinfo.detectInterfaces();
    const prototype = Object.prototype as Record<string, unknown>;
    const { netinfo, runner } = setup(PORTS, { ...BOTH, en7: ETHERNET });

    prototype['ethernet'] = 'en7';
    prototype['wifi'] = 'en7';
    prototype['overrides'] = { ethernet: 'en7' };
    prototype['force'] = true;
    try {
      const first = await netinfo.detectInterfaces({});
      const inheritedOnly = await netinfo.detectInterfaces({ overrides: Object.create({ ethernet: 'en7' }) as IfaceOverrides });

      expect(first).toEqual(plain);
      expect(first.ethernet).toMatchObject({ device: 'en5', overridden: false });
      // Same (empty) overrides and no inherited `force`: served from the cache.
      expect(inheritedOnly).toBe(first);
      expect(runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(1);
    } finally {
      delete prototype['ethernet'];
      delete prototype['wifi'];
      delete prototype['overrides'];
      delete prototype['force'];
    }
    // An own property is still honoured.
    const own = await netinfo.detectInterfaces({ overrides: { ethernet: 'en7' } });
    expect(own.ethernet).toMatchObject({ device: 'en7', overridden: true });
  });

  it.each([2, 64, 255])(
    'treats exit code %i with empty stdout and stderr as a failed lookup, not as "no value"',
    async (exitCode) => {
      const address = setup(PORTS, BOTH);
      address.runner.when(IPCONFIG, ['getifaddr', 'en0'], { exitCode });
      const noAddress = await address.netinfo.detectInterfaces();
      expect(noAddress.wifi).toMatchObject({ ip: null, up: false, reason: 'address-lookup-failed' });
      expect(noAddress.degraded).toBe(true);
      expect(warnings(address.entries).map((entry) => entry.context)).toEqual([
        { component: 'netinfo', device: 'en0', query: 'address', failure: 'nonzero-exit', exitCode },
      ]);

      const router = setup(PORTS, BOTH);
      router.runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });
      router.runner.when(IPCONFIG, ['getoption', 'en5', 'router'], { exitCode });
      const noGateway = await router.netinfo.detectInterfaces();
      expect(noGateway.ethernet).toMatchObject({ gateway: null, routable: false, reason: 'gateway-lookup-failed' });
      expect(noGateway.degraded).toBe(true);
      // A failed query is not "no value": the routing table is not consulted.
      expect(netstatCalls(router.runner)).toBe(0);

      const mask = setup(PORTS, BOTH);
      mask.runner.when(NETSTAT, ROUTES, { stdout: ROUTING_TABLE });
      mask.runner.when(IPCONFIG, ['getoption', 'en5', 'subnet_mask'], { exitCode });
      const noSubnet = await mask.netinfo.detectInterfaces();
      expect(noSubnet.ethernet).toMatchObject({ netmask: null, subnet: null, routable: true });
      expect(noSubnet.degraded).toBe(true);
      expect(netstatCalls(mask.runner)).toBe(0);
    },
  );

  it('accepts exactly the device names of the shared DEVICE_NAME pattern', async () => {
    const longest = `en${'1'.repeat(14)}`;
    const tooLong = `en${'1'.repeat(15)}`;
    const ports = `Hardware Port: Wi-Fi\nDevice: en0\n\nHardware Port: Long\nDevice: ${longest}\n\nHardware Port: Longer\nDevice: ${tooLong}\n`;
    const { netinfo, runner } = setup(ports, { en0: WIFI, [longest]: ETHERNET, [tooLong]: ETHERNET });

    const result = await netinfo.detectInterfaces();
    expect(result.adapters.map((adapter) => adapter.device)).toEqual(['en0', longest]);
    expect(result.ethernet).toMatchObject({ device: longest, routable: true });
    expect(argvOf(runner).some((argv) => argv.includes(tooLong))).toBe(false);

    const pinned = await netinfo.detectInterfaces({ overrides: { ethernet: tooLong } });
    expect(pinned.ethernet).toMatchObject({ device: null, reason: 'invalid-override' });
  });
});
