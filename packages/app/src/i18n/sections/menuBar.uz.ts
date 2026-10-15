// The menu bar window (TASK-DELTA-12), in Uzbek: the source of the keys of
// `t.menuBar`. `menuBar.ru.ts` and `menuBar.en.ts` fill the same shape.

export const menuBarUz = {
  /** The word next to the global switch. */
  on: 'Faol',
  off: "O'chiq",
  /** The switch's accessible name. */
  toggleLabel: 'Routing (barcha qoidalar)',
  interfaces: 'Interfeyslar',
  activeRules: 'Faol qoidalar',
  /** "3 ta · 5 route": enabled rules, and routes in the table on their behalf. */
  ruleCount: (rules: number, routes: number): string => `${String(rules)} ta · ${String(routes)} route`,
  rulesUnreadable: "Qoidalarni o'qib bo'lmadi.",
  reload: "Qayta o'qish",
  rulesLoading: "Qoidalar o'qilmoqda…",
  noRules: "Yoqilgan qoida yo'q. «Qoidalarni boshqarish» orqali qo'shing.",
  /** The enabled rules beyond the ones listed. */
  moreRules: (count: number): string => `Yana ${String(count)} ta qoida`,
  /** The accessible name of a rule's warning mark. */
  warning: (text: string): string => `Ogohlantirish: ${text}`,
  /** A domain rule's row: its own DNS server … */
  dnsServer: (server: string): string => `DNS: ${server}`,
  /** … or how many addresses it resolved to, and when (`ago` is "2 daq oldin"). */
  resolved: (count: number, ago: string): string => `${String(count)} IP · ${ago}`,
  /** A wildcard domain rule: how many addresses the DNS proxy learned, and when the last one came (`ago` may be ''). */
  learned: (count: number, ago: string): string => `${String(count)} ta o'rganilgan IP${ago === '' ? '' : ` · ${ago}`}`,
  routingOff: "Routing o'chirilgan — qoidalar qo'llanmaydi",
  notAppliedYet: "Hali qo'llanmagan",
  /** "Oxirgi qo'llash: 10:58"; the trigger follows as " · tarmoq o'zgarganda". */
  lastApply: (time: string): string => `Oxirgi qo'llash: ${time}`,
  rulesFailing: (count: number): string => `${String(count)} ta qoidada xato`,
  reapply: "Qayta qo'llash",
  manageRules: 'Qoidalarni boshqarish',
  rulesWindowFailed: (reason: string): string => `Qoidalar oynasi ochilmadi. ${reason}`,
};
