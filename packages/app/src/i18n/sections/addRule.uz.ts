// Uzbek words of the add / edit rule dialog (TASK-DELTA-13). The source of the
// section's keys (`addRule.ru.ts` and `addRule.en.ts` are typed by it). The
// command preview's own lines (`$ route -n add …`) are argv, not words: they
// are built in the screen's model and never translated.

import { LIMITS, type RuleKind } from '@routeswitch/shared';

export const addRuleUz = {
  titles: { add: 'Yangi qoida', edit: 'Qoidani tahrirlash' },
  subtitle: 'Manzil va u qaysi kanal orqali borishini tanlang.',
  kindLabel: 'Turi',
  kinds: { ip: 'IP', subnet: 'Subnet', domain: 'Domen' } satisfies Readonly<Record<RuleKind, string>>,
  /** Label and hint of the address field, per kind (the design's words). */
  targetField: {
    ip: { label: 'IP manzil', hint: "Bitta host uchun route qo'shiladi. Wildcard ham bo'ladi: 10.*.*.* → 10.0.0.0/8 (subnet)." },
    subnet: { label: 'Subnet (CIDR)', hint: "Butun ichki tarmoq uchun eng ishonchli variant. Wildcard ham bo'ladi: 10.*.*.* → 10.0.0.0/8." },
    domain: { label: 'Domen', hint: "Domen IP'ga resolve qilinib, har bir IP uchun route qo'shiladi." },
  } satisfies Readonly<Record<RuleKind, { readonly label: string; readonly hint: string }>>,
  normalised: (target: string): string => `${target} sifatida saqlanadi.`,
  /** An IP wildcard (`10.*.*.*`) and the subnet it is saved as (the shared normaliser's CIDR). */
  wildcardResult: (cidr: string): string => `→ ${cidr} (subnet)`,
  sameAs: (target: string): string => `Bu manzil «${target}» qoidasida ham bor (shu interfeys) — ikkinchi qoida ortiqcha.`,
  useDns: 'Ichki DNS server orqali resolve qilish',
  dnsAddress: 'DNS server manzili',
  refreshLabel: "IP'larni yangilash oralig'i (soniya)",
  resolverFile: (domain: string): string => `/etc/resolver/${domain} fayli yaratiladi. `,
  /** "IP'lar har 10 daqiqada yangilanadi." — whole minutes or seconds. */
  refreshMinutes: (minutes: number): string => `IP'lar har ${String(minutes)} daqiqada yangilanadi.`,
  refreshSeconds: (seconds: number): string => `IP'lar har ${String(seconds)} soniyada yangilanadi.`,
  ifaceLabel: 'Interfeys',
  noteLabel: 'Izoh',
  notePlaceholder: 'Masalan: buxgalteriya tizimi',

  /** Field errors besides the shared validators' codes (`validation`). */
  errors: {
    wildcardDomain: "Wildcard domen (*.corp.local) qo'llab-quvvatlanmaydi — aniq domen kiriting, masalan corp.local.",
    upperCase: 'Domenni kichik harflarda yozing, masalan corp.local.',
    refresh: `${String(LIMITS.refreshSecMin)} dan ${String(LIMITS.refreshSecMax)} gacha butun son (soniya) kiriting.`,
    note: `Izoh ${String(LIMITS.noteMaxLength)} belgidan oshmasin.`,
    targetEmpty: 'Manzilni kiriting.',
    targetLong: `Manzil ${String(LIMITS.targetMaxLength)} belgidan oshmasin.`,
    dnsEmpty: 'DNS server manzilini kiriting (yoki belgini olib tashlang).',
    invalidRule: 'Qoida yaroqsiz.',
    ifaceConflict: (target: string, role: string): string =>
      `Bu manzil «${target}» qoidasida ${role} orqali yo'naltirilgan — bitta manzil ikki interfeysga bog'lanmaydi.`,
    tooManyRules: `${String(LIMITS.maxRules)} tadan ortiq qoida qo'shib bo'lmaydi.`,
  },

  /** The command preview: its label and the notes under the lines. */
  previewLabel: "Helper qo'llaydigan buyruq — ko'rsatish uchun, ilova uni yuritmaydi",
  previewNoHelper: "Buyruq helper ulanganda ko'rinadi (gateway undan olinadi).",
  previewNoAdapter: (role: string): string => `${role} adapteri topilmadi — qoida «Kutilmoqda» bo'ladi va ulanganda qo'llanadi.`,
  previewNoGateway: (role: string): string => `${role} gateway'i yo'q — qoida «Kutilmoqda» bo'ladi va ulanganda qo'llanadi.`,
  previewDown: (role: string): string => `${role} ulanmagan — qoida «Kutilmoqda» bo'ladi va ulanganda qo'llanadi.`,
  previewEachIp: 'Har bir resolve qilingan IP uchun.',
  previewEachIpDns: "Har bir resolve qilingan IP uchun; DNS server — o'z tarmog'ida bo'lmasa.",

  /** "Sinab ko'rish". */
  test: "Sinab ko'rish",
  testOff: (reason: string): string => `Sinab ko'rish — ${reason}`,
  testAddress: (address: string): string => `${address} manzilini sinab ko'rish`,
  testIdle: (address: string): string => `${address} hozir qaysi interfeys orqali ketishini tekshiradi (route -n get).`,
  testRunning: (address: string): string => `${address} tekshirilmoqda…`,
  testNoHelper: "Helper bilan aloqa yo'q.",
  testEnterValid: "Avval to'g'ri manzil kiriting.",
  testSubnetUntestable: "Bu subnetdagi manzilni sinab bo'lmaydi.",
  testDomainSaveFirst: "Domen IP'lari helper resolve qilgandan keyin sinaladi — avval saqlang.",
  testDomainNotResolved: "Domen hali resolve qilinmagan yoki route qo'yilmagan.",
  testNoRoute: 'Bu manzil uchun route topilmadi.',
  testFailed: (why: string): string => `Sinab bo'lmadi: ${why}`,
  testMatch: 'Mos',
  testMismatch: 'Mos emas',
  /** The route line: "→ en5 (Ethernet) · gateway 10.20.4.1". */
  testDirect: "to'g'ridan-to'g'ri",
  testGateway: (gateway: string): string => `gateway ${gateway}`,
  testByThisRule: (role: string): string => `Shu qoida bo'yicha ${role} orqali ketadi.`,
  testGoesVia: (role: string): string => `Hozir ${role} orqali ketadi.`,
  testOtherNow: 'Hozir boshqa interfeys orqali ketadi',
  testRoleNow: (role: string): string => `Hozir ${role} orqali ketadi`,
  /** `now` is `testOtherNow` / `testRoleNow`. */
  testNotRole: (now: string, role: string): string => `${now}, ${role} emas.`,
  testAfterSave: (now: string, role: string): string => `${now} — saqlangandan keyin ${role} orqali bo'ladi.`,

  /** The dialog's status and buttons. */
  helperDown: (status: string): string => `${status} — qoidani saqlab bo'lmaydi.`,
  loadingRule: "Qoida o'qilmoqda…",
  missingRule: "Bu qoida endi yo'q — boshqa oynada o'chirilgan bo'lishi mumkin.",
  readFailed: (why: string): string => `Qoidani o'qib bo'lmadi: ${why}`,
  readNoHelper: "Helper bilan aloqa yo'q — qoidani o'qib bo'lmaydi.",
  cancel: 'Bekor qilish',
  save: "Saqlash va qo'llash",
  saveRefused: "Qoida saqlanmadi: helper uni qabul qilmadi (manzil yoki qoidalar soni cheklovdan o'tmadi).",
  saveFailed: (why: string): string => `Qoida saqlanmadi: ${why}`,
};
