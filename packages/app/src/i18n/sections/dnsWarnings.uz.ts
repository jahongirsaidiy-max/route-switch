// "DNS server boshqa interfeysda" (TASK-DELTA-21), in Uzbek: the source of
// the `dnsWarnings` keys — the banner of the menu bar and the rules window,
// and its one-click "add rule" offer. `role` / `other` are product names
// (Ethernet, Wi‑Fi), `server` an IPv4 address.

export const dnsWarningsUz = {
  /** Banner title: the server of an interface. */
  titleInterface: (role: string, server: string, other: string): string => `${role} DNS serveri (${server}) ${other} orqali ketmoqda`,
  /** Banner title: the `dns` of a rule; `target` is the rule's domain. */
  titleRule: (target: string, server: string, other: string): string => `«${target}» qoidasining DNS serveri (${server}) ${other} orqali ketmoqda`,
  /** A rule's server while the rules are not read yet. */
  titleRuleUnknown: (server: string, other: string): string => `Qoidaning DNS serveri (${server}) ${other} orqali ketmoqda`,
  /** Why, by the helper's code. */
  textSubnet: (server: string, role: string, other: string): string =>
    `${server} — ${other} tarmog'ida: unga so'rovlar ${role} o'rniga ${other}'dan chiqadi va javob kelmasligi mumkin (ichki nomlar yechilmaydi). Yechim — ${server} uchun ${role} orqali IP qoida.`,
  textRouted: (server: string, role: string, other: string): string =>
    `Route jadvali ${server} ni ${other} orqali yuboradi, ${role} orqali emas — ichki nomlar yechilmasligi mumkin. Yechim — ${server} uchun ${role} orqali IP qoida.`,
  /** The offer's button: opens the add-rule form filled in; nothing is saved until "Saqlash". */
  addRule: (server: string, role: string): string => `${server} → ${role} qoidasini qo'shish`,
  /** The note of the offered rule. */
  ruleNote: 'DNS server',
  /** In place of the button, why no rule is offered. */
  blockedGateway: (server: string, role: string): string =>
    `Qoida taklif qilinmaydi: ${server} — ${role} gateway'i, unga route qo'shib bo'lmaydi.`,
  blockedOwnAddress: (server: string, role: string): string =>
    `Qoida taklif qilinmaydi: ${server} — ${role} interfeysining o'z manzili.`,
  blockedNoGateway: (role: string): string => `Qoida taklif qilinmaydi: ${role} ulanmagan yoki gateway'i yo'q.`,
  blockedInvalid: (reason: string): string => `Qoida taklif qilinmaydi: ${reason}`,
  blockedExists: (target: string, role: string): string =>
    `${target} → ${role} qoidasi allaqachon bor — Qoidalar ro'yxatida yoqilganini va holatini tekshiring.`,
  /** The add-rule button of the rules window is off (no form, or an unreadable config). */
  blockedUnavailable: (reason: string): string => `Qoida qo'shib bo'lmaydi: ${reason}`,
};
