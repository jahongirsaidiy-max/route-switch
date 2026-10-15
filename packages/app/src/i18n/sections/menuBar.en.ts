// The menu bar window, in English (shape: `menuBar.uz.ts`).

import { plural } from '../plural';
import type { Shape } from '../types';
import type { menuBarUz } from './menuBar.uz';

const n = (count: number, one: string, other: string): string => `${String(count)} ${plural('en', count, { one, other })}`;

export const menuBarEn: Shape<typeof menuBarUz> = {
  on: 'On',
  off: 'Off',
  toggleLabel: 'Routing (all rules)',
  interfaces: 'Interfaces',
  activeRules: 'Active rules',
  ruleCount: (rules, routes) => `${n(rules, 'rule', 'rules')} · ${n(routes, 'route', 'routes')}`,
  rulesUnreadable: 'The rules could not be read.',
  reload: 'Read again',
  rulesLoading: 'Reading the rules…',
  noRules: 'No rules are enabled. Add some in “Manage rules”.',
  moreRules: (count) => n(count, 'more rule', 'more rules'),
  warning: (text) => `Warning: ${text}`,
  dnsServer: (server) => `DNS: ${server}`,
  resolved: (count, ago) => `${n(count, 'IP', 'IPs')} · ${ago}`,
  routingOff: 'Routing is off — no rules are applied',
  notAppliedYet: 'Not applied yet',
  lastApply: (time) => `Last applied: ${time}`,
  rulesFailing: (count) => `${n(count, 'rule', 'rules')} failing`,
  reapply: 'Apply again',
  manageRules: 'Manage rules',
  rulesWindowFailed: (reason) => `The rules window did not open. ${reason}`,
};
