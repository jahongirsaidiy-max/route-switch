// Uzbek: the source of every key. `Messages` (types.ts) is this object's
// shape; `ru.ts` and `en.ts` must fill exactly the same keys. Tables keyed
// by a closed set of codes are checked against that set here (`satisfies`),
// so a new code of the protocol fails `tsc` until it has words.

import {
  LIMITS,
  MIN_SUBNET_PREFIX,
  type ReconcileReason,
  type RuleReasonCode,
  type ValidationCode,
} from '@routeswitch/shared';

import type { RsConnection, RsErrorCode } from '../renderer/src/rs';
import { addRuleUz } from './sections/addRule.uz';
import { rulesUz } from './sections/rules.uz';
import { menuBarUz } from './sections/menuBar.uz';
import { shellUz } from './sections/shell.uz';
import { componentsUz } from './sections/components.uz';
import { logUz } from './sections/log.uz';
import { settingsUz } from './sections/settings.uz';

/** What the UI shows about the helper: the connection kinds plus the renderer's own two. */
export type HelperStatusKey = RsConnection['kind'] | 'loading' | 'unavailable';
/** Why an installed helper is not reachable now. */
export type DisconnectedReason = Extract<RsConnection, { kind: 'disconnected' }>['reason'];
/** The field names of a rule (and the config) that a refused import file may name. */
export type ConfigFieldKey = 'id' | 'kind' | 'target' | 'iface' | 'dns' | 'refreshSec' | 'note' | 'enabled';
/** Codes of a refused config file that are not the validators' own: cross-rule checks, the structure walk, zod's. */
export type ConfigIssueKey =
  | 'iface-conflict'
  | 'duplicate-id'
  | 'too-many-values'
  | 'array-too-long'
  | 'too-deep'
  | 'string-too-long'
  | 'invalid_type'
  | 'invalid_value'
  | 'too_small'
  | 'too_big'
  | 'invalid_format';

const unexpected = (code: string): string => `Kutilmagan xato (${code}).`;

