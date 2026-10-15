// The words for what the engine reports about rules and reconciles. The
// helper sends codes (and an English `reason` for the log); every screen
// shows these instead. The tables live in the dictionary (`t.ruleReason`,
// `t.reconcileReason`); the constants here are their Uzbek copies.

import type { ReconcileReason, RuleReasonCode, RuleState } from '@routeswitch/shared';

import type { I18n } from '../../../i18n';
import { UZ } from './errors';

/** Why a rule is in its status, in Uzbek. Every code of the protocol has one (`uz.ts` checks it). */
export const RULE_REASON_TEXT: Readonly<Record<RuleReasonCode, string>> = UZ.t.ruleReason;

/**
 * The rule works, with a warning: `active` and a reason code
 * (`addresses-truncated`, `overridden-by-rule`, `dns-server-excluded`).
 * Not an error — it is not counted as one.
 */
export function isActiveWarning(state: Pick<RuleState, 'status' | 'reasonCode'>): boolean {
  return state.status === 'active' && state.reasonCode !== null;
}

/** The translated reason of a rule state; null for a plain `active` rule. */
export function ruleReasonText(state: Pick<RuleState, 'reasonCode'>, i18n: I18n = UZ): string | null {
  return state.reasonCode === null ? null : i18n.t.ruleReason[state.reasonCode];
}

/** What triggered the last reconcile, as the end of "Oxirgi qo'llash: 10:58 · …" (Uzbek; `t.reconcileReason` per language). */
export const RECONCILE_REASON_TEXT: Readonly<Record<ReconcileReason, string>> = UZ.t.reconcileReason;
