// What the menu bar window shows, as plain functions of the engine state and
// the stored config. No state of its own: every value is derived from what
// `onState` and `getConfig` delivered.

import type { Config, EngineState, IfaceRole, RuleState, RuleStatus } from '@routeswitch/shared';

import type { RsServiceOrder } from '../../rs';
import { isActiveWarning, RECONCILE_REASON_TEXT, ruleReasonText } from './ruleText';

/** How many rules the window lists; the rest are counted (RouteSwitch.md §Renderer ekranlari). */
export const MENU_RULE_LIMIT = 4;

/** What a listed rule says about its state, besides its target. */
export type RuleNotice =
  /** `pending` or `error`: a status tag with the translated reason. */
  | { readonly kind: 'status'; readonly status: Extract<RuleStatus, 'pending' | 'error'>; readonly text: string }
  /** `active` with a warning code: works, with a warning mark (not an error). */
  | { readonly kind: 'warning'; readonly text: string };

export interface MenuRule {
  readonly id: string;
  readonly iface: IfaceRole;
  readonly target: string;
  /** The right-hand text of the row: the note, or what a domain rule resolved to. */
  readonly detail: string;
  readonly notice: RuleNotice | null;
}

export interface MenuRules {
  /** The first `MENU_RULE_LIMIT` enabled rules, in config order. */
  readonly shown: readonly MenuRule[];
  /** Every enabled rule of the config. */
  readonly total: number;
  /** `total` minus the ones shown. */
  readonly hidden: number;
  /** Routes in the routing table on behalf of all rules. */
  readonly routes: number;
}

const MINUTE = 60_000;

/** "hozirgina", "2 daq oldin", "3 soat oldin", "4 kun oldin". A time in the future reads as "hozirgina". */
export function formatAgo(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return 'hozirgina';
  const minutes = Math.floor(elapsed / MINUTE);
  if (minutes < 60) return `${String(minutes)} daq oldin`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} soat oldin`;
  return `${String(Math.floor(hours / 24))} kun oldin`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local `HH:MM`, with `DD.MM` in front when it is not today. */
export function formatClock(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const today = new Date(now);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock : `${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${clock}`;
}

type ConfigRule = Config['rules'][number];

/** The row text: the note when there is one; for a domain, its DNS server or how many addresses it resolved to. */
export function ruleDetail(rule: ConfigRule, state: RuleState | null, now: number): string {
  const note = rule.note?.trim() ?? '';
  if (note !== '') return note;
  if (rule.kind !== 'domain') return '';
  if (rule.dns !== undefined) return `DNS: ${rule.dns}`;
  if (state === null || state.lastResolvedAt === null) return '';
  return `${String(state.appliedDestinations.length)} IP · ${formatAgo(state.lastResolvedAt, now)}`;
}

export function ruleNotice(state: RuleState | null): RuleNotice | null {
  if (state === null) return null;
  const text = ruleReasonText(state);
  if (text === null) return null;
  if (state.status === 'pending' || state.status === 'error') return { kind: 'status', status: state.status, text };
  if (isActiveWarning(state)) return { kind: 'warning', text };
  // `disabled`: the whole list is off (the global toggle says so), or the config is newer than the state.
  return null;
}

/** The enabled rules of the config joined with their state by id; the first `limit` are listed. */
export function menuRules(config: Config, state: EngineState, now: number, limit = MENU_RULE_LIMIT): MenuRules {
  const states = new Map(state.rules.map((rule) => [rule.ruleId, rule]));
  const enabled = config.rules.filter((rule) => rule.enabled);
  const shown = enabled.slice(0, limit).map((rule): MenuRule => {
    // The config may be a revision ahead of the state for a moment: such a rule has no state yet.
    const ruleState = states.get(rule.id) ?? null;
    return {
      id: rule.id,
      iface: rule.iface,
      target: rule.target,
      detail: ruleDetail(rule, ruleState, now),
      notice: ruleNotice(ruleState),
    };
  });
  const routes = state.rules.reduce((sum, rule) => sum + rule.appliedDestinations.length, 0);
  return { shown, total: enabled.length, hidden: enabled.length - shown.length, routes };
}

/**
 * Rules in `error`. An `active` rule with a warning code works and is not
 * counted; neither are `pending` ones (waiting is not failing).
 */
export function errorCount(state: EngineState): number {
  return state.rules.filter((rule) => rule.status === 'error').length;
}

export interface StatusLine {
  readonly tone: 'success' | 'danger' | 'neutral';
  /** "Oxirgi qo'llash: 10:58 · tarmoq o'zgarganda". */
  readonly text: string;
  /** "2 ta qoidada xato"; null when there is none. */
  readonly errors: string | null;
}

/** The status row: last apply and its trigger, and how many rules are in error. */
export function statusLine(state: EngineState, now: number): StatusLine {
  if (!state.enabled) {
    return { tone: 'neutral', text: "Routing o'chirilgan — qoidalar qo'llanmaydi", errors: null };
  }
  const failing = errorCount(state);
  const errors = failing === 0 ? null : `${String(failing)} ta qoidada xato`;
  const tone = failing === 0 ? 'success' : 'danger';
  if (state.lastApplyAt === null) return { tone, text: "Hali qo'llanmagan", errors };
  const trigger = state.lastReconcileReason === null ? '' : ` · ${RECONCILE_REASON_TEXT[state.lastReconcileReason]}`;
  return { tone, text: `Oxirgi qo'llash: ${formatClock(state.lastApplyAt, now)}${trigger}`, errors };
}

/** The role whose interface can carry traffic: up, with an address and a gateway. */
const carries = (iface: EngineState['interfaces'][IfaceRole]): boolean =>
  iface.device !== null && iface.up && iface.ip !== null && iface.gateway !== null;

/**
 * The role that carries the default route: macOS sends unmatched traffic
 * through the first enabled service of the service order that is connected.
 * Only the two roles are considered (another adapter's routing is not known
 * here); null when neither role is connected or the order is unknown.
 */
export function defaultRole(order: RsServiceOrder | null, interfaces: EngineState['interfaces']): IfaceRole | null {
  if (order === null) return null;
  for (const service of order.services) {
    if (!service.enabled || service.device === null) continue;
    for (const role of ['ethernet', 'wifi'] as const) {
      const iface = interfaces[role];
      if (iface.device === service.device && carries(iface)) return role;
    }
  }
  return null;
}

/** The part of the interfaces that decides `defaultRole`: the order is read again when it changes. */
export function interfacesKey(interfaces: EngineState['interfaces']): string {
  return (['ethernet', 'wifi'] as const)
    .map((role) => {
      const iface = interfaces[role];
      return [role, iface.device ?? '-', iface.up ? 'up' : 'down', iface.ip ?? '-', iface.gateway ?? '-'].join(':');
    })
    .join('|');
}
