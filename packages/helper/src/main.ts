import { PATHS, type Config, type EngineState } from '@routeswitch/shared';

import { emptyConfig, loadConfig, type ConfigFileReader } from './config-store';
import {
  createDomainResolver,
  realClearTimer,
  realSetTimer,
  type ClearTimer,
  type DnsResolverFactory,
  type DomainResolverService,
  type SetTimer,
} from './dns';
import { DEGRADED_ACCEPT_AFTER, createEngine, type AppliedRoute, type ClearResult, type Engine } from './engine';
import { createCommandRunner, createProcessSpawner, type CommandRunner, type ProcessSpawner } from './exec';
import { createJsonLinesSink, createLogger, type LineWritable, type Logger } from './logger';
import { createNetworkMonitor, type NetworkMonitor } from './monitor';
import { createNetInfo, type NetInfo } from './netinfo';
import { createResolverFiles, type ResolverFiles, type ResolverFs } from './resolver';
import { createRouteOperations } from './route';
import { createStateStore, type StateFs, type StateStore } from './state-store';

/**
 * Entry point of the helper.
 *
 * `--once`: load the config, run a single reconcile and print the resulting
 * `EngineState` as JSON on stdout. It does not read or write `state.json`.
 *
 * Without `--once`, the daemon (the socket server arrives with TASK-114):
 * 1. clean up what a previous run left behind: the routes of `state.json`
 *    (restored into the engine, then removed through `routeDelete`, which
 *    deletes only routes that are still ours) and every managed resolver file;
 * 2. reconcile (`startup`), start the network monitor;
 * 3. on SIGTERM or SIGINT: stop the DNS module, then the monitor, then
 *    `cleanupAll` (every applied route and resolver file), and exit.
 * Every change of the applied routes is written to `state.json`, so a crash
 * at any point is cleaned up by step 1 of the next start.
 *
 * The log goes to stderr as JSON lines in both modes, so stdout carries
 * nothing but the state.
 *
 * Domain rules in `--once` mode: the first pass only starts their DNS lookups
 * (a pass never waits for DNS), so when it leaves a rule `resolving` the run
 * waits for the lookups, at most `ONE_SHOT_DNS_WAIT_MS`, and reconciles once
 * more. A config without an enabled domain rule never gets there: no lookup,
 * no timer, no second pass.
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
  /** Nothing failed, but a domain rule was still being resolved when the one-shot wait ended; its routes are missing. */
  resolvePending: 6,
  /** `run` itself failed, which is a bug. */
  internal: 70,
} as const;

/**
 * Seconds launchd waits after SIGTERM before it sends SIGKILL (`ExitTimeOut`
 * of the LaunchDaemon plist, written by the install script). Enough for the
 * cleanup of a large config (≈ 16 500 routes, 8 deletes at a time); what is
 * left when it runs out stays in `state.json` and is removed at the next start.
 */
export const SHUTDOWN_EXIT_TIMEOUT_SEC = 60;
/** Delay before the engine's own retry of an untrusted interface detection, per attempt. */
export const DETECTION_RETRY_DELAY_MS = 2000;

/**
 * How long a one-shot run waits for the DNS lookups of its domain rules
 * before the follow-up pass. Three times the limit of a single lookup: enough
 * for every lookup of a config with up to 12 domains on one DNS server to
 * answer or time out (four run at a time against one set of servers).
 */
export const ONE_SHOT_DNS_WAIT_MS = 15_000;

