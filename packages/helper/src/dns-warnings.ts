import {
  PROTOCOL_LIMITS,
  cidrContains,
  parseIpv4Destination,
  type DnsWarning,
  type DnsWarningCode,
  type DnsWarningSource,
  type IfaceRole,
  type Rule,
} from '@routeswitch/shared';

import type { InterfaceInfo } from './netinfo';

/**
 * "The DNS server is reached through the other interface" (release 0.2.0).
 *
 * A DNS server belongs to a role: the interface that announced it (its DHCP
 * lease or the network settings, `scutil --dns`), or the interface of the
 * domain rule whose `dns` it is. A query to it leaves through whatever the
 * kernel routes the address through, and that may be the other role's
 * interface -- typically when the server lies in the other interface's
 * connected subnet (the case this exists for: the Ethernet lease names a
 * server inside the Wi-Fi /24, so every lookup leaves through Wi-Fi and times
 * out). Such a server gets a warning, unless a route of ours already takes it
 * through its own role.
 *
 * Everything here is pure. The engine looks up, through `route -n get`, only
 * the servers `serversToLookUp` names, and hands the answers back as
 * `routeOf`. A warning never changes a rule's status or any route.
 *
 * How one server of role R (the other role: O) is judged, the way the kernel
 * picks a route -- the longest prefix that contains the address:
 * - candidates are the routes we have applied (their role is the one whose
 *   gateway they use) and the connected subnets of both roles;
 * - the most specific candidate is R's (or R's ties with O's: both interfaces
 *   are on the same network) -> fine;
 * - it is O's connected subnet -> `other-interface-subnet`;
 * - it is a route of ours through O -> `routed-via-other-interface`;
 * - there is none: the query follows a route that is not ours (default,
 *   VPN, ...). Only then is the table asked: `route -n get -host <server>`
 *   naming O's device -> `routed-via-other-interface`. Any other answer, or no
 *   answer, is no warning: only a confident finding is reported.
 * A role that is not routable (down, or without a gateway) has no servers to
 * judge; the other role must be up for a server to go through it.
 */

const ROLES: readonly IfaceRole[] = ['ethernet', 'wifi'];
const otherRole = (role: IfaceRole): IfaceRole => (role === 'ethernet' ? 'wifi' : 'ethernet');

/** Route lookups one evaluation may need, and warnings it reports. */
export const MAX_DNS_WARNINGS = PROTOCOL_LIMITS.maxDnsWarnings;
export const MAX_DNS_ROUTE_LOOKUPS = PROTOCOL_LIMITS.maxDnsWarnings;

/** What is known of a role's interface. */
export type DnsWarningInterface = Pick<InterfaceInfo, 'device' | 'up' | 'routable' | 'ip' | 'gateway' | 'subnet'>;

/** What `route -n get -host <server>` answered: the device, or `null` when it gave no usable answer. */
export type ServerRoute = { readonly device: string } | null;

export interface DnsWarningInput {
  /** The interfaces of a trusted (clean) detection. */
  readonly interfaces: Readonly<Record<IfaceRole, DnsWarningInterface>>;
  /** Each role's DNS servers, as the engine asks them; a missing role is not known. */
  readonly dnsServers: Readonly<Partial<Record<IfaceRole, readonly string[]>>>;
  /** The config's rules; only enabled domain rules with `dns` count. Pass none when the config is disabled. */
  readonly rules: readonly Pick<Rule, 'id' | 'kind' | 'enabled' | 'iface' | 'dns'>[];
  /** The routes applied right now. */
  readonly applied: readonly { readonly dst: string; readonly gateway: string }[];
}

export interface DnsWarningLookupInput extends DnsWarningInput {
  /** The answer for a server `serversToLookUp` named; `undefined` when it was not looked up. */
  readonly routeOf: (server: string) => ServerRoute | undefined;
}

/** One DNS server to judge: where it comes from and the role it belongs to. */
interface Subject {
  readonly server: string;
  readonly source: DnsWarningSource;
  readonly role: IfaceRole;
  readonly ruleId?: string;
}

type Verdict =
  | { readonly kind: 'fine' }
  | { readonly kind: 'warn'; readonly code: DnsWarningCode }
  /** Nothing of ours decides: the table has to be asked. */
  | { readonly kind: 'lookup' };

/** Usable at all: a role whose interface is up and has a gateway. */
const isRoutable = (info: DnsWarningInterface): boolean => info.up && info.routable && info.gateway !== null;

/**
 * Every server to judge, de-duplicated by server and role, in a stable order:
 * the interfaces' servers (Ethernet, then Wi-Fi, each in the order the system
 * asks them), then the rules' servers in config order (the first rule naming
 * a server for a role is the one reported).
 */
