import { describe, expect, it } from 'vitest';

import { i18nFor, type Locale } from '../i18n';
import {
  CONNECTION_JOURNAL_BUDGET,
  CONNECTION_JOURNAL_WINDOW_MS,
  createConnectionJournal,
  flappingLineOf,
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

describe('the language of the lines (TASK-DELTA-12)', () => {
  /** Every queued microtask has run once a macrotask comes round. */
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  it.each<[Locale, HelperStatus, string]>([
    ['ru', connected, 'Связь с helper установлена (v0.1.0)'],
    ['ru', { kind: 'not-installed' }, 'Helper не установлен — правила не применяются'],
    ['ru', lost, 'Нет связи с helper: связь прервалась'],
    ['ru', { kind: 'incompatible', helperVersion: '9.0.0', protocolVersion: 9, expectedProtocolVersion: 2 }, 'Версия helper не подходит: v9.0.0, протокол 9 (нужен: 2)'],
    ['en', connected, 'Connected to the helper (v0.1.0)'],
    ['en', { kind: 'disconnected', reason: 'permission-denied' }, "No connection to the helper: no permission for the helper's socket"],
    ['en', { kind: 'config-unreadable', helperVersion: '0.1.0' }, 'The helper could not read its saved config — no rule is applied. Restore it by importing a config or starting with an empty one'],
  ])('%s: %j → %s', (locale, status, msg) => {
    expect(journalLineOf(status, i18nFor(locale))?.msg).toBe(msg);
  });

  it('every status and reason has words in every language, and the level does not depend on the language', () => {
    const statuses: HelperStatus[] = [
      connected,
      { kind: 'not-installed' },
      ...(['not-running', 'permission-denied', 'connection-lost', 'protocol-error', 'timeout', 'error'] as const).map(
        (reason): HelperStatus => ({ kind: 'disconnected', reason }),
      ),
      { kind: 'config-unreadable', helperVersion: '0.1.0' },
      { kind: 'incompatible', helperVersion: '9.0.0', protocolVersion: 9, expectedProtocolVersion: 2 },
    ];
    for (const status of statuses) {
      const uz = journalLineOf(status);
      for (const locale of ['ru', 'en'] as const) {
        const line = journalLineOf(status, i18nFor(locale));
        expect(line?.level).toBe(uz?.level);
        expect(line?.msg).not.toBe(uz?.msg);
        expect(line?.msg).not.toMatch(/undefined/);
      }
    }
    expect(flappingLineOf(i18nFor('en')).msg).toMatch(/keeps changing/);
    expect(flappingLineOf(i18nFor('ru')).msg).toMatch(/часто меняется/);
  });

  it('a line is written in the language of the moment it is recorded, in order, with the time it was recorded', async () => {
    let now = T0;
    let language: Locale = 'ru';
    const logBuffer = createLogBuffer({ onListenerError: () => undefined });
    const journal = createConnectionJournal({ logBuffer, now: () => now, language: () => Promise.resolve(language) });
    journal.record(connected);
    now += 1_000;
    journal.record(lost);
    // Not yet: the lines wait for the language.
    expect(logBuffer.entries()).toEqual([]);
    await settle();
    language = 'en';
    now += 1_000;
    journal.record(connected);
    await settle();
    expect(logBuffer.entries().map((entry) => [entry.seq, entry.msg, entry.at])).toEqual([
      [1, 'Связь с helper установлена (v0.1.0)', new Date(T0).toISOString()],
      [2, 'Нет связи с helper: связь прервалась', new Date(T0 + 1_000).toISOString()],
      // The language changed: the new line is English, the lines before it stay Russian.
      [3, 'Connected to the helper (v0.1.0)', new Date(T0 + 2_000).toISOString()],
    ]);
  });

  it('a slow language answer does not reorder the lines; a failing one falls back to Uzbek', async () => {
    const logBuffer = createLogBuffer({ onListenerError: () => undefined });
    const answers: ((locale: Locale) => void)[] = [];
    let calls = 0;
    const journal = createConnectionJournal({
      logBuffer,
      now: () => T0,
      language: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('boom'));
        return new Promise<Locale>((resolve) => answers.push(resolve));
      },
    });
    journal.record(connected);
    journal.record(lost);
    journal.record({ kind: 'not-installed' });
    await settle();
    answers.shift()?.('en');
    await settle();
    answers.shift()?.('ru');
    await settle();
    expect(logBuffer.entries().map((entry) => entry.msg)).toEqual([
      'Connected to the helper (v0.1.0)',
      "Helper bilan aloqa yo'q: aloqa uzildi",
      'Helper не установлен — правила не применяются',
    ]);
  });

  it('the budget is counted when a line is recorded, not when it is written', async () => {
    const logBuffer = createLogBuffer({ onListenerError: () => undefined });
    const journal = createConnectionJournal({ logBuffer, now: () => T0, language: () => Promise.resolve<Locale>('en') });
    for (let i = 0; i < 100; i += 1) journal.record(i % 2 === 0 ? connected : lost);
    await settle();
    const entries = logBuffer.entries();
    expect(entries).toHaveLength(CONNECTION_JOURNAL_BUDGET + 1);
    expect(entries.at(-1)?.msg).toBe(flappingLineOf(i18nFor('en')).msg);
  });
});
