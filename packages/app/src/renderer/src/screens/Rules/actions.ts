// What the rules table does, as plain functions over the preload API. Each
// settles with null on success — the new config and state arrive through
// `onState` (and the config revision) — or with a message; none throws.

import type { RsApi, RsResult } from '../../rs';
import { errorText, type Feedback } from '../../text';

export type RulesApi = Pick<RsApi, 'toggleRule' | 'deleteRule'>;

const outcome = (result: RsResult<unknown>, what: string): Feedback | null => {
  if (result.ok) return null;
  if (result.code === 'rule-not-found') return { tone: 'danger', text: `${what}: qoida endi yo'q (boshqa oynada o'chirilgan bo'lishi mumkin).` };
  return { tone: 'danger', text: `${what}: ${errorText(result.code)}` };
};

/** The rule's own switch (`toggleRule`). */
export async function setRuleEnabled(rs: RulesApi, id: string, enabled: boolean): Promise<Feedback | null> {
  return outcome(await rs.toggleRule(id, enabled), enabled ? 'Qoida yoqilmadi' : "Qoida o'chirilmadi");
}

/** Removes the rule (`deleteRule`); its routes go with it. Asked for only after the user confirmed. */
export async function removeRule(rs: RulesApi, id: string): Promise<Feedback | null> {
  return outcome(await rs.deleteRule(id), "Qoida o'chirib tashlanmadi");
}
