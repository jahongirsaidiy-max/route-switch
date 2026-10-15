import { constants, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config, EngineState, PATHS, PROTOCOL_VERSION } from '@routeswitch/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigFileRead, ConfigFileReader } from './config-store';
import { LOOKUP_TIMEOUT_MS } from './dns';
import {
  createFakeDns,
  createFakeNetwork,
  createFakeScheduler,
  dnsError,
  flush,
  type FakeDns,
  type FakeNetwork,
  type FakeScheduler,
} from './dns-test-utils';
import { createLogger } from './logger';
import {
  EXIT_CODES,
  HELPER_VERSION,
  ONE_SHOT_DNS_WAIT_MS,
  SHUTDOWN_EXIT_TIMEOUT_SEC,
  USAGE,
  cleanupAll,
  createCore,
  createWildcardProxyControl,
  parseArgs,
  proxyFileStatus,
  run,
  systemServerAddresses,
  wantsWildcardProxy,
  type RunDeps,
  type WildcardProxyDeps,
} from './main';
import type { DnsProxy, DnsProxyOptions, DnsProxyState } from './dns-proxy/server';
import type { ProcessSpawner } from './exec';
import { connectTestClient } from './socket-test-client';
import { createStateStore } from './state-store';
import { createFakeCommandRunner, type FakeCommandResponse, type FakeCommandRunner } from './test-utils';
import { assertFsGuardInstalled } from './test-fs-guard-check';

// Touches the file system: refuse to run at all without the guard of the test setup.
assertFsGuardInstalled();

// The DNS proxy (TASK-DELTA-28) must never bind a real port here: every harness passes a fake network,
// and a UDP socket opened through the default factory would hit this trap instead of the OS.
vi.mock('node:dgram', () => {
  const trap = (): never => {
    throw Object.assign(new Error('ETESTNETGUARD: a test tried to open a real UDP socket'), { code: 'ETESTNETGUARD' });
  };
  return { createSocket: trap, default: { createSocket: trap } };
});

const ROUTE = '/sbin/route';
const NETWORKSETUP = '/usr/sbin/networksetup';
const IPCONFIG = '/usr/sbin/ipconfig';
const SCUTIL = '/usr/sbin/scutil';
const DSCACHEUTIL = '/usr/bin/dscacheutil';
const KILLALL = '/usr/bin/killall';

/** Scoped-DNS files of every harness go to a temporary directory of its own, never to the real one. */
const resolverDirs: string[] = [];
const newResolverDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'routeswitch-main-test-'));
  resolverDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of resolverDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ETH_GW = '10.20.4.1';
const NOW = new Date('2026-10-12T08:30:00.000Z');

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';

const PORTS = `
Hardware Port: USB 10/100/1000 LAN
Device: en5
Ethernet Address: 00:00:5e:00:53:05

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 00:00:5e:00:53:00
`;

const CONFIG = {
  version: 1,
  rules: [
    { id: ID_A, kind: 'subnet', target: '198.51.100.0/24', iface: 'ethernet' },
    { id: ID_B, kind: 'ip', target: '203.0.113.7', iface: 'wifi' },
  ],
};

const NO_VALUE: FakeCommandResponse = { exitCode: 1 };

/** A `scutil --dns` output with one scoped default resolver per device (in the shape scutil prints). */
const scutilDns = (servers: Readonly<Record<string, readonly string[]>>): FakeCommandResponse => ({
  stdout: [
    'DNS configuration',
    '',
    'DNS configuration (for scoped queries)',
    '',
    ...Object.entries(servers).flatMap(([device, list], index) => [
      `resolver #${String(index + 1)}`,
      ...list.map((server, position) => `  nameserver[${String(position)}] : ${server}`),
      `  if_index : ${String(index + 4)} (${device})`,
      '  flags    : Scoped, Request A records',
      '',
    ]),
  ].join('\n'),
});

