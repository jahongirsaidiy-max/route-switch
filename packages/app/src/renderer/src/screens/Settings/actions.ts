// What the settings screen does, as plain functions over the preload API:
// each call settles with a message for the screen and never throws.

import type { AdapterInfo, Config } from '@routeswitch/shared';

import type { RsApi, RsErrorCode, RsIfaceOverrides, RsResult, RsServiceOrder } from '../../rs';

export type SettingsApi = Pick<
  RsApi,
  'getSettings' | 'setOpenAtLogin' | 'getConfig' | 'setIfaceOverrides' | 'getServiceOrder' | 'copyServiceOrderCommand' | 'uninstallHelper'
>;

export interface Feedback {
  readonly tone: 'success' | 'danger';
  readonly text: string;
}

/** The words for a failed call. `error` (English, for the log) is never shown. */
export function errorText(code: RsErrorCode): string {
  switch (code) {
    case 'not-connected':
      return "Helper bilan aloqa yo'q — hech narsa yuborilmadi.";
    case 'disconnected':
    case 'timeout':
      return "Javob kelmadi: natija noma'lum. Helper qayta ulanganda holat yangilanadi.";
    case 'busy':
      return "Helper band — birozdan keyin qayta urinib ko'ring.";
    case 'not-implemented':
      return "O'rnatilgan helper bu amalni hali bajara olmaydi.";
    case 'invalid-config':
    case 'invalid-input':
      return 'Qiymat qabul qilinmadi.';
    case 'operation-failed':
      return 'Amal bajarilmadi.';
    case 'forbidden':
      return "Bu oynadan ruxsat yo'q.";
    default:
      return `Kutilmagan xato (${code}).`;
  }
}

const failed = (result: Extract<RsResult<unknown>, { ok: false }>): Feedback => ({
  tone: 'danger',
  text: errorText(result.code),
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
): Promise<{ readonly openAtLogin: boolean | null; readonly feedback: Feedback }> {
  const result = await rs.setOpenAtLogin(on);
  if (!result.ok) return { openAtLogin: null, feedback: failed(result) };
  const applied = result.value.openAtLogin;
  return {
    openAtLogin: applied,
    feedback:
      applied === on
        ? { tone: 'success', text: on ? "RouteSwitch login'da ishga tushadi." : "Login'da ishga tushish o'chirildi." }
        : { tone: 'danger', text: "macOS sozlamani qabul qilmadi (Tizim sozlamalari → Login elementlari)." },
  };
}

export async function saveEthernetOverride(rs: SettingsApi, device: string | null): Promise<Feedback> {
  // Read the overrides fresh: another window may have changed them.
  const config = await rs.getConfig();
  if (!config.ok) return failed(config);
  const result = await rs.setIfaceOverrides(withEthernetOverride(config.value.ifaceOverrides, device));
  if (!result.ok) return failed(result);
  return {
    tone: 'success',
    text: device === null ? 'Ethernet adapteri avtomatik aniqlanadi.' : `Ethernet roli endi ${device} da.`,
  };
}

export async function copyServiceOrderCommand(
  rs: SettingsApi,
): Promise<{ readonly order: RsServiceOrder | null; readonly feedback: Feedback }> {
  const result = await rs.copyServiceOrderCommand();
  if (!result.ok) return { order: null, feedback: failed(result) };
  return { order: result.value, feedback: { tone: 'success', text: "Buyruq nusxalandi — Terminal'ga qo'ying." } };
}

export async function uninstallHelper(rs: SettingsApi): Promise<Feedback> {
  const result = await rs.uninstallHelper();
  if (!result.ok) return failed(result);
  return {
    tone: 'success',
    text: "Helper o'chirildi: uning route'lari va resolver fayllari olib tashlandi. Routing to'xtadi.",
  };
}
