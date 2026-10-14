// What the form sends, as plain functions over the preload API. Neither throws:
// `window.rs` settles every call with a result.

import type { Rule, TestResult } from '@routeswitch/shared';

import type { RsApi, RsErrorCode } from '../../rs';
import { errorText, type Feedback } from '../../text';

export type AddRuleApi = Pick<RsApi, 'saveRule' | 'test'>;

/** Why the helper (or the main process before it) refused the rule, in the user's words. */
export function saveErrorText(code: RsErrorCode): string {
  if (code === 'invalid-config' || code === 'invalid-input') {
    return "Qoida saqlanmadi: helper uni qabul qilmadi (manzil yoki qoidalar soni cheklovdan o'tmadi).";
  }
  return `Qoida saqlanmadi: ${errorText(code)}`;
}

/** Adds the rule, or replaces the rule with its id (`saveRule`). Null on success. */
export async function saveRule(rs: AddRuleApi, rule: Rule): Promise<Feedback | null> {
  const result = await rs.saveRule(rule);
  return result.ok ? null : { tone: 'danger', text: saveErrorText(result.code) };
}

export type TestOutcome = { readonly ok: true; readonly result: TestResult } | { readonly ok: false; readonly text: string };

/** Which interface the system would use for the address now (`test` → `route -n get`). Read-only. */
export async function testRoute(rs: AddRuleApi, address: string): Promise<TestOutcome> {
  const result = await rs.test(address);
  if (result.ok) return { ok: true, result: result.value };
  if (result.code === 'operation-failed') return { ok: false, text: 'Bu manzil uchun route topilmadi.' };
  return { ok: false, text: `Sinab bo'lmadi: ${errorText(result.code)}` };
}