const subjectsOf = ({ interfaces, dnsServers, rules }: DnsWarningInput): Subject[] => {
  const seen = new Set<string>();
  const subjects: Subject[] = [];
  const add = (subject: Subject): void => {
    const key = `${subject.role}|${subject.server}`;
    if (seen.has(key) || parseIpv4Destination(subject.server)?.isHost !== true) return;
    seen.add(key);
    subjects.push(subject);
  };
  for (const role of ROLES) {
    if (!isRoutable(interfaces[role])) continue;
    for (const server of dnsServers[role] ?? []) add({ server, source: 'interface', role });
  }
  for (const rule of rules) {
    if (!rule.enabled || rule.kind !== 'domain' || rule.dns === undefined) continue;
    if (!isRoutable(interfaces[rule.iface])) continue;
    add({ server: rule.dns, source: 'rule', role: rule.iface, ruleId: rule.id });
  }
  return subjects;
};

/** The role whose gateway a route uses; null when it is neither's (or both's). */
const roleOfGateway = (interfaces: DnsWarningInput['interfaces'], gateway: string): IfaceRole | null => {
  const matches = ROLES.filter((role) => interfaces[role].gateway === gateway);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const judge = (input: DnsWarningInput, subject: Subject): Verdict => {
  const { interfaces, applied } = input;
  const own = subject.role;
  const other = otherRole(own);
  /** The most specific candidates seen so far, and their prefix. */
  let best = -1;
  let winners: { readonly role: IfaceRole; readonly connected: boolean }[] = [];
  const consider = (cidr: string, role: IfaceRole, connected: boolean): void => {
    const destination = parseIpv4Destination(cidr);
    if (destination === null || !cidrContains(destination.cidr, subject.server)) return;
    if (destination.prefix > best) {
      best = destination.prefix;
      winners = [{ role, connected }];
    } else if (destination.prefix === best) {
      winners.push({ role, connected });
    }
  };
  for (const route of applied) {
    const role = roleOfGateway(interfaces, route.gateway);
    if (role !== null) consider(route.dst, role, false);
  }
  for (const role of ROLES) {
    const { up, subnet } = interfaces[role];
    if (up && subnet !== null) consider(subnet, role, true);
  }
  if (winners.length === 0) return interfaces[other].up && interfaces[other].device !== null ? { kind: 'lookup' } : { kind: 'fine' };
  if (winners.some((winner) => winner.role === own)) return { kind: 'fine' };
  // Only the other role's candidates are left at the longest prefix.
  return {
    kind: 'warn',
    code: winners.some((winner) => winner.connected) ? 'other-interface-subnet' : 'routed-via-other-interface',
  };
};

/**
 * The servers whose route only `route -n get` can tell, at most
 * `MAX_DNS_ROUTE_LOOKUPS`, each once, in the order of `findDnsWarnings`.
 */
export const serversToLookUp = (input: DnsWarningInput): string[] => {
  const servers = new Set<string>();
  for (const subject of subjectsOf(input)) {
    if (servers.size >= MAX_DNS_ROUTE_LOOKUPS) break;
    if (judge(input, subject).kind === 'lookup') servers.add(subject.server);
  }
  return [...servers];
};

/** The warnings for a set of facts: at most `MAX_DNS_WARNINGS`, each server and role once, in a stable order. */
export const findDnsWarnings = (input: DnsWarningLookupInput): DnsWarning[] => {
  const warnings: DnsWarning[] = [];
  for (const subject of subjectsOf(input)) {
    if (warnings.length >= MAX_DNS_WARNINGS) break;
    const verdict = judge(input, subject);
    let code: DnsWarningCode | null = null;
    if (verdict.kind === 'warn') {
      code = verdict.code;
    } else if (verdict.kind === 'lookup') {
      // `judge` asks for a lookup only while the other role has a device.
      if (input.routeOf(subject.server)?.device === input.interfaces[otherRole(subject.role)].device) {
        code = 'routed-via-other-interface';
      }
    }
    if (code === null) continue;
    warnings.push({
      server: subject.server,
      source: subject.source,
      role: subject.role,
      via: otherRole(subject.role),
      ...(subject.ruleId === undefined ? {} : { ruleId: subject.ruleId }),
      code,
    });
  }
  return warnings;
};

/** One comparable string for a list of warnings (log once on change). */
export const dnsWarningsSignature = (warnings: readonly DnsWarning[]): string =>
  warnings.map((w) => `${w.code}|${w.source}|${w.role}|${w.server}|${w.ruleId ?? ''}`).join(',');
