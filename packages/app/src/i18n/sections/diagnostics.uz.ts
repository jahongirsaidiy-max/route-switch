// Uzbek words of the "Diagnostika" section of the rules window
// (TASK-DELTA-20): the input, the verdict, the matching rule and why it wins,
// the address table, DNS, and the helper's note codes. The source of the
// section's keys (`diagnostics.ru.ts` and `diagnostics.en.ts` are typed by it).
// Code tables are checked against the shared protocol's closed sets.

import type { DiagnoseDnsOutcome, DiagnoseMatchVia, DiagnoseNote, DiagnosePrecedence } from '@routeswitch/shared';

import type { RsLookupOutcome } from '../../renderer/src/rs';

/** Why the input was refused before anything was sent. */
export type DiagnosticInputError = 'empty' | 'too-long' | 'ipv6' | 'wildcard' | 'invalid-host';

/** Where an address in the table comes from: the helper's (rule cache / its query) or the app's system lookup. */
export type DiagnosticSourceKey = 'rule-cache' | 'query' | 'system';

/** The mark of one address row. */
export type DiagnosticRowStatus = 'ok' | 'mismatch' | 'default' | 'unknown' | 'failed';

export const diagnosticsUz = {
  title: 'Diagnostika',
  subtitle: "Manzil qaysi interfeys orqali ketishini va nega shundayligini tekshiring: qoida, haqiqiy route va DNS.",
  inputLabel: 'Xost, IP yoki URL',
  placeholder: 'corp.local, 10.20.4.37 yoki https://example.com/sahifa',
  hint: "URL'dan faqat xost olinadi (sxema, port va yo'l tashlanadi). Hech narsa o'zgartirilmaydi.",
  run: 'Tekshirish',
  /** The name of a disabled "Tekshirish", with the reason. */
  runOff: (reason: string): string => `Tekshirish — ${reason}`,
  needsHelper: 'helper ulanmagan',
  running: 'Tekshirilmoqda… nom yechilishi bir necha soniya olishi mumkin.',
  inputErrors: {
    empty: 'Xost, IP manzil yoki URL kiriting.',
    'too-long': 'Juda uzun — bitta xost, IP yoki URL kiriting.',
    ipv6: "IPv6 manzillar qo'llab-quvvatlanmaydi — IPv4 manzil yoki xost nomini kiriting.",
    wildcard: "«*» bo'lmaydi: diagnostika bitta aniq nom yoki manzil uchun.",
    'invalid-host': "Bu xost nomi emas. Masalan: corp.local, 10.20.4.37 yoki https://example.com.",
  } satisfies Readonly<Record<DiagnosticInputError, string>>,
  failed: (reason: string): string => `Tekshirib bo'lmadi: ${reason}`,
  /** The helper refused the diagnosis: its per-minute budget (10 requests per connection) is used up. */
  rateLimited: "Tekshiruvlar juda ko'p: helper daqiqasiga 10 tagacha so'rovni tekshiradi (qamralmagan nomning har manzili alohida so'rov). Bir daqiqadan keyin qayta urinib ko'ring.",
  /** The helper refused it: other diagnoses are running. */
  helperBusy: "Helper hozir boshqa tekshiruv bilan band — birozdan keyin qayta urinib ko'ring.",

  emptyTitle: "Hali tekshiruv yo'q",
  emptyText: "Xost, IP yoki URL kiriting — natijada mos qoida, har manzilning haqiqiy interfeysi va DNS server ko'rinadi.",

  resultLabel: (target: string): string => `${target} natijasi`,
  /** The verdict line at the top of a result. */
  verdict: {
    ok: 'Hammasi kutilganidek',
    okVia: (role: string): string => `Hammasi kutilganidek — ${role} orqali`,
    mismatch: 'Trafik kutilgan interfeysdan ketmayapti',
    noRule: "Qoida yo'q — default kanaldan ketadi",
    noAddresses: 'Manzil topilmadi',
    onlyExcluded: 'Nom route qilinmaydigan manzilga yechiladi',
    dnsDown: 'DNS server javob bermayapti',
    partial: 'Ayrim manzillar tekshirilmadi',
  },
  /** One short advice under the verdict. */
  advice: {
    noRule: "Boshqa interfeysdan ketishi kerak bo'lsa — Qoidalar bo'limida qoida qo'shing.",
    ruleDisabled: "Mos qoida o'chirilgan — Qoidalar bo'limida yoqing.",
    globallyDisabled: "Yo'naltirish umuman o'chiq — menu bar'da yoqing.",
    interfaceDown: "Qoida interfeysi ulanmagan — kabel yoki Wi‑Fi'ni tekshiring; ulanganda qoida o'zi qo'llanadi.",
    notApplied: "Qoida route'i jadvalda yo'q — Qoidalar bo'limida qoida holatini ko'ring yoki menu bar'da «Qayta qo'llash» ni bosing.",
    mismatch: "Boshqa route ustun kelmoqda (masalan VPN yoki aniqroq route) — Qoidalar bo'limida qoida holatini ko'ring.",
    dnsDown: "Ichki nomlar yechilmasligi mumkin — DNS serverga yo'l qaysi interfeysdan ketishini tekshiring.",
    partial: "Bir daqiqadan keyin qayta tekshirib ko'ring.",
    noAddresses: "Nom to'g'ri yozilganini va DNS ishlayotganini tekshiring.",
    onlyExcluded: "Bu nom kompyuterning o'ziga (masalan localhost) yoki link-local manzilga ishora qiladi — bunday trafik hech qaysi interfeysdan chiqmaydi va qoida kerak emas.",
  },

  matchTitle: 'Mos qoida',
  /** The rule as the rules table shows it. */
  matchRule: (target: string, role: string): string => `${target} → ${role}`,
  unknownRule: "qoida (qoidalar ro'yxati hali o'qilmagan)",
  noMatch: 'Hech bir yoqilgan qoida mos emas — trafik default kanaldan ketadi.',
  /** What made the rule match. */
  via: {
    ip: 'IP qoidasi',
    subnet: 'subnet qoidasi',
    domain: 'domen qoidasi',
    wildcard: 'wildcard domen qoidasi',
    'dns-server': 'qoidaning DNS serveri',
  } satisfies Readonly<Record<DiagnoseMatchVia, string>>,
  /** Why that rule wins. */
  precedence: {
    'only-match': "boshqa mos qoida yo'q",
    'host-route': 'aniq manzil (/32) qoidasi hammasidan ustun',
    'domain-address': 'domen javobidagi manzil kengroq subnetdan ustun',
    'longest-prefix': 'eng tor subnet (eng uzun prefiks) ustun',
    'exact-domain': "aniq domen wildcard'dan ustun",
    'deeper-wildcard': 'eng chuqur wildcard ustun',
    'config-order': "teng darajada — ro'yxatda oldingi qoida ustun",
  } satisfies Readonly<Record<DiagnosePrecedence, string>>,
  /** One address's rule, in the lookup table. */
  addressRule: (via: string, rule: string): string => `${via}: ${rule}`,

  addressesTitle: 'Manzillar',
  columns: { address: 'Manzil', actual: 'Haqiqiy route', expected: 'Kutilgan', status: 'Natija' },
  sources: {
    'rule-cache': 'qoida keshidan',
    query: "helper so'rovi",
    system: 'tizim resolveri',
  } satisfies Readonly<Record<DiagnosticSourceKey, string>>,
  noRoute: "route yo'q",
  gateway: (gateway: string): string => `gateway ${gateway}`,
  direct: "to'g'ridan-to'g'ri",
  noRole: 'rolsiz interfeys',
  defaultRoute: 'default kanal',
  status: {
    ok: '✓ mos',
    mismatch: '✗ mos emas',
    default: '— qoidasiz',
    unknown: "? noma'lum",
    failed: 'tekshirilmadi',
  } satisfies Readonly<Record<DiagnosticRowStatus, string>>,
  rowFailed: (reason: string): string => `Tekshirilmadi: ${reason}`,
  noAddressRows: "Tekshiriladigan manzil yo'q.",

  dnsTitle: 'DNS',
  dnsServer: (server: string): string => `Server: ${server}`,
  dnsVia: (role: string): string => `${role} orqali`,
  dnsOutcome: {
    ok: 'javob berdi',
    timeout: 'javob bermadi (3 s)',
    refused: "so'rovni rad etdi",
    error: "so'rov xato bilan tugadi",
    'not-queried': "so'ralmadi",
  } satisfies Readonly<Record<DiagnoseDnsOutcome, string>>,
  dnsMs: (ms: number): string => `${String(ms)} ms`,
  resolverFile: (path: string): string => `Resolver fayli: ${path}`,
  noResolverFile: "Resolver fayli yo'q — tizim DNS'i ishlatiladi.",
  noDns: "Qoidaning alohida DNS serveri yo'q — tizim DNS'i ishlatiladi.",

  notesTitle: 'Izohlar',
  notes: {
    'name-not-covered':
      "Bu nom hech bir domen qoidasi bilan qamralmagan — helper uni yechmaydi; ilova uni oddiy huquqda tizim resolveri bilan yechdi.",
    'no-matching-rule': 'Hech bir yoqilgan qoida mos emas — default kanal ishlatiladi.',
    'rule-disabled': "Mos keladigan qoida bor, lekin u o'chirilgan.",
    'globally-disabled': "Yo'naltirish umuman o'chiq — hech bir qoida qo'llanmayapti.",
    'interface-down': 'Qoida interfeysi ulanmagan.',
    'no-gateway': "Qoida interfeysida gateway yo'q.",
    'not-applied': "Qoidaning route'i routing jadvalida yo'q.",
    'route-mismatch': 'Tizim manzilni qoida interfeysidan boshqa interfeys orqali yuboryapti.',
    'connected-network': "Manzil to'g'ridan-to'g'ri ulangan tarmoqda (yoki interfeysning gateway'i/o'z manzili) — u route qilinmaydi.",
    'dns-server-excluded': 'Manzil DNS server — u hech qachon route qilinmaydi.',
    'no-addresses': "Nomning A-yozuvi (IPv4 manzili) yo'q.",
    'resolve-failed': "Nomni yechib bo'lmadi.",
    'addresses-truncated': "Manzillar ko'p — faqat bir qismi ko'rsatildi.",
  } satisfies Readonly<Record<DiagnoseNote, string>>,

  /** The app's own lookup of a name no rule covers. */
  lookup: {
    ok: (count: number): string => `Tizim resolveri ${String(count)} ta IPv4 manzil berdi.`,
    truncated: (max: number): string => `Tizim resolveri ${String(max)} tadan ko'p IPv4 manzil berdi — faqat birinchi ${String(max)} tasi tekshirildi.`,
    excluded: (count: number): string => `${String(count)} ta manzil (loopback, link-local va h.k.) route qilinmaydi — tekshirilmadi.`,
    /** Every address the resolver gave is one that is never routed: nothing to check. */
    onlyExcluded: (count: number): string =>
      `Tizim resolveri faqat route qilinmaydigan manzil berdi (${String(count)} ta: loopback, link-local va h.k.) — tekshiradigan manzil yo'q.`,
    outcomes: {
      'not-found': "Nom topilmadi: tizim resolveri unga IPv4 manzil bermadi.",
      timeout: 'Tizim resolveri 3 soniya ichida javob bermadi.',
      failed: "Nomni tizim resolveri bilan yechib bo'lmadi.",
    } satisfies Readonly<Record<Exclude<RsLookupOutcome, 'ok'>, string>>,
  },
};
