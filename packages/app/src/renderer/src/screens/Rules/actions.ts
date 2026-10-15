// What the rules table does, as plain functions over the preload API. Each
// settles with null on success — the new config and state arrive through
// `onState` (and the config revision) — or with a message; none throws.

import type { I18n } from '../../../../i18n';
import type { RsApi, RsResult } from '../../rs';
import { errorText, UZ, type Feedback } from '../../text';

export type RulesApi = Pick<RsApi, 'toggleRule' | 'deleteRule'>;

/** A language, or where to read it once the answer is in (a controller's current language). */
export type Words = I18n | (() => I18n);
const wordsOf = (words: Words): I18n => (typeof words === 'function' ? words() : words);

const outcome = (result: RsResult<unknown>, what: (i18n: I18n) => string, words: Words): Feedback | null => {
  const i18n = wordsOf(words);
  if (result.ok) return null;
  const t = i18n.t.rules;
  const why = result.code === 'rule-not-found' ? t.ruleGone : errorText(result.code, i18n);
  return { tone: 'danger', text: t.failed(what(i18n), why) };
};

/** The rule's own switch (`toggleRule`). */
export async function setRuleEnabled(rs: RulesApi, id: string, enabled: boolean, words: Words = UZ): Promise<Feedback | null> {
  const result = await rs.toggleRule(id, enabled);
  return outcome(result, (i18n) => (enabled ? i18n.t.rules.enableFailed : i18n.t.rules.disableFailed), words);
}

/** Removes the rule (`deleteRule`); its routes go with it. Asked for only after the user confirmed. */
export async function removeRule(rs: RulesApi, id: string, words: Words = UZ): Promise<Feedback | null> {
  const result = await rs.deleteRule(id);
  return outcome(result, (i18n) => i18n.t.rules.deleteFailed, words);
}
