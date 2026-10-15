import { describe, expect, it } from 'vitest';

import {
  ALLOWED_BINARIES,
  assertAllowedBinary,
  assertSafeArgs,
  COMMAND_ENV,
  CommandRejectedError,
  createCommandRunner,
  createProcessSpawner,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isAllowedBinary,
  MAX_EXPECTED_EXIT_CODES,
  REDACTED_ARG,
  MAX_OUTPUT_BYTES,
  MAX_STREAM_LINE_LENGTH,
  MAX_TIMEOUT_MS,
  type AllowedBinary,
  type ChildProcessLike,
  type ProcessExit,
  type ProcessSpawnOptions,
  type SpawnFn,
  type ExecFileFailure,
  type ExecFileFn,
  type ExecFileSpawnOptions,
} from './exec';
import { createLogger, createMemorySink, type LogEntry } from './logger';
import { createFakeCommandRunner, fakeCommandResult } from './test-utils';

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecFileSpawnOptions;
}

interface Reply {
  readonly error?: ExecFileFailure;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Builds a runner around a fake execFile; no process is ever started. */
const setup = (reply: Reply | (() => never) = {}) => {
  const calls: ExecCall[] = [];
  const execFile: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (typeof reply === 'function') {
      reply();
    } else {
      callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '');
    }
  };
  const memory = createMemorySink();
  const logger = createLogger({
    sinks: [memory.sink],
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  // Each run reads the clock twice: 1000 at start, 1042.4 at the end.
  const ticks = [1000, 1042.4];
  let tick = 0;
  const now = (): number => ticks[tick++ % ticks.length] ?? 0;
  const runner = createCommandRunner({ logger, execFile, now });
  return { runner, calls, entries: memory.entries };
};

const only = (entries: readonly LogEntry[]): LogEntry => {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error('expected exactly one log entry');
  }
  return entry;
};

const EXPECTED_ALLOWLIST = [
  '/sbin/route',
  '/usr/sbin/networksetup',
  '/usr/sbin/ipconfig',
  '/usr/sbin/scutil',
  '/usr/sbin/netstat',
  '/usr/bin/dscacheutil',
  '/usr/bin/killall',
];

const REJECTED_BINARIES: readonly unknown[] = [
  'route',
  'sbin/route',
  './route',
  '../sbin/route',
  '/sbin/../sbin/route',
  '/sbin/./route',
  '//sbin/route',
  '/sbin/route/',
  '/sbin/route ',
  ' /sbin/route',
  '/sbin/route\n',
  '/sbin/route\0',
  '/SBIN/ROUTE',
  '/sbin/routed',
  '/sbin/rout',
  '/usr/sbin/route',
  '/usr/local/sbin/route',
  '/sbin/route -n get default',
  '/sbin/route;/bin/sh',
  '/sbin/ifconfig',
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/sudo',
  '/usr/bin/env',
  '/bin/launchctl',
  '',
  'toString',
  '__proto__',
  undefined,
  null,
  0,
  ['/sbin/route'],
  { toString: () => '/sbin/route' },
];

describe('allowlist', () => {
  it('contains exactly the seven permitted absolute paths', () => {
    expect(Object.values(ALLOWED_BINARIES).toSorted()).toEqual(EXPECTED_ALLOWLIST.toSorted());
  });

  it.each(EXPECTED_ALLOWLIST)('accepts %s', (bin) => {
    expect(isAllowedBinary(bin)).toBe(true);
    expect(() => {
      assertAllowedBinary(bin);
    }).not.toThrow();
  });

  it.each(REJECTED_BINARIES)('rejects %j', (bin) => {
    expect(isAllowedBinary(bin)).toBe(false);
    expect(() => {
      assertAllowedBinary(bin);
    }).toThrow(CommandRejectedError);
  });

  it.each(REJECTED_BINARIES)('run() rejects %j before starting any process', async (bin) => {
    const { runner, calls, entries } = setup();

    await expect(runner.run(bin as AllowedBinary, ['-n', 'get', 'default'])).rejects.toMatchObject({
      name: 'CommandRejectedError',
      reason: 'binary-not-allowed',
    });

    expect(calls).toHaveLength(0);
    const entry = only(entries);
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('command rejected');
    expect(entry.context).toMatchObject({ component: 'exec', reason: 'binary-not-allowed' });
    expect(entry.context).not.toHaveProperty('args');
  });

  it('makes an arbitrary string a type error at the call site', async () => {
    const { runner, calls } = setup();
    const name: string = ['/bin', 'sh'].join('/');

    // @ts-expect-error -- `string` is not assignable to `AllowedBinary`.
    await expect(runner.run(name, [])).rejects.toBeInstanceOf(CommandRejectedError);
    // @ts-expect-error -- a relative name is not an `AllowedBinary` either.
    await expect(runner.run('route', [])).rejects.toBeInstanceOf(CommandRejectedError);

    expect(calls).toHaveLength(0);
  });
});

