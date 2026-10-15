import {
  assertAllowedBinary,
  assertSafeArgs,
  type AllowedBinary,
  type CommandFailure,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
} from './exec';

/**
 * Test doubles for code that runs system commands. Nothing here starts a
 * process. Kept free of test-framework imports so it type-checks with the
 * rest of the package.
 */

/** What a faked command returns; unspecified fields describe a clean exit 0. */
export interface FakeCommandResponse {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly signal?: string | null;
  readonly failure?: CommandFailure | null;
  readonly error?: string | null;
  readonly durationMs?: number;
}

export interface RecordedCommand {
  readonly bin: AllowedBinary;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

/** Decides the response for a call; return `undefined` to fall through to the next stub. */
export type FakeCommandHandler = (
  bin: AllowedBinary,
  args: readonly string[],
) => FakeCommandResponse | undefined;

export interface FakeCommandRunner extends CommandRunner {
  /** Every call that passed validation, in order. */
  readonly calls: readonly RecordedCommand[];
  /** Stubs an exact `bin` + `args` match. Later stubs for the same call win. */
  when(bin: AllowedBinary, args: readonly string[], response: FakeCommandResponse): this;
  /** Stubs by function; consulted after exact stubs, most recently added first. */
  whenMatching(handler: FakeCommandHandler): this;
  reset(): void;
}

/** Builds a full `CommandResult` from a partial response, deriving `failure` and `ok`. */
export const fakeCommandResult = (
  bin: AllowedBinary,
  args: readonly string[],
  response: FakeCommandResponse = {},
): CommandResult => {
  const exitCode = response.exitCode === undefined ? 0 : response.exitCode;
  const failure =
    response.failure === undefined ? (exitCode === 0 ? null : 'nonzero-exit') : response.failure;
  return {
    bin,
    args,
    ok: failure === null,
    exitCode: failure === null || failure === 'nonzero-exit' ? exitCode : null,
    signal: response.signal ?? null,
    stdout: response.stdout ?? '',
    stderr: response.stderr ?? '',
    durationMs: response.durationMs ?? 0,
    failure,
    error: response.error ?? null,
  };
};

const sameArgs = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A `CommandRunner` that returns canned results. It applies the same binary
 * allowlist and argument checks as the real runner, and rejects any call that
 * no stub covers, so a test cannot pass by accident on an unexpected command.
 */
export const createFakeCommandRunner = (): FakeCommandRunner => {
  const calls: RecordedCommand[] = [];
  const exact: { bin: AllowedBinary; args: readonly string[]; response: FakeCommandResponse }[] =
    [];
  const handlers: FakeCommandHandler[] = [];

  const respond = (bin: AllowedBinary, args: readonly string[]): FakeCommandResponse => {
    const stub = exact.findLast((entry) => entry.bin === bin && sameArgs(entry.args, args));
    if (stub !== undefined) {
      return stub.response;
    }
    for (const handler of handlers.toReversed()) {
      const response = handler(bin, args);
      if (response !== undefined) {
        return response;
      }
    }
    throw new Error(`No fake response for command: ${JSON.stringify([bin, ...args])}`);
  };

  const runner: FakeCommandRunner = {
    calls,
    run: (bin, args, options) => {
      try {
        assertAllowedBinary(bin);
        assertSafeArgs(args);
        const argv = [...args];
        calls.push({ bin, args: argv, options });
        return Promise.resolve(fakeCommandResult(bin, argv, respond(bin, argv)));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    when: (bin, args, response) => {
      exact.push({ bin, args: [...args], response });
      return runner;
    },
    whenMatching: (handler) => {
      handlers.push(handler);
      return runner;
    },
    reset: () => {
      calls.length = 0;
      exact.length = 0;
      handlers.length = 0;
    },
  };
  return runner;
};
