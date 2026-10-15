import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';

import {
  DNS_PROXY,
  LIMITS,
  RESOLVER_MARKER,
  isWildcardDomain,
  normalizeDomain,
  normalizeHostAddress,
  normalizeIpv4,
  wildcardBase,
  type Config,
} from '@routeswitch/shared';

import { ALLOWED_BINARIES, type CommandRunner } from './exec';
import type { Logger } from './logger';

/**
 * Scoped DNS: one `/etc/resolver/<domain>` file per enabled domain rule that
 * names its own server (`rule.dns`), so that the whole system — not only the
 * helper's own lookups — asks that server for the domain and its subdomains.
 *
 *     nameserver 10.20.0.10
 *     # managed-by: routeswitch
 *
 * A wildcard rule `*.B` (ADR-002) gets `/etc/resolver/B`, which sends B and
 * every name under it to the helper's loopback DNS proxy:
 *
 *     nameserver 127.0.0.1
 *     port 954
 *     # managed-by: routeswitch
 *
 * only while the proxy listens (`WildcardProxyStatus` `ready`). Otherwise no
 * such file is written — and one left from before is removed like any stale
 * file — so the names keep resolving through the normal DNS; the rule is
 * `pending` (the proxy is starting) or `error` (it cannot listen), with
 * `dns-proxy-unavailable`.
 *
 * One file name, several rules (`B` for an exact rule `B` with `dns` and for
 * `*.B`): the first rule in config order decides who answers for B — its
 * `dns` server, or for a wildcard without `dns` the system resolvers, through
 * the proxy. A later rule that agrees (the same server) shares the file; when
 * any of them is a wildcard the file is the proxy's, which forwards B itself
 * to that same server (`routeQuery` passthrough). A later rule that disagrees
 * is `error` / `resolver-conflict`. An exact rule without `dns` needs no file
 * and so never conflicts.
 *
 * Ownership is the marker line, nothing else. A file without it belongs to
 * the user or to another tool: it is never read beyond the check, never
 * changed and never removed, and the rule that would need it is `error` /
 * `resolver-conflict`. Only what this module can identify as its own is ever
 * created, rewritten or deleted:
 * - names are domains that pass `normalizeDomain` again here (no `/`, no
 *   `..`, no empty name), whatever the config schema already checked;
 * - nothing is followed: files are opened with `O_NOFOLLOW`, a symlink or
 *   anything that is not a regular file counts as foreign, and the directory
 *   itself must be a real directory;
 * - a file is written to a temporary name in the same directory and renamed
 *   over the target, so a reader never sees half a file.
 *
 * After a pass that created, changed or removed a file, the system's DNS
 * cache is flushed (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`),
 * once; a pass that changed nothing runs no command.
 *
 * Error model: `sync` never rejects. A file that cannot be written makes its
 * rule `error` / `resolver-failed`; a stale file that cannot be removed is
 * logged and tried again on the next pass.
 */

/** A file of ours is two or three short lines; anything larger is not ours. */
export const MAX_RESOLVER_FILE_BYTES = 4096;
/** Directory entries looked at per pass; the rest wait for a later pass (nothing of the user's is touched either way). */
export const MAX_RESOLVER_DIR_ENTRIES = 4 * LIMITS.maxRules;
const TEMP_PREFIX = '.routeswitch-';
const TEMP_SUFFIX = '.tmp';
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const FLUSH_TIMEOUT_MS = 5_000;

/** Why a domain rule's resolver file is not in place. */
export interface ResolverIssue {
  readonly reasonCode: 'resolver-conflict' | 'resolver-failed' | 'dns-proxy-unavailable';
  readonly reason: string;
  /** The rule waits rather than fails (the DNS proxy is still starting): its status is `pending`, not `error`. */
  readonly pending?: boolean | undefined;
}

/**
 * Whether the DNS proxy (ADR-002) can take the names of wildcard rules now:
 * - `ready`       — it listens; their files are written;
 * - `starting`    — it has not been started yet, or is binding; no file, the rules wait;
 * - `unavailable` — it cannot listen (`detail`: the error code of the bind, e.g.
 *                   `EADDRINUSE`); no file, the rules are `error`. It is retried.
 * - `absent`      — this process runs no proxy (the one-shot run, `--uninstall`);
 *                   no file, the rules are `error`.
 */
