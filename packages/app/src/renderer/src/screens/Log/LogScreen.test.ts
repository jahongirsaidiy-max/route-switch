import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../../components/test-utils';
import type { RsApi, RsLogEntry, RsResult } from '../../rs';
import { LogPanel, LogScreen, filterOptions, formatLogTime, visibleEntries, type LogFilter } from './LogScreen';
import { logStoreFor, type LogView } from './useLog';

const NOW = new Date(2026, 9, 14, 12, 0, 0);
const at = (hours: number, minutes: number, seconds: number, day = 14) =>
  new Date(2026, 9, day, hours, minutes, seconds).toISOString();

const ENTRIES: RsLogEntry[] = [
  { seq: 1, level: 'info', msg: 'Reconcile finished: 3 routes', at: at(10, 58, 1) },
  { seq: 2, level: 'warn', msg: 'Ethernet is down; 2 rules pending', at: at(11, 2, 30) },
  { seq: 3, level: 'error', msg: 'route add 10.0.0.0/8 failed', at: at(11, 3, 0) },
  { seq: 4, level: 'info', msg: 'Reconcile finished: 4 routes', at: at(23, 59, 59, 13) },
];

const ready = (entries: readonly RsLogEntry[]): LogView => ({ phase: 'ready', entries, error: null });

const render = (view: LogView, filter: LogFilter = 'all') =>
  renderMarkup(createElement(LogPanel, { view, filter, onFilterChange: vi.fn(), now: NOW }));

const rowsOf = (html: string) => html.match(/<li [^>]*>.*?<\/li>/g) ?? [];

describe('visibleEntries', () => {
  it('shows newest first', () => {
    expect(visibleEntries(ENTRIES, 'all').map((entry) => entry.seq)).toEqual([4, 3, 2, 1]);
  });

  it('filters by level', () => {
    expect(visibleEntries(ENTRIES, 'info').map((entry) => entry.seq)).toEqual([4, 1]);
    expect(visibleEntries(ENTRIES, 'warn').map((entry) => entry.seq)).toEqual([2]);
    expect(visibleEntries(ENTRIES, 'error').map((entry) => entry.seq)).toEqual([3]);
  });

  it('leaves its input alone', () => {
    const entries = [...ENTRIES];
    visibleEntries(entries, 'all');
    expect(entries).toEqual(ENTRIES);
  });
});

describe('filterOptions', () => {
  it('counts each level', () => {
    expect(filterOptions(ENTRIES).map((option) => option.label)).toEqual([
      'Hammasi (4)',
      "Ma'lumot (2)",
      'Ogohlantirish (1)',
      'Xato (1)',
    ]);
    expect(filterOptions([]).map((option) => option.value)).toEqual(['all', 'info', 'warn', 'error']);
  });
});

describe('formatLogTime', () => {
  it('shows the time of today and the date of other days', () => {
    expect(formatLogTime(at(9, 5, 7), NOW)).toBe('09:05:07');
    expect(formatLogTime(at(23, 59, 59, 13), NOW)).toBe('13.10 23:59:59');
  });

  it('shows a value that is not a date as it came', () => {
    expect(formatLogTime('not a date', NOW)).toBe('not a date');
  });
});

describe('LogPanel', () => {
  it('lists time, level and message, newest first', () => {
    const html = render(ready(ENTRIES));
    const rows = rowsOf(html);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('13.10 23:59:59');
    expect(rows[1]).toContain('data-level="error"');
    expect(rows[1]).toContain('>Xato<');
    expect(rows[1]).toContain('route add 10.0.0.0/8 failed');
    expect(rows[2]).toContain('>Ogohlantirish<');
    expect(rows[3]).toContain('>10:58:01<');
    expect(rows[3]).toContain(`="${ENTRIES[0]?.at ?? ''}"`);
    expect(html).toContain('4 ta yozuv');
    expect(html).toContain('Hammasi (4)');
    expect(html).not.toContain('role="alert"');
  });

  it('shows only the chosen level', () => {
    const rows = rowsOf(render(ready(ENTRIES), 'warn'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Ethernet is down');
  });

  it('has an empty state', () => {
    const html = render(ready([]));
    expect(html).toContain("Jurnal hozircha bo&#x27;sh");
    expect(rowsOf(html)).toHaveLength(0);
    expect(html).toContain('0 ta yozuv');
  });

  it('says when the chosen level has nothing', () => {
    const html = render(ready(ENTRIES.filter((entry) => entry.level !== 'error')), 'error');
    expect(html).toContain('Bu darajada yozuv yo&#x27;q.');
    expect(rowsOf(html)).toHaveLength(0);
  });

  it('shows loading, then a failed history with the entries it has', () => {
    expect(render({ phase: 'loading', entries: [], error: null })).toContain('Jurnal yuklanmoqda');
    const failed = render({ phase: 'failed', entries: ENTRIES.slice(0, 1), error: { code: 'forbidden', message: 'x' } });
    expect(failed).toContain('role="alert"');
    expect(rowsOf(failed)).toHaveLength(1);
  });

  it('renders messages as text, never as markup', () => {
    const html = render(ready([{ seq: 1, level: 'info', msg: '<img src=x onerror=alert(1)>', at: at(10, 0, 0) }]));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('LogScreen', () => {
  it('shows the journal of the API it is given', async () => {
    let answer: (result: RsResult<readonly RsLogEntry[]>) => void = () => undefined;
    const rs: Pick<RsApi, 'getLog' | 'onLog'> = {
      getLog: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      onLog: () => () => undefined,
    };
    expect(renderMarkup(createElement(LogScreen, { rs }))).toContain('Jurnal yuklanmoqda');
    const store = logStoreFor(rs);
    store.subscribe(() => undefined);
    answer({ ok: true, value: ENTRIES });
    await Promise.resolve();
    await Promise.resolve();
    const html = renderMarkup(createElement(LogScreen, { rs }));
    expect(rowsOf(html)).toHaveLength(4);
    expect(html).toContain('aria-checked="true"');
  });
});
