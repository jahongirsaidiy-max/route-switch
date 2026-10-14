import { describe, expect, it, vi } from 'vitest';

import { createLogBuffer, LOG_BUFFER_CAPACITY, type LogEntry } from './logBuffer';

const AT = '2026-01-02T03:04:05.000Z';
const unexpected = (error: unknown): never => {
  throw error;
};
const line = (msg: string, level: 'info' | 'warn' | 'error' = 'info') => ({ level, msg, at: AT });

describe('createLogBuffer', () => {
  it('keeps 500 entries by default', () => {
    expect(LOG_BUFFER_CAPACITY).toBe(500);
    const buffer = createLogBuffer({ onListenerError: unexpected });
    for (let i = 1; i <= 500; i += 1) buffer.push(line(`line ${String(i)}`));
    expect(buffer.entries()).toHaveLength(500);
  });

  it('starts empty and numbers the entries from 1, oldest first', () => {
    const buffer = createLogBuffer({ onListenerError: unexpected });
    expect(buffer.entries()).toEqual([]);
    expect(buffer.push(line('a'))).toEqual({ seq: 1, level: 'info', msg: 'a', at: AT });
    buffer.push(line('b', 'error'));
    expect(buffer.entries()).toEqual([
      { seq: 1, level: 'info', msg: 'a', at: AT },
      { seq: 2, level: 'error', msg: 'b', at: AT },
    ]);
  });

  it('drops the oldest entries beyond 500, keeping order and numbers', () => {
    const buffer = createLogBuffer({ onListenerError: unexpected });
    for (let i = 1; i <= 1234; i += 1) buffer.push(line(`line ${String(i)}`));
    const entries = buffer.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0]).toMatchObject({ seq: 735, msg: 'line 735' });
    expect(entries.at(-1)).toMatchObject({ seq: 1234, msg: 'line 1234' });
    expect(entries.every((entry, index) => index === 0 || entry.seq === (entries[index - 1]?.seq ?? 0) + 1)).toBe(true);
  });

  it('wraps correctly at every position of a small ring', () => {
    const buffer = createLogBuffer({ capacity: 3, onListenerError: unexpected });
    const seen: number[][] = [];
    for (let i = 1; i <= 7; i += 1) {
      buffer.push(line(String(i)));
      seen.push(buffer.entries().map((entry) => entry.seq));
    }
    expect(seen).toEqual([[1], [1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6], [5, 6, 7]]);
  });

  it('copies only the three fields of the event', () => {
    const buffer = createLogBuffer({ onListenerError: unexpected });
    const entry = buffer.push({ ...line('a'), event: 'log', extra: 'x' } as unknown as ReturnType<typeof line>);
    expect(Object.keys(entry).sort()).toEqual(['at', 'level', 'msg', 'seq']);
  });

  it('returns a new array each time', () => {
    const buffer = createLogBuffer({ onListenerError: unexpected });
    buffer.push(line('a'));
    const first = buffer.entries();
    buffer.push(line('b'));
    expect(first).toHaveLength(1);
    expect(buffer.entries()).not.toBe(buffer.entries());
  });

  it('refuses a capacity that is not a positive integer', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(() => createLogBuffer({ capacity, onListenerError: unexpected })).toThrow(RangeError);
    }
  });

  it('tells each listener about every later entry until it unsubscribes', () => {
    const buffer = createLogBuffer({ onListenerError: unexpected });
    buffer.push(line('before'));
    const received: LogEntry[] = [];
    const listener = (entry: LogEntry) => received.push(entry);
    const stopA = buffer.subscribe(listener);
    const stopB = buffer.subscribe(listener);
    buffer.push(line('a'));
    expect(received.map((entry) => entry.msg)).toEqual(['a', 'a']);
    stopA();
    stopA();
    buffer.push(line('b'));
    expect(received.map((entry) => entry.msg)).toEqual(['a', 'a', 'b']);
    stopB();
    buffer.push(line('c'));
    expect(received).toHaveLength(3);
  });

  it('a throwing listener is reported and does not stop the others or the buffer', () => {
    const onListenerError = vi.fn();
    const buffer = createLogBuffer({ onListenerError });
    const error = new Error('window gone');
    buffer.subscribe(() => {
      throw error;
    });
    const after = vi.fn();
    buffer.subscribe(after);
    expect(() => buffer.push(line('a'))).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(error);
    expect(after).toHaveBeenCalledTimes(1);
    expect(buffer.entries()).toHaveLength(1);
  });
});
