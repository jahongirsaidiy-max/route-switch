// What the form sends, as plain functions over the preload API. Neither throws:
// `window.rs` settles every call with a result.

import type { Rule, TestResult } from '@routeswitch/shared';

import type { I18n } from '../../../../i18n';
import type { RsApi, RsErrorCode } from '../../rs';
import { errorText, UZ, type Feedback } from '../../text';

export type AddRuleApi = Pick<RsApi, 'saveRule' | 'test'>;

/** Why the helper (or the main process before it) refused the rule, in the user's words. */
export function saveErrorText(code: RsErrorCode, i18n: I18n = UZ): string {
  if (code === 'invalid-config' || code === 'invalid-input') return i18n.t.addRule.saveRefused;
  return i18n.t.addRule.saveFailed(errorText(code, i18n));
}

/** Adds the rule, or replaces the rule with its id (`saveRule`). Null on success. */
/** A language, or where to read it once the answer is in (the controller's current language). */
export type Words = I18n | (() => I18n);
const wordsOf = (words: Words): I18n => (typeof words === 'function' ? words() : words);

export async function saveRule(rs: AddRuleApi, rule: Rule, words: Words = UZ): Promise<Feedback | null> {
  const result = await rs.saveRule(rule);
  return result.ok ? null : { tone: 'danger', text: saveErrorText(result.code, wordsOf(words)) };
}

export type TestOutcome = { readonly ok: true; readonly result: TestResult } | { readonly ok: false; readonly text: string };

/** Which interface the system would use for the address now (`test` → `route -n get`). Read-only. */
export async function testRoute(rs: AddRuleApi, address: string, words: Words = UZ): Promise<TestOutcome> {
  const result = await rs.test(address);
  if (result.ok) return { ok: true, result: result.value };
  const i18n = wordsOf(words);
  if (result.code === 'operation-failed') return { ok: false, text: i18n.t.addRule.testNoRoute };
  return { ok: false, text: i18n.t.addRule.testFailed(errorText(result.code, i18n)) };
}
