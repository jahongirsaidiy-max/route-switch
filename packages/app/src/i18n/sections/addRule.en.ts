// English words of the add / edit rule dialog. Typed by the Uzbek section: a
// key missing or added fails `tsc`.

import { LIMITS } from '@routeswitch/shared';

import { plural } from '../plural';
import type { Shape } from '../types';
import type { addRuleUz } from './addRule.uz';

const every = (count: number, unit: string): string =>
  count === 1 ? `every ${unit}` : `every ${String(count)} ${plural('en', count, { one: unit, other: `${unit}s` })}`;
const waiting = 'the rule will be “Pending” and is applied once it connects.';

export const addRuleEn: Shape<typeof addRuleUz> = {
  titles: { add: 'New rule', edit: 'Edit rule' },
  subtitle: 'Choose an address and the channel it goes through.',
  kindLabel: 'Type',
  kinds: { ip: 'IP', subnet: 'Subnet', domain: 'Domain' },
  targetField: {
    ip: { label: 'IP address', hint: 'Adds a route for a single host. A wildcard works too: 10.*.*.* → 10.0.0.0/8 (subnet).' },
    subnet: { label: 'Subnet (CIDR)', hint: 'The most reliable choice for a whole internal network. A wildcard works too: 10.*.*.* → 10.0.0.0/8.' },
    domain: { label: 'Domain', hint: 'The domain is resolved to IPs, and a route is added for each IP. For subdomains: *.corp.local.' },
  },
  normalised: (target) => `Will be saved as ${target}.`,
  wildcardResult: (cidr) => `→ ${cidr} (subnet)`,
  wildcardHint: (base) => `Subdomains only (e.g. app.${base}) — add a separate rule for ${base} itself.`,
  wildcardLimits: 'A browser with “Secure DNS” (DNS over HTTPS) turned on bypasses this rule. No routes are added for IPv6 addresses.',
  sameAs: (target) => `This address is already in the rule “${target}” (same interface) — a second rule is redundant.`,
  useDns: 'Resolve through an internal DNS server',
  dnsAddress: 'DNS server address',
  refreshLabel: 'IP refresh interval (seconds)',
  resolverFile: (domain) => `The file /etc/resolver/${domain} will be created. `,
  refreshMinutes: (minutes) => `IPs are refreshed ${every(minutes, 'minute')}.`,
  refreshSeconds: (seconds) => `IPs are refreshed ${every(seconds, 'second')}.`,
  ifaceLabel: 'Interface',
  noteLabel: 'Note',
  notePlaceholder: 'For example: accounting system',

  errors: {
    upperCase: 'Write the domain in lower case, e.g. corp.local.',
    refresh: `Enter a whole number of seconds from ${String(LIMITS.refreshSecMin)} to ${String(LIMITS.refreshSecMax)}.`,
    note: `The note can be at most ${String(LIMITS.noteMaxLength)} characters.`,
    targetEmpty: 'Enter an address.',
    targetLong: `The address can be at most ${String(LIMITS.targetMaxLength)} characters.`,
    dnsEmpty: 'Enter the DNS server address (or clear the check box).',
    invalidRule: 'The rule is not valid.',
    ifaceConflict: (target, role) =>
      `This address is already routed through ${role} by the rule “${target}” — one address cannot be bound to two interfaces.`,
    tooManyRules: `You cannot add more than ${String(LIMITS.maxRules)} rules.`,
  },

  previewLabel: 'The command the helper runs — shown for reference, the app does not run it',
  previewNoHelper: 'The command appears once the helper is connected (the gateway comes from it).',
  previewNoAdapter: (role) => `No ${role} adapter found — ${waiting}`,
  previewNoGateway: (role) => `${role} has no gateway — ${waiting}`,
  previewDown: (role) => `${role} is not connected — ${waiting}`,
  previewEachIp: 'For each resolved IP.',
  previewEachIpDns: 'For each resolved IP; for the DNS server — unless it is on its own network.',
  previewWildcard: 'No routes in advance: when a subdomain is looked up, a route is added for each IP of the answer.',
  previewWildcardDns: 'Subdomain routes are added on lookup; the DNS server’s route right away.',

  test: 'Test',
  testOff: (reason) => `Test — ${reason}`,
  testAddress: (address) => `Test the address ${address}`,
  testIdle: (address) => `Checks which interface ${address} goes through now (route -n get).`,
  testRunning: (address) => `Checking ${address}…`,
  testNoHelper: 'No connection to the helper.',
  testEnterValid: 'Enter a valid address first.',
  testSubnetUntestable: 'An address in this subnet cannot be tested.',
  testDomainSaveFirst: "A domain's IPs are tested after the helper resolves it — save first.",
  testDomainNotResolved: 'The domain is not resolved yet, or no route has been added.',
  testNoRoute: 'No route found for this address.',
  testFailed: (why) => `Could not test: ${why}`,
  testMatch: 'Matches',
  testMismatch: 'Does not match',
  testDirect: 'direct',
  testGateway: (gateway) => `gateway ${gateway}`,
  testByThisRule: (role) => `Goes through ${role} by this rule.`,
  testGoesVia: (role) => `Goes through ${role} now.`,
  testOtherNow: 'Goes through another interface now',
  testRoleNow: (role) => `Goes through ${role} now`,
  testNotRole: (now, role) => `${now}, not ${role}.`,
  testAfterSave: (now, role) => `${now} — after saving it goes through ${role}.`,

  helperDown: (status) => `${status} — the rule cannot be saved.`,
  loadingRule: 'Reading the rule…',
  missingRule: 'This rule no longer exists — it may have been deleted in another window.',
  readFailed: (why) => `Could not read the rule: ${why}`,
  readNoHelper: 'No connection to the helper — the rule cannot be read.',
  cancel: 'Cancel',
  save: 'Save and apply',
  saveRefused: 'Rule not saved: the helper refused it (the address or the number of rules is over a limit).',
  saveFailed: (why) => `Rule not saved: ${why}`,
};
