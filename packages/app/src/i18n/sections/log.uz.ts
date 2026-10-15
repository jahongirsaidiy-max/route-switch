// The journal screen (TASK-DELTA-14), in Uzbek: the source of the `log` keys.
// The helper's own lines (`msg`) are English and are never translated.

import type { EventLogLevel } from '@routeswitch/shared';

export const logUz = {
  title: 'Jurnal',
  subtitle: (limit: number): string =>
    `Helper'ning oxirgi ${String(limit)} ta xabari va ilovaning helper bilan aloqa haqidagi yozuvlari. Ilova ishga tushgandan beri kelganlari saqlanadi.`,
  levels: {
    info: "Ma'lumot",
    warn: 'Ogohlantirish',
    error: 'Xato',
  } satisfies Readonly<Record<EventLogLevel, string>>,
  /** The filter option that shows every level. */
  all: 'Hammasi',
  /** Accessible name of the level filter. */
  filterLabel: 'Daraja',
  loading: 'Jurnal yuklanmoqda…',
  emptyTitle: "Jurnal hozircha bo'sh",
  emptyText: "Helper yozgan xabarlar (qo'llash, xatolar, tarmoq o'zgarishi) shu yerda paydo bo'ladi.",
  noneAtLevel: "Bu darajada yozuv yo'q.",
  historyFailed: "Jurnal tarixini o'qib bo'lmadi. Yangi xabarlar kelishi bilan ko'rinadi.",
  columns: { time: 'Vaqt', level: 'Daraja', message: 'Xabar' },
  /** Accessible name of the list of entries. */
  entriesLabel: 'Jurnal yozuvlari',
  /** The tag of the app's own entries (TASK-300) and its tooltip. */
  appTag: 'Ilova',
  appTagTitle: "Ilovaning o'z yozuvi (helper emas)",
  count: (count: number): string => `${String(count)} ta yozuv · eng yangisi tepada`,
  kept: (limit: number): string => `Oxirgi ${String(limit)} tasi saqlanadi`,
};