export const USAGE = `Usage: com.routeswitch.helper [--once] [--config <path>]

  (no --once)       run as the daemon: clean up leftovers, apply, follow network changes, clean up on SIGTERM
  --once            apply the config once, print the resulting state as JSON, exit
  --config <path>   config file (default: ${PATHS.config})
  --help            show this text
  --version         print the helper version

Exit codes: 0 applied; 1 a rule is in error; 2 usage; 3 config could not be loaded; 4 mode not implemented;
            5 interfaces could not be detected reliably, nothing was added; 6 a domain is still being resolved.
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
  /** Builds the resolver of one DNS lookup; defaults to a new `dns.promises.Resolver`. */
  readonly createDnsResolver?: DnsResolverFactory | undefined;
  /** Timers of the DNS lookups and of the one-shot wait; default to the real ones. */
  readonly setTimer?: SetTimer | undefined;
  readonly clearTimer?: ClearTimer | undefined;
  /** The resolvers of the process, which a domain rule never routes; defaults to `dns.getServers()`. */
  readonly systemDnsServers?: (() => readonly string[]) | undefined;
  /** Directory of the scoped-DNS files; defaults to `PATHS.resolverDir`. Tests pass a temporary one. */
  readonly resolverDir?: string | undefined;
  /** File system of the scoped-DNS files; defaults to the real one. */
  readonly resolverFs?: ResolverFs | undefined;
  /** Daemon: `state.json`; defaults to `PATHS.state`. Tests pass a file in a temporary directory. */
  readonly statePath?: string | undefined;
  readonly stateFs?: StateFs | undefined;
  /** Daemon: starts `route -n monitor`; tests pass a fake that starts nothing. */
  readonly createSpawner?: ((logger: Logger) => ProcessSpawner) | undefined;
  /** Daemon: resolves with the name of the first SIGTERM / SIGINT; defaults to the process's signals. */
  readonly waitForSignal?: (() => Promise<string>) | undefined;
  /** Daemon: wall clock and monotonic clock of the monitor, in milliseconds. */
  readonly wallNow?: (() => number) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
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

  // No `requestReconcile`: a one-shot run decides itself when the follow-up pass happens.
  const core = createCore(loaded.config, deps, root);
  try {
    return await reconcileOnce(core, deps, root);
  } finally {
    core.dns.stop();
  }
};

/** The engine and the DNS resolver, wired to each other. */
export interface HelperCore {
  readonly engine: Engine;
  readonly dns: DomainResolverService;
  /** The scoped-DNS files; synced by the engine on every pass, removed by `cleanupAll`. */
  readonly resolverFiles: ResolverFiles;
  /** The very instance the engine detects with: the monitor invalidates this one. */
  readonly netinfo: NetInfo;
  readonly runner: CommandRunner;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
}

/** What only the daemon wires into the core. */
export interface CoreHooks {
  readonly onApplied?: ((routes: readonly AppliedRoute[]) => void | Promise<void>) | undefined;
  readonly scheduleRetry?: Parameters<typeof createEngine>[0]['scheduleRetry'];
}

/**
 * Builds the engine with everything it needs. The resolver is told about the
 * initial config here and about every later change by the engine itself
 * (`onConfigChanged`), so no caller has to keep the two in step. Starts
 * nothing: no command, no lookup and no timer until the first reconcile.
 */

export const createCore = (
  config: Config,
  deps: RunDeps,
  root: Logger,
  requestReconcile?: (reason: 'dns-refresh') => unknown,
  hooks: CoreHooks = {},
): HelperCore => {
  const setTimer = deps.setTimer ?? realSetTimer;
  const clearTimer = deps.clearTimer ?? realClearTimer;
  const dns = createDomainResolver({
    logger: root,
    now: deps.now,
    createResolver: deps.createDnsResolver,
    setTimer,
    clearTimer,
    systemServers: deps.systemDnsServers,
    requestReconcile,
  });
  dns.syncConfig(config);
  const runner = deps.createRunner(root);
  const resolverFiles = createResolverFiles({
    dir: deps.resolverDir ?? PATHS.resolverDir,
    runner,
    logger: root,
    fs: deps.resolverFs,
  });
  const netinfo = createNetInfo({ runner, logger: root });
  const engine = createEngine({
    netinfo,
    routes: createRouteOperations({ runner, logger: root }),
    logger: root,
    helperVersion: HELPER_VERSION,
    initialConfig: config,
    now: deps.now,
    resolveDomain: dns.resolveDomain,
    onConfigChanged: dns.syncConfig,
    syncResolvers: (current) => resolverFiles.sync(current),
    onApplied: hooks.onApplied,
    scheduleRetry: hooks.scheduleRetry,
  });
  return { engine, dns, resolverFiles, netinfo, runner, setTimer, clearTimer };
};

const isResolving = (state: EngineState): boolean =>
  state.rules.some((rule) => rule.status === 'pending' && rule.reasonCode === 'resolving');

/** Resolves with whether every lookup finished within `ONE_SHOT_DNS_WAIT_MS`. */
const waitForLookups = ({ dns, setTimer, clearTimer }: HelperCore): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const deadline = setTimer(() => {
      resolve(false);
    }, ONE_SHOT_DNS_WAIT_MS);
    void dns.whenIdle().then(() => {
      clearTimer(deadline);
      resolve(true);
    });
  });

const reconcileOnce = async (core: HelperCore, deps: RunDeps, root: Logger): Promise<number> => {
  const logger = root.child({ component: 'main' });
  const { engine } = core;

  // There is no daemon loop to retry later, so an untrusted interface
  // detection is retried right here, but only as long as the engine still
  // holds everything back. A one-shot process has no earlier, trusted
  // detection to check the connected-subnet guard against, so it never goes
  // on to the pass that would accept a degraded detection and add routes.
  let outcome = await engine.reconcile('startup');
  for (let attempt = 1; outcome.retryRequested && attempt < DEGRADED_ACCEPT_AFTER - 1; attempt += 1) {
    outcome = await engine.reconcile('startup');
  }

  let failedCommands = outcome.summary.failed;
  if (!outcome.retryRequested && isResolving(outcome.state)) {
    const finished = await waitForLookups(core);
    if (!finished) {
      logger.warn('DNS lookups are still running; reconciling with what has been resolved so far', {
        waitedMs: ONE_SHOT_DNS_WAIT_MS,
        ...core.dns.stats(),
      });
    }
    outcome = await engine.reconcile('dns-refresh');
    failedCommands += outcome.summary.failed;
  }

  deps.stdout.write(`${JSON.stringify(outcome.state, null, 2)}\n`);

  if (outcome.retryRequested) {
    logger.error('interfaces could not be detected reliably; no route was added', { attempts: DEGRADED_ACCEPT_AFTER - 1 });
    return EXIT_CODES.detectionUnreliable;
  }

  const failedRules = outcome.state.rules.filter((rule) => rule.status === 'error').length;
  if (failedRules > 0 || failedCommands > 0) {
    logger.error('one-shot run finished with errors', { failedRules, failedCommands });
    return EXIT_CODES.ruleError;
  }
  if (isResolving(outcome.state)) {
    logger.error('one-shot run finished while a domain was still being resolved; its routes were not added');
    return EXIT_CODES.resolvePending;
  }
  return EXIT_CODES.ok;
};

// ---------------------------------------------------------------------------
// Daemon: state, cleanup, shutdown
// ---------------------------------------------------------------------------

export interface CleanupResult extends ClearResult {
  /** Managed resolver files removed. */
  readonly resolverFilesRemoved: number;
  /** Managed resolver files that could not be removed (logged by the resolver module). */
  readonly resolverFilesFailed: number;
  /** Whether `state.json` now holds what is still applied. */
  readonly stateSaved: boolean;
}

/**
 * The one way to take everything down: every applied route (through
 * `routeDelete`, no interface detection), every managed resolver file, then
 * `state.json` rewritten with whatever could not be removed. Used for the
 * global toggle off and uninstall (TASK-114/115), at shutdown (`final`) and
 * for the leftovers at start. Never rejects.
 */
export const cleanupAll = async (
  core: Pick<HelperCore, 'engine' | 'resolverFiles'>,
  store: StateStore,
  logger: Logger,
  options: { readonly final?: boolean } = {},
): Promise<CleanupResult> => {
  const routes = await core.engine.clear({ final: options.final === true });
  const files = await core.resolverFiles.removeAll();
  const stateSaved = await store.save(core.engine.getApplied());
  const result: CleanupResult = {
    ...routes,
    resolverFilesRemoved: files.changed,
    resolverFilesFailed: files.issues.size,
    stateSaved,
  };
  logger
    .child({ component: 'main' })
    .log(routes.failed > 0 || !stateSaved ? 'warn' : 'info', 'cleanup finished', { ...result, final: options.final === true });
  return result;
};

/** Start of the daemon: what `state.json` lists is restored into the engine and removed, with every managed resolver file. */
export const recoverFromState = async (
  core: Pick<HelperCore, 'engine' | 'resolverFiles'>,
  store: StateStore,
  logger: Logger,
): Promise<CleanupResult> => {
  const loaded = await store.load();
  const restored = core.engine.restoreApplied(loaded.routes);
  logger.child({ component: 'main' }).info('cleaning up what the previous run left behind', {
    source: loaded.source,
    ...restored,
  });
  return cleanupAll(core, store, logger);
};

const defaultWaitForSignal = (): Promise<string> =>
  new Promise<string>((resolve) => {
    const signals = ['SIGTERM', 'SIGINT'] as const;
    const handlers = signals.map((signal) => {
      const handler = (): void => {
        for (const [index, name] of signals.entries()) process.off(name, handlers[index] ?? handler);
        resolve(signal);
      };
      return handler;
    });
    // `once` per signal and both removed on the first: a second signal gets Node's default (exit at once).
    for (const [index, signal] of signals.entries()) {
      const handler = handlers[index];
      if (handler !== undefined) process.once(signal, handler);
    }
  });

const runDaemon = async (configPath: string, deps: RunDeps): Promise<number> => {
  // Listening before anything else: a SIGTERM during the startup still gets the cleanup.
  const signalled = (deps.waitForSignal ?? defaultWaitForSignal)();
  const root = createLogger({
    sinks: [createJsonLinesSink(deps.stderr)],
    minLevel: 'info',
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const logger = root.child({ component: 'main' });
  if (deps.euid !== undefined && deps.euid() !== 0) {
    logger.warn('not running as root; route commands will be refused by the system');
  }

  const loaded = await loadConfig(configPath, deps.readConfig);
  if (!loaded.ok) {
    logger.error('config could not be loaded; cleaning up leftovers and exiting', {
      config: configPath,
      code: loaded.code,
      error: loaded.message,
    });
  } else {
    logger.info('config loaded', { config: configPath, source: loaded.source, rules: loaded.config.rules.length, enabled: loaded.config.enabled });
  }
  const config = loaded.ok ? loaded.config : { ...emptyConfig(), enabled: false };

  const store = createStateStore({ logger: root, path: deps.statePath, fs: deps.stateFs });
  const retryTimers = new Set<unknown>();
  // An object, not a `let`: `shutdown` sets it while the startup and the retry hook still run.
  const life = { stopping: false };
  let core: HelperCore | null = null;
  core = createCore(
    config,
    deps,
    root,
    (reason) => core?.engine.reconcile(reason),
    {
      onApplied: async (routes) => {
        await store.save(routes);
      },
      scheduleRetry: ({ reason, attempt }) => {
        // A pass still running during the shutdown may ask for a retry: no timer may outlive the exit.
        if (life.stopping) return;
        const timer = (deps.setTimer ?? realSetTimer)(() => {
          retryTimers.delete(timer);
          void core?.engine.reconcile(reason);
        }, DETECTION_RETRY_DELAY_MS * attempt);
        retryTimers.add(timer);
      },
    },
  );
  const helper = core;
  const clearTimer = deps.clearTimer ?? realClearTimer;

  let monitor: NetworkMonitor | null = null;
  // Whatever comes first: the startup finishing, or a signal during it.
  const startup = (async (): Promise<'started'> => {
    await recoverFromState(helper, store, root);
    if (loaded.ok && !life.stopping) await helper.engine.reconcile('startup');
    return 'started';
  })();

  const shutdown = async (signal: string): Promise<number> => {
    life.stopping = true;
    logger.info('shutting down', { signal });
    // A signal during the startup: let it finish its cleanup first (it adds nothing once `stopping` is set).
    await startup;
    // DNS first (no lookup asks for a pass any more), then the monitor, then the timers of the retries.
    helper.dns.stop();
    monitor?.stop();
    for (const timer of retryTimers) clearTimer(timer);
    retryTimers.clear();
    const result = await cleanupAll(helper, store, root, { final: true });
    // Again: a pass the cleanup waited for may have asked for a retry before `stopping` was seen everywhere.
    for (const timer of retryTimers) clearTimer(timer);
    retryTimers.clear();
    return result.failed > 0 || result.resolverFilesFailed > 0 ? EXIT_CODES.ruleError : EXIT_CODES.ok;
  };

  const first = await Promise.race([startup, signalled]);
  if (first !== 'started') return shutdown(first);
  if (!loaded.ok) {
    helper.dns.stop();
    return EXIT_CODES.configError;
  }

  monitor = createNetworkMonitor({
    engine: helper.engine,
    netinfo: helper.netinfo,
    dns: helper.dns,
    runner: helper.runner,
    spawner: (deps.createSpawner ?? ((spawnLogger) => createProcessSpawner({ logger: spawnLogger })))(root),
    logger: root,
    setTimer: helper.setTimer,
    clearTimer: helper.clearTimer,
    now: deps.wallNow,
    monotonicNow: deps.monotonicNow,
  });
  monitor.start();
  logger.info('daemon running', { pid: process.pid });
  return shutdown(await signalled);
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
        return args.once ? await runOnce(args.configPath, deps) : await runDaemon(args.configPath, deps);
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
