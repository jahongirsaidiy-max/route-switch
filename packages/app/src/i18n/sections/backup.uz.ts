// The rules backup (TASK-DELTA-16), in Uzbek: the source of the `backup`
// keys — the restore offer (menu bar, rules window), the preview's first
// line and the settings card. `time` is already formatted (`formatTime`).

export const backupUz = {
  /** The offer's title: the helper holds no rules, the app's backup does. */
  offerTitle: (count: number): string => `Oldingi qoidalarni tiklash (${String(count)})`,
  offerText: (time: string): string =>
    `Helper'da qoidalar yo'q, lekin ilovada ${time} dagi zaxira bor. Ko'rib chiqing — tasdiqlamaguningizcha hech narsa o'zgarmaydi.`,
  review: "Ko'rib chiqish",
  dismiss: 'Kerak emas',
  /** The menu bar's button: the preview lives in the rules window. */
  openRules: 'Qoidalar oynasida ochish',
  /** The first line of the restore preview. */
  previewFrom: (time: string): string => `Zaxira (${time}).`,
  restored: (count: number): string => `Qoidalar zaxiradan tiklandi: ${String(count)} ta qoida.`,
  restoreFailed: (why: string): string => `Zaxiradan tiklanmadi: ${why}`,
  dismissFailed: (why: string): string => `Taklifni yopib bo'lmadi: ${why}`,
  settings: {
    title: 'Qoidalar zaxirasi',
    hint: "Ilova helper'dan olgan oxirgi qoidalar nusxasini sizning foydalanuvchi papkangizda saqlaydi (faqat siz o'qiy olasiz). Helper o'chirilsa ham zaxira qoladi; tiklash faqat ko'rib chiqib, tasdiqlagandan keyin.",
    summary: (count: number, time: string): string => `Zaxira: ${String(count)} ta qoida, ${time}`,
    none: "Zaxira hali yo'q — qoidalar qo'shilgach avtomatik saqlanadi.",
    loading: 'Zaxira tekshirilmoqda…',
    restore: 'Zaxiradan tiklash',
    remove: "Zaxirani o'chirish",
    removeQuestion: "Zaxira rostdan ham o'chirilsinmi? Helper'dagi qoidalarga tegilmaydi.",
    removeConfirm: "Ha, o'chirish",
    cancel: 'Bekor qilish',
    removed: "Zaxira o'chirildi.",
    removeFailed: (why: string): string => `Zaxira o'chirilmadi: ${why}`,
    needsHelper: "Tiklash uchun helper ulangan bo'lishi kerak.",
  },
};