export type WildcardProxyStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'starting' }
  | { readonly state: 'unavailable'; readonly detail: string | null }
  | { readonly state: 'absent' };

/** What a `sync` without a proxy status assumes: this process runs no proxy. */
export const NO_WILDCARD_PROXY: WildcardProxyStatus = Object.freeze({ state: 'absent' });

export interface ResolverSyncResult {
  /** Rule id -> the problem with its file; rules without an entry are fine (or need no file). */
  readonly issues: ReadonlyMap<string, ResolverIssue>;
  /** Files created, rewritten or removed in this pass. */
  readonly changed: number;
  /**
   * Stale files of ours that may still be there: a removal that failed, or a directory that could
   * not be checked or listed. Fail closed: `removeAll` has no rule to hang an issue on, so this is
   * how the uninstall knows that a managed file may be left (TASK-115).
   */
  readonly notRemoved: number;
}

/** The part of `node:fs/promises` this module uses; tests point it at a temporary directory. */
export interface ResolverFs {
  readonly open: typeof nodeFs.open;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly lstat: typeof nodeFs.lstat;
  readonly rename: typeof nodeFs.rename;
  readonly unlink: typeof nodeFs.unlink;
  readonly mkdir: (path: string, options: { readonly mode: number }) => Promise<unknown>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
}

const realFs: ResolverFs = {
  open: nodeFs.open,
  readdir: (path) => nodeFs.readdir(path),
  lstat: nodeFs.lstat,
  rename: nodeFs.rename,
  unlink: nodeFs.unlink,
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
};

export interface ResolverFilesDeps {
  /** `PATHS.resolverDir` in the daemon; a temporary directory in tests. Must be absolute. */
  readonly dir: string;
  readonly runner: CommandRunner;
  readonly logger: Logger;
  readonly fs?: ResolverFs | undefined;
}

export interface ResolverFiles {
  /**
   * Brings the managed files in line with the config. Never rejects. `proxy`
   * decides about the files of wildcard rules; without it there is no proxy.
   */
  sync(config: Pick<Config, 'enabled' | 'rules'>, proxy?: WildcardProxyStatus): Promise<ResolverSyncResult>;
  /** Removes every managed file (global toggle off, shutdown, uninstall). Never rejects. */
  removeAll(): Promise<ResolverSyncResult>;
}

/** The exact content of a managed file. */
export const resolverFileContent = (server: string): string => `nameserver ${server}\n${RESOLVER_MARKER}\n`;

/** The `port` line of a file that points at the DNS proxy. */
const PROXY_PORT_LINE = `port ${String(DNS_PROXY.port)}\n`;

/** The exact content of the managed file of a wildcard rule's base: the loopback DNS proxy. */
export const proxyResolverFileContent = (): string => `nameserver ${DNS_PROXY.address}\n${PROXY_PORT_LINE}${RESOLVER_MARKER}\n`;

/** True when the text carries the marker as a line of its own. */
export const hasResolverMarker = (text: string): boolean =>
  text.split('\n').some((line) => line.trim() === RESOLVER_MARKER);

const NAMESERVER_PREFIX = 'nameserver ';
const MAX_IPV4_TEXT = 15;

/**
 * True when `text` is what a write of ours can leave behind in a temporary
 * file when it was cut short (a crash or power loss after the file was
 * created): empty, or a prefix of `nameserver <IPv4>\n# managed-by: routeswitch\n`
 * or of the proxy's `nameserver 127.0.0.1\nport 954\n# managed-by: routeswitch\n`.
 * Only used for the temporary names; a target file is ours by its marker alone.
 */