/** A machine with Ethernet (en5) and Wi-Fi (en0) both connected; every `route` call succeeds. */
const machine = (): FakeCommandRunner => {
  const runner = createFakeCommandRunner();
  runner.whenMatching((bin, args) => {
    if (bin === ROUTE) return {};
    if (bin === DSCACHEUTIL || bin === KILLALL) return {};
    if (bin === NETWORKSETUP) return { stdout: PORTS };
    if (bin === '/usr/sbin/netstat') return { stdout: 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n' };
    // No DNS server anywhere unless a test says otherwise.
    if (bin === SCUTIL) return scutilDns({});
    const wifi = args[1] === 'en0';
    if (args[0] === 'getifaddr') return { stdout: wifi ? '192.168.1.23\n' : '10.20.4.23\n' };
    if (args[2] === 'router') return { stdout: wifi ? '192.168.1.1\n' : `${ETH_GW}\n` };
    return args[2] === 'subnet_mask' ? { stdout: '255.255.255.0\n' } : NO_VALUE;
  });
  return runner;
};

interface Harness {
  readonly deps: RunDeps;
  readonly runner: FakeCommandRunner;
  /** DNS queries never reach the network: they stay open until a test answers them or sets `dns.auto`. */
  readonly dns: FakeDns;
  readonly scheduler: FakeScheduler;
  /** Sockets of the DNS proxy: nothing is ever bound for real. */
  readonly network: FakeNetwork;
  readonly out: string[];
  readonly err: string[];
  readonly configPaths: string[];
  readonly routeArgv: () => (readonly string[])[];
  readonly logs: () => Record<string, unknown>[];
}

/** `file` is either what the reader returns or a value to serve as the JSON content of the file. */
const harness = (file: unknown = CONFIG, extra: Partial<RunDeps> = {}): Harness => {
  const runner = machine();
  const dns = createFakeDns();
  const scheduler = createFakeScheduler(NOW);
  const network = createFakeNetwork();
  const out: string[] = [];
  const err: string[] = [];
  const configPaths: string[] = [];
  const isRead = (value: unknown): value is ConfigFileRead =>
    typeof value === 'object' && value !== null && 'kind' in value && !('version' in value);
  const readConfig: ConfigFileReader = (path) => {
    configPaths.push(path);
    return Promise.resolve(isRead(file) ? file : { kind: 'content', text: JSON.stringify(file) });
  };
  return {
    deps: {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
      createRunner: () => runner,
      readConfig,
      now: () => NOW,
      euid: () => 0,
      createDnsResolver: dns.factory,
      // Never the resolvers of the machine the tests run on.
      systemDnsServers: () => [],
      resolverDir: newResolverDir(),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      wallNow: () => scheduler.now().getTime(),
      monotonicNow: () => scheduler.now().getTime() - NOW.getTime(),
      // Never the real socket: a path in a temporary directory, left with the owner it was created with.
      socketPath: join(newResolverDir(), 's.sock'),
      socketOwner: null,
      dnsProxySockets: network.factory,
      ...extra,
    },
    runner,
    dns,
    scheduler,
    network,
    out,
    err,
    configPaths,
    routeArgv: () => runner.calls.filter((call) => call.bin === ROUTE).map((call) => call.args),
    logs: () =>
      err
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

describe('parseArgs', () => {
  it.each([
    [[], { kind: 'run', once: false, configPath: PATHS.config }],
    [['--once'], { kind: 'run', once: true, configPath: PATHS.config }],
    [['--once', '--config', '/tmp/rules.json'], { kind: 'run', once: true, configPath: '/tmp/rules.json' }],
    [['--config', 'rules.json', '--once'], { kind: 'run', once: true, configPath: 'rules.json' }],
    [['--help'], { kind: 'help' }],
    [['--once', '--help'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['--version', '--help'], { kind: 'help' }],
    [['--uninstall'], { kind: 'uninstall' }],
    [['--uninstall', '--help'], { kind: 'help' }],
  ] as const)('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [['--bogus'], 'Unknown argument at position 1'],
    [['--once', 'extra'], 'Unknown argument at position 2'],
    [['-h'], 'Unknown argument at position 1'],
    [['--config=/tmp/x.json'], 'Unknown argument at position 1'],
    [['--once', '--exec', 'rm -rf /'], 'Unknown argument at position 2'],
    [['--config'], '--config needs a path'],
    [['--config', ''], '--config needs a path'],
    [['--config', '--once'], '--config needs a path'],
    [['--config', 'a.json', '--config', 'b.json'], '--config was given more than once'],
    [['--uninstall', '--once'], '--uninstall takes no other argument'],
    [['--uninstall', '--config', '/tmp/x.json'], '--uninstall takes no other argument'],
    [['--uninstall', 'now'], 'Unknown argument at position 2'],
  ] as const)('refuses %j', (argv, message) => {
    expect(parseArgs(argv)).toEqual({ kind: 'usage-error', message });
  });
});

describe('run: flags that do no work', () => {
  it('prints the usage for --help and starts nothing', async () => {
    const h = harness();

    expect(await run(['--help'], h.deps)).toBe(EXIT_CODES.ok);

    expect(h.out).toEqual([USAGE]);
    expect(USAGE).toContain('--once');
    expect(USAGE).toContain(PATHS.config);
    expect(h.err).toEqual([]);
    expect(h.runner.calls).toEqual([]);
    expect(h.configPaths).toEqual([]);
  });

  it('prints the version for --version, and it is the version of the package', async () => {
    const h = harness();
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

    expect(await run(['--version'], h.deps)).toBe(EXIT_CODES.ok);

    expect(h.out).toEqual([`${HELPER_VERSION}\n`]);
    expect(HELPER_VERSION).toBe(manifest.version);
    expect(h.runner.calls).toEqual([]);
  });

  it('refuses an unknown flag with a usage error, without repeating it', async () => {
    const h = harness();

    expect(await run(['--once', '--evil=$(reboot)'], h.deps)).toBe(EXIT_CODES.usage);

    expect(h.out).toEqual([]);
    expect(h.err.join('')).toBe(`Unknown argument at position 2\n\n${USAGE}`);
    expect(h.runner.calls).toEqual([]);
    expect(h.configPaths).toEqual([]);
  });

  it('uses distinct non-zero exit codes', () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((code) => code === 0)).toEqual([EXIT_CODES.ok]);
  });
});

describe('run --once', () => {
  it('applies the config once and prints the state as the only thing on stdout', async () => {
    const h = harness();

    const code = await run(['--once', '--config', '/tmp/rules.json'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.configPaths).toEqual(['/tmp/rules.json']);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-net', '198.51.100.0/24', ETH_GW],
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
    ]);
    expect(h.out).toHaveLength(1);
    const printed: unknown = JSON.parse(h.out[0] ?? '');
    expect(EngineState.parse(printed)).toEqual(printed);
    expect(printed).toEqual({
      helperVersion: HELPER_VERSION,
      seq: 1,
      configRevision: 0,
      enabled: true,
      interfaces: {
        ethernet: { device: 'en5', ip: '10.20.4.23', gateway: ETH_GW, up: true },
        wifi: { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', up: true },
      },
      adapters: [
        { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.23' },
        { device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' },
      ],
      rules: [
        { ruleId: ID_A, status: 'active', reasonCode: null, reason: null, appliedDestinations: ['198.51.100.0/24'], lastResolvedAt: null },
        { ruleId: ID_B, status: 'active', reasonCode: null, reason: null, appliedDestinations: ['203.0.113.7'], lastResolvedAt: null },
      ],
      lastApplyAt: NOW.toISOString(),
      lastReconcileReason: 'startup',
    });
    expect(h.out[0]?.endsWith('}\n')).toBe(true);
  });

  it('reads the default config path when --config is not given', async () => {
    const h = harness();

    await run(['--once'], h.deps);

    expect(h.configPaths).toEqual([PATHS.config]);
  });

  it('logs to stderr as JSON lines, including every command it ran', async () => {
    const h = harness();

    await run(['--once'], h.deps);

    const logs = h.logs();
    expect(logs.every((entry) => typeof entry['level'] === 'string' && typeof entry['at'] === 'string')).toBe(true);
    expect(logs.find((entry) => entry['msg'] === 'config loaded')).toMatchObject({ component: 'main', source: 'file', rules: 2 });
    expect(logs.find((entry) => entry['msg'] === 'reconcile finished')).toMatchObject({
      component: 'engine',
      reason: 'startup',
      added: 2,
      removed: 0,
      failed: 0,
    });
    expect(logs.filter((entry) => entry['msg'] === 'route added')).toHaveLength(2);
    expect(logs.some((entry) => entry['level'] === 'warn' || entry['level'] === 'error')).toBe(false);
  });

  it('treats a missing config file as a first run: nothing to apply, exit 0', async () => {
    const h = harness({ kind: 'missing' });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.routeArgv()).toEqual([]);
    expect((JSON.parse(h.out[0] ?? '') as EngineState).rules).toEqual([]);
    expect(h.logs().find((entry) => entry['msg'] === 'config loaded')).toMatchObject({ source: 'default', rules: 0 });
  });

  it.each([
    ['corrupt JSON', { kind: 'content', text: '{"version":1,' }, 'invalid-json'],
    ['an invalid rule', { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '0.0.0.0/0', iface: 'ethernet' }] }, 'invalid-config'],
    ['an unreadable file', { kind: 'unreadable', detail: 'EACCES' }, 'unreadable'],
    ['an oversized file', { kind: 'too-large' }, 'too-large'],
    ['too many rules', { version: 1, rules: Array.from({ length: 501 }, () => ({})) }, 'invalid-structure'],
  ] as const)('touches nothing when the config is %s', async (_name, file, code) => {
    const h = harness(file);

    const exit = await run(['--once', '--config', '/tmp/rules.json'], h.deps);

    expect(exit).toBe(EXIT_CODES.configError);
    // Not one command: no route change, and not even an interface query.
    expect(h.runner.calls).toEqual([]);
    expect(h.out).toEqual([]);
    expect(h.logs()).toEqual([
      expect.objectContaining({
        level: 'error',
        component: 'main',
        msg: 'config could not be loaded; no route was touched',
        config: '/tmp/rules.json',
        code,
      }),
    ]);
  });

  it('exits non-zero when a rule ends in error, and still prints the state', async () => {
    const h = harness();
    h.runner.when(ROUTE, ['-n', 'add', '-net', '198.51.100.0/24', ETH_GW], {
      exitCode: 77,
      stderr: 'route: must be root to alter routing table\n',
    });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ruleError);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules.map((rule) => [rule.status, rule.reasonCode])).toEqual([
      ['error', 'route-failed'],
      ['active', null],
    ]);
    expect(h.logs().at(-1)).toMatchObject({ level: 'error', msg: 'one-shot run finished with errors', failedRules: 1, failedCommands: 1 });
  });

  it('exits non-zero for a rule the connected-subnet guard refuses, without running route', async () => {
    const h = harness({ version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '192.168.1.0/24', iface: 'ethernet' }] });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ruleError);
    expect(h.routeArgv()).toEqual([]);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({ status: 'error', reasonCode: 'connected-network' });
  });

  it('exits 0 when rules are merely pending or disabled', async () => {
    const h = harness({
      version: 1,
      rules: [
        { id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet' },
        { id: ID_B, kind: 'ip', target: '203.0.113.7', iface: 'wifi', enabled: false },
      ],
    });
    // Ethernet has no address: the domain rule waits for the interface, and nothing is resolved for it.
    h.runner.when(IPCONFIG, ['getifaddr', 'en5'], NO_VALUE);

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.routeArgv()).toEqual([]);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules.map((rule) => rule.reasonCode)).toEqual(['interface-down', 'rule-disabled']);
    expect(h.dns.created).toBe(0);
    expect(h.scheduler.scheduled).toEqual([]);
  });

  it('never adds a route on a detection it cannot trust: it retries once, then exits non-zero', async () => {
    const h = harness();
    h.runner.whenMatching((bin) => (bin === NETWORKSETUP ? { failure: 'timeout' } : undefined));

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.detectionUnreliable);
    // Two held passes; the pass that would accept the degraded detection is never run.
    expect(h.runner.calls.filter((call) => call.bin === NETWORKSETUP)).toHaveLength(2);
    expect(h.routeArgv()).toEqual([]);
    expect(h.out).toHaveLength(1);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.seq).toBe(2);
    expect(state.rules.map((rule) => [rule.status, rule.reasonCode])).toEqual([
      ['pending', 'interface-down'],
      ['pending', 'interface-down'],
    ]);
    expect(h.logs().at(-1)).toMatchObject({
      level: 'error',
      component: 'main',
      msg: 'interfaces could not be detected reliably; no route was added',
    });
  });

  it('does not let one failed address lookup turn a guarded rule into a route (QA reproduction, one-shot)', async () => {
    const h = harness({
      version: 1,
      rules: [
        { id: ID_A, kind: 'subnet', target: '192.168.1.0/24', iface: 'ethernet' },
        { id: ID_B, kind: 'subnet', target: '198.51.100.0/24', iface: 'ethernet' },
      ],
    });
    h.runner.when(IPCONFIG, ['getifaddr', 'en0'], { failure: 'timeout' });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.detectionUnreliable);
    expect(h.routeArgv()).toEqual([]);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.interfaces.wifi.up).toBe(false);
    expect(state.rules.every((rule) => rule.status === 'pending' && rule.appliedDestinations.length === 0)).toBe(true);
  });

  it('applies normally when the retry gets a clean detection', async () => {
    const h = harness();
    let failures = 1;
    h.runner.whenMatching((bin) => {
      if (bin !== NETWORKSETUP || failures === 0) return undefined;
      failures -= 1;
      return { failure: 'timeout' };
    });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.routeArgv()).toHaveLength(2);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).seq).toBe(2);
  });

  it('warns when it is not running as root', async () => {
    const asUser = harness(CONFIG, { euid: () => 501 });
    const asRoot = harness();

    await run(['--once'], asUser.deps);
    await run(['--once'], asRoot.deps);

    const warning = 'not running as root; route commands will be refused by the system';
    expect(asUser.logs().filter((entry) => entry['msg'] === warning)).toHaveLength(1);
    expect(asRoot.logs().filter((entry) => entry['msg'] === warning)).toHaveLength(0);
  });

  it('returns an exit code instead of rejecting when a dependency throws', async () => {
    const h = harness(CONFIG, {
      createRunner: () => {
        throw new Error('no runner');
      },
    });

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.internal);
    expect(h.err.at(-1)).toBe('Unexpected failure: no runner\n');
    expect(h.out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

const DOMAIN_CONFIG = {
  version: 1,
  rules: [
    { id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet' },
    { id: ID_B, kind: 'ip', target: '203.0.113.7', iface: 'wifi' },
  ],
};

/** Lets the run get on until `ready` holds; fails instead of waiting for ever. */
const until = async (ready: () => boolean): Promise<void> => {
  for (let round = 0; round < 2000 && !ready(); round += 1) {
    await flush(5);
    // The resolver files are real file-system work (in a temporary directory): let it finish.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  if (!ready()) throw new Error('the run never got there');
};

describe('run --once: domain rules', () => {
  it('performs no DNS activity at all for a config without domain rules', async () => {
    const h = harness();

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.dns.created).toBe(0);
    expect(h.dns.lookups).toEqual([]);
    expect(h.scheduler.scheduled).toEqual([]);
    expect(h.logs().some((entry) => entry['component'] === 'dns')).toBe(false);
    // One pass, as before domain rules existed.
    expect(h.logs().filter((entry) => entry['msg'] === 'reconcile finished')).toHaveLength(1);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect([state.seq, state.lastReconcileReason]).toEqual([1, 'startup']);
  });

  it.each([
    ['a disabled domain rule', { version: 1, rules: [{ ...DOMAIN_CONFIG.rules[0], enabled: false }] }],
    ['a config that is switched off', { ...DOMAIN_CONFIG, enabled: false }],
  ])('resolves nothing for %s', async (_name, file) => {
    const h = harness(file);

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.dns.created).toBe(0);
    expect(h.scheduler.scheduled).toEqual([]);
    expect(h.routeArgv()).toEqual([]);
  });

  it('waits for the lookup and applies the domain rule in a follow-up pass', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.dns.auto = () => ['198.51.100.21', '198.51.100.20'];

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.dns.lookups.map((lookup) => [lookup.hostname, lookup.servers])).toEqual([['corp.local', null]]);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
      ['-n', 'add', '-host', '198.51.100.21', ETH_GW],
    ]);
    expect(h.out).toHaveLength(1);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect([state.seq, state.lastReconcileReason]).toEqual([2, 'dns-refresh']);
    expect(state.rules).toEqual([
      {
        ruleId: ID_A,
        status: 'active',
        reasonCode: null,
        reason: null,
        appliedDestinations: ['198.51.100.20', '198.51.100.21'],
        lastResolvedAt: NOW.toISOString(),
      },
      { ruleId: ID_B, status: 'active', reasonCode: null, reason: null, appliedDestinations: ['203.0.113.7'], lastResolvedAt: null },
    ]);
    expect(h.logs().find((entry) => entry['msg'] === 'domain resolved')).toMatchObject({ component: 'dns', domain: 'corp.local', addresses: 2 });
    // Nothing is left behind: the refresh timer of the resolver is gone.
    expect(h.scheduler.pending()).toBe(0);
  });

  it('asks the DNS server of the rule', async () => {
    const h = harness({ version: 1, rules: [{ ...DOMAIN_CONFIG.rules[0], dns: '198.51.100.53' }] });
    h.dns.auto = () => ['198.51.100.20'];

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ok);

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['198.51.100.53']]);
  });

  it('exits non-zero when the lookup fails, and still applies the other rules', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.dns.auto = () => dnsError('ESERVFAIL');

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ruleError);
    expect(h.routeArgv()).toEqual([['-n', 'add', '-host', '203.0.113.7', '192.168.1.1']]);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules.map((rule) => [rule.status, rule.reasonCode, rule.appliedDestinations])).toEqual([
      ['error', 'resolve-failed', []],
      ['active', null, ['203.0.113.7']],
    ]);
    expect(h.logs().find((entry) => entry['msg'] === 'domain lookup failed')).toMatchObject({ level: 'warn', component: 'dns' });
    expect(h.logs().at(-1)).toMatchObject({ msg: 'one-shot run finished with errors', failedRules: 1, failedCommands: 0 });
    // The retry the resolver had scheduled is cancelled.
    expect(h.scheduler.pending()).toBe(0);
  });

  it('gives a DNS server that never answers the lookup timeout, then reports the rule as failed', async () => {
    const h = harness(DOMAIN_CONFIG);

    const running = run(['--once'], h.deps);
    await until(() => h.dns.lookups.length === 1 && h.scheduler.pending() === 2);
    expect(h.scheduler.delays()).toEqual([LOOKUP_TIMEOUT_MS, ONE_SHOT_DNS_WAIT_MS]);
    h.scheduler.advance(LOOKUP_TIMEOUT_MS);

    expect(await running).toBe(EXIT_CODES.ruleError);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'resolve-failed', appliedDestinations: [] });
    expect(h.scheduler.pending()).toBe(0);
  });

  it('stops waiting after the one-shot limit and says that a domain is still being resolved', async () => {
    const ids = Array.from({ length: 14 }, (_unused, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
    const h = harness({
      version: 1,
      rules: ids.map((id, index) => ({ id, kind: 'domain', target: `host-${String(index)}.corp.local`, iface: 'ethernet' })),
    });

    const running = run(['--once'], h.deps);
    // The first pass is over and the run waits for the lookups.
    await until(() => h.scheduler.scheduled.includes(ONE_SHOT_DNS_WAIT_MS));
    // Three batches of four (the limit per server set) answer just before their lookup timeout; the last
    // two domains are still in flight at 15 s.
    for (let batch = 1; batch <= 3; batch += 1) {
      await until(() => h.dns.open().length === 4);
      h.scheduler.advance(LOOKUP_TIMEOUT_MS - 100);
      for (const lookup of h.dns.open()) lookup.answer(['198.51.100.20']);
    }
    await until(() => h.dns.open().length === 2);
    h.scheduler.advance(300);

    expect(await running).toBe(EXIT_CODES.resolvePending);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules.filter((rule) => rule.status === 'active')).toHaveLength(12);
    expect(state.rules.filter((rule) => rule.reasonCode === 'resolving')).toHaveLength(2);
    expect(h.routeArgv()).toEqual([['-n', 'add', '-host', '198.51.100.20', ETH_GW]]);
    expect(h.logs().find((entry) => entry['msg'] === 'DNS lookups are still running; reconciling with what has been resolved so far')).toMatchObject({
      level: 'warn',
      waitedMs: ONE_SHOT_DNS_WAIT_MS,
      inFlight: 2,
    });
    expect(h.logs().at(-1)).toMatchObject({
      level: 'error',
      msg: 'one-shot run finished while a domain was still being resolved; its routes were not added',
    });
    // The two lookups are cancelled and their timers cleared.
    expect(h.dns.open()).toEqual([]);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('does not wait for DNS when the interfaces cannot be detected reliably', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.whenMatching((bin) => (bin === NETWORKSETUP ? { failure: 'timeout' } : undefined));

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.detectionUnreliable);
    expect(h.routeArgv()).toEqual([]);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('documents the exit code for a domain that is still being resolved', () => {
    expect(EXIT_CODES.resolvePending).toBe(6);
    expect(USAGE).toContain('6 a domain is still being resolved');
  });

  // -------------------------------------------------------------------------
  // The DNS server of the interface, config changes, QA gaps of TASK-110
  // -------------------------------------------------------------------------

  const dnsArgv = (h: Harness): (readonly string[])[] =>
    h.runner.calls.filter((call) => call.bin === SCUTIL).map((call) => call.args);

  it('never looks up the DNS servers of the interfaces for a config without an enabled domain rule', async () => {
    const files: unknown[] = [
      CONFIG,
      { version: 1, rules: [] },
      { version: 1, rules: [{ ...DOMAIN_CONFIG.rules[0], enabled: false }, CONFIG.rules[1]] },
      { ...DOMAIN_CONFIG, enabled: false },
    ];
    for (const file of files) {
      const h = harness(file);

      expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ok);

      expect(dnsArgv(h)).toEqual([]);
      expect(h.dns.created).toBe(0);
    }
  });

  it('looks them up for a rule that names its own server too, to keep them out of its answers (QA scenario i)', async () => {
    // One domain rule WITH `dns`, bound to Wi-Fi; the answer contains the DHCP DNS server of Ethernet.
    const h = harness({ version: 1, rules: [{ ...DOMAIN_CONFIG.rules[0], iface: 'wifi', dns: '198.51.100.53' }] });
    h.runner.when(SCUTIL, ['--dns'], scutilDns({ en5: ['10.20.4.53'], en0: ['192.168.1.1'] }));
    h.dns.auto = () => ['10.20.4.53', '198.51.100.20'];

    const code = await run(['--once'], h.deps);

    // Two passes, one cached detection: one command.
    expect(dnsArgv(h)).toEqual([['--dns']]);
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['198.51.100.53']]);
    // The real route wrapper on the fake runner: the rule's own server is routed (TASK-111), the
    // server of an interface never is.
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '198.51.100.53', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', '192.168.1.1'],
    ]);
    expect(JSON.stringify(h.routeArgv())).not.toMatch(/10\.20\.4\.53/);
    // The rule works for its other address: a warning, not an error (TASK-DELTA-07).
    expect(code).toBe(EXIT_CODES.ok);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({
      status: 'active',
      reasonCode: 'dns-server-excluded',
      reason: '1 resolved address of corp.local is a DNS server and never routed',
      appliedDestinations: ['198.51.100.53', '198.51.100.20'],
    });
  });

  it('does not hold explicit rules back when the DNS servers cannot be looked up', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.when(SCUTIL, ['--dns'], { failure: 'timeout' });
    h.dns.auto = () => ['198.51.100.20'];

    const code = await run(['--once'], h.deps);

    // Before, the failed lookup made the detection degraded: exit 5 and no route at all.
    expect(code).toBe(EXIT_CODES.ok);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    // The domain rule's own interface server is unknown, so the system resolvers were asked, with the warning.
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([null]);
    expect(h.logs().filter((entry) => entry['msg'] === 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toHaveLength(1);
  });

  it('asks the DNS servers of the interface the rule is bound to, in order, with one more command per detection', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.when(SCUTIL, ['--dns'], scutilDns({ en5: ['10.20.0.10', '10.20.0.11'], en0: ['192.168.1.1'] }));
    // The answer names the Wi-Fi resolver as well: it is not routed through Ethernet.
    h.dns.auto = () => ['198.51.100.20', '192.168.1.1'];

    const code = await run(['--once'], h.deps);

    expect(h.dns.lookups.map((lookup) => [lookup.hostname, lookup.servers])).toEqual([['corp.local', ['10.20.0.10', '10.20.0.11']]]);
    // Two passes, one cached detection: one command.
    expect(dnsArgv(h)).toEqual([['--dns']]);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      // The Ethernet servers are outside both connected subnets: the DNS-server warning asks the
      // table which way they go (TASK-DELTA-19), once for both passes (read-only `route -n get`).
      ['-n', 'get', '-host', '10.20.0.10'],
      ['-n', 'get', '-host', '10.20.0.11'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    expect(code).toBe(EXIT_CODES.ok);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules[0]).toMatchObject({ status: 'active', reasonCode: 'dns-server-excluded', appliedDestinations: ['198.51.100.20'] });
    // Which server was asked is in the log.
    expect(h.logs().find((entry) => entry['msg'] === 'domain resolved')).toMatchObject({
      component: 'dns',
      domain: 'corp.local',
      servers: ['10.20.0.10', '10.20.0.11'],
      source: 'interface',
    });
    expect(h.logs().some((entry) => entry['msg'] === 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toBe(false);
    // The interface state on stdout has no DNS field.
    expect(h.out[0]).not.toContain('10.20.0.10');
  });

  it('falls back to the system resolvers, with a warning, when the interface has no DNS server', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.dns.auto = () => ['198.51.100.20'];

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ok);

    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([null]);
    expect(h.logs().filter((entry) => entry['msg'] === 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toEqual([
      expect.objectContaining({ level: 'warn', component: 'dns', ruleId: ID_A, domain: 'corp.local', iface: 'ethernet' }),
    ]);
  });

  it('does not route the resolver of the system when a name resolves to it', async () => {
    const h = harness(DOMAIN_CONFIG, { systemDnsServers: () => ['198.51.100.53'] });
    h.dns.auto = () => ['198.51.100.53', '198.51.100.20'];

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ok);

    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({
      status: 'active',
      reasonCode: 'dns-server-excluded',
      reason: '1 resolved address of corp.local is a DNS server and never routed',
    });
  });

  it('does not wait for DNS on a degraded detection: the lookup is still open, and the run ends at once', async () => {
    // The rule names its server, so its lookup starts whatever the detection is like, and nothing answers it.
    const h = harness({ version: 1, rules: [{ ...DOMAIN_CONFIG.rules[0], dns: '198.51.100.53' }, DOMAIN_CONFIG.rules[1]] });
    // Wi-Fi's mask cannot be read: the detection is degraded, Ethernet is as usable as ever.
    h.runner.when(IPCONFIG, ['getoption', 'en0', 'subnet_mask'], { failure: 'timeout' });

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.detectionUnreliable);
    expect(h.routeArgv()).toEqual([]);
    // The rule is `resolving` in the last state, and its lookup really was in flight ...
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules[0]).toMatchObject({ status: 'pending', reasonCode: 'resolving' });
    expect(h.dns.lookups).toHaveLength(1);
    expect(h.dns.lookups[0]).toMatchObject({ settled: false, cancelled: true });
    // ... and still the run neither armed the DNS wait nor ran a third pass (which would have accepted
    // the degraded detection and added routes).
    expect(h.scheduler.scheduled).not.toContain(ONE_SHOT_DNS_WAIT_MS);
    expect(h.logs().filter((entry) => entry['msg'] === 'reconcile finished')).toHaveLength(2);
    expect(h.logs().some((entry) => entry['reason'] === 'dns-refresh')).toBe(false);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('on a degraded detection a rule without `dns` waits for a reliable one instead of asking the system resolvers', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.when(IPCONFIG, ['getoption', 'en0', 'subnet_mask'], { failure: 'timeout' });
    h.runner.when(SCUTIL, ['--dns'], scutilDns({ en5: ['10.20.0.10'] }));

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.detectionUnreliable);
    expect(h.routeArgv()).toEqual([]);
    expect(h.dns.created).toBe(0);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({
      status: 'pending',
      reasonCode: 'resolving',
      reason: 'Waiting for the DNS server of the ethernet interface to be known',
    });
    expect(h.logs().some((entry) => entry['msg'] === 'no DNS server is known for the interface of the rule; the system resolvers are asked')).toBe(false);
    // Nothing is in flight, so a wait would have returned at once and let a third, accepting pass run.
    expect(h.scheduler.scheduled).toEqual([]);
    expect(h.logs().filter((entry) => entry['msg'] === 'reconcile finished')).toHaveLength(2);
    expect(h.scheduler.pending()).toBe(0);
  });

  it('still reports a command that failed in the first pass after the follow-up pass succeeded', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.dns.auto = () => ['198.51.100.20'];
    let failures = 1;
    h.runner.whenMatching((bin, args) => {
      if (bin !== ROUTE || args[1] !== 'add' || args[3] !== '203.0.113.7' || failures === 0) return undefined;
      failures -= 1;
      return { exitCode: 1, stderr: 'route: writing to routing socket: Network is unreachable\n' };
    });

    const code = await run(['--once'], h.deps);

    // The follow-up pass added the route after all: no rule is in error at the end ...
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules.map((rule) => rule.status)).toEqual(['active', 'active']);
    expect(h.routeArgv().filter((args) => args[3] === '203.0.113.7')).toHaveLength(2);
    // ... but the run did have a failed command, and says so.
    expect(code).toBe(EXIT_CODES.ruleError);
    expect(h.logs().at(-1)).toMatchObject({ msg: 'one-shot run finished with errors', failedRules: 0, failedCommands: 1 });
  });

  it('wires the resolver to the engine: a config change reaches it without anyone calling `syncConfig`', async () => {
    const h = harness();
    const requests: string[] = [];
    const config = Config.parse(DOMAIN_CONFIG);
    const core = createCore(config, h.deps, createLogger({ sinks: [] }), (reason) => requests.push(reason));
    // Nothing runs before the first reconcile.
    expect([h.runner.calls.length, h.dns.created, h.scheduler.scheduled.length]).toEqual([0, 0, 0]);

    await core.engine.reconcile('startup');
    h.dns.lookups[0]?.answer(['198.51.100.20']);
    await flush();
    h.scheduler.advance(500);
    expect(requests).toEqual(['dns-refresh']);
    expect(core.dns.stats().entries).toBe(1);

    core.engine.setConfig(Config.parse({ ...DOMAIN_CONFIG, rules: [DOMAIN_CONFIG.rules[1]] }));

    expect(core.dns.stats()).toEqual({ entries: 0, inFlight: 0, queued: 0, timers: 0 });
    expect(h.scheduler.pending()).toBe(0);

    core.engine.setConfig(config);
    await core.engine.reconcile('config-change');
    expect(core.dns.stats().entries).toBe(1);
    core.engine.setEnabled(false);
    expect(core.dns.stats().entries).toBe(0);
    core.dns.stop();
  });

  it('knows the `dns` of every rule from the start, also of a rule whose interface is down', async () => {
    const h = harness();
    // Ethernet has no address: its rule is never asked about, and its DNS server must still not be routed.
    h.runner.when(IPCONFIG, ['getifaddr', 'en5'], NO_VALUE);
    const config = Config.parse({
      version: 1,
      rules: [
        { id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '198.51.100.53' },
        { id: ID_B, kind: 'domain', target: 'other.corp.local', iface: 'wifi' },
      ],
    });
    const core = createCore(config, h.deps, createLogger({ sinks: [] }));
    h.dns.auto = () => ['198.51.100.53', '198.51.100.20'];

    await core.engine.reconcile('startup');
    await flush();
    const outcome = await core.engine.reconcile('dns-refresh');
    core.dns.stop();

    expect(h.dns.lookups.map((lookup) => lookup.hostname)).toEqual(['other.corp.local']);
    expect(h.routeArgv()).toEqual([['-n', 'add', '-host', '198.51.100.20', '192.168.1.1']]);
    expect(outcome.state.rules.map((rule) => rule.reasonCode)).toEqual(['interface-down', 'dns-server-excluded']);
  });
});

