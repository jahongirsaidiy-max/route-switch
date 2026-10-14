// The app's own lines in the journal: what happened to the helper connection
// (lost, back, never installed, config unreadable). The helper cannot report
// these — it is the one that is gone — so the main process writes them into
// the same buffer as the helper's `log` events, marked `source: 'app'`, in the
// UI's words.
//
// Only real changes are written: `connecting` and `stopped` are steps, not
// news, and a status equal to the last one written is skipped. A peer that
// makes the status flap could still fill the journal and push the helper's
// own lines out, so the app's lines share a budget per window of time.

import type { EventLogLevel } from '@routeswitch/shared';

import type { HelperStatus } from './helperClient';
import type { LogBuffer } from './logBuffer';

/** At most this many app lines per window … */
export const CONNECTION_JOURNAL_BUDGET = 20;
/** … of this length; one more line says that the rest of the window is not written. */
export const CONNECTION_JOURNAL_WINDOW_MS = 10 * 60 * 1000;

const DISCONNECT_WORDS: Readonly<Record<Extract<HelperStatus, { kind: 'disconnected' }>['reason'], string>> = {
  'not-running': "helper ishlamayapti (socket bor, javob yo'q)",
  'permission-denied': "helper socket'iga ruxsat yo'q",
  'connection-lost': 'aloqa uzildi',
  'protocol-error': 'helper tushunarsiz javob berdi',
  timeout: 'helper javob bermadi',
  error: "helper'ga ulanib bo'lmadi",
};

export interface JournalLine {
  readonly level: EventLogLevel;
  readonly msg: string;
}

/** The line for a status; null for the steps that are not written (`connecting`, `stopped`). */
export function journalLineOf(status: HelperStatus): JournalLine | null {
  switch (status.kind) {
    case 'connecting':
    case 'stopped':
      return null;
    case 'connected':
      return { level: 'info', msg: `Helper bilan aloqa o'rnatildi (v${status.helperVersion})` };
    case 'not-installed':
      return { level: 'warn', msg: "Helper o'rnatilmagan — qoidalar qo'llanmaydi" };
    case 'disconnected':
      return { level: 'warn', msg: `Helper bilan aloqa yo'q: ${DISCONNECT_WORDS[status.reason]}` };
    case 'config-unreadable':
      return {
        level: 'error',
        msg: "Helper saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmaydi. Import yoki bo'sh config bilan tiklang",
      };
    case 'incompatible':
      return {
        level: 'error',
        msg: `Helper versiyasi mos emas: v${status.helperVersion}, protokol ${String(status.protocolVersion)} (kerak: ${String(status.expectedProtocolVersion)})`,
      };
  }
}

/** What makes two statuses the same news. */
const keyOf = (status: HelperStatus): string =>
  status.kind === 'disconnected' ? `disconnected:${status.reason}` : status.kind;

export interface ConnectionJournalDeps {
  readonly logBuffer: Pick<LogBuffer, 'push'>;
  /** Milliseconds since the epoch: the time of a line and of its budget window. */
  readonly now: () => number;
}

export interface ConnectionJournal {
  /** Called with every status of the helper client; writes a line when it is news and the budget allows. */
  readonly record: (status: HelperStatus) => void;
}

export function createConnectionJournal(deps: ConnectionJournalDeps): ConnectionJournal {
  let lastKey: string | null = null;
  let windowStart: number | null = null;
  let written = 0;
  let silenced = false;

  const write = (line: JournalLine, at: number): void => {
    deps.logBuffer.push({ level: line.level, msg: line.msg, at: new Date(at).toISOString(), source: 'app' });
  };

  return {
    record: (status) => {
      const line = journalLineOf(status);
      if (line === null) return;
      const key = keyOf(status);
      if (key === lastKey) return;
      lastKey = key;
      const at = deps.now();
      // A clock that went back counts as a new window (never a window that never ends).
      if (windowStart === null || at - windowStart >= CONNECTION_JOURNAL_WINDOW_MS || at < windowStart) {
        windowStart = at;
        written = 0;
        silenced = false;
      }
      if (written < CONNECTION_JOURNAL_BUDGET) {
        written += 1;
        write(line, at);
        return;
      }
      if (silenced) return;
      silenced = true;
      write({ level: 'warn', msg: "Helper bilan aloqa tez-tez o'zgarmoqda — keyingi o'zgarishlar 10 daqiqagacha jurnalga yozilmaydi" }, at);
    },
  };
}
