// English words of the rules window. Typed by the Uzbek section: a key
// missing or added fails `tsc`.

import { plural } from '../plural';
import type { Shape } from '../types';
import type { rulesUz } from './rules.uz';

const rules = (count: number): string => `${String(count)} ${plural('en', count, { one: 'rule', other: 'rules' })}`;

export const rulesEn: Shape<typeof rulesUz> = {
  sections: { rules: 'Rules', log: 'Log', diagnostics: 'Diagnostics', settings: 'Settings', help: 'Help' },
  sectionsNav: 'Sections',
  helperDaemon: (version) => `root daemon · v${version}`,

  title: 'Rules',
  subtitle: 'Choose which interface each address goes through. All other traffic uses the default route.',
  addRule: 'Add rule',
  addRuleOff: (reason) => `Add rule — ${reason}`,
  configUnreadableReason: "The helper's config is damaged — import a config or start with an empty one first",
  addRuleUnavailable: 'The add-rule form is not ready yet',

  search: 'Search',
  searchPlaceholder: 'Search by IP, subnet, domain or note',
  filterLabel: 'Show',
  filters: { all: 'All', problems: 'With problems', off: 'Turned off' },
  import: 'Import',
  importLabel: 'Import config (from a JSON file)',
  export: 'Export',
  exportLabel: 'Export config (to a JSON file)',
  exportOff: (reason) => `Export config — ${reason}`,

  columns: { status: 'Status', target: 'Address', kind: 'Type', iface: 'Interface', note: 'Note' },
  kinds: { ip: 'IP', subnet: 'Subnet', domain: 'Domain', domainDns: 'Domain + DNS', wildcard: 'Wildcard', wildcardDns: 'Wildcard + DNS' },
  detailDns: (dns) => `DNS: ${dns}`,
  detailEvery: (minutes) => `every ${String(minutes)} min`,
  detailCount: (count, every) => `${String(count)} ${plural('en', count, { one: 'IP', other: 'IPs' })} · ${every}`,
  detailLearned: (count) => `${String(count)} learned ${plural('en', count, { one: 'IP', other: 'IPs' })}`,
  warningMark: 'Warning',
  toggleLabel: (target) => `Rule ${target}`,
  editLabel: (target) => `Edit rule ${target}`,
  editOff: (reason) => `Edit — ${reason}`,
  deleteLabel: (target) => `Delete rule ${target}`,

  emptyTitle: 'No rules yet',
  emptyText: 'Once you add a rule, its address shows up here and is routed through the chosen interface.',
  noMatchTitle: 'Nothing found',
  noMatchText: (query, filter) =>
    `No matching rules${query === null ? '' : ` for “${query}”`}${filter === null ? '' : ` in “${filter}”`}.`,

  readFailedTitle: 'Could not read the rules',
  reload: 'Read again',
  reading: 'Reading the rules…',

  overlapsLabel: 'Overlapping addresses',
  overlapsTitle: 'Overlapping addresses — the more specific one (longer prefix) wins:',
  overlapInside: (narrower, wider) => `${narrower} → inside ${wider}`,
  overlapOtherIface: ' · different interface',
  overlapMore: (count) => `${String(count)} more`,

  activeRules: (count) =>
    `${rules(count)} active · reapplied automatically when the network changes`,
  routingOff: 'Routing is turned on with the main switch in the menu bar window',

  replace: 'Replace',
  cancel: 'Cancel',
  remove: 'Delete',
  deleteQuestion: (target) => `Delete the rule “${target}”? Its routes will be removed.`,

  enableFailed: 'Rule not turned on',
  disableFailed: 'Rule not turned off',
  deleteFailed: 'Rule not deleted',
  ruleGone: 'the rule no longer exists (it may have been deleted in another window).',
  failed: (what, why) => `${what}: ${why}`,

  importFailed: (why) => `Import failed: ${why}`,
  imported: (count) => `Config imported: ${rules(count)}.`,
  replaceFailed: (why) => `Config not replaced: ${why}`,
  exportFailed: (why) => `Export failed: ${why}`,
  exported: (count) => `Config saved to file: ${rules(count)}.`,
  importReplaces: (count, current) =>
    `Import replaces the current config completely: ${rules(count)}${current === null ? '' : ` (now ${String(current)})`}.`,
  importCounts: (added, removed, changed, unchanged) =>
    `Added: ${String(added)}, removed: ${String(removed)}, changed: ${String(changed)}, unchanged: ${String(unchanged)}.`,
  importRoutingOff: 'Routing will be turned off.',
  importRoutingOn: 'Routing will be turned on.',
  importOverrides: 'Interface overrides are replaced too.',

  importConfig: 'Import config',
  startEmpty: 'Start with an empty config',
  resetQuestion: (path) =>
    `Replace the stored (unreadable) config with an empty one? Its rules will not come back — to recover them by hand, copy ${path} first.`,
  resetDone: 'Empty config saved — the helper is running again. You can now add rules or import a config.',
};