describe('run --once: scoped DNS files (TASK-111)', () => {
  const WITH_DNS = {
    version: 1,
    rules: [{ id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.30.0.53' }],
  };

  it('never points a test at the real resolver directory', () => {
    expect(harness().deps.resolverDir).not.toBe(PATHS.resolverDir);
    expect(harness().deps.resolverDir?.startsWith(tmpdir())).toBe(true);
  });

  it('wires the resolver files to the engine: the file is written, the cache flushed, the server routed', async () => {
    const h = harness(WITH_DNS);
    h.dns.auto = () => ['198.51.100.20'];
    const dir = h.deps.resolverDir ?? '';

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ok);

    expect(readdirSync(dir)).toEqual(['corp.local']);
    expect(readFileSync(join(dir, 'corp.local'), 'utf8')).toBe('nameserver 10.30.0.53\n# managed-by: routeswitch\n');
    // One flush for the pass that wrote the file; the follow-up pass changed nothing.
    expect(h.runner.calls.filter((call) => call.bin === DSCACHEUTIL || call.bin === KILLALL).map((call) => [call.bin, ...call.args])).toEqual([
      [DSCACHEUTIL, '-flushcache'],
      [KILLALL, '-HUP', 'mDNSResponder'],
    ]);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '10.30.0.53', ETH_GW],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['10.30.0.53']]);
  });

  it('leaves a file that is not ours alone and reports the rule', async () => {
    const h = harness(WITH_DNS);
    h.dns.auto = () => ['198.51.100.20'];
    const dir = h.deps.resolverDir ?? '';
    writeFileSync(join(dir, 'corp.local'), 'nameserver 10.1.1.1\n');

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ruleError);

    expect(readFileSync(join(dir, 'corp.local'), 'utf8')).toBe('nameserver 10.1.1.1\n');
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({ status: 'error', reasonCode: 'resolver-conflict' });
    expect(h.runner.calls.some((call) => call.bin === DSCACHEUTIL)).toBe(false);
  });

  it('uses the file system it is given for the resolver files', async () => {
    const seen: string[] = [];
    const real = await import('node:fs/promises');
    const h = harness(WITH_DNS, {
      resolverFs: {
        open: ((path: string, ...rest: unknown[]) => {
          seen.push(`open ${path}`);
          return (real.open as (...args: unknown[]) => unknown)(path, ...rest);
        }) as typeof real.open,
        readdir: (path) => {
          seen.push(`readdir ${path}`);
          return real.readdir(path);
        },
        lstat: ((path: string) => {
          seen.push(`lstat ${path}`);
          return real.lstat(path);
        }) as typeof real.lstat,
        rename: real.rename,
        unlink: real.unlink,
        mkdir: (path, options) => real.mkdir(path, options),
        chmod: (path, mode) => real.chmod(path, mode),
      },
    });
    h.dns.auto = () => ['198.51.100.20'];

    await run(['--once'], h.deps);

    const dir = h.deps.resolverDir ?? '';
    expect(seen).toContain(`lstat ${dir}`);
    expect(seen).toContain(`readdir ${dir}`);
    expect(seen).toContain(`open ${dir}/corp.local`);
  });

  it('exposes the resolver files on the core for the shutdown path', () => {
    const h = harness(WITH_DNS);
    const core = createCore(Config.parse(WITH_DNS), h.deps, createLogger({ sinks: [] }));
    expect(typeof core.resolverFiles.removeAll).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Daemon: state.json, cleanup, shutdown (TASK-113)
// ---------------------------------------------------------------------------

describe('run without --once (daemon): state.json and cleanup', () => {
  const MARKER = '# managed-by: routeswitch';
  const OTHER_GW = '10.20.4.99';
  const METRICS = ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire\n       0         0         0         0         0         0      1500         0\n';

  /** A routing table the fake `route` acts on: `add`, `get` and `delete`, for hosts and /24 networks. */
  interface Table {
    readonly routes: Map<string, string>;
    /** Destinations whose delete fails (exit 1, "Operation not permitted"). */
    readonly failDelete: Set<string>;
  }

  const getBlock = (dst: string, gateway: string | null): string => {
    if (gateway === null) {
      return `   route to: ${dst.split('/')[0] ?? dst}\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n${METRICS}`;
    }
    const [address = dst, prefix] = dst.split('/');
    return prefix === undefined
      ? `   route to: ${address}\ndestination: ${address}\n    gateway: ${gateway}\n  interface: en5\n      flags: <UP,GATEWAY,HOST,DONE,STATIC>\n${METRICS}`
      : `   route to: ${address}\ndestination: ${address}\n       mask: 255.255.255.0\n    gateway: ${gateway}\n  interface: en5\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n${METRICS}`;
  };

  const withTable = (runner: FakeCommandRunner, table: Table): void => {
    runner.whenMatching((bin, args) => {
      if (bin !== ROUTE) return undefined;
      const [, op, kind, dst = '', gateway = ''] = args;
      const key = kind === '-net' ? dst : dst;
      if (op === 'add') {
        if (table.routes.has(key)) return { exitCode: 1, stderr: `route: writing to routing socket: File exists\n`, stdout: `add ${kind === '-net' ? 'net' : 'host'} ${dst}: gateway ${gateway}: File exists\n` };
        table.routes.set(key, gateway);
        return { stdout: `add ${kind === '-net' ? 'net' : 'host'} ${dst}: gateway ${gateway}\n` };
      }
      if (op === 'get') return { stdout: getBlock(dst, table.routes.get(key) ?? null) };
      if (op === 'delete') {
        if (table.failDelete.has(key)) return { exitCode: 1, stderr: 'route: writing to routing socket: Operation not permitted\n' };
        if (!table.routes.delete(key)) return { exitCode: 1, stdout: `delete net ${dst}: not in table\n`, stderr: 'route: writing to routing socket: not in table\n' };
        return { stdout: `delete ${kind === '-net' ? 'net' : 'host'} ${dst}\n` };
      }
      return undefined;
    });
  };

  interface FakeProcess {
    readonly bin: string;
    readonly args: readonly string[];
    stopped: boolean;
  }

  interface Daemon {
    readonly h: Harness;
    readonly table: Table;
    readonly statePath: string;
    readonly resolverDir: string;
    readonly processes: FakeProcess[];
    /** Sends the signal the daemon waits for. */
    signal(name?: string): void;
    readonly exit: Promise<number>;
    state(): unknown;
    commands(): string[];
  }

  const startDaemon = (
    options: {
      file?: unknown;
      table?: Table;
      statePath?: string;
      resolverDir?: string;
      signalAtOnce?: string;
      /** While `gate` is set, every `networksetup` call waits for it. */
      hold?: { gate: Promise<void> | null };
      /** Command line of the daemon; `[]` by default. */
      argv?: readonly string[];
      socketPath?: string;
      /** More dependencies, e.g. failing file systems. */
      extra?: Partial<RunDeps>;
    } = {},
  ): Daemon => {
    const table = options.table ?? { routes: new Map<string, string>(), failDelete: new Set<string>() };
    const resolverDir = options.resolverDir ?? newResolverDir();
    const statePath = options.statePath ?? join(newResolverDir(), 'state.json');
    const processes: FakeProcess[] = [];
    const spawner: ProcessSpawner = {
      spawn: (bin, args) => {
        const process: FakeProcess = { bin, args: [...args], stopped: false };
        processes.push(process);
        return {
          stop: () => {
            process.stopped = true;
          },
        };
      },
    };
    let fire: (name: string) => void = () => undefined;
    const signalled = new Promise<string>((resolve) => {
      fire = resolve;
    });
    if (options.signalAtOnce !== undefined) fire(options.signalAtOnce);
    const holder: { runner: FakeCommandRunner | null } = { runner: null };
    const hold = options.hold;
    const h = harness(options.file ?? CONFIG, {
      resolverDir,
      statePath,
      createSpawner: () => spawner,
      waitForSignal: () => signalled,
      ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
      ...options.extra,
      ...(hold === undefined
        ? {}
        : {
            createRunner: () => ({
              run: async (bin, args, runOptions) => {
                if (bin === NETWORKSETUP && hold.gate !== null) await hold.gate;
                if (holder.runner === null) throw new Error('runner not ready');
                return holder.runner.run(bin, args, runOptions);
              },
            }),
          }),
    });
    holder.runner = h.runner;
    withTable(h.runner, table);
    const exit = run(options.argv ?? [], h.deps);
    return {
      h,
      table,
      statePath,
      resolverDir,
      processes,
      signal: (name = 'SIGTERM') => {
        fire(name);
      },
      exit,
      state: () => JSON.parse(readFileSync(statePath, 'utf8')) as unknown,
      commands: () => h.runner.calls.map((call) => `${call.bin === ROUTE ? 'route' : call.bin.split('/').at(-1) ?? ''} ${call.args.join(' ')}`),
    };
  };

  const startDaemonStatePath = (): string => join(newResolverDir(), 'state.json');

  const running = async (daemon: Daemon): Promise<void> => {
    await vi.waitFor(() => {
      expect(daemon.processes).toHaveLength(1);
    });
  };

  it('applies, writes state.json, starts the monitor, and on SIGTERM removes everything and exits 0 with nothing left running', async () => {
    const daemon = startDaemon();
    await running(daemon);

    expect(daemon.processes[0]).toMatchObject({ bin: '/sbin/route', args: ['-n', 'monitor'] });
    expect([...daemon.table.routes]).toEqual([
      ['198.51.100.0/24', ETH_GW],
      ['203.0.113.7', '192.168.1.1'],
    ]);
    await vi.waitFor(() => {
      expect(daemon.state()).toEqual({
        version: 1,
        routes: [
          { dst: '198.51.100.0/24', gateway: ETH_GW, ruleIds: [ID_A] },
          { dst: '203.0.113.7', gateway: '192.168.1.1', ruleIds: [ID_B] },
        ],
      });
    });

    const before = daemon.h.runner.calls.length;
    daemon.signal('SIGTERM');
    expect(await daemon.exit).toBe(EXIT_CODES.ok);

    expect(daemon.table.routes.size).toBe(0);
    expect(daemon.state()).toEqual({ version: 1, routes: [] });
    expect(daemon.processes[0]?.stopped).toBe(true);
    // No interface detection during the cleanup: only route get / delete.
    expect(daemon.commands().slice(before).every((command) => /^route -n (get|delete) /.test(command))).toBe(true);
    // Nothing is left that would keep the process alive or reconcile later.
    expect(daemon.h.scheduler.pending()).toBe(0);
    const logs = daemon.h.logs();
    expect(logs.find((entry) => entry['msg'] === 'shutting down')).toMatchObject({ signal: 'SIGTERM' });
    // The second cleanup of the run (the first one was the startup's, with nothing left over).
    expect(logs.filter((entry) => entry['msg'] === 'cleanup finished').at(-1)).toMatchObject({ removed: 2, failed: 0, stateSaved: true });
  });

  it('SIGINT does the same', async () => {
    const daemon = startDaemon();
    await running(daemon);
    daemon.signal('SIGINT');
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.table.routes.size).toBe(0);
  });

  it('after a crash: removes what state.json lists and every managed resolver file first, then reconciles', async () => {
    const table: Table = {
      routes: new Map([
        ['192.0.2.0/24', ETH_GW],
        ['198.51.100.0/24', ETH_GW],
        // Listed in state.json through ETH_GW, but someone routed it through another gateway since.
        ['192.0.2.77', OTHER_GW],
      ]),
      failDelete: new Set(),
    };
    const statePath = join(newResolverDir(), 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        routes: [
          { dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] },
          { dst: '198.51.100.0/24', gateway: ETH_GW, ruleIds: [ID_A] },
          { dst: '192.0.2.77', gateway: ETH_GW, ruleIds: [] },
          { dst: '0.0.0.0/0', gateway: ETH_GW, ruleIds: [] },
        ],
      }),
    );
    const resolverDir = newResolverDir();
    writeFileSync(join(resolverDir, 'old.corp.local'), `nameserver 10.30.0.53\n${MARKER}\n`);
    writeFileSync(join(resolverDir, 'user.example'), 'nameserver 10.30.0.54\n');

    const daemon = startDaemon({ table, statePath, resolverDir });
    await running(daemon);

    const commands = daemon.commands();
    const firstDetection = commands.findIndex((command) => command.startsWith('networksetup'));
    expect(firstDetection).toBeGreaterThan(0);
    // Before any detection: only the checked deletes of the leftovers (up to 8 at a time, so interleaved; each
    // `get` before its own `delete`), never the forbidden one, and nothing deleted through another gateway.
    const cleanup = commands.slice(0, firstDetection).filter((command) => command.startsWith('route'));
    expect([...cleanup].sort()).toEqual([
      'route -n delete -net 192.0.2.0/24',
      'route -n delete -net 198.51.100.0/24',
      'route -n get -host 192.0.2.77',
      'route -n get -net 192.0.2.0/24',
      'route -n get -net 198.51.100.0/24',
    ]);
    for (const dst of ['192.0.2.0/24', '198.51.100.0/24']) {
      expect(cleanup.indexOf(`route -n get -net ${dst}`)).toBeLessThan(cleanup.indexOf(`route -n delete -net ${dst}`));
    }
    // The route through another gateway is forgotten, not deleted; the config's routes are back.
    expect([...daemon.table.routes].sort()).toEqual([
      ['192.0.2.77', OTHER_GW],
      ['198.51.100.0/24', ETH_GW],
      ['203.0.113.7', '192.168.1.1'],
    ]);
    expect(readdirSync(resolverDir)).toEqual(['user.example']);
    expect(daemon.h.logs().find((entry) => entry['msg'] === 'cleaning up what the previous run left behind')).toMatchObject({
      source: 'file',
      restored: 3,
      dropped: 1,
    });

    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect([...daemon.table.routes]).toEqual([['192.0.2.77', OTHER_GW]]);
  });

  it.each([
    ['garbage', 'not json at all'],
    ['the wrong shape', '{"version":7}'],
  ])('starts normally with a state.json that is %s', async (_name, content) => {
    const statePath = join(newResolverDir(), 'state.json');
    writeFileSync(statePath, content);
    const daemon = startDaemon({ statePath });
    await running(daemon);
    expect(daemon.table.routes.size).toBe(2);
    expect(daemon.h.logs().some((entry) => entry['level'] === 'error' && String(entry['msg']).startsWith('state file'))).toBe(true);
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
  });

  it('keeps a route whose delete failed in state.json, exits 1, and removes it at the next start', async () => {
    const table: Table = { routes: new Map(), failDelete: new Set(['203.0.113.7']) };
    const statePath = join(newResolverDir(), 'state.json');
    const first = startDaemon({ table, statePath });
    await running(first);
    first.signal();
    expect(await first.exit).toBe(EXIT_CODES.ruleError);
    expect(first.state()).toEqual({ version: 1, routes: [{ dst: '203.0.113.7', gateway: '192.168.1.1', ruleIds: [ID_B] }] });

    table.failDelete.clear();
    const second = startDaemon({ table, statePath, file: { version: 1, rules: [] } });
    await running(second);
    expect(table.routes.size).toBe(0);
    expect(second.state()).toEqual({ version: 1, routes: [] });
    second.signal();
    expect(await second.exit).toBe(EXIT_CODES.ok);
  });

  it('a signal during the startup: the startup adds nothing, the cleanup still runs, the monitor never starts', async () => {
    const table: Table = { routes: new Map([['192.0.2.0/24', ETH_GW]]), failDelete: new Set() };
    const statePath = join(newResolverDir(), 'state.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] }));
    const daemon = startDaemon({ table, statePath, signalAtOnce: 'SIGTERM' });
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.processes).toEqual([]);
    expect(daemon.table.routes.size).toBe(0);
    expect(daemon.commands().some((command) => command.includes(' add '))).toBe(false);
    expect(daemon.state()).toEqual({ version: 1, routes: [] });
    // The startup's cleanup finished before the final one began.
    const cleanups = daemon.h.logs().filter((entry) => entry['msg'] === 'cleanup finished');
    expect(cleanups.map((entry) => [entry['final'], entry['removed']])).toEqual([
      [false, 1],
      [true, 0],
    ]);
  });

  it('stops the DNS lookups and their timers too: nothing is left pending after the exit', async () => {
    const daemon = startDaemon({
      file: { version: 1, rules: [{ id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.30.0.53' }] },
    });
    daemon.h.dns.auto = () => ['198.51.100.20'];
    await running(daemon);
    expect(daemon.h.scheduler.pending()).toBeGreaterThan(1);
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.h.scheduler.pending()).toBe(0);
    expect(daemon.table.routes.size).toBe(0);
  });

  it('leaves no retry timer behind when a pass running at SIGTERM asks for one (detection keeps failing)', async () => {
    const hold: { gate: Promise<void> | null } = { gate: null };
    const daemon = startDaemon({ hold });
    // Every interface detection fails: each pass asks the daemon for a retry timer.
    daemon.h.runner.when(NETWORKSETUP, ['-listallhardwareports'], { exitCode: 1, stderr: 'networksetup failed\n' });
    await running(daemon);
    expect(daemon.h.scheduler.delays()).toContain(2000);

    // The retry fires; its pass hangs in the detection.
    let open: () => void = () => undefined;
    hold.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    daemon.h.scheduler.advance(2000);
    await flush();
    const scheduledBefore = daemon.h.scheduler.scheduled.length;

    daemon.signal('SIGTERM');
    await flush();
    hold.gate = null;
    open();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);

    expect(daemon.h.scheduler.pending()).toBe(0);
    // Not even scheduled and cleared again: once stopping, the hook sets no timer.
    expect(daemon.h.scheduler.scheduled.slice(scheduledBefore)).toEqual([]);
    expect(daemon.h.logs().some((entry) => entry['msg'] === 'interface detection is degraded; no route is added, and none is removed because of interface state, in this reconcile' || entry['msg'] === 'interface detection threw')).toBe(true);
  });

  it('with a config that cannot be loaded: cleans up the leftovers, applies nothing, keeps serving, and a setConfig repairs it', async () => {
    const table: Table = { routes: new Map([['192.0.2.0/24', ETH_GW]]), failDelete: new Set() };
    const dir = newResolverDir();
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const socketPath = join(dir, 's.sock');
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] }));
    const daemon = startDaemon({ table, statePath, socketPath, argv: ['--config', configPath], file: { kind: 'unreadable', detail: 'EACCES' } });
    await running(daemon);
    expect(daemon.table.routes.size).toBe(0);
    expect(daemon.commands().every((command) => /^route -n (get|delete|monitor)/.test(command) || !command.startsWith('route'))).toBe(true);

    const client = await connectTestClient(socketPath);
    const status = await client.request({ id: 1, method: 'status' });
    expect(status).toMatchObject({ id: 1, ok: true, result: { protocolVersion: PROTOCOL_VERSION, state: { enabled: false, rules: [] } } });
    // Never an empty config in place of the broken one.
    expect(await client.request({ id: 2, method: 'getConfig' })).toMatchObject({ id: 2, ok: false, code: 'operation-failed' });
    expect(await client.request({ id: 3, method: 'setEnabled', enabled: true })).toMatchObject({ id: 3, ok: false, code: 'operation-failed' });
    expect(existsSync(configPath)).toBe(false);

    const set = await client.request({ id: 4, method: 'setConfig', config: CONFIG });
    expect(set).toMatchObject({ id: 4, ok: true });
    expect(Config.parse(JSON.parse(readFileSync(configPath, 'utf8')))).toEqual(Config.parse(CONFIG));
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    expect(await client.request({ id: 5, method: 'getConfig' })).toMatchObject({ id: 5, ok: true, result: { configRevision: 1 } });
    expect(daemon.table.routes.size).toBe(2);
    client.close();
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.table.routes.size).toBe(0);
  });

  it('serves the socket: status, getConfig, setConfig, setEnabled, apply, with state events to the client', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const configPath = join(dir, 'config.json');
    const daemon = startDaemon({ socketPath, argv: ['--config', configPath] });
    await running(daemon);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(statSync(socketPath).isSocket()).toBe(true);

    const client = await connectTestClient(socketPath);
    const status = await client.request({ id: 1, method: 'status' });
    expect(status).toMatchObject({ ok: true, result: { protocolVersion: PROTOCOL_VERSION, helperVersion: HELPER_VERSION } });
    const got = await client.request({ id: 2, method: 'getConfig' });
    expect(got).toMatchObject({ ok: true, result: { configRevision: 0 } });

    const oneRule = { version: 1, rules: [CONFIG.rules[0]] };
    const set = await client.request({ id: 3, method: 'setConfig', config: oneRule });
    expect(set.ok).toBe(true);
    const setState = set.ok ? EngineState.parse(set.result['state']) : null;
    expect(setState?.configRevision).toBe(1);
    expect(setState?.lastReconcileReason).toBe('config-change');
    expect([...daemon.table.routes.keys()]).toEqual(['198.51.100.0/24']);
    // The event of that pass reached the client too, with the same seq.
    await client.waitFor(() => client.events.some((event) => event.event === 'state' && event.state.seq === setState?.seq));

    const off = await client.request({ id: 4, method: 'setEnabled', enabled: false });
    expect(off).toMatchObject({ ok: true, result: { state: { enabled: false, configRevision: 2 } } });
    expect(daemon.table.routes.size).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ enabled: false });

    const on = await client.request({ id: 5, method: 'setEnabled', enabled: true });
    expect(on).toMatchObject({ ok: true, result: { state: { enabled: true, configRevision: 3 } } });
    expect(daemon.table.routes.size).toBe(1);
    const applied = await client.request({ id: 6, method: 'apply' });
    expect(applied).toMatchObject({ ok: true, result: { state: { lastReconcileReason: 'manual' } } });

    // seq only ever grows on the connection.
    const seqs = client.events.flatMap((event) => (event.event === 'state' ? [event.state.seq] : []));
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(client.invalid).toEqual([]);

    // SIGTERM: the connection is closed before the cleanup, so no state event reports it (TASK-002).
    const eventsBefore = client.events.length;
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    await client.closed;
    expect(client.events.slice(eventsBefore).filter((event) => event.event === 'state')).toEqual([]);
    expect(daemon.table.routes.size).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    expect(daemon.h.scheduler.pending()).toBe(0);
  });

  it('uninstall: removes every route and resolver file, answers, closes the socket, then waits for the signal', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const daemon = startDaemon({ socketPath, argv: ['--config', join(dir, 'config.json')] });
    await running(daemon);
    expect(daemon.table.routes.size).toBe(2);
    const client = await connectTestClient(socketPath);
    await client.request({ id: 1, method: 'status' });
    const eventsBefore = client.events.length;

    expect(await client.request({ id: 2, method: 'uninstall' })).toEqual({ id: 2, ok: true, result: {} });
    expect(daemon.table.routes.size).toBe(0);
    expect(daemon.state()).toEqual({ version: 1, routes: [] });
    expect(daemon.processes[0]?.stopped).toBe(true);
    await client.closed;
    expect(client.events.slice(eventsBefore).filter((event) => event.event === 'state')).toEqual([]);
    await vi.waitFor(() => {
      expect(existsSync(socketPath)).toBe(false);
    });

    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.table.routes.size).toBe(0);
  });

  it('does not take over the socket of a helper that is running: exits 7 and touches nothing', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const first = startDaemon({ socketPath, argv: ['--config', join(dir, 'config.json')] });
    await running(first);
    const routes = [...first.table.routes];

    const statePath = join(dir, 'second-state.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '198.51.100.0/24', gateway: ETH_GW, ruleIds: [] }] }));
    const second = startDaemon({ socketPath, statePath, table: first.table });
    expect(await second.exit).toBe(EXIT_CODES.socketUnavailable);
    expect(second.processes).toEqual([]);
    expect([...first.table.routes]).toEqual(routes);
    expect(second.h.runner.calls).toEqual([]);

    // The first still answers.
    const client = await connectTestClient(socketPath);
    expect(await client.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
    client.close();
    first.signal();
    expect(await first.exit).toBe(EXIT_CODES.ok);
  });

  it('replaces a stale socket file left by a crashed helper', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    // A socket file nobody listens on any more.
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
    const staleIno = statSync(socketPath).ino;
    await new Promise<void>((resolve) => {
      // Node removes the file on close; put a socket file back without a listener.
      stale.close(() => {
        resolve();
      });
    });
    const ghost = createServer();
    await new Promise<void>((resolve) => ghost.listen(socketPath, resolve));
    // Leave the file, drop the listener: close the handle without unlinking.
    const ghostIno = statSync(socketPath).ino;
    expect(ghostIno).not.toBe(staleIno);
    renameSync(socketPath, `${socketPath}.keep`);
    await new Promise<void>((resolve) => {
      ghost.close(() => {
        resolve();
      });
    });
    renameSync(`${socketPath}.keep`, socketPath);

    const daemon = startDaemon({ socketPath, argv: ['--config', join(dir, 'config.json')] });
    await running(daemon);
    expect(statSync(socketPath).ino).not.toBe(ghostIno);
    const client = await connectTestClient(socketPath);
    expect(await client.request({ id: 1, method: 'status' })).toMatchObject({ ok: true });
    client.close();
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
  });

  it('leaves a path that is not a socket alone and exits 7', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    writeFileSync(socketPath, 'not a socket');
    const daemon = startDaemon({ socketPath });
    expect(await daemon.exit).toBe(EXIT_CODES.socketUnavailable);
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket');
    expect(daemon.h.runner.calls).toEqual([]);
  });

  it('logs to the log file when one is given, and not to stderr', async () => {
    const dir = newResolverDir();
    const logPath = join(dir, 'logs', 'helper.log');
    const h = harness(CONFIG, { logPath, waitForSignal: () => Promise.resolve('SIGTERM'), createSpawner: () => ({ spawn: () => ({ stop: () => undefined }) }) });
    expect(await run(['--config', join(dir, 'config.json')], h.deps)).toBe(EXIT_CODES.ok);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line['msg'] === 'shutting down')).toBe(true);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);
    expect(h.err).toEqual([]);
  });

  it('cleanupAll (global toggle off): routes and resolver files go, the engine keeps working', async () => {
    const WITH_DNS = {
      version: 1,
      rules: [{ id: ID_A, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.30.0.53' }],
    };
    const h = harness(WITH_DNS);
    const table: Table = { routes: new Map(), failDelete: new Set() };
    withTable(h.runner, table);
    h.dns.auto = () => ['198.51.100.20'];
    const statePath = join(newResolverDir(), 'state.json');
    const root = createLogger({ sinks: [] });
    const store = createStateStore({ logger: root, path: statePath });
    const core = createCore(Config.parse(WITH_DNS), h.deps, root, undefined, {
      onApplied: async (routes) => {
        await store.save(routes);
      },
    });
    await core.engine.reconcile('startup');
    await core.dns.whenIdle();
    await core.engine.reconcile('dns-refresh');
    const dir = h.deps.resolverDir ?? '';
    expect(readdirSync(dir)).not.toEqual([]);
    expect(table.routes.size).toBeGreaterThan(0);

    const result = await cleanupAll(core, store, root);

    expect(result).toMatchObject({ failed: 0, stateSaved: true });
    expect(table.routes.size).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ version: 1, routes: [] });
    // Not final: a later pass applies again.
    await core.engine.reconcile('manual');
    expect(table.routes.size).toBeGreaterThan(0);
    core.dns.stop();
  });

  it('documents the launchd exit timeout the cleanup is sized for', () => {
    expect(SHUTDOWN_EXIT_TIMEOUT_SEC).toBe(60);
  });

  it('never points a daemon test at the real socket or log file', () => {
    const daemonDeps = harness().deps;
    expect(daemonDeps.socketPath).not.toBe(PATHS.socket);
    expect(daemonDeps.socketPath?.startsWith(tmpdir())).toBe(true);
    expect(daemonDeps.socketOwner).toBeNull();
    expect(daemonDeps.logPath).toBeUndefined();
  });

  it('never points a daemon test at the real state file', () => {
    const daemonDeps = harness().deps;
    expect(daemonDeps.statePath).toBeUndefined();
    expect(startDaemonStatePath()).not.toBe(PATHS.state);
  });

  // -------------------------------------------------------------------------
  // --uninstall (TASK-115): what uninstall.sh runs before it boots the daemon out
  // -------------------------------------------------------------------------

  it('documents --uninstall and its exit code', () => {
    expect(EXIT_CODES.uninstallFailed).toBe(8);
    expect(USAGE).toContain('--uninstall');
    expect(USAGE).toContain('8 --uninstall: something could not be removed, or the running helper did not answer');
  });

  it('--uninstall: the running helper removes everything and answers; the daemon then waits for SIGTERM', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const daemon = startDaemon({ socketPath, argv: ['--config', join(dir, 'config.json')] });
    await running(daemon);
    expect(daemon.table.routes.size).toBe(2);

    const tool = startDaemon({ socketPath, argv: ['--uninstall'], table: daemon.table, statePath: join(dir, 'tool-state.json') });
    expect(await tool.exit).toBe(EXIT_CODES.ok);
    expect(tool.h.out).toEqual(['the running helper removed its routes and resolver files\n']);
    // The tool itself ran nothing: the daemon did the cleanup.
    expect(tool.h.runner.calls).toEqual([]);
    expect(existsSync(join(dir, 'tool-state.json'))).toBe(false);
    expect(daemon.table.routes.size).toBe(0);
    expect(daemon.state()).toEqual({ version: 1, routes: [] });
    expect(daemon.processes[0]?.stopped).toBe(true);
    expect(tool.h.logs().find((entry) => entry['msg'] === 'uninstall: the running helper removed every route and resolver file')).toMatchObject({
      level: 'info',
      component: 'main',
    });

    // launchctl bootout: SIGTERM finds nothing left to remove.
    daemon.signal();
    expect(await daemon.exit).toBe(EXIT_CODES.ok);
    expect(daemon.table.routes.size).toBe(0);
  });

  it('--uninstall without a running helper: removes the routes of state.json and the managed resolver files itself', async () => {
    const table: Table = {
      routes: new Map([
        ['192.0.2.0/24', ETH_GW],
        ['192.0.2.77', OTHER_GW],
      ]),
      failDelete: new Set<string>(),
    };
    const statePath = startDaemonStatePath();
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        routes: [
          { dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [ID_A] },
          { dst: '192.0.2.77', gateway: ETH_GW, ruleIds: [] },
          { dst: '0.0.0.0/0', gateway: ETH_GW, ruleIds: [] },
        ],
      }),
    );
    const resolverDir = newResolverDir();
    writeFileSync(join(resolverDir, 'old.corp.local'), `nameserver 10.30.0.53\n${MARKER}\n`);
    writeFileSync(join(resolverDir, 'user.example'), 'nameserver 10.30.0.54\n');

    const tool = startDaemon({ table, statePath, resolverDir, argv: ['--uninstall'], socketPath: join(newResolverDir(), 'none.sock') });
    expect(await tool.exit).toBe(EXIT_CODES.ok);

    expect(tool.h.out).toEqual(['no helper is running\n', 'removed what the last run left behind: 1 route(s), 1 resolver file(s)\n']);
    // Only checked deletes of what state.json lists (never the forbidden entry, never through another
    // gateway), the cache flush after the resolver file: no detection, no add, no monitor.
    expect([...tool.commands()].sort()).toEqual([
      'dscacheutil -flushcache',
      'killall -HUP mDNSResponder',
      'route -n delete -net 192.0.2.0/24',
      'route -n get -host 192.0.2.77',
      'route -n get -net 192.0.2.0/24',
    ]);
    expect(tool.processes).toEqual([]);
    expect([...table.routes]).toEqual([['192.0.2.77', OTHER_GW]]);
    expect(readdirSync(resolverDir)).toEqual(['user.example']);
    expect(tool.state()).toEqual({ version: 1, routes: [] });
    expect(tool.h.scheduler.pending()).toBe(0);
    expect(tool.h.logs().find((entry) => entry['msg'] === 'uninstall: no helper answers on the socket; cleaning up after the last run')).toMatchObject({
      code: 'ENOENT',
    });
  });

  it('--uninstall without a running helper: a route that cannot be deleted stays in state.json and the exit code is 8', async () => {
    const table: Table = { routes: new Map([['192.0.2.0/24', ETH_GW]]), failDelete: new Set(['192.0.2.0/24']) };
    const statePath = startDaemonStatePath();
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] }));

    const tool = startDaemon({ table, statePath, argv: ['--uninstall'], socketPath: join(newResolverDir(), 'none.sock') });
    expect(await tool.exit).toBe(EXIT_CODES.uninstallFailed);
    expect(tool.h.out.at(-1)).toMatch(/^could not remove everything the last run left behind \(1 route\(s\), 0 resolver file\(s\)\)/);
    // uninstall.sh stops here, so a second run can still find the route.
    expect(tool.state()).toEqual({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] });
  });

  it('--uninstall without a running helper: a managed resolver file that cannot be removed gives exit 8', async () => {
    const resolverDir = newResolverDir();
    writeFileSync(join(resolverDir, 'old.corp.local'), `nameserver 10.30.0.53\n${MARKER}\n`);
    const realFs = await import('node:fs/promises');
    const tool = startDaemon({
      resolverDir,
      argv: ['--uninstall'],
      socketPath: join(newResolverDir(), 'none.sock'),
      extra: {
        resolverFs: {
          open: realFs.open,
          readdir: (path) => realFs.readdir(path),
          lstat: realFs.lstat,
          rename: realFs.rename,
          unlink: () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })),
          mkdir: (path, options) => realFs.mkdir(path, options),
          chmod: (path, mode) => realFs.chmod(path, mode),
        },
      },
    });
    expect(await tool.exit).toBe(EXIT_CODES.uninstallFailed);
    expect(tool.h.out.at(-1)).toMatch(/^could not remove everything the last run left behind \(0 route\(s\), 1 resolver file\(s\)\)/);
    expect(readdirSync(resolverDir)).toEqual(['old.corp.local']);
  });

  it('--uninstall without a running helper: a state.json that cannot be saved gives exit 8', async () => {
    const table: Table = { routes: new Map([['192.0.2.0/24', ETH_GW]]), failDelete: new Set<string>() };
    const statePath = startDaemonStatePath();
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] }));
    const realFs = await import('node:fs/promises');
    const tool = startDaemon({
      table,
      statePath,
      argv: ['--uninstall'],
      socketPath: join(newResolverDir(), 'none.sock'),
      extra: {
        stateFs: {
          // Reading works; every write fails.
          open: (path, flags, mode) =>
            typeof flags === 'number' && (flags & constants.O_WRONLY) !== 0
              ? Promise.reject(Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }))
              : realFs.open(path, flags, mode),
          rename: realFs.rename,
          unlink: realFs.unlink,
          mkdir: (path, options) => realFs.mkdir(path, options),
        },
      },
    });
    expect(await tool.exit).toBe(EXIT_CODES.uninstallFailed);
    // The route itself is gone; what fails is the record of it.
    expect(table.routes.size).toBe(0);
    expect(tool.h.out.at(-1)).toMatch(/^could not remove everything the last run left behind/);
  });

  it('--uninstall with nothing left behind: exit 0, no route command', async () => {
    const tool = startDaemon({ argv: ['--uninstall'], socketPath: join(newResolverDir(), 'none.sock') });
    expect(await tool.exit).toBe(EXIT_CODES.ok);
    expect(tool.h.out.at(-1)).toBe('removed what the last run left behind: 0 route(s), 0 resolver file(s)\n');
    expect(tool.h.runner.calls).toEqual([]);
  });

  it.each([
    ['answers with an error', (socket: Socket) => {
      socket.write(`${JSON.stringify({ id: 1, ok: false, code: 'operation-failed', error: 'cleanup failed: 1 route(s) could not be removed' })}\n`);
    }, 'the running helper could not remove everything (operation-failed: cleanup failed: 1 route(s) could not be removed); see /Library/Logs/RouteSwitch/helper.log\n'],
    ['closes the connection without an answer', (socket: Socket) => {
      socket.end();
    }, 'the helper socket could not be used (closed)\n'],
  ])('--uninstall: exit 8 and nothing cleaned up here when the running helper %s', async (_name, answer, line) => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const helper = createServer((socket) => {
      socket.once('data', () => {
        answer(socket);
      });
    });
    await new Promise<void>((resolve) => helper.listen(socketPath, resolve));
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] }));
    try {
      const tool = startDaemon({ socketPath, statePath, argv: ['--uninstall'] });
      expect(await tool.exit).toBe(EXIT_CODES.uninstallFailed);
      expect(tool.h.out).toEqual([line]);
      expect(tool.h.runner.calls).toEqual([]);
      expect(tool.state()).toEqual({ version: 1, routes: [{ dst: '192.0.2.0/24', gateway: ETH_GW, ruleIds: [] }] });
      expect(tool.h.logs().find((entry) => entry['msg'] === 'uninstall: the running helper did not confirm the cleanup')).toMatchObject({ level: 'error' });
    } finally {
      await new Promise<void>((resolve) => {
        helper.close(() => {
          resolve();
        });
      });
    }
  });

  it('--uninstall: exit 8 after 60 s without an answer', async () => {
    const dir = newResolverDir();
    const socketPath = join(dir, 's.sock');
    const helper = createServer((socket) => {
      socket.resume();
    });
    await new Promise<void>((resolve) => helper.listen(socketPath, resolve));
    try {
      const tool = startDaemon({ socketPath, argv: ['--uninstall'] });
      await vi.waitFor(() => {
        expect(tool.h.scheduler.delays()).toContain(60_000);
      });
      tool.h.scheduler.advance(60_000);
      expect(await tool.exit).toBe(EXIT_CODES.uninstallFailed);
      expect(tool.h.out).toEqual(['the running helper did not answer within 60 s\n']);
      expect(tool.h.runner.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => {
        helper.close(() => {
          resolve();
        });
      });
    }
  });
  describe('the DNS proxy of wildcard rules (TASK-DELTA-28)', () => {
    const ID_W = '00000000-0000-4000-8000-000000000009';
    const WILD = { id: ID_W, kind: 'domain', target: '*.corp.local', iface: 'ethernet' };
    const WILD_CONFIG = { version: 1, rules: [...CONFIG.rules, WILD] };
    const PROXY_FILE = `nameserver 127.0.0.1\nport 954\n${MARKER}\n`;
    const msgIndex = (daemon: Daemon, msg: string, from = 0): number =>
      daemon.h.logs().findIndex((entry, index) => index >= from && entry['msg'] === msg);
    const fileOf = (daemon: Daemon): string | null =>
      existsSync(join(daemon.resolverDir, 'corp.local')) ? readFileSync(join(daemon.resolverDir, 'corp.local'), 'utf8') : null;
    const ruleState = async (client: Awaited<ReturnType<typeof connectTestClient>>, id: number): Promise<unknown> => {
      const response = await client.request({ id, method: 'status' });
      return response.ok ? EngineState.parse(response.result['state']).rules.find((rule) => rule.ruleId === ID_W) : null;
    };

    it('starts after the leftovers are cleaned up and the first pass ran, writes the proxy file, and stops before the cleanup at SIGTERM', async () => {
      const daemon = startDaemon({ file: WILD_CONFIG });
      await running(daemon);
      await vi.waitFor(() => {
        expect(fileOf(daemon)).toBe(PROXY_FILE);
      });
      const { network } = daemon.h;
      // Loopback only, port 954, UDP and TCP.
      expect(network.udpSockets.map((socket) => socket.bound)).toEqual([{ port: 954, address: '127.0.0.1' }]);
      expect(network.tcpServers.map((server) => server.listening)).toEqual([{ port: 954, address: '127.0.0.1' }]);
      const recovered = msgIndex(daemon, 'cleanup finished');
      const firstPass = msgIndex(daemon, 'reconcile finished');
      const started = msgIndex(daemon, 'starting the DNS proxy for wildcard rules');
      expect(recovered).toBeGreaterThanOrEqual(0);
      expect(firstPass).toBeGreaterThan(recovered);
      expect(started).toBeGreaterThan(firstPass);
      // The first pass ran without the proxy: the rule waited, it was not an error, and no file was written then.
      expect(daemon.h.logs()[firstPass]).toMatchObject({ reason: 'startup' });
      expect(daemon.h.logs().find((entry) => entry['msg'] === 'rule cannot be applied' && entry['ruleId'] === ID_W)).toMatchObject({
        level: 'info',
        reasonCode: 'dns-proxy-unavailable',
      });

      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
      const stopping = msgIndex(daemon, 'stopping the DNS proxy');
      const shutdown = msgIndex(daemon, 'shutting down');
      const finalCleanup = msgIndex(daemon, 'cleanup finished', shutdown);
      expect(stopping).toBeGreaterThan(shutdown);
      expect(finalCleanup).toBeGreaterThan(stopping);
      expect(daemon.h.logs()[stopping]).toMatchObject({ why: 'shutting down' });
      expect(network.udpSockets.every((socket) => socket.closed)).toBe(true);
      expect(network.tcpServers.every((server) => server.closed)).toBe(true);
      expect(fileOf(daemon)).toBeNull();
      expect(daemon.h.scheduler.pending()).toBe(0);
    });

    it('never starts without an enabled wildcard rule; starts with the first one a setConfig brings, stops after the last goes', async () => {
      const dir = newResolverDir();
      const socketPath = join(dir, 's.sock');
      const daemon = startDaemon({ socketPath, argv: ['--config', join(dir, 'config.json')] });
      await running(daemon);
      expect(daemon.h.network.udpSockets).toEqual([]);
      const client = await connectTestClient(socketPath);

      // A switched-off wildcard does not count.
      await client.request({ id: 1, method: 'setConfig', config: { version: 1, rules: [{ ...WILD, enabled: false }] } });
      expect(daemon.h.network.udpSockets).toEqual([]);

      // Started inside the pass, before its files: the rule is active at once, never pending or in error.
      expect((await client.request({ id: 2, method: 'setConfig', config: WILD_CONFIG })).ok).toBe(true);
      expect(daemon.h.network.udpSockets[0]?.bound).toEqual({ port: 954, address: '127.0.0.1' });
      expect(fileOf(daemon)).toBe(PROXY_FILE);
      expect(await ruleState(client, 3)).toMatchObject({ status: 'active', reasonCode: null });

      await client.request({ id: 4, method: 'setConfig', config: CONFIG });
      expect(fileOf(daemon)).toBeNull();
      expect(daemon.h.network.udpSockets[0]?.closed).toBe(true);
      // The file went first, then the proxy (no name is sent to a proxy that is gone).
      expect(msgIndex(daemon, 'stopping the DNS proxy')).toBeGreaterThan(msgIndex(daemon, 'resolver file removed'));

      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
    });

    it('port 954 in use: no file (normal DNS keeps working), the rule is `error` / `dns-proxy-unavailable`, and a later retry fixes it', async () => {
      const dir = newResolverDir();
      const socketPath = join(dir, 's.sock');
      const network = createFakeNetwork();
      network.bindErrors.push('EADDRINUSE');
      const daemon = startDaemon({ socketPath, file: WILD_CONFIG, argv: ['--config', join(dir, 'config.json')], extra: { dnsProxySockets: network.factory } });
      await running(daemon);
      const client = await connectTestClient(socketPath);
      await vi.waitFor(async () => {
        expect(await ruleState(client, 1)).toMatchObject({ status: 'error', reasonCode: 'dns-proxy-unavailable' });
      });
      expect(((await ruleState(client, 2)) as { reason: string }).reason).toContain('EADDRINUSE');
      expect(fileOf(daemon)).toBeNull();
      // The other rules are applied as usual.
      expect(daemon.table.routes.size).toBe(2);

      // The proxy retries on its own (5 s first); the pass it asks for writes the file.
      daemon.h.scheduler.advance(5000);
      await vi.waitFor(() => {
        expect(fileOf(daemon)).toBe(PROXY_FILE);
      });
      await vi.waitFor(async () => {
        expect(await ruleState(client, 3)).toMatchObject({ status: 'active' });
      });
      expect(daemon.h.logs().find((entry) => entry['msg'] === 'DNS proxy state changed; resolver files follow')).toMatchObject({ state: 'running' });

      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
      expect(daemon.h.scheduler.pending()).toBe(0);
    });

    it('a shutdown while the bind is being retried cancels the retry: nothing is left pending', async () => {
      const network = createFakeNetwork();
      network.bindErrors.push('EADDRINUSE');
      const daemon = startDaemon({ file: WILD_CONFIG, extra: { dnsProxySockets: network.factory } });
      await running(daemon);
      await vi.waitFor(() => {
        expect(daemon.h.logs().find((entry) => entry['msg'] === 'DNS proxy could not listen; wildcard domains are unavailable')).toMatchObject({
          code: 'EADDRINUSE',
          port: 954,
          retryInMs: 5000,
        });
      });
      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
      expect(daemon.h.scheduler.pending()).toBe(0);
      expect(network.udpSockets.every((socket) => socket.closed)).toBe(true);
    });

    it('global toggle off: the proxy stops first, then everything is removed; on again starts it again', async () => {
      const dir = newResolverDir();
      const socketPath = join(dir, 's.sock');
      const daemon = startDaemon({ socketPath, file: WILD_CONFIG, argv: ['--config', join(dir, 'config.json')] });
      await running(daemon);
      await vi.waitFor(() => {
        expect(fileOf(daemon)).toBe(PROXY_FILE);
      });
      const client = await connectTestClient(socketPath);
      const before = daemon.h.logs().length;

      expect((await client.request({ id: 1, method: 'setEnabled', enabled: false })).ok).toBe(true);
      const stopping = msgIndex(daemon, 'stopping the DNS proxy', before);
      expect(daemon.h.logs()[stopping]).toMatchObject({ why: 'routing turned off' });
      expect(msgIndex(daemon, 'cleanup finished', before)).toBeGreaterThan(stopping);
      expect(fileOf(daemon)).toBeNull();
      expect(daemon.table.routes.size).toBe(0);
      expect(daemon.h.network.udpSockets.every((socket) => socket.closed)).toBe(true);

      expect((await client.request({ id: 2, method: 'setEnabled', enabled: true })).ok).toBe(true);
      expect(fileOf(daemon)).toBe(PROXY_FILE);
      expect(daemon.h.network.udpSockets.at(-1)?.closed).toBe(false);

      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
    });

    it('uninstall: the proxy stops before the cleanup and never starts again', async () => {
      const dir = newResolverDir();
      const socketPath = join(dir, 's.sock');
      const daemon = startDaemon({ socketPath, file: WILD_CONFIG, argv: ['--config', join(dir, 'config.json')] });
      await running(daemon);
      await vi.waitFor(() => {
        expect(fileOf(daemon)).toBe(PROXY_FILE);
      });
      const client = await connectTestClient(socketPath);
      const before = daemon.h.logs().length;
      expect(await client.request({ id: 1, method: 'uninstall' })).toEqual({ id: 1, ok: true, result: {} });
      const stopping = msgIndex(daemon, 'stopping the DNS proxy', before);
      expect(stopping).toBeGreaterThanOrEqual(0);
      expect(msgIndex(daemon, 'cleanup finished', before)).toBeGreaterThan(stopping);
      expect(fileOf(daemon)).toBeNull();
      expect(daemon.h.network.udpSockets).toHaveLength(1);

      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
      expect(daemon.h.network.udpSockets).toHaveLength(1);
    });

    it('after a crash: a proxy file left behind is removed at the start, also when no wildcard rule is left', async () => {
      const resolverDir = newResolverDir();
      writeFileSync(join(resolverDir, 'corp.local'), PROXY_FILE);
      writeFileSync(join(resolverDir, '.routeswitch-lab.local.tmp'), 'nameserver 127.0.0.1\nport 9');
      const daemon = startDaemon({ resolverDir });
      await running(daemon);
      expect(readdirSync(resolverDir)).toEqual([]);
      expect(daemon.h.network.udpSockets).toEqual([]);
      daemon.signal();
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
    });

    it('a signal during the startup: the proxy never starts', async () => {
      const daemon = startDaemon({ file: WILD_CONFIG, signalAtOnce: 'SIGTERM' });
      expect(await daemon.exit).toBe(EXIT_CODES.ok);
      expect(daemon.h.network.udpSockets).toEqual([]);
      expect(readdirSync(daemon.resolverDir)).toEqual([]);
    });
  });
});

