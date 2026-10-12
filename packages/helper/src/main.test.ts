import { readFileSync } from 'node:fs';

import { EngineState, PATHS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import type { ConfigFileRead, ConfigFileReader } from './config-store';
import { EXIT_CODES, HELPER_VERSION, USAGE, parseArgs, run, type RunDeps } from './main';
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
  readonly out: string[];
  readonly err: string[];
  readonly configPaths: string[];
  readonly routeArgv: () => (readonly string[])[];
  readonly logs: () => Record<string, unknown>[];
}

/** `file` is either what the reader returns or a value to serve as the JSON content of the file. */
const harness = (file: unknown = CONFIG, extra: Partial<RunDeps> = {}): Harness => {
  const runner = machine();
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
      ...extra,
    },
    runner,
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

    const code = await run(['--once'], h.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.routeArgv()).toEqual([]);
    expect(EngineState.parse(JSON.parse(h.out[0] ?? '')).rules.map((rule) => rule.reasonCode)).toEqual(['resolving', 'rule-disabled']);
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
