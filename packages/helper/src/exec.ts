import { execFile } from 'node:child_process';

import type { Logger } from './logger';

/**
 * The only binaries the helper may start, by absolute path. Every system
 * command in the helper goes through this list; adding an entry widens what a
 * root process can run and needs the same scrutiny as a protocol change.
 */
export const ALLOWED_BINARIES = {
  route: '/sbin/route',
  networksetup: '/usr/sbin/networksetup',
  ipconfig: '/usr/sbin/ipconfig',
  scutil: '/usr/sbin/scutil',
  netstat: '/usr/sbin/netstat',
  dscacheutil: '/usr/bin/dscacheutil',
  killall: '/usr/bin/killall',
} as const;

export type AllowedBinary = (typeof ALLOWED_BINARIES)[keyof typeof ALLOWED_BINARIES];

const ALLOWED_BINARY_SET: ReadonlySet<string> = new Set(Object.values(ALLOWED_BINARIES));

/**
 * Environment given to every child process. The helper's own environment is
 * never passed through: a root daemon should not hand whatever launchd (or a
 * developer shell) put there to the tools it runs. `LANG`/`LC_ALL` pin the
 * output language so parsers see the same text on every machine.
 */
export const COMMAND_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
  LC_ALL: 'C',
});

/** Working directory for every child process. */
export const COMMAND_CWD = '/';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Upper bound on the length of `RunOptions.expectedExitCodes`. */
export const MAX_EXPECTED_EXIT_CODES = 16;
const MAX_EXIT_CODE = 255;

const STDERR_LOG_LIMIT = 1000;

export type CommandRejectionReason =
  'binary-not-allowed' | 'invalid-arguments' | 'invalid-options';

/**
 * Thrown (as a promise rejection from `run`) when a call is refused before
 * any process is started. It signals a bug in the calling code, never a
 * runtime condition of the system, so it is not folded into `CommandResult`.
 */
export class CommandRejectedError extends Error {
  readonly reason: CommandRejectionReason;

  constructor(reason: CommandRejectionReason, message: string) {
    super(message);
    this.name = 'CommandRejectedError';
    this.reason = reason;
  }
}

/** True only for an exact, byte-for-byte match with an allowlisted absolute path. */
export const isAllowedBinary = (value: unknown): value is AllowedBinary =>
  typeof value === 'string' && ALLOWED_BINARY_SET.has(value);

/**
 * Rejects anything that is not an allowlisted absolute path. The comparison is
 * exact on purpose: the value is never normalised, resolved or looked up in
 * PATH, so `route`, `/sbin/../sbin/route` and `/sbin/route ` are all refused.
 * Reusable by code that starts a long-running child with `spawn`.
 */
export function assertAllowedBinary(value: unknown): asserts value is AllowedBinary {
  if (!isAllowedBinary(value)) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : `a ${typeof value}`;
    throw new CommandRejectedError(
      'binary-not-allowed',
      `Binary is not on the allowlist: ${shown}`,
    );
  }
}

/**
 * Rejects an argv that is not an array of strings, or that contains a NUL
 * byte. Arguments are passed to the child verbatim and never interpreted by a
 * shell, so nothing is escaped or rewritten here; what an argument means is
 * for the caller to validate.
 */
export function assertSafeArgs(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new CommandRejectedError('invalid-arguments', 'Arguments must be an array of strings');
  }
  // Indexed loop so that holes in a sparse array are visited as well.
  for (let index = 0; index < value.length; index += 1) {
    const arg: unknown = value[index];
    if (typeof arg !== 'string') {
      throw new CommandRejectedError(
        'invalid-arguments',
        `Argument ${String(index)} is not a string`,
      );
    }
    if (arg.includes('\0')) {
      throw new CommandRejectedError(
        'invalid-arguments',
        `Argument ${String(index)} contains a NUL byte`,
      );
    }
  }
}

/**
 * Why a started (or attempted) command did not succeed:
 * - `nonzero-exit` — the process ran and exited with a non-zero code;
 * - `timeout` — it was killed with SIGKILL after `timeoutMs`;
 * - `output-overflow` — it was killed after writing more than `maxOutputBytes`;
 * - `signal` — it was terminated by a signal the wrapper did not send;
 * - `spawn-error` — it could not be started (missing binary, permissions, ...).
 */
export type CommandFailure =
  'nonzero-exit' | 'timeout' | 'output-overflow' | 'signal' | 'spawn-error';

