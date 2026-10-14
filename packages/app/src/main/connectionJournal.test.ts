import { describe, expect, it } from 'vitest';

import {
  CONNECTION_JOURNAL_BUDGET,
  CONNECTION_JOURNAL_WINDOW_MS,
  createConnectionJournal,
  journalLineOf,
} from './connectionJournal';
import type { HelperStatus } from './helperClient';
import { createLogBuffer } from './logBuffer';

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0);

function harness() {
  let now = T0;
  const logBuffer = createLogBuffer({ onListenerError: () => undefined });
  const journal = createConnectionJournal({ logBuffer, now: () => now });
  return {
    journal,
    entries: () => logBuffer.entries(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const connected: HelperStatus = { kind: 'connected', helperVersion: '0.1.0' };
const lost: HelperStatus = { kind: 'disconnected', reason: 'connection-lost' };

describe('journalLineOf', () => {
  it.each<[HelperStatus, string, string]>([
    [connected, 'info', "Helper bilan aloqa o'rnatildi (v0.1.0)"],
    [{ kind: 'not-installed' }, 'warn', "Helper o'rnatilmagan — qoidalar qo'llanmaydi"],
    [{ kind: 'disconnected', reason: 'not-running' }, 'warn', "Helper bilan aloqa yo'q: helper ishlamayapti (socket bor, javob yo'q)"],
    [{ kind: 'disconnected', reason: 'permission-denied' }, 'warn', "Helper bilan aloqa yo'q: helper socket'iga ruxsat yo'q"],
    [lost, 'warn', "Helper bilan aloqa yo'q: aloqa uzildi"],
    [{ kind: 'disconnected', reason: 'protocol-error' }, 'warn', "Helper bilan aloqa yo'q: helper tushunarsiz javob berdi"],
    [{ kind: 'disconnected', reason: 'timeout' }, 'warn', "Helper bilan aloqa yo'q: helper javob bermadi"],
    [{ kind: 'disconnected', reason: 'error' }, 'warn', "Helper bilan aloqa yo'q: helper'ga ulanib bo'lmadi"],
    [{ kind: 'config-unreadable', helperVersion: '0.1.0' }, 'error', "Helper saqlangan config'ni o'qiy olmadi — hech bir qoida qo'llanmaydi. Import yoki bo'sh config bilan tiklang"],
    [{ kind: 'incompatible', helperVersion: '9.0.0', protocolVersion: 9, expectedProtocolVersion: 2 }, 'error', 'Helper versiyasi mos emas: v9.0.0, protokol 9 (kerak: 2)'],
  ])('%j → %s', (status, level, msg) => {
    expect(journalLineOf(status)).toEqual({ level, msg });
  });

  it('writes nothing for the steps: connecting, stopped', () => {
    expect(journalLineOf({ kind: 'connecting' })).toBeNull();
    expect(journalLineOf({ kind: 'stopped' })).toBeNull();
  });
});

describe('createConnectionJournal', () => {
  it('writes each change once, marked as the app, with the time of the change', () => {
    const h = harness();
    h.journal.record({ kind: 'connecting' });
    h.journal.record(connected);
    h.advance(5_000);
    h.journal.record(lost);
    h.journal.record({ kind: 'connecting' });
    // A failed retry ends where it began: the same news is not written again.
    h.journal.record(lost);
    h.journal.record({ kind: 'disconnected', reason: 'not-running' });
    expect(h.entries()).toEqual([
      { seq: 1, level: 'info', msg: "Helper bilan aloqa o'rnatildi (v0.1.0)", at: new Date(T0).toISOString(), source: 'app' },
      { seq: 2, level: 'warn', msg: "Helper bilan aloqa yo'q: aloqa uzildi", at: new Date(T0 + 5_000).toISOString(), source: 'app' },
      {
        seq: 3,
        level: 'warn',
        msg: "Helper bilan aloqa yo'q: helper ishlamayapti (socket bor, javob yo'q)",
        at: new Date(T0 + 5_000).toISOString(),
        source: 'app',
      },
    ]);
  });

  it('keeps a flapping connection to its budget per window, says so once, and writes again in the next window', () => {
    const h = harness();
    for (let i = 0; i < 100; i += 1) h.journal.record(i % 2 === 0 ? connected : lost);
    const first = h.entries();
    expect(first).toHaveLength(CONNECTION_JOURNAL_BUDGET + 1);
    expect(first.at(-1)?.msg).toBe("Helper bilan aloqa tez-tez o'zgarmoqda — keyingi o'zgarishlar 10 daqiqagacha jurnalga yozilmaydi");
    h.advance(CONNECTION_JOURNAL_WINDOW_MS - 1);
    h.journal.record(connected);
    h.journal.record(lost);
    expect(h.entries()).toHaveLength(CONNECTION_JOURNAL_BUDGET + 1);
    h.advance(1);
    h.journal.record(connected);
    expect(h.entries()).toHaveLength(CONNECTION_JOURNAL_BUDGET + 2);
    expect(h.entries().at(-1)?.msg).toBe("Helper bilan aloqa o'rnatildi (v0.1.0)");
  });

  it('a clock that went back starts a new window instead of silencing for good', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) h.journal.record(i % 2 === 0 ? connected : lost);
    const before = h.entries().length;
    h.advance(-60_000);
    h.journal.record(connected);
    expect(h.entries()).toHaveLength(before + 1);
  });
});
