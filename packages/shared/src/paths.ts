/**
 * Every runtime path and system identifier RouteSwitch uses, in one place.
 *
 * Plain string constants only: this module is imported by the sandboxed
 * renderer as well, so it must not pull in `node:path` or `node:fs`.
 * None of these files live in the repository; the install script creates them.
 */

/** launchd label of the helper daemon; also the file name of its binary. */
export const LAUNCHD_LABEL = 'com.routeswitch.helper';

/** Service target for `launchctl print|bootout`, in the system domain. */
export const LAUNCHD_SERVICE_TARGET = `system/${LAUNCHD_LABEL}`;

/** Marker line that identifies an `/etc/resolver` file as ours. Files without it are never touched. */
export const RESOLVER_MARKER = '# managed-by: routeswitch';

const HELPER_TOOLS_DIR = '/Library/PrivilegedHelperTools';
const LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';
const SUPPORT_DIR = '/Library/Application Support/RouteSwitch';
const LOG_DIR = '/Library/Logs/RouteSwitch';

export const PATHS = {
  /** Helper binary (root:wheel 0755). */
  helperBinary: `${HELPER_TOOLS_DIR}/${LAUNCHD_LABEL}`,
  /** LaunchDaemon plist (root:wheel 0644). */
  launchDaemonPlist: `${LAUNCH_DAEMONS_DIR}/${LAUNCHD_LABEL}.plist`,
  /** Directory of `config.json` and `state.json` (root:wheel 0755). */
  supportDir: SUPPORT_DIR,
  /** The rules. Read and written by the helper only (root:wheel 0644). */
  config: `${SUPPORT_DIR}/config.json`,
  /** Routes and resolver files the helper has applied, for cleanup after a crash. */
  state: `${SUPPORT_DIR}/state.json`,
  /** Unix domain socket the app connects to (root:staff 0660). */
  socket: '/var/run/routeswitch.sock',
  /** Directory of the helper log (root:wheel 0755). */
  logDir: LOG_DIR,
  /** Helper log, JSON lines (root:wheel 0644). */
  log: `${LOG_DIR}/helper.log`,
  /** Scoped DNS: one file per domain, named after the domain. */
  resolverDir: '/etc/resolver',
  /** Rotation of `log` by the system's newsyslog (root:wheel 0644); written by the install script. */
  newsyslogConf: `/etc/newsyslog.d/${LAUNCHD_LABEL}.conf`,
} as const;

export type PathName = keyof typeof PATHS;

/**
 * The helper's loopback DNS forwarding proxy for wildcard domain rules
 * (ADR-002). Port 954 is below 1024, so only root can bind it: while the
 * helper restarts, no ordinary process can take the port and answer for the
 * wildcard domains. Never 53 (local DNS servers, Internet Sharing). Written as
 * `nameserver` + `port` into `/etc/resolver/<base>` of every enabled wildcard
 * rule.
 */
export const DNS_PROXY = Object.freeze({ address: '127.0.0.1', port: 954 } as const);
