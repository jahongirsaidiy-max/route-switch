// Uzbek words of the rules window (TASK-DELTA-13): the sidebar, the rules
// table and its toolbar, the confirmation panels, config import / export and
// the way out of an unreadable stored config. The source of the section's
// keys (`rules.ru.ts` and `rules.en.ts` are typed by it).

/** The filter of the rules table. */
export type RowFilterKey = 'all' | 'problems' | 'off';

export const rulesUz = {
  /** The sidebar of the rules window. */
  sections: { rules: 'Qoidalar', log: 'Jurnal', diagnostics: 'Diagnostika', settings: 'Sozlamalar', help: 'Yordam' },
  sectionsNav: "Bo'limlar",
  /** Under the helper status when connected. */
  helperDaemon: (version: string): string => `root daemon · v${version}`,

  title: 'Qoidalar',
  subtitle: 'Qaysi manzil qaysi interfeys orqali borishini belgilang. Qolgan trafik default kanal orqali ketadi.',
  addRule: "Qoida qo'shish",
  /** The name of a disabled "Qoida qo'shish", with the reason. */
  addRuleOff: (reason: string): string => `Qoida qo'shish — ${reason}`,
  configUnreadableReason: "Helper config'i buzilgan — avval import qiling yoki bo'sh config bilan boshlang",
  addRuleUnavailable: "Qoida qo'shish oynasi hali tayyor emas",

  search: 'Qidirish',
  searchPlaceholder: "IP, subnet, domen yoki izoh bo'yicha qidirish",
  filterLabel: "Ko'rsatish",
  filters: { all: 'Hammasi', problems: 'Muammoli', off: "O'chirilgan" } satisfies Readonly<Record<RowFilterKey, string>>,
  import: 'Import',
  importLabel: 'Config import (JSON fayldan)',
  export: 'Export',
  exportLabel: 'Config export (JSON faylga)',
  exportOff: (reason: string): string => `Config export — ${reason}`,

  columns: { status: 'Holat', target: 'Manzil', kind: 'Turi', iface: 'Interfeys', note: 'Izoh' },
  /** The "Turi" column. */
  kinds: { ip: 'IP', subnet: 'Subnet', domain: 'Domen', domainDns: 'Domen + DNS' },
  /** The "Izoh" column of a domain rule without a note. */
  detailDns: (dns: string): string => `DNS: ${dns}`,
  detailEvery: (minutes: number): string => `har ${String(minutes)} daq`,
  detailCount: (count: number, every: string): string => `${String(count)} IP · ${every}`,
  warningMark: 'Ogohlantirish',
  toggleLabel: (target: string): string => `${target} qoidasi`,
  editLabel: (target: string): string => `${target} qoidasini tahrirlash`,
  editOff: (reason: string): string => `Tahrirlash — ${reason}`,
  deleteLabel: (target: string): string => `${target} qoidasini o'chirish`,

  emptyTitle: "Hali qoida yo'q",
  emptyText: "Qoida qo'shilgach, manzil shu yerda ko'rinadi va tanlangan interfeys orqali yo'naltiriladi.",
  noMatchTitle: 'Hech narsa topilmadi',
  /** `query` / `filter` are null when not in use. */
  noMatchText: (query: string | null, filter: string | null): string =>
    `${query === null ? '' : `«${query}» bo'yicha `}${filter === null ? '' : `«${filter}» orasida `}mos qoida yo'q.`,

  readFailedTitle: "Qoidalarni o'qib bo'lmadi",
  reload: "Qayta o'qish",
  reading: "Qoidalar o'qilmoqda…",

  overlapsLabel: 'Ustma-ust manzillar',
  overlapsTitle: "Ustma-ust manzillar — aniqrog'i (uzunroq prefiks) ustun keladi:",
  overlapInside: (narrower: string, wider: string): string => `${narrower} → ${wider} ichida`,
  overlapOtherIface: ' · boshqa interfeys',
  overlapMore: (count: number): string => `yana ${String(count)} ta`,

  activeRules: (count: number): string => `${String(count)} ta qoida faol · tarmoq o'zgarganda avtomatik qo'llanadi`,
  routingOff: 'Routing menu bar oynasidagi umumiy tugma bilan yoqiladi',

  /** The buttons of the confirmation panels. */
  replace: 'Almashtirish',
  cancel: 'Bekor qilish',
  remove: "O'chirish",
  deleteQuestion: (target: string): string => `«${target}» qoidasi o'chirilsinmi? Uning route'lari olib tashlanadi.`,

  /** A refused switch or removal: "<what>: <why>". */
  enableFailed: 'Qoida yoqilmadi',
  disableFailed: "Qoida o'chirilmadi",
  deleteFailed: "Qoida o'chirib tashlanmadi",
  ruleGone: "qoida endi yo'q (boshqa oynada o'chirilgan bo'lishi mumkin).",
  failed: (what: string, why: string): string => `${what}: ${why}`,

  /** Config import / export (TASK-215). */
  importFailed: (why: string): string => `Import qilinmadi: ${why}`,
  imported: (count: number): string => `Config import qilindi: ${String(count)} ta qoida.`,
  replaceFailed: (why: string): string => `Config almashtirilmadi: ${why}`,
  exportFailed: (why: string): string => `Export qilinmadi: ${why}`,
  exported: (count: number): string => `Config faylga saqlandi: ${String(count)} ta qoida.`,
  /** The question of the import confirmation, in parts. */
  importReplaces: (count: number, current: number | null): string =>
    `Import joriy configni to'liq almashtiradi: ${String(count)} ta qoida${current === null ? '' : ` (hozir ${String(current)} ta)`}.`,
  importCounts: (added: number, removed: number, changed: number, unchanged: number): string =>
    `Qo'shiladi: ${String(added)}, o'chiriladi: ${String(removed)}, o'zgaradi: ${String(changed)}, o'zgarmaydi: ${String(unchanged)}.`,
  importRoutingOff: "Routing o'chiriladi.",
  importRoutingOn: 'Routing yoqiladi.',
  importOverrides: 'Interfeys almashtirishlari ham almashadi.',

  /** "Bo'sh config bilan boshlash" (TASK-300). */
  importConfig: "Config'ni import qilish",
  startEmpty: "Bo'sh config bilan boshlash",
  resetQuestion: (path: string): string =>
    `Saqlangan (o'qib bo'lmaydigan) config bo'sh config bilan almashtirilsinmi? Undagi qoidalar qaytmaydi — qo'lda tiklamoqchi bo'lsangiz, avval ${path} nusxasini oling.`,
  resetDone: "Bo'sh config saqlandi — helper yana ishlayapti. Endi qoida qo'shishingiz yoki import qilishingiz mumkin.",
};
