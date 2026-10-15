// What the menu bar window does, as plain functions over the preload API.
// Each settles with null on success — the new state arrives through
// `onState`, nothing is shown from the answer — or with a message for the
// window; none throws.

import type { I18n } from '../../../../i18n';
import type { RsApi, RsResult } from '../../rs';
import { errorText, UZ, type Feedback } from '../../text';

export type MenuBarApi = Pick<RsApi, 'setEnabled' | 'apply' | 'openRulesWindow'>;

const outcome = (result: RsResult<unknown>, i18n: I18n): Feedback | null =>
  result.ok ? null : { tone: 'danger', text: errorText(result.code, i18n) };

/** The global switch: off removes every route and resolver file the helper applied. */
export async function setRouting(rs: MenuBarApi, on: boolean, i18n: I18n = UZ): Promise<Feedback | null> {
  return outcome(await rs.setEnabled(on), i18n);
}

/** "Qayta qo'llash": every rule again, with fresh interface data. */
export async function reapply(rs: MenuBarApi, i18n: I18n = UZ): Promise<Feedback | null> {
  return outcome(await rs.apply(), i18n);
}

/** "Qoidalarni boshqarish": opens the rules window (main process; no helper needed). */
export async function openRules(rs: MenuBarApi, i18n: I18n = UZ): Promise<Feedback | null> {
  const result = await rs.openRulesWindow();
  return result.ok ? null : { tone: 'danger', text: i18n.t.menuBar.rulesWindowFailed(errorText(result.code, i18n)) };
}
