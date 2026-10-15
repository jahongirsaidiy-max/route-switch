// What the settings screen does, as plain functions over the preload API:
// each call settles with a message for the screen and never throws. The
// message is in the language of the last argument (Uzbek without one).

import type { AdapterInfo, Config } from '@routeswitch/shared';

import type { RsApi, RsIfaceOverrides, RsResult, RsServiceOrder } from '../../rs';
import type { I18n } from '../../../../i18n';
import { errorText, UZ, type Feedback } from '../../text';
import { removeHelper } from '../Install';

export type { Feedback };

export type SettingsApi = Pick<
  RsApi,
  'getSettings' | 'setOpenAtLogin' | 'getConfig' | 'setIfaceOverrides' | 'getServiceOrder' | 'copyServiceOrderCommand' | 'uninstallHelper' | 'removeHelper'
>;

const failed = (result: Extract<RsResult<unknown>, { ok: false }>, i18n: I18n): Feedback => ({
  tone: 'danger',
  text: errorText(result.code, i18n),
});

/**
 * Adapters that may carry the Ethernet role: every `en*` adapter except the
 * Wi‑Fi role's device, in the engine's order.
 */
export function ethernetChoices(adapters: readonly AdapterInfo[], wifiDevice: string | null): AdapterInfo[] {
  return adapters.filter((adapter) => adapter.device !== wifiDevice && adapter.port !== 'Wi-Fi');
}

/** The overrides with the Ethernet role bound to `device`, or detected automatically when `device` is null. */
export function withEthernetOverride(current: Config['ifaceOverrides'], device: string | null): RsIfaceOverrides {
  const next: RsIfaceOverrides = { ...current };
  delete next.ethernet;
  if (device !== null) next.ethernet = device;
  return next;
}

export async function setOpenAtLogin(
  rs: SettingsApi,
  on: boolean,
  i18n: I18n = UZ,
): Promise<{ readonly openAtLogin: boolean | null; readonly feedback: Feedback }> {
  const words = i18n.t.settings.login;
  const result = await rs.setOpenAtLogin(on);
  if (!result.ok) return { openAtLogin: null, feedback: failed(result, i18n) };
  const applied = result.value.openAtLogin;
  return {
    openAtLogin: applied,
    feedback:
      applied === on
        ? { tone: 'success', text: on ? words.on : words.off }
        : { tone: 'danger', text: words.refused },
  };
}

export async function saveEthernetOverride(rs: SettingsApi, device: string | null, i18n: I18n = UZ): Promise<Feedback> {
  const words = i18n.t.settings.ethernet;
  // Read the overrides fresh: another window may have changed them.
  const config = await rs.getConfig();
  if (!config.ok) return failed(config, i18n);
  const result = await rs.setIfaceOverrides(withEthernetOverride(config.value.ifaceOverrides, device));
  if (!result.ok) return failed(result, i18n);
  return { tone: 'success', text: device === null ? words.savedAuto : words.saved(device) };
}

export async function copyServiceOrderCommand(
  rs: SettingsApi,
  i18n: I18n = UZ,
): Promise<{ readonly order: RsServiceOrder | null; readonly feedback: Feedback }> {
  const result = await rs.copyServiceOrderCommand();
  if (!result.ok) return { order: null, feedback: failed(result, i18n) };
  return { order: result.value, feedback: { tone: 'success', text: i18n.t.settings.wifi.copied } };
}

/**
 * "Ha, o'chirish": the full removal through the administrator password
 * (`uninstall.sh`, TASK-214), or — without the package — the helper's own
 * `uninstall` over the socket. See `removeHelper` of the install screen.
 */
export function uninstallHelper(rs: SettingsApi, i18n: I18n = UZ): Promise<Feedback> {
  return removeHelper(rs, i18n);
}
