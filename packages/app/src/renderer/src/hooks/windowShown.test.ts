import { describe, expect, it, vi } from 'vitest';

import { readOnShow, type ReadCause, type ShowSignal } from './windowShown';

/** A show signal fired by hand. */
function fakeShow() {
  const ticks = new Set<() => void>();
  const signal: ShowSignal = (tick) => {
    ticks.add(tick);
    return () => ticks.delete(tick);
  };
  return {
    signal,
    listeners: () => ticks.size,
    show: () => {
      for (const tick of [...ticks]) tick();
    },
  };
}

/** Reads answered by hand, in any order. */
function heldReads<T>() {
  const pending: ((value: T) => void)[] = [];
  const read = vi.fn<(cause: ReadCause) => Promise<T>>(
    () =>
      new Promise<T>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    read,
    answer: async (index: number, value: T) => {
      pending[index]?.(value);
      await Promise.resolve();
    },
  };
}

describe('readOnShow', () => {
  it('reads at once and again on every show; the answers are delivered', async () => {
    const show = fakeShow();
    const reads = heldReads<string>();
    const deliver = vi.fn();
    readOnShow(reads.read, deliver, show.signal);
    expect(reads.read).toHaveBeenCalledTimes(1);
    await reads.answer(0, 'first');
    show.show();
    expect(reads.read).toHaveBeenCalledTimes(2);
    await reads.answer(1, 'second');
    expect(deliver.mock.calls).toEqual([['first'], ['second']]);
  });

  it('two reads racing: the latest wins, a slow stale answer is dropped', async () => {
    const show = fakeShow();
    const reads = heldReads<string>();
    const deliver = vi.fn();
    const reader = readOnShow(reads.read, deliver, show.signal);
    show.show();
    await reads.answer(1, 'new');
    await reads.answer(0, 'old');
    expect(deliver.mock.calls).toEqual([['new']]);
    // And the other way round: a refresh's answer arriving first is still the one kept.
    reader.refresh();
    show.show();
    await reads.answer(3, 'latest');
    await reads.answer(2, 'stale');
    expect(deliver.mock.calls).toEqual([['new'], ['latest']]);
  });

  it('stop removes the listener and drops the read in flight', async () => {
    const show = fakeShow();
    const reads = heldReads<string>();
    const deliver = vi.fn();
    const reader = readOnShow(reads.read, deliver, show.signal);
    expect(show.listeners()).toBe(1);
    reader.stop();
    expect(show.listeners()).toBe(0);
    await reads.answer(0, 'late');
    show.show();
    expect(reads.read).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('read is told why it runs: start, show, refresh', () => {
    const show = fakeShow();
    const reads = heldReads<string>();
    const reader = readOnShow(reads.read, vi.fn(), show.signal);
    show.show();
    reader.refresh();
    expect(reads.read.mock.calls).toEqual([['start'], ['show'], ['refresh']]);
  });
});