export const uz = {
  /** The page was opened for a window it does not know. */
  unknownWindow: "Noma'lum oyna. Ilovani menu bar ikonkasidan qayta oching.",

  /** A failure code the UI has no words for (only from a newer main process or helper). */
  unexpectedError: unexpected,

  /** The menu bar window (TASK-DELTA-12; `sections/menuBar.*.ts`). */
  menuBar: menuBarUz,
  /** The tray, the main process's dialogs and its journal lines (TASK-DELTA-12; `sections/shell.*.ts`). */
  ...shellUz,

  /** A failed `window.rs` call. */
  errors: {
    'not-connected': "Helper bilan aloqa yo'q — hech narsa yuborilmadi.",
    disconnected: "Javob kelmadi: natija noma'lum. Helper qayta ulanganda holat yangilanadi.",
    timeout: "Javob kelmadi: natija noma'lum. Helper qayta ulanganda holat yangilanadi.",
    busy: "Helper band — birozdan keyin qayta urinib ko'ring.",
    'not-implemented': "O'rnatilgan helper bu amalni hali bajara olmaydi.",
    'invalid-config': 'Qiymat qabul qilinmadi.',
    'invalid-input': 'Qiymat qabul qilinmadi.',
    'operation-failed': 'Amal bajarilmadi.',
    forbidden: "Bu oynadan ruxsat yo'q.",
    'file-unreadable': "Faylni o'qib bo'lmadi.",
    'file-not-regular': 'Tanlangan narsa oddiy fayl emas.',
    'file-too-large': 'Fayl juda katta (1 MB dan ortiq) — bu config fayli emas.',
    'file-not-text': 'Fayl UTF-8 matn emas.',
    'file-not-json': 'Fayl JSON emas yoki buzilgan.',
    'import-expired': "Tanlangan fayl muddati o'tdi — faylni qayta tanlang.",
    'write-failed': "Faylni yozib bo'lmadi — boshqa joyni tanlang.",
    'install-unavailable':
      "Ilova ichida helper paketi topilmadi yoki u ishonchsiz (symlink yoki boshqa foydalanuvchi o'zgartira oladi) — ilovani qayta o'rnating.",
    'install-cancelled': "Parol oynasi yopildi — hech narsa o'zgarmadi. Qayta urinib ko'rishingiz mumkin.",
    'install-denied': "Administrator paroli qabul qilinmadi — hech narsa o'zgarmadi. Qayta urinib ko'ring.",
    'install-failed':
      "Skript xato bilan tugadi. Batafsil: /Library/Logs/RouteSwitch/helper.log. Qayta urinib ko'rishingiz mumkin.",
    'invalid-json': unexpected('invalid-json'),
    'line-too-long': unexpected('line-too-long'),
    'invalid-request': unexpected('invalid-request'),
    'unknown-method': unexpected('unknown-method'),
    internal: unexpected('internal'),
    'invalid-response': unexpected('invalid-response'),
    unspecified: unexpected('unspecified'),
    'rule-not-found': unexpected('rule-not-found'),
  } satisfies Readonly<Record<RsErrorCode, string>>,

  /** The short helper status line (rules window sidebar, settings). */
  helperStatus: {
    loading: 'Tekshirilmoqda…',
    connected: 'Helper ishlayapti',
    connecting: 'Helper bilan ulanmoqda…',
    'not-installed': "Helper o'rnatilmagan",
    disconnected: 'Helper ishlamayapti',
    'config-unreadable': "Helper config'i buzilgan",
    incompatible: 'Helper versiyasi mos emas',
    stopped: "Ilova to'xtamoqda",
    unavailable: "Holatni o'qib bo'lmadi",
  } satisfies Readonly<Record<HelperStatusKey, string>>,

  /** Installing the helper from the app (TASK-214). */
  install: {
    install: "Helper'ni o'rnatish",
    reinstall: "Helper'ni qayta o'rnatish",
    waiting: "Administrator paroli so'raladi (macOS oynasi). O'rnatish bir daqiqagacha davom etishi mumkin.",
    installed: "Helper o'rnatildi — ulanmoqda…",
    removed: "Helper butunlay o'chirildi: route'lar, resolver fayllari, daemon, config va log olib tashlandi.",
  },

  /** The notice a screen shows in place of its content while there is no live state. */
  notice: {
    loadingTitle: "Holat o'qilmoqda…",
    connectingTitle: 'Helper bilan ulanmoqda…',
    notInstalledTitle: "Helper o'rnatilmagan",
    notInstalledText: "Routing uchun helper bir marta administrator paroli bilan o'rnatiladi. Hozircha hech bir qoida qo'llanmaydi.",
    disconnectedTitle: "Helper bilan aloqa yo'q",
    routesStay: "Qo'llangan route'lar helper'da qoladi.",
    disconnected: {
      'not-running': "Helper ishlamayapti. U launchd orqali qayta ishga tushadi; bo'lmasa qayta o'rnating.",
      'permission-denied': "Helper socket'iga ruxsat yo'q (foydalanuvchi staff guruhida emas).",
      'connection-lost': 'Aloqa uzildi — qayta ulanmoqda.',
      'protocol-error': 'Helper tushunarsiz javob berdi — qayta ulanmoqda.',
      timeout: 'Helper javob bermadi — qayta ulanmoqda.',
      error: "Helper'ga ulanib bo'lmadi — qayta urinilmoqda.",
    } satisfies Readonly<Record<DisconnectedReason, string>>,
    configUnreadableTitle: "Helper config'i buzilgan",
    configUnreadableText:
      "Helper ishlayapti, lekin saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmayapti. «Qoidalar» bo'limida config'ni import qiling yoki bo'sh config bilan boshlang.",
    incompatibleTitle: 'Helper versiyasi mos emas',
    incompatibleText: (helperVersion: string, protocolVersion: number, expected: number): string =>
      `Helper v${helperVersion} boshqa protokolda (${String(protocolVersion)}, kerak: ${String(expected)}). Helper'ni qayta o'rnating.`,
    reinstall: "Helper'ni qayta o'rnating.",
    stoppedTitle: "Ilova to'xtamoqda",
    unavailableTitle: "Holatni o'qib bo'lmadi",
  },

  /** Why a rule is in its status. */
  ruleReason: {
    'rule-disabled': "Qoida o'chirilgan",
    'globally-disabled': "Routing o'chirilgan",
    'interface-down': 'Interfeys ulanmagan',
    'no-gateway': "Interfeysda gateway yo'q",
    resolving: 'Domen resolve qilinmoqda',
    'resolve-failed': "DNS so'rovi bajarilmadi",
    'no-addresses': "Domenning IPv4 manzili (A-yozuvi) yo'q",
    'forbidden-destination': "Taqiqlangan manzil — default route himoyasi uni yo'naltirmaydi",
    'connected-network': "Manzil interfeysning o'z tarmog'i yoki gateway'i bilan ustma-ust — route qo'shilmadi",
    'route-failed': "Route qo'shilmadi",
    'resolver-conflict': '/etc/resolver da shu domen uchun begona fayl bor',
    'resolver-failed': 'Resolver fayli yozilmadi',
    internal: 'Helper ichki xatosi',
    'addresses-truncated': "Manzillar juda ko'p — faqat bir qismi yo'naltirildi",
    'overridden-by-rule': "Ba'zi manzillar boshqa qoida orqali boshqa interfeysga yo'naltirilgan",
    'dns-server-excluded': "Ba'zi manzillar DNS server — ular yo'naltirilmaydi",
  } satisfies Readonly<Record<RuleReasonCode, string>>,

  /** What triggered the last reconcile, as the end of "Oxirgi qo'llash: 10:58 · …". */
  reconcileReason: {
    startup: 'helper ishga tushganda',
    'config-change': "qoidalar o'zgarganda",
    'enabled-change': "routing yoqilganda yoki o'chirilganda",
    manual: "qo'lda",
    'network-change': "tarmoq o'zgarganda",
    'dns-refresh': 'DNS yangilanganda',
    'drift-check': 'davriy tekshiruvda',
  } satisfies Readonly<Record<ReconcileReason, string>>,

  /** One sentence per code of the shared validators. */
  validation: {
    'invalid-ipv4': 'IPv4 manzil kiriting, masalan 172.16.12.40.',
    'invalid-cidr': "Subnetni CIDR ko'rinishida kiriting, masalan 10.0.0.0/8.",
    'invalid-prefix': `Prefiks ${String(MIN_SUBNET_PREFIX)} dan 32 gacha bo'lishi kerak.`,
    'prefix-too-wide': `Subnet juda keng: prefiks kamida /${String(MIN_SUBNET_PREFIX)} bo'lishi kerak.`,
    'invalid-domain': "Domen faqat kichik lotin harflari, raqamlar, «-» va «.» dan iborat bo'ladi, masalan corp.local.",
    'invalid-wildcard': "Wildcard'da «*» faqat oxirgi oktetlarda bo'ladi, masalan 10.*.*.* yoki 192.168.5.*.",
    'invalid-destination': 'IPv4 manzil yoki CIDR subnet kiriting.',
    'default-route': "Default route (0.0.0.0/0) hech qachon o'zgartirilmaydi.",
    'this-network': '0.0.0.0/8 manzillari route qilinmaydi.',
    loopback: 'Loopback manzillari (127.0.0.0/8) route qilinmaydi.',
    'link-local': 'Link-local manzillari (169.254.0.0/16) route qilinmaydi.',
    multicast: 'Multicast manzillari (224.0.0.0/4) route qilinmaydi.',
    broadcast: '255.255.255.255 route qilinmaydi.',
  } satisfies Readonly<Record<ValidationCode, string>>,

  /** Where and why a config file breaks the schema (config import). */
  configFile: {
    fields: {
      id: 'id',
      kind: 'turi',
      target: 'manzil',
      iface: 'interfeys',
      dns: 'DNS server',
      refreshSec: "yangilash oralig'i",
      note: 'izoh',
      enabled: 'holat',
    } satisfies Readonly<Record<ConfigFieldKey, string>>,
    issues: {
      'iface-conflict': "bir manzil ikki interfeysga bog'langan.",
      'duplicate-id': "qoida id'si takrorlangan.",
      'too-many-values': 'fayl juda katta yoki juda chuqur.',
      'array-too-long': `${String(LIMITS.maxRules)} tadan ortiq qoida.`,
      'too-deep': 'fayl juda katta yoki juda chuqur.',
      'string-too-long': 'juda uzun matn.',
      invalid_type: "qiymat turi noto'g'ri yoki qiymat yo'q.",
      invalid_value: "qiymat noto'g'ri.",
      too_small: 'qiymat juda kichik yoki qisqa.',
      too_big: 'qiymat juda katta yoki uzun.',
      invalid_format: "qiymat ko'rinishi noto'g'ri.",
    } satisfies Readonly<Record<ConfigIssueKey, string>>,
    invalidValue: "qiymat noto'g'ri.",
    notAConfig: "Fayl config ko'rinishiga mos emas.",
    wrongVersion: "Config versiyasi mos emas (kutilgan: 1) — fayl boshqa versiyadan.",
    tooManyRules: `${String(LIMITS.maxRules)} tadan ortiq qoida.`,
    /** "3-qoida: " / "3-qoida, manzil: " — `index` counts from 1. */
    ruleAt: (index: number, field: string | null): string => `${String(index)}-qoida${field === null ? '' : `, ${field}`}: `,
    ifaceOverridesAt: 'Interfeys almashtirishlari: ',
    enabledAt: 'Umumiy holat: ',
  },

  /** Warnings about the network that are not a rule's own error. */
  network: {
    adapterMissing: (role: string): string => `${role} adapteri topilmadi`,
    noGateway: (role: string): string => `${role}'da gateway yo'q`,
    notConnected: (role: string): string => `${role} ulanmagan`,
    rulesWaiting: (count: number): string =>
      `${String(count)} ta qoida kutilmoqda — interfeys ulanganda avtomatik qo'llanadi.`,
    rulesWaitingUncounted: "Unga bog'langan qoidalar kutilmoqda — interfeys ulanganda avtomatik qo'llanadi.",
    sameSubnetTitle: 'Ethernet va Wi‑Fi bitta tarmoqda',
    sameSubnetText: (gateway: string): string =>
      `Ikkalasining gateway'i ${gateway}: gateway orqali route ishonchsiz — trafik qaysi interfeysdan chiqishini tizim tanlaydi. Interfeyslardan birini boshqa tarmoqqa ulang.`,
    lastKnownNone: "Oxirgi ma'lum IP yo'q — domen hozir yo'naltirilmayapti.",
    /** `addresses` is already "10.0.0.5, 10.0.0.6 +2"; `when` is "" or " · 12 daq oldin". */
    lastKnown: (addresses: string, when: string): string => `Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): ${addresses}${when}`,
  },

  /** "N daq oldin" (`formatAgo`). */
  time: {
    justNow: 'hozirgina',
    minutesAgo: (minutes: number): string => `${String(minutes)} daq oldin`,
    hoursAgo: (hours: number): string => `${String(hours)} soat oldin`,
    daysAgo: (days: number): string => `${String(days)} kun oldin`,
  },

  /** The language card of the settings screen; its title is the same in every language (`LANGUAGE_PICKER_TITLE`). */
  settingsLanguage: {
    hint: "Ilova matnlari shu tilda ko'rsatiladi. Helper jurnalidagi yozuvlar inglizcha qoladi.",
    saved: "Til o'zgartirildi.",
  },

  /** The journal, settings and shared components (TASK-DELTA-14): `sections/*.ts`. */
  log: logUz,
  settings: settingsUz,
  components: componentsUz,

  /** The rules window and the add-rule dialog (TASK-DELTA-13): `sections/rules.*`, `sections/addRule.*`. */
  rules: rulesUz,
  addRule: addRuleUz,
};
