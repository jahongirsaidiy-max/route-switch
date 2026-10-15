// Warnings about the network that are not a rule's own error: rules waiting
// for an interface that is down, both interfaces on one subnet, and the
// addresses a domain rule that failed to resolve still routes. Plain
// functions of the engine state (and the config, for each rule's interface);
// the menu bar window and the rules window show the same words.

import type { Config, DnsWarning, EngineState, IfaceRole, RuleState } from '@routeswitch/shared';

import type { I18n } from '../../../i18n';

/** Product names: the same in every language. */
const ROLE_NAMES: Readonly<Record<IfaceRole, string>> = { ethernet: 'Ethernet', wifi: 'Wi‑Fi' };

/** A warning shown above a screen's rules. `id` is stable for one kind of warning (a React key). */
export interface NetworkWarning {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** Pending reasons that mean "the interface is not usable now" (not "the domain is resolving"). */
const WAITING_FOR_INTERFACE = new Set<RuleState['reasonCode']>(['interface-down', 'no-gateway']);

/**
 * Both roles up behind one gateway: they are on one subnet, so a route
 * "through the gateway" names an address both interfaces reach, and which one
 * the traffic leaves through is the system's choice (RouteSwitch.md §Test
 * rejasi). The state carries no netmask, so the shared gateway is the sign:
 * two adapters cannot share a gateway without sharing its subnet. Two
 * interfaces on one subnet with different gateways are not detected.
 */
export function sameSubnetGateway(interfaces: EngineState['interfaces']): string | null {
  const { ethernet, wifi } = interfaces;
  if (!ethernet.up || !wifi.up || ethernet.gateway === null) return null;
  return ethernet.gateway === wifi.gateway ? ethernet.gateway : null;
}

/**
 * Per role, the enabled rules waiting because the role's interface is down
 * or has no gateway; then the one-subnet warning. Nothing while routing is
 * off (no rule is waiting then). Without the config the rules cannot be told
 * apart by interface, so the count is left out but the interface still is.
 */
export function networkWarnings(state: EngineState, config: Config | null, i18n: I18n): NetworkWarning[] {
  const words = i18n.t.network;
  const warnings: NetworkWarning[] = [];
  if (state.enabled) {
    const waiting = state.rules.filter((rule) => rule.status === 'pending' && WAITING_FOR_INTERFACE.has(rule.reasonCode));
    const ifaceOf = new Map(config?.rules.map((rule) => [rule.id, rule.iface]) ?? []);
    for (const role of ['ethernet', 'wifi'] as const) {
      const iface = state.interfaces[role];
      const name = ROLE_NAMES[role];
      const known = config !== null;
      const mine = waiting.filter((rule) => ifaceOf.get(rule.ruleId) === role).length;
      if (known ? mine === 0 : waiting.length === 0 || (iface.up && iface.gateway !== null)) continue;
      const problem = iface.device === null ? words.adapterMissing(name) : iface.up ? words.noGateway(name) : words.notConnected(name);
      warnings.push({
        id: `waiting-${role}`,
        title: problem,
        text: known ? words.rulesWaiting(mine) : words.rulesWaitingUncounted,
      });
    }
  }
  const gateway = sameSubnetGateway(state.interfaces);
  if (gateway !== null) {
    warnings.push({ id: 'same-subnet', title: words.sameSubnetTitle, text: words.sameSubnetText(gateway) });
  }
  return warnings;
}

/** The role a DNS warning's server is wrongly reached through: there are two roles, so it is the other one. */
const OTHER_ROLE: Readonly<Record<IfaceRole, IfaceRole>> = { ethernet: 'wifi', wifi: 'ethernet' };

/** A DNS server reached through the wrong interface (`EngineState.dnsWarnings`), as a banner. */
export interface DnsWarningBanner extends NetworkWarning {
  readonly server: string;
  /** The interface the server should be reached through: the rule the offer adds goes there. */
  readonly role: IfaceRole;
}

/**
 * The helper's DNS warnings, one banner per server (the first warning of a
 * server wins: the helper lists an interface's own servers before the rules'),
 * in the helper's order. Shown whatever routing's switch says: the warning
 * is about the interfaces, not about a rule. The title names the interface
 * (or the rule, by its domain from the config) the server belongs to; the
 * text says why, by the helper's code.
 */
export function dnsWarningBanners(state: EngineState, config: Config | null, i18n: I18n): DnsWarningBanner[] {
  const words = i18n.t.dnsWarnings;
  const banners: DnsWarningBanner[] = [];
  const seen = new Set<string>();
  const targetOf = new Map(config?.rules.map((rule) => [rule.id, rule.target]) ?? []);
  for (const warning of state.dnsWarnings ?? []) {
    if (seen.has(warning.server)) continue;
    seen.add(warning.server);
    banners.push(dnsWarningBanner(warning, warning.ruleId === undefined ? null : (targetOf.get(warning.ruleId) ?? null), words));
  }
  return banners;
}

function dnsWarningBanner(warning: DnsWarning, ruleTarget: string | null, words: I18n['t']['dnsWarnings']): DnsWarningBanner {
  const { server, role } = warning;
  const name = ROLE_NAMES[role];
  // `via` is null when the helper did not learn it; with two roles it can only be the other one.
  const other = ROLE_NAMES[warning.via ?? OTHER_ROLE[role]];
  const title =
    warning.source === 'interface'
      ? words.titleInterface(name, server, other)
      : ruleTarget === null
        ? words.titleRuleUnknown(server, other)
        : words.titleRule(ruleTarget, server, other);
  const text = warning.code === 'other-interface-subnet' ? words.textSubnet(server, name, other) : words.textRouted(server, name, other);
  return { id: `dns-${server}`, title, text, server, role };
}

/** How many of the last known addresses are named; the rest are counted. */
export const LAST_KNOWN_SHOWN = 3;

/**
 * What a domain rule in `error` still routes: the addresses of its last
 * successful answer, kept in the routing table (`appliedDestinations`, less
 * the rule's own DNS server). "Oxirgi ma'lum IP'lar: 10.0.0.5, 10.0.0.6 +2 ·
 * 12 daq oldin"; "Oxirgi ma'lum IP yo'q" when nothing is routed. Null for a
 * rule that is not in `error` or not a domain rule.
 */
export function lastKnownText(
  rule: { readonly kind: string; readonly dns?: string | undefined },
  state: RuleState,
  now: number,
  shown = LAST_KNOWN_SHOWN,
  i18n: I18n,
): string | null {
  if (state.status !== 'error' || rule.kind !== 'domain') return null;
  const addresses = state.appliedDestinations.filter((destination) => destination !== rule.dns);
  if (addresses.length === 0) return i18n.t.network.lastKnownNone;
  const named = addresses.slice(0, shown).join(', ');
  const more = addresses.length > shown ? ` +${String(addresses.length - shown)}` : '';
  const when = state.lastResolvedAt === null ? '' : ` · ${i18n.formatAgo(state.lastResolvedAt, now)}`;
  return i18n.t.network.lastKnown(`${named}${more}`, when);
}

/**
 * The menu bar row's short form, the first address and how many more:
 * "10.0.0.5 +2" (the row is narrow; its status tag carries `lastKnownText`).
 * Null like `lastKnownText`, and when nothing is routed.
 */
export function lastKnownShort(rule: { readonly kind: string; readonly dns?: string | undefined }, state: RuleState): string | null {
  if (state.status !== 'error' || rule.kind !== 'domain') return null;
  const addresses = state.appliedDestinations.filter((destination) => destination !== rule.dns);
  const first = addresses[0];
  if (first === undefined) return null;
  return `${first}${addresses.length > 1 ? ` +${String(addresses.length - 1)}` : ''}`;
}