describe('argument validation', () => {
  it('accepts strings verbatim, including shell metacharacters and empty strings', () => {
    expect(() => {
      assertSafeArgs(['-n', '', '$(reboot)', 'a b', '; rm -rf /', '`id`', '|', '>', "'", '"']);
    }).not.toThrow();
  });

  const BAD_ARGS: readonly (readonly [string, unknown])[] = [
    ['a number', ['-n', 1]],
    ['undefined', ['-n', undefined]],
    ['null', [null]],
    ['a nested array', [['-n']]],
    ['an object', [{ toString: () => '-n' }]],
    ['a sparse hole', [, '-n']], // eslint-disable-line no-sparse-arrays -- the hole is the case under test
    ['a NUL byte', ['10.0.0.1\0/8']],
    ['a lone NUL byte', ['\0']],
    ['a string instead of an array', '-n get default'],
    ['undefined instead of an array', undefined],
    ['an array-like object', { 0: '-n', length: 1 }],
  ];

  it.each(BAD_ARGS)('rejects %s', async (_label, args) => {
    expect(() => {
      assertSafeArgs(args);
    }).toThrow(CommandRejectedError);

    const { runner, calls, entries } = setup();
    await expect(runner.run('/sbin/route', args as readonly string[])).rejects.toMatchObject({
      reason: 'invalid-arguments',
    });
    expect(calls).toHaveLength(0);
    expect(only(entries).level).toBe('error');
  });

  it('passes arguments through unchanged as a separate argv array', async () => {
    const { runner, calls } = setup();
    const args = ['-n', 'add', '-net', '10.0.0.0/8', '192.0.2.1; echo $(id) && `reboot`', ''];

    const result = await runner.run('/sbin/route', args);

    expect(calls[0]?.file).toBe('/sbin/route');
    expect(calls[0]?.args).toEqual(args);
    expect(result.args).toEqual(args);
  });

  it('runs a snapshot of the arguments, not the caller-owned array', async () => {
    const { runner, calls } = setup();
    const args = ['-n', 'get', '10.0.0.1'];

    const pending = runner.run('/sbin/route', args);
    args[2] = 'default';
    const result = await pending;

    expect(calls[0]?.args).toEqual(['-n', 'get', '10.0.0.1']);
    expect(result.args).toEqual(['-n', 'get', '10.0.0.1']);
    expect(Object.isFrozen(result.args)).toBe(true);
  });
});

