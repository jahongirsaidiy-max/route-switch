// English. Typed as `Messages`: a key missing from or added to `uz.ts` fails `tsc`.

import { LIMITS, MIN_SUBNET_PREFIX } from '@routeswitch/shared';

import { plural } from './plural';
import { addRuleEn } from './sections/addRule.en';
import { rulesEn } from './sections/rules.en';
import { menuBarEn } from './sections/menuBar.en';
import { shellEn } from './sections/shell.en';
import type { Messages } from './types';
import { componentsEn } from './sections/components.en';
import { logEn } from './sections/log.en';
import { settingsEn } from './sections/settings.en';
import { backupEn } from './sections/backup.en';
import { diagnosticsEn } from './sections/diagnostics.en';

const unexpected = (code: string): string => `Unexpected error (${code}).`;

const count = (n: number, one: string, other: string): string => `${String(n)} ${plural('en', n, { one, other })}`;

export const en: Messages = {
  unknownWindow: 'Unknown window. Open the app again from its menu bar icon.',

  unexpectedError: unexpected,

  menuBar: menuBarEn,
  ...shellEn,

  errors: {
    'not-connected': 'No connection to the helper — nothing was sent.',
    disconnected: 'No answer came, so the outcome is unknown. The status will update when the helper reconnects.',
    timeout: 'No answer came, so the outcome is unknown. The status will update when the helper reconnects.',
    busy: 'The helper is busy — try again in a moment.',
    'not-implemented': 'The installed helper cannot do this yet.',
    'invalid-config': 'The value was not accepted.',
    'invalid-input': 'The value was not accepted.',
    'operation-failed': 'The action could not be completed.',
    forbidden: 'This window is not allowed to do that.',
    'file-unreadable': 'The file could not be read.',
    'file-not-regular': 'The selected item is not a regular file.',
    'file-too-large': 'The file is too large (over 1 MB) — it is not a config file.',
    'file-not-text': 'The file is not UTF-8 text.',
    'file-not-json': 'The file is not JSON or is damaged.',
    'import-expired': 'The selected file has expired — choose it again.',
    'write-failed': 'The file could not be written — choose another location.',
    'no-backup': 'The app holds no rules backup.',
    'install-unavailable':
      'The helper package inside the app is missing or untrusted (a symbolic link, or writable by another user) — reinstall the app.',
    'install-cancelled': 'The password dialog was closed — nothing changed. You can try again.',
    'install-denied': 'The administrator password was not accepted — nothing changed. Try again.',
    'install-failed': 'The script ended with an error. Details: /Library/Logs/RouteSwitch/helper.log. You can try again.',
    'invalid-json': unexpected('invalid-json'),
    'line-too-long': unexpected('line-too-long'),
    'invalid-request': unexpected('invalid-request'),
    'unknown-method': unexpected('unknown-method'),
    internal: unexpected('internal'),
    'invalid-response': unexpected('invalid-response'),
    unspecified: unexpected('unspecified'),
    'rule-not-found': unexpected('rule-not-found'),
  },

  helperStatus: {
    loading: 'Checking…',
    connected: 'Helper is running',
    connecting: 'Connecting to the helper…',
    'not-installed': 'Helper is not installed',
    disconnected: 'Helper is not running',
    'config-unreadable': 'Helper config is damaged',
    incompatible: 'Helper version does not match',
    stopped: 'The app is quitting',
    unavailable: 'Could not read the status',
  },

  install: {
    install: 'Install the helper',
    reinstall: 'Reinstall the helper',
    waiting: 'macOS will ask for the administrator password. Installing can take up to a minute.',
    installed: 'Helper installed — connecting…',
    removed: 'The helper was removed completely: routes, resolver files, the daemon, its config and log are gone.',
  },

  notice: {
    loadingTitle: 'Reading the status…',
    connectingTitle: 'Connecting to the helper…',
    notInstalledTitle: 'Helper is not installed',
    notInstalledText: 'Routing needs the helper, installed once with the administrator password. Until then no rule is applied.',
    disconnectedTitle: 'No connection to the helper',
    routesStay: 'Routes already applied stay with the helper.',
    disconnected: {
      'not-running': 'The helper is not running. launchd restarts it; if it does not, reinstall it.',
      'permission-denied': 'No access to the helper socket (the user is not in the staff group).',
      'connection-lost': 'The connection was lost — reconnecting.',
      'protocol-error': 'The helper sent an answer that could not be understood — reconnecting.',
      timeout: 'The helper did not answer — reconnecting.',
      error: 'Could not connect to the helper — retrying.',
    },
    configUnreadableTitle: 'Helper config is damaged',
    configUnreadableText:
      'The helper is running but could not read its stored config, so no rule is applied. In “Rules”, import a config or start with an empty one.',
    incompatibleTitle: 'Helper version does not match',
    incompatibleText: (helperVersion, protocolVersion, expected) =>
      `Helper v${helperVersion} uses a different protocol (${String(protocolVersion)}, needed: ${String(expected)}). Reinstall the helper.`,
    reinstall: 'Reinstall the helper.',
    stoppedTitle: 'The app is quitting',
    unavailableTitle: 'Could not read the status',
  },

  ruleReason: {
    'rule-disabled': 'Rule is off',
    'globally-disabled': 'Routing is off',
    'interface-down': 'Interface is not connected',
    'no-gateway': 'Interface has no gateway',
    resolving: 'Resolving the domain',
    'resolve-failed': 'DNS lookup failed',
    'no-addresses': 'The domain has no IPv4 address (A record)',
    'forbidden-destination': 'Forbidden address — default route protection never routes it',
    'connected-network': 'The address overlaps the interface’s own network or gateway — no route was added',
    'route-failed': 'Route was not added',
    'resolver-conflict': '/etc/resolver holds a file RouteSwitch did not create for this domain',
    'resolver-failed': 'Resolver file was not written',
    internal: 'Internal helper error',
    'addresses-truncated': 'Too many addresses — only some are routed',
    'overridden-by-rule': 'Some addresses are routed through another interface by another rule',
    'dns-server-excluded': 'Some addresses are DNS servers and are not routed',
  },

  reconcileReason: {
    startup: 'when the helper started',
    'config-change': 'when the rules changed',
    'enabled-change': 'when routing was turned on or off',
    manual: 'manually',
    'network-change': 'when the network changed',
    'dns-refresh': 'when DNS was refreshed',
    'drift-check': 'during a periodic check',
  },

  validation: {
    'invalid-ipv4': 'Enter an IPv4 address, e.g. 172.16.12.40.',
    'invalid-cidr': 'Enter a subnet in CIDR form, e.g. 10.0.0.0/8.',
    'invalid-prefix': `The prefix must be between ${String(MIN_SUBNET_PREFIX)} and 32.`,
    'prefix-too-wide': `The subnet is too wide: the prefix must be at least /${String(MIN_SUBNET_PREFIX)}.`,
    'invalid-domain': 'A domain may contain only lowercase Latin letters, digits, “-” and “.”, e.g. corp.local.',
    'invalid-wildcard': 'A wildcard “*” may stand only in the last octets, e.g. 10.*.*.* or 192.168.5.*.',
    'invalid-destination': 'Enter an IPv4 address or a subnet in CIDR form.',
    'default-route': 'The default route (0.0.0.0/0) is never changed.',
    'this-network': '0.0.0.0/8 addresses are never routed.',
    loopback: 'Loopback addresses (127.0.0.0/8) are never routed.',
    'link-local': 'Link-local addresses (169.254.0.0/16) are never routed.',
    multicast: 'Multicast addresses (224.0.0.0/4) are never routed.',
    broadcast: '255.255.255.255 is never routed.',
  },

  configFile: {
    fields: {
      id: 'id',
      kind: 'type',
      target: 'address',
      iface: 'interface',
      dns: 'DNS server',
      refreshSec: 'refresh interval',
      note: 'note',
      enabled: 'state',
    },
    issues: {
      'iface-conflict': 'one address is bound to two interfaces.',
      'duplicate-id': 'a rule id is repeated.',
      'too-many-values': 'the file is too large or too deeply nested.',
      'array-too-long': `more than ${String(LIMITS.maxRules)} rules.`,
      'too-deep': 'the file is too large or too deeply nested.',
      'string-too-long': 'a text is too long.',
      invalid_type: 'the value has the wrong type or is missing.',
      invalid_value: 'the value is invalid.',
      too_small: 'the value is too small or too short.',
      too_big: 'the value is too large or too long.',
      invalid_format: 'the value has the wrong format.',
    },
    invalidValue: 'the value is invalid.',
    notAConfig: 'The file does not look like a config.',
    wrongVersion: 'The config version does not match (expected: 1) — the file is from another version.',
    tooManyRules: `More than ${String(LIMITS.maxRules)} rules.`,
    ruleAt: (index, field) => `Rule ${String(index)}${field === null ? '' : `, ${field}`}: `,
    ifaceOverridesAt: 'Interface overrides: ',
    enabledAt: 'Overall state: ',
  },

  network: {
    adapterMissing: (role) => `${role} adapter not found`,
    noGateway: (role) => `${role} has no gateway`,
    notConnected: (role) => `${role} is not connected`,
    rulesWaiting: (n) =>
      `${count(n, 'rule is', 'rules are')} waiting — ${plural('en', n, { one: 'it applies', other: 'they apply' })} automatically once the interface connects.`,
    rulesWaitingUncounted: 'Its rules are waiting — they apply automatically once the interface connects.',
    sameSubnetTitle: 'Ethernet and Wi‑Fi are on one network',
    sameSubnetText: (gateway) =>
      `Both use the gateway ${gateway}, so a route through it is unreliable: the system picks the interface the traffic leaves through. Connect one of them to another network.`,
    lastKnownNone: 'No last known IPs — the domain is not routed now.',
    lastKnown: (addresses, when) => `Last known IPs (still routed): ${addresses}${when}`,
  },

  time: {
    justNow: 'just now',
    minutesAgo: (n) => `${String(n)} min ago`,
    hoursAgo: (n) => `${count(n, 'hour', 'hours')} ago`,
    daysAgo: (n) => `${count(n, 'day', 'days')} ago`,
  },

  settingsLanguage: {
    hint: 'The app shows its texts in this language. Entries the helper writes to the log stay in English.',
    saved: 'Language changed.',
  },

  /** The journal, settings and shared components (TASK-DELTA-14): `sections/*.ts`. */
  log: logEn,
  settings: settingsEn,
  /** The rules backup and its restore offer (TASK-DELTA-16): `sections/backup.*`. */
  backup: backupEn,
  components: componentsEn,

  /** The rules window and the add-rule dialog (TASK-DELTA-13): `sections/rules.*`, `sections/addRule.*`. */
  rules: rulesEn,
  addRule: addRuleEn,
  /** The "Diagnostika" section of the rules window (TASK-DELTA-20): `sections/diagnostics.*`. */
  diagnostics: diagnosticsEn,
};
