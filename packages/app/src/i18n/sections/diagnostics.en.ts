// English words of the "Diagnostika" section. Typed by the Uzbek section: a
// key missing or added fails `tsc`.

import { plural } from '../plural';
import type { Shape } from '../types';
import type { diagnosticsUz } from './diagnostics.uz';

const count = (n: number, one: string, other: string): string => `${String(n)} ${plural('en', n, { one, other })}`;

export const diagnosticsEn: Shape<typeof diagnosticsUz> = {
  title: 'Diagnostics',
  subtitle: 'Check which interface an address leaves through, and why: the rule, the actual route and DNS.',
  inputLabel: 'Host, IP or URL',
  placeholder: 'corp.local, 10.20.4.37 or https://example.com/page',
  hint: 'Only the host of a URL is used (scheme, port and path are dropped). Nothing is changed.',
  run: 'Check',
  runOff: (reason) => `Check — ${reason}`,
  needsHelper: 'the helper is not connected',
  running: 'Checking… resolving a name can take a few seconds.',
  inputErrors: {
    empty: 'Enter a host, an IP address or a URL.',
    'too-long': 'Too long — enter one host, IP or URL.',
    ipv6: 'IPv6 addresses are not supported — enter an IPv4 address or a host name.',
    wildcard: 'No «*»: diagnostics are for one concrete name or address.',
    'invalid-host': 'This is not a host name. For example: corp.local, 10.20.4.37 or https://example.com.',
  },
  failed: (reason) => `Could not check: ${reason}`,
  rateLimited:
    'Too many checks: the helper checks up to 10 requests a minute (each address of a name no rule covers is a request of its own). Try again in a minute.',
  helperBusy: 'The helper is busy with another check — try again shortly.',

  emptyTitle: 'Nothing checked yet',
  emptyText: "Enter a host, IP or URL — the result shows the matching rule, each address's actual interface and the DNS server.",

  resultLabel: (target) => `Result for ${target}`,
  verdict: {
    ok: 'Everything as expected',
    okVia: (role) => `Everything as expected — through ${role}`,
    mismatch: 'Traffic does not leave through the expected interface',
    noRule: 'No rule — it uses the default route',
    noAddresses: 'No addresses found',
    onlyExcluded: 'The name points to an address that is never routed',
    dnsDown: 'The DNS server does not answer',
    partial: 'Some addresses were not checked',
  },
  advice: {
    noRule: 'If it should go through another interface, add a rule in the Rules section.',
    ruleDisabled: 'The matching rule is switched off — switch it on in the Rules section.',
    globallyDisabled: 'Routing is switched off altogether — switch it on in the menu bar window.',
    interfaceDown: "The rule's interface is not connected — check the cable or Wi‑Fi; the rule applies by itself once it is.",
    notApplied: "The rule's route is not in the table — see the rule's state in the Rules section or press “Apply again” in the menu bar window.",
    mismatch: "Another route wins (a VPN or a more specific route, for example) — see the rule's state in the Rules section.",
    dnsDown: 'Internal names may not resolve — check which interface the way to the DNS server takes.',
    partial: 'Try checking again in a minute.',
    noAddresses: 'Check that the name is spelled correctly and that DNS works.',
    onlyExcluded: 'This name points to the computer itself (localhost, for example) or to a link-local address — such traffic leaves through no interface, no rule is needed.',
  },

  matchTitle: 'Matching rule',
  matchRule: (target, role) => `${target} → ${role}`,
  unknownRule: 'a rule (the rule list has not been read yet)',
  noMatch: 'No enabled rule matches — traffic uses the default route.',
  via: {
    ip: 'IP rule',
    subnet: 'subnet rule',
    domain: 'domain rule',
    wildcard: 'wildcard domain rule',
    'dns-server': "the rule's DNS server",
  },
  precedence: {
    'only-match': 'no other rule matches',
    'host-route': 'an exact address (/32) rule beats everything',
    'domain-address': "an address of a domain's answer beats a wider subnet",
    'longest-prefix': 'the narrowest subnet (longest prefix) wins',
    'exact-domain': 'an exact domain beats a wildcard',
    'deeper-wildcard': 'the deepest wildcard wins',
    'config-order': 'a tie — the rule higher in the list wins',
  },
  addressRule: (via, rule) => `${via}: ${rule}`,

  addressesTitle: 'Addresses',
  columns: { address: 'Address', actual: 'Actual route', expected: 'Expected', status: 'Result' },
  sources: {
    'rule-cache': "from the rule's cache",
    query: 'helper query',
    system: 'system resolver',
  },
  noRoute: 'no route',
  gateway: (gateway) => `gateway ${gateway}`,
  direct: 'directly connected',
  noRole: 'interface without a role',
  defaultRoute: 'default route',
  status: {
    ok: '✓ matches',
    mismatch: '✗ does not match',
    default: '— no rule',
    unknown: '? unknown',
    failed: 'not checked',
  },
  rowFailed: (reason) => `Not checked: ${reason}`,
  noAddressRows: 'No address to check.',

  dnsTitle: 'DNS',
  dnsServer: (server) => `Server: ${server}`,
  dnsVia: (role) => `through ${role}`,
  dnsOutcome: {
    ok: 'answered',
    timeout: 'did not answer (3 s)',
    refused: 'refused the query',
    error: 'the query failed',
    'not-queried': 'not queried',
  },
  dnsMs: (ms) => `${String(ms)} ms`,
  resolverFile: (path) => `Resolver file: ${path}`,
  noResolverFile: 'No resolver file — the system DNS is used.',
  noDns: 'The rule has no DNS server of its own — the system DNS is used.',

  notesTitle: 'Notes',
  notes: {
    'name-not-covered':
      'No domain rule covers this name — the helper does not resolve it; the app resolved it with the system resolver, with your normal rights.',
    'no-matching-rule': 'No enabled rule matches — the default route is used.',
    'rule-disabled': 'A rule matches, but it is switched off.',
    'globally-disabled': 'Routing is switched off altogether — no rule is applied.',
    'interface-down': "The rule's interface is not connected.",
    'no-gateway': "The rule's interface has no gateway.",
    'not-applied': "The rule's route is not in the routing table.",
    'route-mismatch': "The system sends the address through another interface than the rule's.",
    'connected-network': "The address is on a directly connected network (or is an interface's gateway or own address) — it is never routed.",
    'dns-server-excluded': 'The address is a DNS server — it is never routed.',
    'no-addresses': 'The name has no A records (IPv4 addresses).',
    'resolve-failed': 'The name could not be resolved.',
    'addresses-truncated': 'Many addresses — only some are shown.',
  },

  lookup: {
    ok: (n) => `The system resolver gave ${count(n, 'IPv4 address', 'IPv4 addresses')}.`,
    truncated: (max) => `The system resolver gave more than ${String(max)} IPv4 addresses — only the first ${String(max)} were checked.`,
    excluded: (n) =>
      `${count(n, 'address', 'addresses')} (loopback, link-local, …) ${n === 1 ? 'is never routed and was' : 'are never routed and were'} not checked.`,
    onlyExcluded: (n) => `The system resolver gave only addresses that are never routed (${String(n)}: loopback, link-local, …) — nothing to check.`,
    outcomes: {
      'not-found': 'Name not found: the system resolver gave no IPv4 address.',
      timeout: 'The system resolver did not answer within 3 seconds.',
      failed: 'The name could not be resolved with the system resolver.',
    },
  },
};
