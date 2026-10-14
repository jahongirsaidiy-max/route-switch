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
    default:
      return `Kutilmagan xato (${code}).`;
  }
}
