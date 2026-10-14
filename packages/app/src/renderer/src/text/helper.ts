// How the helper's connection reads in a short status line (rules window
// sidebar, settings screen).

import type { EngineStateView } from '../hooks/useEngineState';

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
  incompatible: { text: 'Helper versiyasi mos emas', tone: 'danger' },
  stopped: { text: "Ilova to'xtamoqda", tone: 'neutral' },
  unavailable: { text: "Holatni o'qib bo'lmadi", tone: 'danger' },
};