describe('process options', () => {
  it('never uses a shell and applies timeout, output limit, fixed env and cwd', async () => {
    const { runner, calls } = setup();

    await runner.run('/usr/sbin/netstat', ['-rn']);

    expect(calls[0]?.options).toEqual({
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      killSignal: 'SIGKILL',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      cwd: '/',
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
  });

  it('does not leak the helper environment into the child', async () => {
    const { runner, calls } = setup();
    process.env['ROUTESWITCH_TEST_MARKER'] = 'must-not-leak';
    try {
      await runner.run('/usr/sbin/scutil', ['--dns']);
    } finally {
      delete process.env['ROUTESWITCH_TEST_MARKER'];
    }

    expect(calls[0]?.options.env).toBe(COMMAND_ENV);
    expect(Object.keys(COMMAND_ENV).toSorted()).toEqual(['LANG', 'LC_ALL', 'PATH']);
    expect(Object.isFrozen(COMMAND_ENV)).toBe(true);
  });

  it('honours per-call limits', async () => {
    const { runner, calls } = setup();

    await runner.run('/usr/sbin/netstat', ['-rn'], { timeoutMs: 2500, maxOutputBytes: 4096 });

    expect(calls[0]?.options.timeout).toBe(2500);
    expect(calls[0]?.options.maxBuffer).toBe(4096);
  });

  it('accepts valid expectedExitCodes without changing how the process is started', async () => {
    const plain = setup();
    const withCodes = setup();

    await plain.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5']);
    await withCodes.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], {
      expectedExitCodes: Array.from({ length: MAX_EXPECTED_EXIT_CODES }, (_unused, index) => index + 1),
    });
    await withCodes.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: [] });
    await withCodes.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: [255] });

    expect(withCodes.calls).toHaveLength(3);
    for (const call of withCodes.calls) expect(call).toEqual(plain.calls[0]);
  });

  it.each([
    ['timeoutMs zero (would disable the timeout)', { timeoutMs: 0 }],
    ['negative timeoutMs', { timeoutMs: -1 }],
    ['fractional timeoutMs', { timeoutMs: 1.5 }],
    ['NaN timeoutMs', { timeoutMs: Number.NaN }],
    ['infinite timeoutMs', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['timeoutMs above the cap', { timeoutMs: MAX_TIMEOUT_MS + 1 }],
    ['maxOutputBytes zero', { maxOutputBytes: 0 }],
    ['maxOutputBytes above the cap', { maxOutputBytes: MAX_OUTPUT_BYTES + 1 }],
    ['expectedExitCodes that is not an array', { expectedExitCodes: 1 as unknown as number[] }],
    ['expectedExitCodes given as a string', { expectedExitCodes: '1' as unknown as number[] }],
    ['expectedExitCodes containing 0', { expectedExitCodes: [0] }],
    ['expectedExitCodes containing a negative code', { expectedExitCodes: [-1] }],
    ['expectedExitCodes containing a code above 255', { expectedExitCodes: [256] }],
    ['expectedExitCodes containing a fraction', { expectedExitCodes: [1.5] }],
    ['expectedExitCodes containing NaN', { expectedExitCodes: [Number.NaN] }],
    ['expectedExitCodes containing a numeric string', { expectedExitCodes: ['1'] as unknown as number[] }],
    ['expectedExitCodes with a hole', { expectedExitCodes: Object.assign(new Array<number>(2), { 0: 1 }) }],
    [
      'expectedExitCodes longer than the cap',
      { expectedExitCodes: Array.from({ length: MAX_EXPECTED_EXIT_CODES + 1 }, () => 1) },
    ],
    ['redactArgsFrom below 0', { redactArgsFrom: -1 }],
    ['redactArgsFrom past the arguments', { redactArgsFrom: 2 }],
    ['redactArgsFrom that is a fraction', { redactArgsFrom: 0.5 }],
    ['redactArgsFrom that is a string', { redactArgsFrom: '0' as unknown as number }],
  ])('rejects %s', async (_label, options) => {
    const { runner, calls, entries } = setup();

    await expect(runner.run('/usr/sbin/netstat', ['-rn'], options)).rejects.toMatchObject({
      reason: 'invalid-options',
    });
    expect(calls).toHaveLength(0);
    expect(only(entries).level).toBe('error');
  });
});

