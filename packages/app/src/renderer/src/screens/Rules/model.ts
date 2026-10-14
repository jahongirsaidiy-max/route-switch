// What the rules table shows, as plain functions of the stored config and the
// engine state (joined by rule id). No state of its own.

import { findOverlaps, type Config, type EngineState, type IfaceRole, type RuleState } from '@routeswitch/shared';

import { ROLE_TAGS } from '../../components';
import { isActiveWarning, ruleReasonText } from '../../text';

type ConfigRule = Config['rules'][number];

/** What the state says about a rule, besides its switch. */
export type RowStatus =
  /** `active` without a warning: the design shows nothing. */
  | { readonly kind: 'ok' }
  /** `active` with a warning code: "Faol", a warning mark and the reason — not an error. */
  | { readonly kind: 'warning'; readonly text: string }
  /** `pending` / `error`: a status tag and the reason. */
  | { readonly kind: 'pending' | 'error'; readonly text: string }
  /** Switched off, or no state for it yet (the config is a revision ahead): nothing to say. */
  | { readonly kind: 'none' };

export interface RuleRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly target: string;
  /** "IP", "Subnet", "Domen", "Domen + DNS". */
  readonly kindLabel: string;
  readonly iface: IfaceRole;
  /** The role's device now ("en5"), or null when the role has none. */
  readonly device: string | null;
  /** The note, or what a domain rule is doing ("DNS: …", "3 IP · har 10 daq"). */
  readonly detail: string;
  readonly status: RowStatus;
}

export function kindLabel(rule: Pick<ConfigRule, 'kind' | 'dns'>): string {
  if (rule.kind === 'ip') return 'IP';
  if (rule.kind === 'subnet') return 'Subnet';
  return rule.dns === undefined ? 'Domen' : 'Domen + DNS';
}

/** The note; without one, a domain rule's DNS server or its address count and refresh interval. */
export function rowDetail(rule: ConfigRule, state: RuleState | null): string {
  const note = rule.note?.trim() ?? '';
  if (note !== '') return note;
  if (rule.kind !== 'domain') return '';
  if (rule.dns !== undefined) return `DNS: ${rule.dns}`;
  const every = `har ${String(Math.round(rule.refreshSec / 60))} daq`;
  const count = state?.appliedDestinations.length ?? 0;
  return count === 0 ? every : `${String(count)} IP · ${every}`;
}

export function rowStatus(state: RuleState | null): RowStatus {
  if (state === null || state.status === 'disabled') return { kind: 'none' };
  const text = ruleReasonText(state);
  if (state.status === 'active') return isActiveWarning(state) && text !== null ? { kind: 'warning', text } : { kind: 'ok' };
  return { kind: state.status, text: text ?? '' };
}

/** Every rule of the config, in config order, with its state. */
export function ruleRows(config: Config, state: EngineState): RuleRow[] {
  const states = new Map(state.rules.map((rule) => [rule.ruleId, rule]));
  return config.rules.map((rule) => {
    const ruleState = states.get(rule.id) ?? null;
    return {
      id: rule.id,
      enabled: rule.enabled,
      target: rule.target,
      kindLabel: kindLabel(rule),
      iface: rule.iface,
      device: state.interfaces[rule.iface].device,
      detail: rowDetail(rule, ruleState),
      status: rowStatus(ruleState),
    };
  });
}

/** The "Hammasi" filter of the toolbar. */
export type RowFilter = 'all' | 'problems' | 'off';

export const ROW_FILTER_LABELS: Readonly<Record<RowFilter, string>> = {
  all: 'Hammasi',
  problems: 'Muammoli',
  off: "O'chirilgan",
};

const matchesFilter = (row: RuleRow, filter: RowFilter): boolean => {
  if (filter === 'off') return !row.enabled;
  if (filter === 'problems') return row.enabled && row.status.kind !== 'ok' && row.status.kind !== 'none';
  return true;
};

/**
 * The rows whose address or note contains the query (case-insensitive,
 * surrounding spaces ignored) and that the filter lets through.
 */
export function visibleRows(rows: readonly RuleRow[], notes: ReadonlyMap<string, string>, query: string, filter: RowFilter): RuleRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesFilter(row, filter)) return false;
    if (needle === '') return true;
    return row.target.toLowerCase().includes(needle) || (notes.get(row.id) ?? '').toLowerCase().includes(needle);
  });
}

/** Each rule's own note (search looks at the note, not at the derived detail). */
export function notesById(config: Config): Map<string, string> {
  return new Map(config.rules.map((rule) => [rule.id, rule.note ?? '']));
}

export interface OverlapWarning {
  readonly wider: string;
  readonly narrower: string;
  /** The two rules send traffic through different interfaces. */
  readonly crossInterface: boolean;
}

const tagged = (rule: Pick<ConfigRule, 'target' | 'iface'>) => `${rule.target} (${ROLE_TAGS[rule.iface]})`;

/**
 * Enabled `ip` / `subnet` rules whose destinations overlap (`findOverlaps`,
 * shared). Legal — the kernel prefers the longer prefix — but worth a warning.
 */
export function overlapWarnings(config: Config): OverlapWarning[] {
  return findOverlaps(config.rules.filter((rule) => rule.enabled)).map(({ wider, narrower }) => ({
    wider: tagged(wider),
    narrower: tagged(narrower),
    crossInterface: wider.iface !== narrower.iface,
  }));
}

/** Rules whose state is `active`, warnings included. */
export function activeCount(state: EngineState): number {
  return state.rules.filter((rule) => rule.status === 'active').length;
}
