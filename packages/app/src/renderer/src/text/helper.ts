// How the helper's connection reads: a short status line (rules window
// sidebar, settings screen) and the notice a screen shows in place of its
// content while there is no live state, with the way out of it.

import type { EngineStateView } from '../hooks/useEngineState';
import type { RsConnection } from '../rs';
import { errorText } from './errors';

export interface HelperStatusText {
  readonly text: string;
  readonly tone: 'success' | 'warning' | 'danger' | 'neutral';
}

export const HELPER_STATUS_TEXT: Readonly<Record<EngineStateView['helper'], HelperStatusText>> = {
  loading: { text: 'Tekshirilmoqda…', tone: 'neutral' },
  connected: { text: 'Helper ishlayapti', tone: 'success' },
  connecting: { text: 'Helper bilan ulanmoqda…', tone: 'warning' },
  'not-installed': { text: "Helper o'rnatilmagan", tone: 'neutral' },
  disconnected: { text: 'Helper ishlamayapti', tone: 'danger' },
  'config-unreadable': { text: "Helper config'i buzilgan", tone: 'danger' },
  incompatible: { text: 'Helper versiyasi mos emas', tone: 'danger' },
  stopped: { text: "Ilova to'xtamoqda", tone: 'neutral' },
  unavailable: { text: "Holatni o'qib bo'lmadi", tone: 'danger' },
};

/**
 * What the user can do about a helper status:
 * - `reconnect`     — try the connection again now ("Qayta ulanish");
 * - `install`       — install the helper (not in the app yet: shown disabled, with `INSTALL_UNAVAILABLE`);
 * - `reinstall`     — install the matching helper version (likewise);
 * - `repair-config` — replace the unreadable stored config: import a file, or start with an empty one.
 */
export type HelperRecovery = 'reconnect' | 'install' | 'reinstall' | 'repair-config';

/** Why "Helper'ni o'rnatish" is disabled: installing from the app is not built yet. */
export const INSTALL_UNAVAILABLE = "Ilova ichidan o'rnatish hali qo'shilmagan";

export interface HelperNotice {
  readonly title: string;
  readonly text: string;
  readonly tone: 'neutral' | 'warning' | 'danger';
  /** The way out; null when there is nothing to do but wait. */
  readonly recovery: HelperRecovery | null;
}

const DISCONNECTED_TEXT: Readonly<Record<Extract<RsConnection, { kind: 'disconnected' }>['reason'], string>> = {
  'not-running': "Helper ishlamayapti. U launchd orqali qayta ishga tushadi; bo'lmasa qayta o'rnating.",
  'permission-denied': "Helper socket'iga ruxsat yo'q (foydalanuvchi staff guruhida emas).",
  'connection-lost': 'Aloqa uzildi — qayta ulanmoqda.',
  'protocol-error': 'Helper tushunarsiz javob berdi — qayta ulanmoqda.',
  timeout: 'Helper javob bermadi — qayta ulanmoqda.',
  error: "Helper'ga ulanib bo'lmadi — qayta urinilmoqda.",
};

export const LOADING_NOTICE: HelperNotice = { title: "Holat o'qilmoqda…", text: '', tone: 'neutral', recovery: null };

/** The notice for every helper status but `connected`; where it matters it says that applied routes stay with the helper. */
export function helperNotice(engine: EngineStateView): HelperNotice | null {
  const connection = engine.connection;
  switch (engine.helper) {
    case 'connected':
      return null;
    case 'loading':
      return LOADING_NOTICE;
    case 'connecting':
      return { title: 'Helper bilan ulanmoqda…', text: '', tone: 'neutral', recovery: null };
    case 'not-installed':
      return {
        title: "Helper o'rnatilmagan",
        text: "Routing uchun helper bir marta administrator paroli bilan o'rnatiladi. Hozircha hech bir qoida qo'llanmaydi.",
        tone: 'warning',
        recovery: 'install',
      };
    case 'disconnected':
      return {
        title: "Helper bilan aloqa yo'q",
        text:
          connection?.kind === 'disconnected'
            ? `${DISCONNECTED_TEXT[connection.reason]} Qo'llangan route'lar helper'da qoladi.`
            : "Qo'llangan route'lar helper'da qoladi.",
        tone: 'danger',
        recovery: 'reconnect',
      };
    case 'config-unreadable':
      return {
        title: "Helper config'i buzilgan",
        text: "Helper ishlayapti, lekin saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmayapti. «Qoidalar» bo'limida config'ni import qiling yoki bo'sh config bilan boshlang.",
        tone: 'danger',
        recovery: 'repair-config',
      };
    case 'incompatible':
      return {
        title: 'Helper versiyasi mos emas',
        text:
          connection?.kind === 'incompatible'
            ? `Helper v${connection.helperVersion} boshqa protokolda (${String(connection.protocolVersion)}, kerak: ${String(connection.expectedProtocolVersion)}). Helper'ni qayta o'rnating.`
            : "Helper'ni qayta o'rnating.",
        tone: 'danger',
        recovery: 'reinstall',
      };
    case 'stopped':
      return { title: "Ilova to'xtamoqda", text: '', tone: 'neutral', recovery: null };
    case 'unavailable':
      return {
        title: "Holatni o'qib bo'lmadi",
        text: engine.error === null ? '' : errorText(engine.error.code),
        tone: 'danger',
        recovery: null,
      };
  }
}