describe('results and logging', () => {
  it('returns stdout/stderr/exit code/duration and logs the invocation at info', async () => {
    const { runner, entries } = setup({ stdout: 'default via 192.0.2.1\n', stderr: '' });

    const result = await runner.run('/sbin/route', ['-n', 'get', 'default']);

    expect(result).toEqual({
      bin: '/sbin/route',
      args: ['-n', 'get', 'default'],
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: 'default via 192.0.2.1\n',
      stderr: '',
      durationMs: 42,
      failure: null,
      error: null,
    });
    expect(only(entries)).toEqual({
      level: 'info',
      at: '2026-01-02T03:04:05.000Z',
      msg: 'command finished',
      context: {
        component: 'exec',
        bin: '/sbin/route',
        args: ['-n', 'get', 'default'],
        exitCode: 0,
        durationMs: 42,
      },
    });
  });

  it('resolves (does not throw) on a non-zero exit and logs it at warn with stderr', async () => {
    const { runner, entries } = setup({
      error: { message: 'Command failed', code: 1, killed: false, signal: null },
      stdout: 'partial',
      stderr: 'route: writing to routing socket: File exists\n',
    });

    const result = await runner.run('/sbin/route', ['-n', 'add', '-net', '10.0.0.0/8', '192.0.2.1']);

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      signal: null,
      failure: 'nonzero-exit',
      error: null,
      stdout: 'partial',
      stderr: 'route: writing to routing socket: File exists\n',
      durationMs: 42,
    });
    const entry = only(entries);
    expect(entry.level).toBe('warn');
    expect(entry.context).toEqual({
      component: 'exec',
      bin: '/sbin/route',
      args: ['-n', 'add', '-net', '10.0.0.0/8', '192.0.2.1'],
      exitCode: 1,
      durationMs: 42,
      failure: 'nonzero-exit',
      signal: null,
      error: null,
      stderr: 'route: writing to routing socket: File exists\n',
    });
  });

  it('logs a non-zero exit listed in expectedExitCodes at debug, with the same result', async () => {
    const reply = {
      error: { message: 'Command failed', code: 1, killed: false, signal: null },
      stdout: '',
      stderr: '',
    };
    const plain = setup(reply);
    const expected = setup(reply);

    const baseline = await plain.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5']);
    const result = await expected.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], {
      expectedExitCodes: [1],
    });

    expect(result).toEqual(baseline);
    expect(result).toMatchObject({ ok: false, exitCode: 1, failure: 'nonzero-exit', error: null });
    expect(only(plain.entries).level).toBe('warn');
    const entry = only(expected.entries);
    expect(entry.level).toBe('debug');
    expect(entry.msg).toBe('command exited with an expected non-zero code');
    expect(entry.context).toEqual({ ...only(plain.entries).context });
    expect(entry.context).toMatchObject({
      component: 'exec',
      bin: '/usr/sbin/ipconfig',
      args: ['getifaddr', 'en5'],
      exitCode: 1,
      failure: 'nonzero-exit',
    });
  });

  it('still warns about a non-zero exit code that is not in expectedExitCodes', async () => {
    const { runner, entries } = setup({
      error: { message: 'Command failed', code: 2, killed: false, signal: null },
    });

    const result = await runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: [1, 3] });

    expect(result).toMatchObject({ ok: false, exitCode: 2, failure: 'nonzero-exit' });
    expect(only(entries).level).toBe('warn');
  });

  it('does not let expectedExitCodes change how success, timeouts or spawn failures are logged', async () => {
    const success = setup({ stdout: '192.0.2.10\n' });
    await success.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: [1] });
    expect(only(success.entries).level).toBe('info');

    const timeout = setup({ error: { message: 'Command failed', code: null, killed: true, signal: 'SIGKILL' } });
    const timedOut = await timeout.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], {
      expectedExitCodes: [1],
    });
    expect(timedOut.failure).toBe('timeout');
    expect(only(timeout.entries).level).toBe('error');

    const spawn = setup({ error: { message: 'spawn ENOENT', code: 'ENOENT' } });
    await spawn.runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: [1] });
    expect(only(spawn.entries).level).toBe('error');
  });

  it('uses a snapshot of expectedExitCodes, not the caller-owned array', async () => {
    const codes = [1];
    let finish: (() => void) | undefined;
    const memory = createMemorySink();
    const runner = createCommandRunner({
      logger: createLogger({ sinks: [memory.sink] }),
      execFile: (_file, _args, _options, callback) => {
        finish = () => {
          callback({ message: 'Command failed', code: 1, killed: false, signal: null }, '', '');
        };
      },
    });

    const pending = runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { expectedExitCodes: codes });
    codes.length = 0;
    finish?.();
    await pending;

    expect(only(memory.entries).level).toBe('debug');
  });

  it('reports a timeout as failure "timeout" and logs it at error', async () => {
    const { runner, entries } = setup({
      error: { message: 'Command failed', code: null, killed: true, signal: 'SIGKILL' },
    });

    const result = await runner.run('/usr/sbin/networksetup', ['-listallhardwareports'], {
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      signal: 'SIGKILL',
      failure: 'timeout',
      error: 'Timed out after 500 ms',
    });
    const entry = only(entries);
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('command failed');
    expect(entry.context).toMatchObject({ failure: 'timeout', exitCode: null, durationMs: 42 });
  });

  it('reports exceeding the output limit as "output-overflow"', async () => {
    const { runner, entries } = setup({
      error: {
        message: 'stdout maxBuffer length exceeded',
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
        signal: 'SIGKILL',
      },
      stdout: 'x'.repeat(16),
    });

    const result = await runner.run('/usr/sbin/netstat', ['-rn'], { maxOutputBytes: 16 });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      failure: 'output-overflow',
      error: 'Output exceeded 16 bytes',
    });
    expect(only(entries).level).toBe('error');
  });

  it('reports a spawn failure delivered through the callback as "spawn-error"', async () => {
    const { runner, entries } = setup({
      error: { message: 'spawn /usr/sbin/ipconfig ENOENT', code: 'ENOENT' },
    });

    const result = await runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en0']);

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      signal: null,
      failure: 'spawn-error',
      error: 'ENOENT: spawn /usr/sbin/ipconfig ENOENT',
      stdout: '',
      stderr: '',
    });
    expect(only(entries).level).toBe('error');
  });

  it('reports a synchronous throw from execFile as "spawn-error" instead of rejecting', async () => {
    const { runner, entries } = setup(() => {
      throw new Error('EMFILE: too many open files');
    });

    const result = await runner.run('/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', 'corp.local']);

    expect(result).toMatchObject({
      ok: false,
      failure: 'spawn-error',
      error: 'EMFILE: too many open files',
    });
    expect(only(entries).level).toBe('error');
  });

  it('reports termination by a foreign signal as "signal"', async () => {
    const { runner, entries } = setup({
      error: { message: 'Command failed', code: null, killed: false, signal: 'SIGTERM' },
    });

    const result = await runner.run('/usr/sbin/scutil', ['--nwi']);

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      signal: 'SIGTERM',
      failure: 'signal',
      error: 'Terminated by SIGTERM',
    });
    expect(only(entries).level).toBe('error');
  });

  it('truncates stderr in the log but not in the result, and never logs stdout', async () => {
    const stderr = 'e'.repeat(5000);
    const { runner, entries } = setup({
      error: { message: 'Command failed', code: 2 },
      stdout: 'STDOUT-CONTENT',
      stderr,
    });

    const result = await runner.run('/usr/sbin/netstat', ['-rn']);

    expect(result.stderr).toHaveLength(5000);
    const entry = only(entries);
    expect(String(entry.context?.['stderr'])).toHaveLength(1000);
    expect(JSON.stringify(entry)).not.toContain('STDOUT-CONTENT');
  });

  it('logs exactly one entry per invocation', async () => {
    const { runner, entries } = setup();

    await runner.run('/usr/sbin/netstat', ['-rn']);
    await runner.run('/usr/sbin/scutil', ['--dns']);
    await runner.run('/usr/sbin/ipconfig', ['getifaddr', 'en0']);

    expect(entries.map((entry) => entry.context?.['bin'])).toEqual([
      '/usr/sbin/netstat',
      '/usr/sbin/scutil',
      '/usr/sbin/ipconfig',
    ]);
  });
});

