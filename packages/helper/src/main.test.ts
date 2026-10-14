import { readFileSync } from 'node:fs';

import { Config, EngineState, PATHS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import type { ConfigFileRead, ConfigFileReader } from './config-store';
import { LOOKUP_TIMEOUT_MS } from './dns';
import { createFakeDns, createFakeScheduler, dnsError, flush, type FakeDns, type FakeScheduler } from './dns-test-utils';
import { createLogger } from './logger';
import { EXIT_CODES, HELPER_VERSION, ONE_SHOT_DNS_WAIT_MS, USAGE, createCore, parseArgs, run, type RunDeps } from './main';
import { createFakeCommandRunner, type FakeCommandResponse, type FakeCommandRunner } from './test-utils';

const ROUTE = '/sbin/route';
const NETWORKSETUP = '/usr/sbin/networksetup';
const IPCONFIG = '/usr/sbin/ipconfig';
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

/** A machine with Ethernet (en5) and Wi-Fi (en0) both connected; every `route` call succeeds. */
const machine = (): FakeCommandRunner => {
  const runner = createFakeCommandRunner();
  runner.whenMatching((bin, args) => {
    if (bin === ROUTE) return {};
    if (bin === NETWORKSETUP) return { stdout: PORTS };
    if (bin === '/usr/sbin/netstat') return { stdout: 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n' };
    if (bin !== IPCONFIG) return undefined;
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
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      ...extra,
    },
    runner,
    dns,
    scheduler,
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

  it('says that the daemon mode does not exist yet when --once is missing', async () => {
    const h = harness();

    expect(await run([], h.deps)).toBe(EXIT_CODES.notImplemented);
    expect(await run(['--config', '/tmp/rules.json'], h.deps)).toBe(EXIT_CODES.notImplemented);

    expect(h.err.join('')).toContain('Daemon mode is not implemented yet');
    expect(h.err.join('')).toContain('TASK-114');
    expect(h.out).toEqual([]);
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
  for (let round = 0; round < 2000 && !ready(); round += 1) await flush(5);
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

  const DNS_OPTION = 'domain_name_server';
  const dnsArgv = (h: Harness): (readonly string[])[] =>
    h.runner.calls.filter((call) => call.bin === IPCONFIG && call.args[2] === DNS_OPTION).map((call) => call.args);

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
    h.runner.when(IPCONFIG, ['getoption', 'en5', DNS_OPTION], { stdout: '10.20.4.53\n' });
    h.runner.when(IPCONFIG, ['getoption', 'en0', DNS_OPTION], { stdout: '192.168.1.1\n' });
    h.dns.auto = () => ['10.20.4.53', '198.51.100.20'];

    const code = await run(['--once'], h.deps);

    expect(dnsArgv(h).map((args) => args[1]).sort()).toEqual(['en0', 'en5']);
    expect(h.dns.lookups.map((lookup) => lookup.servers)).toEqual([['198.51.100.53']]);
    // The real route wrapper on the fake runner: no argv carries the address of a DNS server.
    expect(h.routeArgv()).toEqual([['-n', 'add', '-host', '198.51.100.20', '192.168.1.1']]);
    expect(JSON.stringify(h.routeArgv())).not.toMatch(/10\.20\.4\.53|198\.51\.100\.53/);
    expect(code).toBe(EXIT_CODES.ruleError);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({
      reasonCode: 'forbidden-destination',
      reason: '1 resolved address of corp.local must never be routed (dns-server: 1)',
      appliedDestinations: ['198.51.100.20'],
    });
  });

  it('does not hold explicit rules back when the DNS server of an interface cannot be looked up', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.when(IPCONFIG, ['getoption', 'en5', DNS_OPTION], { failure: 'timeout' });
    h.runner.when(IPCONFIG, ['getoption', 'en0', DNS_OPTION], { stdout: '192.168.1.1\n' });
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

  it('asks the DNS server of the interface the rule is bound to, with one more command per connected role', async () => {
    const h = harness(DOMAIN_CONFIG);
    h.runner.when(IPCONFIG, ['getoption', 'en5', DNS_OPTION], { stdout: '10.20.0.10\n' });
    h.runner.when(IPCONFIG, ['getoption', 'en0', DNS_OPTION], { stdout: '192.168.1.1\n' });
    // The answer names the Wi-Fi resolver as well: it is not routed through Ethernet.
    h.dns.auto = () => ['198.51.100.20', '192.168.1.1'];

    const code = await run(['--once'], h.deps);

    expect(h.dns.lookups.map((lookup) => [lookup.hostname, lookup.servers])).toEqual([['corp.local', ['10.20.0.10']]]);
    // Two passes, one cached detection: each role asked once.
    expect(dnsArgv(h).map((args) => args[1]).sort()).toEqual(['en0', 'en5']);
    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    expect(code).toBe(EXIT_CODES.ruleError);
    const state = EngineState.parse(JSON.parse(h.out[0] ?? ''));
    expect(state.rules[0]).toMatchObject({ status: 'error', reasonCode: 'forbidden-destination', appliedDestinations: ['198.51.100.20'] });
    // Which server was asked is in the log.
    expect(h.logs().find((entry) => entry['msg'] === 'domain resolved')).toMatchObject({
      component: 'dns',
      domain: 'corp.local',
      servers: ['10.20.0.10'],
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

    expect(await run(['--once'], h.deps)).toBe(EXIT_CODES.ruleError);

    expect(h.routeArgv()).toEqual([
      ['-n', 'add', '-host', '203.0.113.7', '192.168.1.1'],
      ['-n', 'add', '-host', '198.51.100.20', ETH_GW],
    ]);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules[0]).toMatchObject({
      reasonCode: 'forbidden-destination',
      reason: '1 resolved address of corp.local must never be routed (dns-server: 1)',
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
    h.runner.when(IPCONFIG, ['getoption', 'en5', DNS_OPTION], { stdout: '10.20.0.10\n' });

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
    expect(outcome.state.rules.map((rule) => rule.reasonCode)).toEqual(['interface-down', 'forbidden-destination']);
  });
});
