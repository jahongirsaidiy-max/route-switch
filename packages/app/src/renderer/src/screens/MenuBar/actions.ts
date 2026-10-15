// What the menu bar window does, as plain functions over the preload API.
// Each settles with null on success — the new state arrives through
// `onState`, nothing is shown from the answer — or with a message for the
// window; none throws.

import type { RsApi, RsResult } from '../../rs';
import { errorText, type Feedback } from '../../text';

export type MenuBarApi = Pick<RsApi, 'setEnabled' | 'apply' | 'openRulesWindow'>;

const outcome = (result: RsResult<unknown>): Feedback | null =>
  result.ok ? null : { tone: 'danger', text: errorText(result.code) };

/** The global switch: off removes every route and resolver file the helper applied. */
export async function setRouting(rs: MenuBarApi, on: boolean): Promise<Feedback | null> {
  return outcome(await rs.setEnabled(on));
}

/** "Qayta qo'llash": every rule again, with fresh interface data. */
export async function reapply(rs: MenuBarApi): Promise<Feedback | null> {
  return outcome(await rs.apply());
}

/** "Qoidalarni boshqarish": opens the rules window (main process; no helper needed). */
export async function openRules(rs: MenuBarApi): Promise<Feedback | null> {
  const result = await rs.openRulesWindow();
  return result.ok ? null : { tone: 'danger', text: `Qoidalar oynasi ochilmadi. ${errorText(result.code)}` };
}
