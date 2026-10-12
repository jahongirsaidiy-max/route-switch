import { describe, expect, it } from 'vitest';

import { createStderrReport, MAX_DETAIL_LENGTH } from './report';

const at = new Date('2026-01-02T03:04:05.000Z');

describe('createStderrReport', () => {
  it('writes one JSON line per report', () => {
    const lines: string[] = [];
    const report = createStderrReport((line) => lines.push(line), () => at);
    report('warn', 'Blocked a request outside the app', 'https://example.com/');
    report('error', 'Startup failed', new RangeError('boom'));
    report('error', 'No detail');
    expect(lines.every((line) => line.endsWith('\n') && line.indexOf('\n') === line.length - 1)).toBe(true);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: 'warn', at: '2026-01-02T03:04:05.000Z', msg: 'Blocked a request outside the app', detail: 'https://example.com/' },
      { level: 'error', at: '2026-01-02T03:04:05.000Z', msg: 'Startup failed', detail: 'RangeError: boom' },
      { level: 'error', at: '2026-01-02T03:04:05.000Z', msg: 'No detail' },
    ]);
  });

  it('cuts a long detail short — a web page can choose it', () => {
    const lines: string[] = [];
    const report = createStderrReport((line) => lines.push(line), () => at);
    report('warn', 'Blocked a request outside the app', `https://evil.example/${'a'.repeat(100_000)}`);
    report('error', 'x', new Error('b'.repeat(100_000)));
    for (const line of lines) {
      const { detail } = JSON.parse(line) as { detail: string };
      expect(detail).toHaveLength(MAX_DETAIL_LENGTH + 1);
      expect(detail.endsWith('…')).toBe(true);
    }
    expect(MAX_DETAIL_LENGTH).toBeLessThanOrEqual(512);
  });

  it('keeps a multi-line detail on one line', () => {
    const lines: string[] = [];
    createStderrReport((line) => lines.push(line), () => at)('error', 'x', 'a\nb');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.trimEnd()).not.toContain('\n');
  });
});
