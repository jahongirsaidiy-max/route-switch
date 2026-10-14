// The words for what the engine reports about rules and reconciles. The
// helper sends codes (and an English `reason` for the log); every screen
// shows these instead.

import type { ReconcileReason, RuleReasonCode, RuleState } from '@routeswitch/shared';

/** Why a rule is in its status, in the UI's words. Every code of the protocol has one. */
export const RULE_REASON_TEXT: Readonly<Record<RuleReasonCode, string>> = {
  // disabled
  'rule-disabled': "Qoida o'chirilgan",
  'globally-disabled': "Routing o'chirilgan",
  // pending
  'interface-down': 'Interfeys ulanmagan',
  'no-gateway': "Interfeysda gateway yo'q",
  resolving: 'Domen resolve qilinmoqda',
  // error
  'resolve-failed': "DNS so'rovi bajarilmadi",
  'no-addresses': "Domenning IPv4 manzili (A-yozuvi) yo'q",
  'forbidden-destination': "Taqiqlangan manzil — default route himoyasi uni yo'naltirmaydi",
  'connected-network': "Manzil interfeysning o'z tarmog'i yoki gateway'i bilan ustma-ust — route qo'shilmadi",
  'route-failed': "Route qo'shilmadi",
  'resolver-conflict': "/etc/resolver da shu domen uchun begona fayl bor",
  'resolver-failed': 'Resolver fayli yozilmadi',
  internal: 'Helper ichki xatosi',
  // active, with a warning: the rule works, but not for every resolved address
  'addresses-truncated': "Manzillar juda ko'p — faqat bir qismi yo'naltirildi",
  'overridden-by-rule': "Ba'zi manzillar boshqa qoida orqali boshqa interfeysga yo'naltirilgan",
  'dns-server-excluded': "Ba'zi manzillar DNS server — ular yo'naltirilmaydi",
};

/**
 * The rule works, with a warning: `active` and a reason code
 * (`addresses-truncated`, `overridden-by-rule`, `dns-server-excluded`).
 * Not an error — it is not counted as one.
 */
export function isActiveWarning(state: Pick<RuleState, 'status' | 'reasonCode'>): boolean {
  return state.status === 'active' && state.reasonCode !== null;
}

/** The translated reason of a rule state; null for a plain `active` rule. */
export function ruleReasonText(state: Pick<RuleState, 'reasonCode'>): string | null {
  return state.reasonCode === null ? null : RULE_REASON_TEXT[state.reasonCode];
}

/** What triggered the last reconcile, as the end of "Oxirgi qo'llash: 10:58 · …". */
export const RECONCILE_REASON_TEXT: Readonly<Record<ReconcileReason, string>> = {
  startup: 'helper ishga tushganda',
  'config-change': "qoidalar o'zgarganda",
  'enabled-change': "routing yoqilganda yoki o'chirilganda",
  manual: "qo'lda",
  'network-change': "tarmoq o'zgarganda",
  'dns-refresh': 'DNS yangilanganda',
  'drift-check': 'davriy tekshiruvda',
};
