// The words for a failed `window.rs` call, shared by every screen. The
// English `error` of an `RsResult` is for the log and is never shown.

import type { RsErrorCode } from '../rs';

export interface Feedback {
  readonly tone: 'success' | 'danger';
  readonly text: string;
}

/** The words for a failed call. */
export function errorText(code: RsErrorCode): string {
  switch (code) {
    case 'not-connected':
      return "Helper bilan aloqa yo'q — hech narsa yuborilmadi.";
    case 'disconnected':
    case 'timeout':
      return "Javob kelmadi: natija noma'lum. Helper qayta ulanganda holat yangilanadi.";
    case 'busy':
      return "Helper band — birozdan keyin qayta urinib ko'ring.";
    case 'not-implemented':
      return "O'rnatilgan helper bu amalni hali bajara olmaydi.";
    case 'invalid-config':
    case 'invalid-input':
      return 'Qiymat qabul qilinmadi.';
    case 'operation-failed':
      return 'Amal bajarilmadi.';
    case 'forbidden':
      return "Bu oynadan ruxsat yo'q.";
    case 'file-unreadable':
      return "Faylni o'qib bo'lmadi.";
    case 'file-not-regular':
      return 'Tanlangan narsa oddiy fayl emas.';
    case 'file-too-large':
      return 'Fayl juda katta (1 MB dan ortiq) — bu config fayli emas.';
    case 'file-not-text':
      return 'Fayl UTF-8 matn emas.';
    case 'file-not-json':
      return "Fayl JSON emas yoki buzilgan.";
    case 'import-expired':
      return "Tanlangan fayl muddati o'tdi — faylni qayta tanlang.";
    case 'write-failed':
      return "Faylni yozib bo'lmadi — boshqa joyni tanlang.";
    case 'install-unavailable':
      return "Ilova ichida helper paketi topilmadi yoki u ishonchsiz (symlink yoki boshqa foydalanuvchi o'zgartira oladi) — ilovani qayta o'rnating.";
    case 'install-cancelled':
      return "Parol oynasi yopildi — hech narsa o'zgarmadi. Qayta urinib ko'rishingiz mumkin.";
    case 'install-denied':
      return "Administrator paroli qabul qilinmadi — hech narsa o'zgarmadi. Qayta urinib ko'ring.";
    case 'install-failed':
      return "Skript xato bilan tugadi. Batafsil: /Library/Logs/RouteSwitch/helper.log. Qayta urinib ko'rishingiz mumkin.";
    default:
      return `Kutilmagan xato (${code}).`;
  }
}