export interface CommandResult {
  readonly bin: AllowedBinary;
  readonly args: readonly string[];
  /** True only when the process exited with code 0. */
  readonly ok: boolean;
  /** Exit code, or `null` when the process did not exit on its own. */
  readonly exitCode: number | null;
  /** Signal that ended the process, if any. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Wall-clock duration in whole milliseconds. */
  readonly durationMs: number;
  /** `null` when `ok` is true. */
  readonly failure: CommandFailure | null;
  /** Description of the failure for anything other than a plain non-zero exit. */
  readonly error: string | null;
}

export interface RunOptions {
  /** Kill the process after this many milliseconds. Default 10 s, at most 60 s. */
  readonly timeoutMs?: number;
  /** Kill the process when stdout or stderr exceeds this size. Default 1 MiB, at most 8 MiB. */
  readonly maxOutputBytes?: number;
  /**
   * Non-zero exit codes that are an ordinary answer for this command (e.g.
   * `ipconfig getifaddr` exits 1 on an interface without an address). The
   * result is the same as for any other non-zero exit — `ok: false`,
   * `failure: 'nonzero-exit'` — only the log entry is written at `debug`
   * instead of `warn`. Integers 1..255, at most `MAX_EXPECTED_EXIT_CODES`.
   */
  readonly expectedExitCodes?: readonly number[];
}

/**
 * The single choke point for system commands. Later helper modules depend on
 * this interface, never on Node's process-spawning module, so tests can swap in a fake.
 *
 * `run` resolves with a `CommandResult` for everything that happens to a
 * command once it is allowed to start — including non-zero exits, timeouts and
 * spawn failures. It rejects with `CommandRejectedError` only when the call
 * itself is refused (binary not allowlisted, bad arguments, bad options).
 */
export interface CommandRunner {
  run(bin: AllowedBinary, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

/** Error shape passed to an `execFile` callback. */
export interface ExecFileFailure {
  readonly message: string;
  readonly code?: string | number | null | undefined;
  readonly killed?: boolean | undefined;
  readonly signal?: string | null | undefined;
}

export interface ExecFileSpawnOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: 'SIGKILL';
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly encoding: 'utf8';
  readonly shell: false;
  readonly windowsHide: true;
}

/** The slice of `execFile` the runner uses; injectable so tests start no process. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileSpawnOptions,
  callback: (error: ExecFileFailure | null, stdout: string, stderr: string) => void,
) => void;

const nodeExecFile: ExecFileFn = (file, args, options, callback) => {
  const child = execFile(file, [...args], { ...options, env: { ...options.env } }, callback);
  // No command the helper runs reads stdin; closing it keeps a tool that
  // unexpectedly does from waiting until the timeout.
  child.stdin?.end();
};

export interface CommandRunnerDeps {
  readonly logger: Logger;
  /** Defaults to Node's own `execFile`. */
  readonly execFile?: ExecFileFn;
  /** Millisecond clock for durations; defaults to the monotonic `performance.now`. */
  readonly now?: () => number;
}

interface Limits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** A private copy: the caller's array is not consulted after validation. */
  readonly expectedExitCodes: readonly number[];
}

const resolveLimit = (name: string, value: number | undefined, fallback: number, max: number) => {
  if (value === undefined) {
    return fallback;
  }
  // `0` would mean "no limit" to execFile, so it is refused like any other
  // value outside 1..max.
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new CommandRejectedError(
      'invalid-options',
      `${name} must be an integer between 1 and ${String(max)}`,
    );
  }
  return value;
};

const resolveExpectedExitCodes = (value: unknown): readonly number[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_EXPECTED_EXIT_CODES) {
    throw new CommandRejectedError(
      'invalid-options',
      `expectedExitCodes must be an array of at most ${String(MAX_EXPECTED_EXIT_CODES)} exit codes`,
    );
  }
  const codes: number[] = [];
  // Indexed loop so that holes in a sparse array are visited as well.
  for (let index = 0; index < value.length; index += 1) {
    const code: unknown = value[index];
    // `0` is success and can never be an "expected failure".
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 1 || code > MAX_EXIT_CODE) {
      throw new CommandRejectedError(
        'invalid-options',
        `expectedExitCodes must contain only integers between 1 and ${String(MAX_EXIT_CODE)}`,
      );
    }
    codes.push(code);
  }
  return codes;
};

const resolveLimits = (options: RunOptions): Limits => ({
  timeoutMs: resolveLimit('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  maxOutputBytes: resolveLimit(
    'maxOutputBytes',
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES,
  ),
  expectedExitCodes: resolveExpectedExitCodes(options.expectedExitCodes),
});

type Outcome = Pick<CommandResult, 'exitCode' | 'signal' | 'failure' | 'error'>;