export const isCutShortContent = (text: string): boolean => {
  if (text.length <= NAMESERVER_PREFIX.length) return NAMESERVER_PREFIX.startsWith(text);
  if (!text.startsWith(NAMESERVER_PREFIX)) return false;
  const rest = text.slice(NAMESERVER_PREFIX.length);
  const newline = rest.indexOf('\n');
  if (newline === -1) {
    // Still inside the address: digits and dots only, no longer than an address.
    return rest.length <= MAX_IPV4_TEXT && /^[0-9.]*$/.test(rest);
  }
  const address = rest.slice(0, newline);
  if (!normalizeIpv4(address).ok) return false;
  const tail = rest.slice(newline + 1);
  if (`${RESOLVER_MARKER}\n`.startsWith(tail)) return true;
  return address === DNS_PROXY.address && (PROXY_PORT_LINE.startsWith(tail) || `${PROXY_PORT_LINE}${RESOLVER_MARKER}\n`.startsWith(tail));
};

/**
 * A domain as a file name in the resolver directory, or `null`. The config
 * schema validated it already; this is the check right before a path is built.
 */
export const resolverFileName = (domain: unknown): string | null => {
  // `normalizeDomain` allows only `[a-z0-9.-]` in non-empty labels: no `/`, no `..`, no empty name.
  if (typeof domain !== 'string') return null;
  const normalised = normalizeDomain(domain);
  return normalised.ok && normalised.value === domain ? domain : null;
};