describe('createWildcardProxyControl (TASK-DELTA-28)', () => {
  const ID_W = '00000000-0000-4000-8000-000000000009';
  const ID_D = '00000000-0000-4000-8000-000000000008';
  const WILD = { id: ID_W, enabled: true, kind: 'domain', target: '*.corp.local', iface: 'ethernet', refreshSec: 600 } as const;
  const parse = (rules: readonly unknown[], enabled = true): Config => Config.parse({ version: 1, enabled, rules });
  const WITH = parse([WILD]);
  const WITHOUT = parse([CONFIG.rules[0]]);
  const CONTEXT = { roleDnsServers: { ethernet: ['10.20.0.53', '127.0.0.1'], wifi: ['192.168.1.1'] } };

  /** A proxy that only records: `start` binds unless `failBind`; its options are kept for the tests. */
  const setup = (initial: Config = WITH, extra: Partial<WildcardProxyDeps> = {}) => {
    let config = initial;
    const calls: string[] = [];
    const reconciles: number[] = [];
    let state: DnsProxyState = 'stopped';
    let failBind = false;
    let options: DnsProxyOptions | null = null;
    const setState = (next: DnsProxyState): void => {
      state = next;
      options?.onStatus?.({ state, address: '127.0.0.1', port: 954, lastError: next === 'unavailable' ? 'EADDRINUSE' : null, stats: { forwarded: 0, servfail: 0, refused: 0, dropped: 0, learnTimeouts: 0 } });
    };
    const proxy: DnsProxy = {
      start: () => {
        calls.push('start');
        setState('starting');
        setState(failBind ? 'unavailable' : 'running');
        return Promise.resolve();
      },
      stop: () => {
        calls.push('stop');
        setState('stopped');
        return Promise.resolve();
      },
      status: () => ({ state, address: '127.0.0.1', port: 954, lastError: state === 'unavailable' ? 'EADDRINUSE' : null, stats: { forwarded: 0, servfail: 0, refused: 0, dropped: 0, learnTimeouts: 0 } }),
    };
    const scheduler = createFakeScheduler(NOW);
    const control = createWildcardProxyControl({
      logger: createLogger({ sinks: [] }),
      getConfig: () => config,
      learn: () => Promise.resolve(null),
      systemServers: () => ['192.0.2.53', '::1', '198.51.100.53:5353'],
      requestReconcile: () => {
        reconciles.push(1);
      },
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      createProxy: (given) => {
        options = given;
        return proxy;
      },
      ...extra,
    });
    return {
      control,
      calls,
      reconciles,
      options: (): DnsProxyOptions => {
        if (options === null) throw new Error('no proxy');
        return options;
      },
      setConfig: (next: Config) => {
        config = next;
      },
      failBind: () => {
        failBind = true;
      },
      /** The proxy changes state on its own (a retried bind). */
      emit: setState,
    };
  };

  it('--once runs no proxy: a wildcard rule is `error` / `dns-proxy-unavailable`, gets no file, and no socket is opened', async () => {
    const h = harness({ version: 1, rules: [WILD] });
    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ruleError);
    const state = EngineState.parse(JSON.parse(h.out.join('')));
    expect(state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'dns-proxy-unavailable' });
    expect(readdirSync(h.deps.resolverDir ?? '')).toEqual([]);
    expect(h.network.udpSockets).toEqual([]);
    expect(h.network.tcpServers).toEqual([]);
  });

  it('decides when it is wanted: an enabled wildcard rule and routing on', () => {
    expect(wantsWildcardProxy(WITH)).toBe(true);
    expect(wantsWildcardProxy(WITHOUT)).toBe(false);
    expect(wantsWildcardProxy(parse([{ ...WILD, enabled: false }]))).toBe(false);
    expect(wantsWildcardProxy(parse([WILD], false))).toBe(false);
    expect(wantsWildcardProxy(parse([{ ...WILD, target: 'corp.local' }]))).toBe(false);
  });

  it('maps the proxy state onto the resolver files', () => {
    const base = { address: '127.0.0.1', port: 954, stats: { forwarded: 0, servfail: 0, refused: 0, dropped: 0, learnTimeouts: 0 } };
    expect(proxyFileStatus({ ...base, state: 'running', lastError: null })).toEqual({ state: 'ready' });
    expect(proxyFileStatus({ ...base, state: 'unavailable', lastError: 'EACCES' })).toEqual({ state: 'unavailable', detail: 'EACCES' });
    expect(proxyFileStatus({ ...base, state: 'starting', lastError: null })).toEqual({ state: 'starting' });
    expect(proxyFileStatus({ ...base, state: 'stopped', lastError: null })).toEqual({ state: 'starting' });
  });

  it('reads only IPv4 system resolvers on port 53', () => {
    expect(systemServerAddresses(['192.0.2.53', '192.0.2.54:53', '198.51.100.1:5353', '::1', '[::1]:53', 'x'])).toEqual(['192.0.2.53', '192.0.2.54']);
  });

  it('does not start before `arm` (the startup pass): the rules wait, nothing is bound', async () => {
    const t = setup();
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'starting' });
    expect(t.calls).toEqual([]);

    await t.control.arm();
    expect(t.calls).toEqual(['start']);
    // The pass that writes the files.
    expect(t.reconciles).toHaveLength(1);
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'ready' });
    expect(t.calls).toEqual(['start']);
  });

  it('`arm` without a wildcard rule starts nothing and asks for no pass', async () => {
    const t = setup(WITHOUT);
    await t.control.beforeSync(WITHOUT, CONTEXT);
    await t.control.arm();
    expect(t.calls).toEqual([]);
    expect(t.reconciles).toEqual([]);
  });

  it('a pass that brings the first wildcard starts it before the files, and asks for no extra pass', async () => {
    const t = setup(WITHOUT);
    await t.control.beforeSync(WITHOUT, CONTEXT);
    await t.control.arm();
    t.setConfig(WITH);
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'ready' });
    await t.control.afterSync(WITH);
    expect(t.calls).toEqual(['start']);
    expect(t.reconciles).toEqual([]);
  });

  it('a bind that fails is `unavailable` for the files; the proxy\'s own later success asks for a pass', async () => {
    const t = setup();
    t.failBind();
    await t.control.beforeSync(WITH, CONTEXT);
    await t.control.arm();
    expect(t.reconciles).toHaveLength(1);
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'unavailable', detail: 'EADDRINUSE' });

    t.emit('starting');
    expect(t.reconciles).toHaveLength(1);
    t.emit('running');
    expect(t.reconciles).toHaveLength(2);
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'ready' });
    // Losing it again is told too; the same state twice is not.
    t.emit('unavailable');
    t.emit('unavailable');
    expect(t.reconciles).toHaveLength(3);
  });

  it('stops after the files when the last wildcard goes, and not while the config still wants it', async () => {
    const t = setup();
    await t.control.beforeSync(WITH, CONTEXT);
    await t.control.arm();
    await t.control.afterSync(WITH);
    expect(t.calls).toEqual(['start']);
    t.setConfig(WITHOUT);
    await t.control.beforeSync(WITHOUT, CONTEXT);
    expect(t.calls).toEqual(['start']);
    await t.control.afterSync(WITHOUT);
    expect(t.calls).toEqual(['start', 'stop']);
    // Stopped by the control itself: no pass is asked for.
    expect(t.reconciles).toHaveLength(1);
  });

  it('`stop` (toggle off): a pass that started before with the old config does not start it again', async () => {
    const t = setup();
    await t.control.arm();
    t.setConfig(parse([WILD], false));
    await t.control.stop();
    // The snapshot of a pass still running still wants it; the config now does not.
    expect(await t.control.beforeSync(WITH, CONTEXT)).toEqual({ state: 'starting' });
    expect(t.calls).toEqual(['start', 'stop']);

    t.setConfig(WITH);
    await t.control.beforeSync(WITH, CONTEXT);
    expect(t.calls).toEqual(['start', 'stop', 'start']);
  });

  it('`close` stops it for good: no pass, `arm` or status change starts it or asks for a pass again', async () => {
    const t = setup();
    await t.control.arm();
    await t.control.close();
    expect(t.calls).toEqual(['start', 'stop']);
    const passes = t.reconciles.length;
    await t.control.beforeSync(WITH, CONTEXT);
    await t.control.arm();
    t.emit('unavailable');
    expect(t.calls).toEqual(['start', 'stop']);
    expect(t.reconciles).toHaveLength(passes);
  });

  it('answers names by the config now: learn for a wildcard name with the role\'s servers (loopback left out), passthrough for the base, REFUSED (null) outside', async () => {
    const t = setup(parse([WILD, { id: ID_D, kind: 'domain', target: 'corp.local', iface: 'wifi' }]));
    await t.control.beforeSync(WITH, CONTEXT);
    const { resolveRule } = t.options();
    expect(resolveRule('app.corp.local')).toEqual({ kind: 'learn', ruleId: ID_W, servers: ['10.20.0.53'] });
    expect(resolveRule('corp.local')).toEqual({ kind: 'passthrough', servers: ['192.0.2.53'] });
    expect(resolveRule('example.com')).toBeNull();
    t.setConfig(parse([WILD], false));
    expect(resolveRule('app.corp.local')).toBeNull();
    t.setConfig(WITHOUT);
    expect(resolveRule('app.corp.local')).toBeNull();
  });

  it('tells `diagnose` the servers of a wildcard rule, and nothing for other rules', async () => {
    const withDns = parse([{ ...WILD, dns: '10.30.0.53' }, CONFIG.rules[0]]);
    const t = setup(WITH);
    await t.control.beforeSync(WITH, CONTEXT);
    expect(t.control.peekWildcard(ID_W)).toEqual({ addresses: null, truncated: false, servers: ['10.20.0.53'], source: 'interface' });
    expect(t.control.peekWildcard(ID_A)).toBeNull();
    t.setConfig(withDns);
    expect(t.control.peekWildcard(ID_W)).toEqual({ addresses: null, truncated: false, servers: ['10.30.0.53'], source: 'rule' });
    expect(t.control.peekWildcard('00000000-0000-4000-8000-000000000077')).toBeNull();
  });

  it('a learn that arrives after its rule went, routing went off or the shutdown is ignored by the engine (QA advisory of DELTA-26)', async () => {
    const h = harness();
    const core = createCore(WITH, h.deps, createLogger({ sinks: [] }));
    const t = setup(WITH, { learn: (ruleId, addresses, ttl) => core.engine.learn(ruleId, addresses, ttl) });
    await core.engine.reconcile('startup');
    const { learn } = t.options();
    expect(await learn(ID_W, ['172.16.40.1'], 600)).toMatchObject({ outcome: 'applied', routed: 1 });

    core.engine.setConfig(WITHOUT);
    expect(await learn(ID_W, ['172.16.40.2'], 600)).toMatchObject({ outcome: 'ignored', reason: 'not-learning' });
    core.engine.setConfig(WITH);
    core.engine.setEnabled(false);
    expect(await learn(ID_W, ['172.16.40.3'], 600)).toMatchObject({ outcome: 'ignored', reason: 'not-learning' });
    core.engine.setEnabled(true);
    await core.engine.clear({ final: true });
    expect(await learn(ID_W, ['172.16.40.4'], 600)).toMatchObject({ outcome: 'ignored', reason: 'shut-down' });
    // None of those added a route.
    expect(h.routeArgv().filter((args) => args[1] === 'add' && String(args[3]).startsWith('172.16.40.'))).toEqual([['-n', 'add', '-host', '172.16.40.1', ETH_GW]]);
    core.dns.stop();
  });
});