// The one test that goes through the real execFile. `ipconfig getiflist` only
// prints interface names: it reads state and changes nothing.
describe.skipIf(process.platform !== 'darwin')('real execFile (read-only command)', () => {
  it('runs an allowlisted binary without a shell and logs it', async () => {
    const memory = createMemorySink();
    const runner = createCommandRunner({ logger: createLogger({ sinks: [memory.sink] }) });

    const result = await runner.run('/usr/sbin/ipconfig', ['getiflist']);

    expect(result.failure).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe('string');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(only(memory.entries).context).toMatchObject({
      component: 'exec',
      bin: '/usr/sbin/ipconfig',
      args: ['getiflist'],
      exitCode: 0,
    });
  });

  it('kills a command that outlives its timeout (read-only `route -n monitor`)', async () => {
    const memory = createMemorySink();
    const runner = createCommandRunner({ logger: createLogger({ sinks: [memory.sink] }) });

    const result = await runner.run('/sbin/route', ['-n', 'monitor'], { timeoutMs: 200 });

    expect(result).toMatchObject({ ok: false, exitCode: null, signal: 'SIGKILL', failure: 'timeout' });
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
    expect(result.durationMs).toBeLessThan(5000);
    expect(only(memory.entries).level).toBe('error');
  });

  it('kills a command that exceeds the output limit (read-only `netstat -rn`)', async () => {
    const runner = createCommandRunner({ logger: createLogger() });

    const result = await runner.run('/usr/sbin/netstat', ['-rn'], { maxOutputBytes: 16 });

    expect(result).toMatchObject({ ok: false, exitCode: null, failure: 'output-overflow' });
  });

  it('treats a shell-looking argument as plain data', async () => {
    const runner = createCommandRunner({ logger: createLogger() });

    // With a shell this would print the interface list twice or run `id`;
    // as a single argv entry it is just an unknown ipconfig sub-command.
    const result = await runner.run('/usr/sbin/ipconfig', ['getiflist; /usr/bin/id']);

    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('uid=');
  });
});

describe('redacted arguments', () => {
  it('logs the command at info with the private arguments replaced, and the real ones at debug only', async () => {
    const { runner, calls, entries } = setup({ stdout: 'route to: 192.0.2.7\n' });
    const result = await runner.run('/sbin/route', ['-n', 'get', '-host', '192.0.2.7'], { redactArgsFrom: 3 });
    expect(calls[0]?.args).toEqual(['-n', 'get', '-host', '192.0.2.7']);
    expect(result.args).toEqual(['-n', 'get', '-host', '192.0.2.7']);
    const info = entries.filter((entry) => entry.level !== 'debug');
    expect(info).toMatchObject([{ level: 'info', msg: 'command finished', context: { args: ['-n', 'get', '-host', REDACTED_ARG] } }]);
    expect(JSON.stringify(info)).not.toContain('192.0.2.7');
    expect(entries.filter((entry) => entry.level === 'debug')).toMatchObject([
      { msg: 'command arguments', context: { args: ['-n', 'get', '-host', '192.0.2.7'], stdout: 'route to: 192.0.2.7\n' } },
    ]);
  });

  it('a failure is reported without the arguments, the output or a system message', async () => {
    const nonzero = setup({ error: { message: 'Command failed: 192.0.2.7', code: 2 }, stderr: 'route: 192.0.2.7: bad\n' });
    await nonzero.runner.run('/sbin/route', ['-n', 'get', '-host', '192.0.2.7'], { redactArgsFrom: 3 });
    const spawn = setup({ error: { message: 'spawn /sbin/route 192.0.2.7 ENOENT', code: 'ENOENT' } });
    await spawn.runner.run('/sbin/route', ['-n', 'get', '-host', '192.0.2.7'], { redactArgsFrom: 3 });
    for (const entries of [nonzero.entries, spawn.entries]) {
      const loud = entries.filter((entry) => entry.level !== 'debug');
      expect(loud).toHaveLength(1);
      expect(loud[0]?.context?.['args']).toEqual(['-n', 'get', '-host', REDACTED_ARG]);
      expect(JSON.stringify(loud)).not.toContain('192.0.2.7');
      expect(JSON.stringify(entries.filter((entry) => entry.level === 'debug'))).toContain('192.0.2.7');
    }
  });

  it('redacts nothing without the option', async () => {
    const { runner, entries } = setup();
    await runner.run('/sbin/route', ['-n', 'get', '-host', '192.0.2.7']);
    expect(only(entries)).toMatchObject({ level: 'info', context: { args: ['-n', 'get', '-host', '192.0.2.7'] } });
  });
});

