// "DNS server boshqa interfeysda" (TASK-DELTA-21), in English. Typed by the
// Uzbek section: a key missing or added fails `tsc`.

import type { Shape } from '../types';
import type { dnsWarningsUz } from './dnsWarnings.uz';

export const dnsWarningsEn: Shape<typeof dnsWarningsUz> = {
  titleInterface: (role, server, other) => `The ${role} DNS server (${server}) is reached through ${other}`,
  titleRule: (target, server, other) => `The DNS server of the «${target}» rule (${server}) is reached through ${other}`,
  titleRuleUnknown: (server, other) => `A rule’s DNS server (${server}) is reached through ${other}`,
  textSubnet: (server, role, other) =>
    `${server} is on the ${other} network: queries to it leave through ${other} instead of ${role} and may get no answer (internal names do not resolve). Fix: an IP rule for ${server} through ${role}.`,
  textRouted: (server, role, other) =>
    `The routing table sends ${server} through ${other}, not ${role} — internal names may not resolve. Fix: an IP rule for ${server} through ${role}.`,
  addRule: (server, role) => `Add rule ${server} → ${role}`,
  ruleNote: 'DNS server',
  blockedGateway: (server, role) => `No rule is offered: ${server} is the ${role} gateway, a route to it cannot be added.`,
  blockedOwnAddress: (server, role) => `No rule is offered: ${server} is the ${role} interface’s own address.`,
  blockedNoGateway: (role) => `No rule is offered: ${role} is not connected or has no gateway.`,
  blockedInvalid: (reason) => `No rule is offered: ${reason}`,
  blockedExists: (target, role) => `A ${target} → ${role} rule already exists — check in the rules list that it is on, and its status.`,
  blockedUnavailable: (reason) => `A rule cannot be added: ${reason}`,
};
