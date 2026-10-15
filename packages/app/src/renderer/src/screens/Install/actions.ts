// Installing the helper from the app (TASK-214), as plain functions over the
// preload API: the page only says "install" — the main process checks the
// app's own helper package, the system asks for the administrator password,
// and the outcome arrives as a new connection in `onState`. Each call settles
// with a message for the screen and never throws.

import type { RsApi, RsResult } from '../../rs';
import { errorText, INSTALL_TEXT, type Feedback } from '../../text';

export type InstallApi = Pick<RsApi, 'installHelper'>;
export type RemoveApi = Pick<RsApi, 'removeHelper' | 'uninstallHelper'>;

/** The words for a failed install or removal; a failed script adds its own error line. */
export function setupFailureText(result: Extract<RsResult<unknown>, { ok: false }>): string {
  const words = errorText(result.code);
  return result.code === 'install-failed' && result.detail !== undefined && result.detail !== ''
    ? `${words} (${result.detail})`
    : words;
}

/** "Helper'ni o'rnatish" / "Helper'ni qayta o'rnatish": success says the app reconnects; a failure says why and that it can be tried again. */
export async function installHelper(rs: InstallApi): Promise<Feedback> {
  const result = await rs.installHelper();
  return result.ok ? { tone: 'success', text: INSTALL_TEXT.installed } : { tone: 'danger', text: setupFailureText(result) };
}

/**
 * "Helper'ni o'chirish" of the settings screen: the full removal
 * (`uninstall.sh` as root) when the app holds it; otherwise — the package has
 * no `uninstall.sh` or the app is not packaged — the helper's own `uninstall`
 * over the socket (routes and resolver files go, the files stay).
 */
export async function removeHelper(rs: RemoveApi): Promise<Feedback> {
  const full = await rs.removeHelper();
  if (full.ok) return { tone: 'success', text: INSTALL_TEXT.removed };
  if (full.code !== 'install-unavailable') return { tone: 'danger', text: setupFailureText(full) };
  const result = await rs.uninstallHelper();
  if (!result.ok) return { tone: 'danger', text: errorText(result.code) };
  return {
    tone: 'success',
    text: "Helper o'chirildi: uning route'lari va resolver fayllari olib tashlandi. Routing to'xtadi.",
  };
}