describe('createFakeCommandRunner', () => {
  it('returns stubbed results and records calls', async () => {
    const fake = createFakeCommandRunner()
      .when('/usr/sbin/ipconfig', ['getifaddr', 'en0'], { stdout: '192.0.2.10\n' })
      .when('/usr/sbin/ipconfig', ['getifaddr', 'en5'], { exitCode: 1 });

    const up = await fake.run('/usr/sbin/ipconfig', ['getifaddr', 'en0'], { timeoutMs: 100 });
    const down = await fake.run('/usr/sbin/ipconfig', ['getifaddr', 'en5']);

    expect(up).toEqual(fakeCommandResult('/usr/sbin/ipconfig', ['getifaddr', 'en0'], { stdout: '192.0.2.10\n' }));
    expect(up.ok).toBe(true);
    expect(down).toMatchObject({ ok: false, exitCode: 1, failure: 'nonzero-exit' });
    expect(fake.calls).toEqual([
      { bin: '/usr/sbin/ipconfig', args: ['getifaddr', 'en0'], options: { timeoutMs: 100 } },
      { bin: '/usr/sbin/ipconfig', args: ['getifaddr', 'en5'], options: undefined },
    ]);
  });

  it('prefers the latest exact stub, then handlers newest-first', async () => {
    const fake = createFakeCommandRunner()
      .whenMatching(() => ({ stdout: 'fallback' }))
      .whenMatching((bin) => (bin === '/sbin/route' ? { stdout: 'route-handler' } : undefined))
      .when('/sbin/route', ['-n', 'get', 'default'], { stdout: 'old' })
      .when('/sbin/route', ['-n', 'get', 'default'], { stdout: 'new' });

    expect((await fake.run('/sbin/route', ['-n', 'get', 'default'])).stdout).toBe('new');
    expect((await fake.run('/sbin/route', ['-n', 'get', '10.0.0.1'])).stdout).toBe('route-handler');
    expect((await fake.run('/usr/sbin/netstat', ['-rn'])).stdout).toBe('fallback');
  });

  it('can simulate timeouts and spawn failures', async () => {
    const fake = createFakeCommandRunner()
      .when('/usr/sbin/netstat', ['-rn'], { failure: 'timeout', signal: 'SIGKILL', error: 'Timed out' })
      .when('/usr/sbin/scutil', ['--dns'], { failure: 'spawn-error', error: 'ENOENT' });

    expect(await fake.run('/usr/sbin/netstat', ['-rn'])).toMatchObject({
      ok: false,
      exitCode: null,
      signal: 'SIGKILL',
      failure: 'timeout',
    });
    expect(await fake.run('/usr/sbin/scutil', ['--dns'])).toMatchObject({
      ok: false,
      exitCode: null,
      failure: 'spawn-error',
      error: 'ENOENT',
    });
  });

  it('rejects unstubbed commands, disallowed binaries and bad arguments', async () => {
    const fake = createFakeCommandRunner();

    await expect(fake.run('/sbin/route', ['-n', 'get', 'default'])).rejects.toThrow(
      'No fake response for command: ["/sbin/route","-n","get","default"]',
    );
    await expect(fake.run('/bin/sh' as AllowedBinary, [])).rejects.toBeInstanceOf(CommandRejectedError);
    await expect(fake.run('/sbin/route', ['a\0b'])).rejects.toBeInstanceOf(CommandRejectedError);
    // Only the call that passed validation is recorded.
    expect(fake.calls).toHaveLength(1);
  });

  it('reset() forgets stubs and calls', async () => {
    const fake = createFakeCommandRunner().when('/usr/sbin/netstat', ['-rn'], {});
    await fake.run('/usr/sbin/netstat', ['-rn']);

    fake.reset();

    expect(fake.calls).toHaveLength(0);
    await expect(fake.run('/usr/sbin/netstat', ['-rn'])).rejects.toThrow('No fake response');
  });
});

