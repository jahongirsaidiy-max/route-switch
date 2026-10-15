// The settings screen (TASK-DELTA-14), in Uzbek: the source of the `settings`
// keys. The language card has its own (`settingsLanguage`). The
// `networksetup` command the Wi‑Fi card shows is never translated.

export const settingsUz = {
  title: 'Sozlamalar',
  subtitle: "Ilova va helper sozlamalari. Qoidalar helper'da saqlanadi.",
  login: {
    title: "Login'da ishga tushirish",
    hint: "Kompyuterga kirganda RouteSwitch menu bar'da ochiladi. Route'lar ilovasiz ham ishlayveradi — ularni helper ushlab turadi.",
    on: "RouteSwitch login'da ishga tushadi.",
    off: "Login'da ishga tushish o'chirildi.",
    refused: 'macOS sozlamani qabul qilmadi (Tizim sozlamalari → Login elementlari).',
  },
  ethernet: {
    title: 'Ethernet adapteri',
    /** `detected` — the adapter the engine picked, or null. */
    hint: (detected: string | null): string =>
      `Odatda birinchi IP manzili bor, Wi‑Fi bo'lmagan adapter olinadi${detected === null ? '' : ` (hozir: ${detected})`}. Bir nechta adapter bo'lsa, keraklisini tanlang.`,
    fieldLabel: 'Ethernet roli uchun adapter',
    auto: 'Avtomatik',
    noIp: "IP yo'q",
    /** A chosen adapter that is not plugged in. */
    notConnected: (device: string): string => `${device} · ulanmagan`,
    needsHelper: 'Helper ulanganda tanlash mumkin.',
    savedAuto: 'Ethernet adapteri avtomatik aniqlanadi.',
    saved: (device: string): string => `Ethernet roli endi ${device} da.`,
  },
  wifi: {
    title: "Wi‑Fi'ni default qilish",
    hint: "Qoidaga tushmagan trafik xizmatlar tartibidagi birinchi ulangan tarmoqdan ketadi. Bu tartibni o'zgartirish administrator huquqini talab qiladi, shuning uchun RouteSwitch buyruqni faqat ko'rsatadi — uni Terminal'da o'zingiz bajarasiz.",
    loading: "Xizmatlar tartibi o'qilmoqda…",
    failed: "Xizmatlar tartibini o'qib bo'lmadi.",
    notFound: 'Wi‑Fi xizmati topilmadi.',
    alreadyFirst: (service: string): string => `${service} allaqachon birinchi — default kanal Wi‑Fi.`,
    currentFirst: (service: string): string => `Hozir birinchi: ${service}.`,
    /** Accessible name of the command block. */
    commandLabel: "Wi‑Fi'ni birinchi qiladigan buyruq",
    copy: 'Nusxalash',
    refresh: 'Yangilash',
    copied: "Buyruq nusxalandi — Terminal'ga qo'ying.",
  },
  helper: {
    title: 'Helper',
    hint: "O'chirish administrator parolini so'raydi: helper qo'shgan barcha route'lar va resolver fayllari olib tashlanadi, root daemon to'xtaydi va uning fayllari — config (qoidalar) va log ham — o'chadi. Qoidalaringiz nusxasi ilovaning zaxirasida qoladi va helper qayta o'rnatilgach tiklashni taklif qiladi; boshqa kompyuterga o'tkazish uchun Export qiling.",
    uninstall: "Helper'ni o'chirish",
    question: "Helper rostdan ham o'chirilsinmi? Qoidalar ilova zaxirasida qoladi — qayta o'rnatgandan keyin tiklashingiz mumkin.",
    confirm: "Ha, o'chirish",
    cancel: 'Bekor qilish',
  },
};