const errorCodeOf = (error: unknown): string => {
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

type ReadOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ours'; readonly text: string }
  /** Exists and is not ours: no marker, not a regular file, a symlink or too large. */
  | { readonly kind: 'foreign'; readonly why: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

/** Who answers for the name of a file: a DNS server, or the system resolvers (a wildcard rule without `dns`). */
const SYSTEM_RESOLVERS = 'system';

interface Wanted {
  readonly name: string;
  /** A DNS server, or `SYSTEM_RESOLVERS`; rules sharing a file must agree on it. */
  readonly answeredBy: string;
  readonly ruleIds: string[];
  /** A wildcard rule shares the file: it points at the DNS proxy, which forwards the name itself to `answeredBy`. */
  proxy: boolean;
}

const contentOf = (entry: Wanted): string => (entry.proxy ? proxyResolverFileContent() : resolverFileContent(entry.answeredBy));

const proxyIssue = (proxy: Exclude<WildcardProxyStatus, { state: 'ready' }>, base: string): ResolverIssue => {
  switch (proxy.state) {
    case 'starting':
      return { reasonCode: 'dns-proxy-unavailable', reason: `The DNS proxy is starting; ${base} is sent to it once it listens`, pending: true };
    case 'absent':
      return { reasonCode: 'dns-proxy-unavailable', reason: 'Wildcard rules need the DNS proxy of the running helper; this run has none' };
    case 'unavailable':
      return {
        reasonCode: 'dns-proxy-unavailable',
        reason: `The DNS proxy cannot listen on ${DNS_PROXY.address}:${String(DNS_PROXY.port)}${proxy.detail === null ? '' : ` (${proxy.detail})`}; names under ${base} use the normal DNS until it can, which is tried again`,
      };
  }
};

export const createResolverFiles = (deps: ResolverFilesDeps): ResolverFiles => {
  const fs = deps.fs ?? realFs;
  const { dir, runner } = deps;
  const logger = deps.logger.child({ component: 'resolver' });
  const pathOf = (name: string): string => `${dir}/${name}`;
  /** Passes run one after another; a second call waits for the first. */
  let queue: Promise<unknown> = Promise.resolve();

  /** Clean-up that may fail without changing the outcome; a failure is still logged. */
  const tidy = async (step: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const detail = errorCodeOf(error);
      if (detail !== 'ENOENT') logger.error('resolver file clean-up failed', { step, error: detail });
    }
  };

  /**
   * Reads a file without following a link, bounded in size. A temporary name
   * of ours is also ours when its content is a write of ours cut short.
   */
  const readEntry = async (name: string, temporary = false): Promise<ReadOutcome> => {
    let handle: nodeFs.FileHandle;
    try {
      handle = await fs.open(pathOf(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const detail = errorCodeOf(error);
      if (detail === 'ENOENT') return { kind: 'missing' };
      // `O_NOFOLLOW` on a symlink.
      if (detail === 'ELOOP' || detail === 'EMLINK') return { kind: 'foreign', why: 'a symbolic link' };
      return { kind: 'unreadable', detail };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { kind: 'foreign', why: 'not a regular file' };
      if (stats.size > MAX_RESOLVER_FILE_BYTES) return { kind: 'foreign', why: 'larger than a file of ours' };
      // Only root writes in the directory, so the size does not change between the two calls.
      const text = await handle.readFile({ encoding: 'utf8' });
      if (hasResolverMarker(text) || (temporary && isCutShortContent(text))) return { kind: 'ours', text };
      return { kind: 'foreign', why: 'no managed-by marker' };
    } catch (error) {
      return { kind: 'unreadable', detail: errorCodeOf(error) };
    } finally {
      await tidy('close', () => handle.close());
    }
  };

  /** `true`, `false` (the directory is missing) or the reason it cannot be used. */
  const checkDir = async (): Promise<boolean | string> => {
    try {
      const stats = await fs.lstat(dir);
      return stats.isDirectory() ? true : 'the resolver directory is not a directory';
    } catch (error) {
      const detail = errorCodeOf(error);
      return detail === 'ENOENT' ? false : `the resolver directory cannot be read (${detail})`;
    }
  };

  /**
   * Removes a leftover temporary file of ours; anything else under that name
   * stays. `null` when the name is free, else the problem, naming the temporary file.
   */
  const dropTemp = async (name: string): Promise<string | null> => {
    const entry = await readEntry(name, true);
    if (entry.kind === 'missing') return null;
    if (entry.kind === 'foreign') return `foreign-temp:${entry.why}`;
    if (entry.kind === 'unreadable') return `${pathOf(name)} (the temporary file) could not be read (${entry.detail})`;
    try {
      await fs.unlink(pathOf(name));
      logger.info('leftover temporary resolver file removed', { file: name });
      return null;
    } catch (error) {
      const detail = errorCodeOf(error);
      if (detail === 'ENOENT') return null;
      logger.error('leftover temporary resolver file could not be removed', { file: name, error: detail });
      return `${pathOf(name)} (the temporary file) could not be removed (${detail})`;
    }
  };

  /** Writes `content` as `name` through a temporary file. `null` on success, else the reason. */
  const writeFile = async (name: string, content: string): Promise<string | null> => {
    const temp = `${TEMP_PREFIX}${name}${TEMP_SUFFIX}`;
    const blocked = await dropTemp(temp);
    if (blocked !== null) return blocked;
    let handle: nodeFs.FileHandle;
    try {
      handle = await fs.open(
        pathOf(temp),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
    } catch (error) {
      return `the file could not be created (${errorCodeOf(error)})`;
    }
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      await handle.chmod(FILE_MODE);
      await handle.sync();
    } catch (error) {
      await tidy('close', () => handle.close());
      await tidy('unlink temporary', () => fs.unlink(pathOf(temp)));
      return `the file could not be written (${errorCodeOf(error)})`;
    }
    await tidy('close', () => handle.close());
    // Checked once more right before the rename: a file that appeared meanwhile is not replaced.
    const target = await readEntry(name);
    if (target.kind === 'foreign' || target.kind === 'unreadable') {
      await tidy('unlink temporary', () => fs.unlink(pathOf(temp)));
      return target.kind === 'foreign' ? `foreign:${target.why}` : `the file could not be read (${target.detail})`;
    }
    try {
      await fs.rename(pathOf(temp), pathOf(name));
      return null;
    } catch (error) {
      await tidy('unlink temporary', () => fs.unlink(pathOf(temp)));
      return `the file could not be put in place (${errorCodeOf(error)})`;
    }
  };

  const flush = async (): Promise<void> => {
    const commands = [
      [ALLOWED_BINARIES.dscacheutil, ['-flushcache']],
      [ALLOWED_BINARIES.killall, ['-HUP', 'mDNSResponder']],
    ] as const;
    for (const [bin, args] of commands) {
      try {
        const result = await runner.run(bin, args, { timeoutMs: FLUSH_TIMEOUT_MS });
        if (!result.ok) {
          logger.warn('flushing the DNS cache failed', { bin, failure: result.failure, exitCode: result.exitCode });
        }
      } catch (error) {
        logger.error('flushing the DNS cache could not be started', {
          bin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /**
   * What the config asks for: one entry per file name, the first rule of a
   * name deciding who answers for it (see the module comment).
   */
  const wantedOf = (
    config: Pick<Config, 'enabled' | 'rules'>,
    proxy: WildcardProxyStatus,
    issues: Map<string, ResolverIssue>,
  ): Map<string, Wanted> => {
    const wanted = new Map<string, Wanted>();
    if (!config.enabled) return wanted;
    const unusable: ResolverIssue = {
      reasonCode: 'resolver-failed',
      reason: 'The domain or DNS server of the rule cannot be used for a resolver file',
    };
    for (const rule of config.rules.slice(0, LIMITS.maxRules)) {
      if (!rule.enabled || rule.kind !== 'domain') continue;
      const wildcard = typeof rule.target === 'string' && isWildcardDomain(rule.target);
      if (!wildcard && rule.dns === undefined) continue;
      const base = wildcard ? wildcardBase(rule.target) : rule.target;
      const name = base === null ? null : resolverFileName(base);
      const server = rule.dns === undefined ? null : typeof rule.dns === 'string' ? normalizeHostAddress(rule.dns) : undefined;
      if (name === null || server === undefined || (server !== null && !server.ok)) {
        issues.set(rule.id, unusable);
        continue;
      }
      if (wildcard && proxy.state !== 'ready') {
        issues.set(rule.id, proxyIssue(proxy, name));
        continue;
      }
      const answeredBy = server === null ? SYSTEM_RESOLVERS : server.value;
      const existing = wanted.get(name);
      if (existing === undefined) {
        wanted.set(name, { name, answeredBy, ruleIds: [rule.id], proxy: wildcard });
      } else if (existing.answeredBy === answeredBy) {
        existing.ruleIds.push(rule.id);
        if (wildcard) existing.proxy = true;
      } else {
        issues.set(rule.id, {
          reasonCode: 'resolver-conflict',
          reason:
            existing.answeredBy === SYSTEM_RESOLVERS
              ? `Another rule already sends ${name} to the DNS proxy, which asks the system resolvers for it`
              : `Another rule already sets ${existing.answeredBy} as the DNS server of ${name}`,
        });
      }
    }
    return wanted;
  };

  const run = async (config: Pick<Config, 'enabled' | 'rules'>, proxy: WildcardProxyStatus): Promise<ResolverSyncResult> => {
    const issues = new Map<string, ResolverIssue>();
    const wanted = wantedOf(config, proxy, issues);
    const failAll = (reason: string): void => {
      for (const entry of wanted.values()) {
        for (const ruleId of entry.ruleIds) issues.set(ruleId, { reasonCode: 'resolver-failed', reason });
      }
    };
    let changed = 0;
    let notRemoved = 0;

    const dirState = await checkDir();
    if (typeof dirState === 'string') {
      logger.error('resolver files cannot be managed', { dir, problem: dirState });
      failAll(`Resolver files cannot be managed: ${dirState}`);
      return { issues, changed, notRemoved: 1 };
    }
    if (!dirState) {
      if (wanted.size === 0) return { issues, changed, notRemoved };
      try {
        await fs.mkdir(dir, { mode: DIR_MODE });
        // `mkdir` applies the umask; the mode is set as meant.
        await fs.chmod(dir, DIR_MODE);
      } catch (error) {
        const detail = errorCodeOf(error);
        if (detail !== 'EEXIST') {
          logger.error('the resolver directory could not be created', { dir, error: detail });
          failAll(`The resolver directory could not be created (${detail})`);
          return { issues, changed, notRemoved };
        }
      }
    }

    for (const entry of wanted.values()) {
      const content = contentOf(entry);
      const current = await readEntry(entry.name);
      let problem: string | null = null;
      if (current.kind === 'foreign') {
        problem = `foreign:${current.why}`;
      } else if (current.kind === 'unreadable') {
        problem = `the file could not be read (${current.detail})`;
      } else if (current.kind === 'missing' || current.text !== content) {
        problem = await writeFile(entry.name, content);
        if (problem === null) {
          changed += 1;
          logger.info(current.kind === 'missing' ? 'resolver file created' : 'resolver file updated', {
            domain: entry.name,
            server: entry.proxy ? `${DNS_PROXY.address}:${String(DNS_PROXY.port)}` : entry.answeredBy,
            ruleIds: entry.ruleIds,
          });
        }
      }
      if (problem === null) continue;
      const foreignTemp = problem.startsWith('foreign-temp:');
      const foreign = foreignTemp || problem.startsWith('foreign:');
      const tempPath = pathOf(`${TEMP_PREFIX}${entry.name}${TEMP_SUFFIX}`);
      let issue: ResolverIssue;
      if (foreignTemp) {
        issue = {
          reasonCode: 'resolver-conflict',
          reason: `${tempPath}, the temporary name of ${pathOf(entry.name)}, is not managed by RouteSwitch (${problem.slice('foreign-temp:'.length)}); it is left as it is`,
        };
      } else if (foreign) {
        issue = {
          reasonCode: 'resolver-conflict',
          reason: `${pathOf(entry.name)} exists and is not managed by RouteSwitch (${problem.slice('foreign:'.length)}); it is left as it is`,
        };
      } else {
        issue = { reasonCode: 'resolver-failed', reason: `${pathOf(entry.name)}: ${problem}` };
      }
      logger.log(foreign ? 'warn' : 'error', foreign ? 'resolver file belongs to someone else; not touched' : 'resolver file could not be written', {
        domain: entry.name,
        file: foreignTemp ? tempPath : pathOf(entry.name),
        ruleIds: entry.ruleIds,
        problem,
      });
      for (const ruleId of entry.ruleIds) issues.set(ruleId, issue);
    }

    // Stale files of ours: a domain no rule asks for any more, and leftovers of an interrupted write.
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      logger.error('the resolver directory could not be listed; stale files stay for now', { dir, error: errorCodeOf(error) });
      notRemoved += 1;
    }
    if (names.length > MAX_RESOLVER_DIR_ENTRIES) {
      logger.warn('the resolver directory has more entries than are looked at in one pass', {
        entries: names.length,
        limit: MAX_RESOLVER_DIR_ENTRIES,
      });
    }
    for (const name of names.slice(0, MAX_RESOLVER_DIR_ENTRIES)) {
      const isTemp = name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);
      if (!isTemp && (wanted.has(name) || resolverFileName(name) === null)) continue;
      if (isTemp && resolverFileName(name.slice(TEMP_PREFIX.length, -TEMP_SUFFIX.length)) === null) continue;
      const entry = await readEntry(name, isTemp);
      if (entry.kind === 'unreadable') {
        logger.warn('resolver file could not be read; left as it is', { file: name, error: entry.detail });
      }
      if (entry.kind !== 'ours') continue;
      try {
        await fs.unlink(pathOf(name));
        changed += 1;
        logger.info(isTemp ? 'leftover temporary resolver file removed' : 'resolver file removed', { file: name });
      } catch (error) {
        logger.error('resolver file could not be removed; tried again next time', { file: name, error: errorCodeOf(error) });
        notRemoved += 1;
      }
    }

    if (changed > 0) await flush();
    return { issues, changed, notRemoved };
  };

  const serialised = (config: Pick<Config, 'enabled' | 'rules'>, proxy: WildcardProxyStatus): Promise<ResolverSyncResult> => {
    const next = queue.then(
      () => run(config, proxy),
      () => run(config, proxy),
    );
    const safe = next.catch((error: unknown) => {
      // Nothing above is expected to throw; a daemon must still get an answer.
      logger.error('resolver sync failed', { error: error instanceof Error ? error.message : String(error) });
      return { issues: new Map<string, ResolverIssue>(), changed: 0, notRemoved: 1 };
    });
    queue = safe;
    return safe;
  };

  return {
    sync: (config, proxy = NO_WILDCARD_PROXY) => serialised(config, proxy),
    removeAll: () => serialised({ enabled: false, rules: [] }, NO_WILDCARD_PROXY),
  };
};