// ---------------------------------------------------------------------------
// Long-running processes (TASK-112) — a fake `spawn`, no process is started
// ---------------------------------------------------------------------------

interface FakeChild extends ChildProcessLike {
  readonly kills: string[];
  out(chunk: string): void;
  err(chunk: string): void;
  exit(code: number | null, signal?: string | null): void;
  fail(error: Error): void;
  readonly encodings: string[];
}

const createFakeChild = (): FakeChild => {
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const add = (event: string, listener: (...args: never[]) => void): void => {
    (listeners[event] ??= []).push(listener);
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners[event] ?? []) (listener as (...values: unknown[]) => void)(...args);
  };
  const encodings: string[] = [];
  const stream = (name: string) => ({
    setEncoding: (encoding: 'utf8') => {
      encodings.push(`${name}:${encoding}`);
    },
    on: (_event: 'data', listener: (chunk: string) => void) => {
      add(`${name}:data`, listener);
    },
  });
  const kills: string[] = [];
  return {
    pid: 4242,
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    on: (event: string, listener: (...args: never[]) => void) => {
      add(event, listener);
    },
    kill: (signal) => {
      kills.push(signal);
      return true;
    },
    kills,
    encodings,
    out: (chunk) => {
      emit('stdout:data', chunk);
    },
    err: (chunk) => {
      emit('stderr:data', chunk);
    },
    exit: (code, signal = null) => {
      emit('exit', code, signal);
    },
    fail: (error) => {
      emit('error', error);
    },
  };
};

const spawnSetup = (makeChild: () => FakeChild = createFakeChild) => {
  const calls: { file: string; args: readonly string[]; options: ProcessSpawnOptions }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = makeChild();
    children.push(child);
    return child;
  };
  const memory = createMemorySink();
  const spawner = createProcessSpawner({ logger: createLogger({ sinks: [memory.sink] }), spawn });
  const lines: string[] = [];
  const exits: ProcessExit[] = [];
  const handlers = { onLine: (line: string) => void lines.push(line), onExit: (exit: ProcessExit) => void exits.push(exit) };
  return { spawner, calls, children, entries: memory.entries, lines, exits, handlers };
};

