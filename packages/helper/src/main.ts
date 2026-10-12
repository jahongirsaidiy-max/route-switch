import { PATHS } from '@routeswitch/shared';

import { loadConfig, type ConfigFileReader } from './config-store';
import { DEGRADED_ACCEPT_AFTER, createEngine } from './engine';
import { createCommandRunner, type CommandRunner } from './exec';
import { createJsonLinesSink, createLogger, type LineWritable, type Logger } from './logger';
import { createNetInfo } from './netinfo';
import { createRouteOperations } from './route';

/**
 * Entry point of the helper.
 *
 * For now it has one mode, `--once`: load the config, run a single reconcile
 * and print the resulting `EngineState` as JSON on stdout. The daemon mode
 * (socket server, monitor, cleanup on SIGTERM) does not exist yet; starting
 * without `--once` says so and exits with a non-zero code.
 *
 * In `--once` mode the log goes to stderr as JSON lines, so stdout carries
 * nothing but the state. The log file at `PATHS.log` belongs to the daemon
 * mode.
 */

/** Version of the helper, reported in `EngineState.helperVersion`. Kept equal to `package.json` by a test. */
export const HELPER_VERSION = '0.0.0';

export const EXIT_CODES = {
  ok: 0,
  /** The reconcile ran, but a rule is in `error` or a route command failed. */
  ruleError: 1,
  usage: 2,
  /** The config could not be loaded; no route was touched. */
  configError: 3,
  notImplemented: 4,
  /** The interfaces could not be detected reliably; nothing was added. */
  detectionUnreliable: 5,
  /** `run` itself failed, which is a bug. */
  internal: 70,
} as const;

export const USAGE = `Usage: com.routeswitch.helper --once [--config <path>]

  --once            apply the config once, print the resulting state as JSON, exit
  --config <path>   config file (default: ${PATHS.config})
  --help            show this text
  --version         print the helper version

Exit codes: 0 applied; 1 a rule is in error; 2 usage; 3 config could not be loaded; 4 mode not implemented;
            5 interfaces could not be detected reliably, nothing was added.
`;

export interface RunDeps {
  readonly stdout: LineWritable;
  readonly stderr: LineWritable;
  /** Builds the runner for system commands; tests pass a fake that starts nothing. */
  readonly createRunner: (logger: Logger) => CommandRunner;
  /** Reads the config file; defaults to the real file system. */
  readonly readConfig?: ConfigFileReader | undefined;
  readonly now?: (() => Date) | undefined;
  /** Effective user id, for the "not root" warning; `null` when unknown. */
  readonly euid?: (() => number | null) | undefined;
}

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly once: boolean; readonly configPath: string }
  | { readonly kind: 'usage-error'; readonly message: string };

const usageError = (message: string): ParsedArgs => ({ kind: 'usage-error', message });

/** The whole command line: `--once`, `--config <path>`, `--help`, `--version`. Anything else is refused. */
export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let once = false;
  let help = false;
  let version = false;
  let configPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') {
      once = true;
    } else if (arg === '--help') {
      help = true;
    } else if (arg === '--version') {
      version = true;
    } else if (arg === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return usageError('--config needs a path');
      if (configPath !== null) return usageError('--config was given more than once');
      configPath = value;
      index += 1;
    } else {
      // The argument itself is not echoed: it is arbitrary text.
      return usageError(`Unknown argument at position ${String(index + 1)}`);
    }
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  return { kind: 'run', once, configPath: configPath ?? PATHS.config };
};

const runOnce = async (configPath: string, deps: RunDeps): Promise<number> => {
  const root = createLogger({
    sinks: [createJsonLinesSink(deps.stderr)],
    minLevel: 'info',
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const logger = root.child({ component: 'main' });

  const loaded = await loadConfig(configPath, deps.readConfig);
  if (!loaded.ok) {
    logger.error('config could not be loaded; no route was touched', {
      config: configPath,
      code: loaded.code,
      error: loaded.message,
    });
    return EXIT_CODES.configError;
  }
  logger.info('config loaded', {
    config: configPath,
    source: loaded.source,
    rules: loaded.config.rules.length,
    enabled: loaded.config.enabled,
  });
  if (deps.euid !== undefined && deps.euid() !== 0) {
    logger.warn('not running as root; route commands will be refused by the system');
  }

  const runner = deps.createRunner(root);
  const engine = createEngine({
    netinfo: createNetInfo({ runner, logger: root }),
    routes: createRouteOperations({ runner, logger: root }),
    logger: root,
    helperVersion: HELPER_VERSION,
    initialConfig: loaded.config,
    now: deps.now,
  });

  // There is no daemon loop to retry later, so an untrusted interface
  // detection is retried right here, but only as long as the engine still
  // holds everything back. A one-shot process has no earlier, trusted
  // detection to check the connected-subnet guard against, so it never goes
  // on to the pass that would accept a degraded detection and add routes.
  let outcome = await engine.reconcile('startup');
  for (let attempt = 1; outcome.retryRequested && attempt < DEGRADED_ACCEPT_AFTER - 1; attempt += 1) {
    outcome = await engine.reconcile('startup');
  }

  deps.stdout.write(`${JSON.stringify(outcome.state, null, 2)}\n`);

  if (outcome.retryRequested) {
    logger.error('interfaces could not be detected reliably; no route was added', { attempts: DEGRADED_ACCEPT_AFTER - 1 });
    return EXIT_CODES.detectionUnreliable;
  }

  const failedRules = outcome.state.rules.filter((rule) => rule.status === 'error').length;
  if (failedRules > 0 || outcome.summary.failed > 0) {
    logger.error('one-shot run finished with errors', { failedRules, failedCommands: outcome.summary.failed });
    return EXIT_CODES.ruleError;
  }
  return EXIT_CODES.ok;
};

/** Runs the helper for one command line and returns the process exit code. Never rejects. */
export const run = async (argv: readonly string[], deps: RunDeps): Promise<number> => {
  try {
    const args = parseArgs(argv);
    switch (args.kind) {
      case 'help':
        deps.stdout.write(USAGE);
        return EXIT_CODES.ok;
      case 'version':
        deps.stdout.write(`${HELPER_VERSION}\n`);
        return EXIT_CODES.ok;
      case 'usage-error':
        deps.stderr.write(`${args.message}\n\n${USAGE}`);
        return EXIT_CODES.usage;
      case 'run':
        if (!args.once) {
          deps.stderr.write(
            'Daemon mode is not implemented yet (it arrives with the socket server, TASK-114). Run with --once.\n',
          );
          return EXIT_CODES.notImplemented;
        }
        return await runOnce(args.configPath, deps);
    }
  } catch (error) {
    deps.stderr.write(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.internal;
  }
};

/** The dependencies of a real process. */
export const realDeps = (): RunDeps => ({
  stdout: process.stdout,
  stderr: process.stderr,
  createRunner: (logger) => createCommandRunner({ logger }),
  euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : null),
});

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), realDeps());
}
