// What the main process says (TASK-DELTA-12), in Uzbek: the source of the
// keys of `t.tray`, `t.dialogs` and `t.journal`. `shell.ru.ts` and
// `shell.en.ts` fill the same shape.
//
// The password dialog's text is not here: it is part of a fixed AppleScript
// per language (`main/installer.ts`, `ELEVATION_SCRIPTS`).

import type { DisconnectedReason } from '../uz';

export const shellUz = {
  /** The tray icon: its tooltip and its right-click menu. */
  tray: {
    connecting: 'RouteSwitch — ulanmoqda…',
    notInstalled: "RouteSwitch — helper o'rnatilmagan",
    disconnected: "RouteSwitch — helper bilan aloqa yo'q",
    incompatible: 'RouteSwitch — helper versiyasi mos emas',
    configUnreadable: "RouteSwitch — helper config'i buzilgan, qoidalar qo'llanmaydi",
    off: "RouteSwitch — o'chirilgan",
    active: 'RouteSwitch — faol',
    failing: (count: number): string => `RouteSwitch — ${String(count)} ta qoidada xato`,
    /** Notes after the status, each as " · …". */
    rulesWaiting: (count: number): string => `${String(count)} ta qoida interfeysni kutmoqda`,
    sameSubnet: 'Ethernet va Wi‑Fi bitta tarmoqda',
    /** DNS servers reached through the other interface (`dnsWarnings`; counted once per server). */
    dnsWarnings: (count: number): string => `${String(count)} ta DNS server boshqa interfeysdan ketmoqda`,
    manageRules: 'Qoidalarni boshqarish',
    help: 'Yordam',
    quit: 'RouteSwitch ilovasidan chiqish',
  },

  /** The titles of the system file dialogs of config import / export. */
  dialogs: {
    importTitle: 'Config import',
    exportTitle: 'Config export',
  },

  /**
   * The app's own journal lines about the helper connection. Written in the
   * language that is on when the line is written; a later change of language
   * does not rewrite lines already in the journal.
   */
  journal: {
    connected: (helperVersion: string): string => `Helper bilan aloqa o'rnatildi (v${helperVersion})`,
    notInstalled: "Helper o'rnatilmagan — qoidalar qo'llanmaydi",
    disconnected: (why: string): string => `Helper bilan aloqa yo'q: ${why}`,
    disconnectedWhy: {
      'not-running': "helper ishlamayapti (socket bor, javob yo'q)",
      'permission-denied': "helper socket'iga ruxsat yo'q",
      'connection-lost': 'aloqa uzildi',
      'protocol-error': 'helper tushunarsiz javob berdi',
      timeout: 'helper javob bermadi',
      error: "helper'ga ulanib bo'lmadi",
    } satisfies Readonly<Record<DisconnectedReason, string>>,
    configUnreadable:
      "Helper saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmaydi. Import yoki bo'sh config bilan tiklang",
    incompatible: (helperVersion: string, protocolVersion: number, expected: number): string =>
      `Helper versiyasi mos emas: v${helperVersion}, protokol ${String(protocolVersion)} (kerak: ${String(expected)})`,
    flapping: "Helper bilan aloqa tez-tez o'zgarmoqda — keyingi o'zgarishlar 10 daqiqagacha jurnalga yozilmaydi",
  },
};