const classify = (error: ExecFileFailure | null, limits: Limits): Outcome => {
  if (error === null) {
    return { exitCode: 0, signal: null, failure: null, error: null };
  }
  const signal = typeof error.signal === 'string' ? error.signal : null;
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return {
      exitCode: null,
      signal,
      failure: 'output-overflow',
      error: `Output exceeded ${String(limits.maxOutputBytes)} bytes`,
    };
  }
  // execFile sets `killed` only when it terminated the child itself; with the
  // output limit handled above, that leaves the timeout.
  if (error.killed === true) {
    return {
      exitCode: null,
      signal,
      failure: 'timeout',
      error: `Timed out after ${String(limits.timeoutMs)} ms`,
    };
  }
  if (typeof error.code === 'number') {
    return { exitCode: error.code, signal, failure: 'nonzero-exit', error: null };
  }
  if (signal !== null) {
    return { exitCode: null, signal, failure: 'signal', error: `Terminated by ${signal}` };
  }
  const code = typeof error.code === 'string' ? `${error.code}: ` : '';
  return { exitCode: null, signal: null, failure: 'spawn-error', error: `${code}${error.message}` };
};

const describeThrown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds the real runner. Every call is logged once, when it settles, with
 * `component: 'exec'`, the binary, the arguments, the exit code and the
 * duration: `info` for exit 0, `warn` for a non-zero exit (`debug` when the
 * caller listed the code in `expectedExitCodes`, e.g. "no address on this
 * interface"), `error` for a timeout, output overflow, signal, spawn failure
 * or a refused call.
 */
export const createCommandRunner = (deps: CommandRunnerDeps): CommandRunner => {
  const logger = deps.logger.child({ component: 'exec' });
  const execFileImpl = deps.execFile ?? nodeExecFile;
  const now = deps.now ?? (() => performance.now());

  const validate = (
    bin: unknown,
    args: unknown,
    options: RunOptions,
  ): { argv: readonly string[]; limits: Limits } => {
    try {
      assertAllowedBinary(bin);
      // Snapshot first, validate the snapshot: what was checked is exactly
      // what runs and what the result and the log report, even if the caller
      // mutates its array afterwards.
      const argv: unknown = Array.isArray(args) ? Object.freeze([...(args as unknown[])]) : args;
      assertSafeArgs(argv);
      return { argv, limits: resolveLimits(options) };
    } catch (error) {
      // Logged without echoing the argv: a refused call may carry values that
      // were never validated.
      logger.error('command rejected', {
        bin: typeof bin === 'string' ? bin : typeof bin,
        reason: error instanceof CommandRejectedError ? error.reason : 'unknown',
        error: describeThrown(error),
      });
      throw error;
    }
  };

  const start = (
    bin: AllowedBinary,
    args: readonly string[],
    limits: Limits,
  ): Promise<{ outcome: Outcome; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const spawnOptions: ExecFileSpawnOptions = {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        killSignal: 'SIGKILL',
        env: COMMAND_ENV,
        cwd: COMMAND_CWD,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      };
      try {
        execFileImpl(bin, args, spawnOptions, (error, stdout, stderr) => {
          resolve({ outcome: classify(error, limits), stdout, stderr });
        });
      } catch (error) {
        // execFile reports most spawn problems through the callback but can
        // also throw synchronously; both end up as the same `spawn-error`
        // result, which is logged below with the rest of the invocation.
        resolve({
          outcome: {
            exitCode: null,
            signal: null,
            failure: 'spawn-error',
            error: describeThrown(error),
          },
          stdout: '',
          stderr: '',
        });
      }
    });

  const logResult = (result: CommandResult, expectedExitCodes: readonly number[]): void => {
    const context = {
      bin: result.bin,
      args: result.args,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
    if (result.failure === null) {
      logger.info('command finished', context);
      return;
    }
    const details = {
      ...context,
      failure: result.failure,
      signal: result.signal,
      error: result.error,
      stderr: result.stderr.slice(0, STDERR_LOG_LIMIT),
    };
    if (result.failure !== 'nonzero-exit') {
      logger.error('command failed', details);
    } else if (result.exitCode !== null && expectedExitCodes.includes(result.exitCode)) {
      logger.debug('command exited with an expected non-zero code', details);
    } else {
      logger.warn('command exited with a non-zero code', details);
    }
  };

  return {
    run: async (bin, args, options = {}) => {
      const { argv, limits } = validate(bin, args, options);
      const startedAt = now();
      const { outcome, stdout, stderr } = await start(bin, argv, limits);
      const result: CommandResult = {
        bin,
        args: argv,
        ok: outcome.failure === null,
        ...outcome,
        stdout,
        stderr,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      };
      logResult(result, limits.expectedExitCodes);
      return result;
    },
  };
};