describe('createProcessSpawner', () => {
  it('starts the allowlisted binary without a shell, with the fixed environment and stdin closed', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    expect(h.calls).toEqual([
      {
        file: '/sbin/route',
        args: ['-n', 'monitor'],
        options: { env: COMMAND_ENV, cwd: '/', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      },
    ]);
    expect(h.children[0]?.encodings).toEqual(['stdout:utf8', 'stderr:utf8']);
    const started = h.entries.find((entry) => entry.msg === 'long-running command started');
    expect(started?.context).toMatchObject({ component: 'exec', bin: '/sbin/route', args: ['-n', 'monitor'], pid: 4242 });
  });

  it.each([
    ['route', ['-n', 'monitor']],
    ['/sbin/../sbin/route', ['-n', 'monitor']],
    ['/bin/sh', ['-c', 'route -n monitor']],
    ['/sbin/route', ['-n', 'mon\0itor']],
    ['/sbin/route', '-n monitor'],
  ])('refuses %s %j before anything is started', (bin, args) => {
    const h = spawnSetup();
    expect(() => h.spawner.spawn(bin as AllowedBinary, args as unknown as readonly string[], h.handlers)).toThrow(CommandRejectedError);
    expect(h.calls).toEqual([]);
    expect(h.exits).toEqual([]);
    expect(h.entries.find((entry) => entry.msg === 'command rejected')?.level).toBe('error');
  });

  it('hands over complete lines only, across chunk boundaries', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    const child = h.children[0];
    child?.out('RTM_IFI');
    child?.out('NFO: iface status change\nsecond line\r\nthi');
    expect(h.lines).toEqual(['RTM_IFINFO: iface status change', 'second line\r']);
    child?.out('rd\n\n');
    expect(h.lines).toEqual(['RTM_IFINFO: iface status change', 'second line\r', 'third', '']);
  });

  it('drops an over-long line up to its newline, once warned, and goes on with the next one', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    const child = h.children[0];
    child?.out('x'.repeat(MAX_STREAM_LINE_LENGTH));
    child?.out('y');
    child?.out('z'.repeat(100));
    child?.out('\nnext\n');
    child?.out(`${'w'.repeat(MAX_STREAM_LINE_LENGTH + 1)}\nafter\n`);
    expect(h.lines).toEqual(['next', 'after']);
    expect(h.entries.filter((entry) => entry.msg === 'over-long output line of a long-running command dropped')).toHaveLength(1);
    // A line of exactly the limit is kept.
    child?.out(`${'v'.repeat(MAX_STREAM_LINE_LENGTH)}\n`);
    expect(h.lines.at(-1)).toHaveLength(MAX_STREAM_LINE_LENGTH);
  });

  it('bounds the buffer of a stream without newlines: warns at once, delivers nothing, then the next whole line', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    const child = h.children[0];
    const warnings = (): number =>
      h.entries.filter((entry) => entry.msg === 'over-long output line of a long-running command dropped').length;
    child?.out('a'.repeat(MAX_STREAM_LINE_LENGTH));
    expect(warnings()).toBe(0);
    child?.out('b');
    // Over the limit and still no newline: warned right away.
    expect(warnings()).toBe(1);
    for (let index = 0; index < 50; index += 1) child?.out('c'.repeat(MAX_STREAM_LINE_LENGTH));
    expect(h.lines).toEqual([]);
    expect(warnings()).toBe(1);
    child?.out('tail of the long line\nRTM_IFINFO: iface status change\n');
    expect(h.lines).toEqual(['RTM_IFINFO: iface status change']);
  });

  it('logs a SIGTERM that could not be sent', () => {
    const h = spawnSetup(() => ({ ...createFakeChild(), kill: () => false }));
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers).stop();
    expect(h.entries.find((entry) => entry.msg === 'SIGTERM could not be sent to a long-running command')?.level).toBe('warn');
  });

  it('reports the exit once, with code, signal and the end of stderr, and logs it with the argv', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    const child = h.children[0];
    child?.err('route: socket: Operation not permitted\n');
    child?.fail(new Error('EPIPE'));
    child?.exit(1);
    child?.out('late line\n');
    expect(h.exits).toEqual([{ exitCode: null, signal: null, error: 'EPIPE', stopped: false }]);
    expect(h.lines).toEqual([]);
    const failed = h.entries.find((entry) => entry.msg === 'long-running command failed');
    expect(failed?.level).toBe('error');
    expect(failed?.context).toMatchObject({ bin: '/sbin/route', args: ['-n', 'monitor'], stderr: 'route: socket: Operation not permitted\n' });
  });

  it('logs an unexpected exit at warn', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    h.children[0]?.exit(null, 'SIGKILL');
    expect(h.exits).toEqual([{ exitCode: null, signal: 'SIGKILL', error: null, stopped: false }]);
    expect(h.entries.find((entry) => entry.msg === 'long-running command exited')?.level).toBe('warn');
  });

  it('stops with SIGTERM once and reports the exit as stopped', () => {
    const h = spawnSetup();
    const running = h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    running.stop();
    running.stop();
    expect(h.children[0]?.kills).toEqual(['SIGTERM']);
    h.children[0]?.exit(null, 'SIGTERM');
    expect(h.exits).toEqual([{ exitCode: null, signal: 'SIGTERM', error: null, stopped: true }]);
    expect(h.entries.find((entry) => entry.msg === 'long-running command stopped')?.level).toBe('info');
    running.stop();
    expect(h.children[0]?.kills).toEqual(['SIGTERM']);
  });

  it('reports a spawn that throws as an exit, synchronously, and stop() is then harmless', () => {
    const h = spawnSetup(() => {
      throw new Error('spawn EACCES');
    });
    const running = h.spawner.spawn('/sbin/route', ['-n', 'monitor'], h.handlers);
    expect(h.exits).toEqual([{ exitCode: null, signal: null, error: 'spawn EACCES', stopped: false }]);
    expect(() => {
      running.stop();
    }).not.toThrow();
  });

  it('isolates handler throws', () => {
    const h = spawnSetup();
    h.spawner.spawn('/sbin/route', ['-n', 'monitor'], {
      onLine: () => {
        throw new Error('bad line handler');
      },
      onExit: () => {
        throw new Error('bad exit handler');
      },
    });
    expect(() => {
      h.children[0]?.out('a\nb\n');
      h.children[0]?.exit(0);
    }).not.toThrow();
    expect(h.entries.filter((entry) => entry.msg === 'line handler of a long-running command threw')).toHaveLength(2);
    expect(h.entries.filter((entry) => entry.msg === 'exit handler of a long-running command threw')).toHaveLength(1);
  });
});
