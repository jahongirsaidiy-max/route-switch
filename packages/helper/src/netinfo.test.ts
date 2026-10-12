import { AdapterInfo, InterfaceState, PROTOCOL_LIMITS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import type { CommandRunner } from './exec';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import {
  createNetInfo,
  NETINFO_CACHE_TTL_MS,
  NETINFO_COMMAND_TIMEOUT_MS,
  netmaskToPrefix,
  parseHardwarePorts,
  toInterfaceState,
  toWireInterfaces,
  type IfaceOverrides,
} from './netinfo';
import { createFakeCommandRunner, type FakeCommandResponse, type FakeCommandRunner } from './test-utils';

const NETWORKSETUP = '/usr/sbin/networksetup';
const IPCONFIG = '/usr/sbin/ipconfig';
const LIST_PORTS = ['-listallhardwareports'];

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
