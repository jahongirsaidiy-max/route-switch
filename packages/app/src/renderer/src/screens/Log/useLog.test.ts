import { describe, expect, it, vi } from 'vitest';

import type { RsApi, RsLogEntry, RsResult } from '../../rs';
import { LOADING_LOG, LOG_VIEW_LIMIT, appendNewer, createLogStore, logStoreFor } from './useLog';

const AT = '2026-01-02T03:04:05.000Z';
const entry = (seq: number, level: RsLogEntry['level'] = 'info'): RsLogEntry => ({ seq, level, msg: `m${String(seq)}`, at: AT });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
const seqs = (entries: readonly RsLogEntry[]) => entries.map((e) => e.seq);

function fakeRs() {
  const listeners = new Set<(entry: RsLogEntry) => void>();
  const answers: ((result: RsResult<readonly RsLogEntry[]>) => void)[] = [];
  const rejections: ((error: unknown) => void)[] = [];
  const api: Pick<RsApi, 'getLog' | 'onLog'> = {
    getLog: vi.fn(
      () =>
        new Promise<RsResult<readonly RsLogEntry[]>>((resolve, reject) => {
          answers.push(resolve);
          rejections.push(reject);
        }),
    ),
    onLog: vi.fn((listener: (entry: RsLogEntry) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    api,
    listeners,
    push: (e: RsLogEntry) => {
      for (const listener of [...listeners]) listener(e);
    },
    answer: async (result: RsResult<readonly RsLogEntry[]>, index = answers.length - 1) => {
      answers[index]?.(result);
      await settle();
    },
    reject: async (error: unknown) => {
      rejections.at(-1)?.(error);
      await settle();
    },
  };
}

describe('appendNewer', () => {
  it('appends only entries newer than the last one', () => {
    expect(seqs(appendNewer(range(1, 3), [entry(2), entry(3), entry(4), entry(5)]))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(appendNewer([], [entry(4), entry(2), entry(5)]))).toEqual([4, 5]);
  });

  it('returns the same array when nothing is new', () => {
    const entries = range(1, 3);
    expect(appendNewer(entries, [entry(3)])).toBe(entries);
  });

  it('keeps at most the last 500', () => {
    expect(LOG_VIEW_LIMIT).toBe(500);
    const joined = appendNewer(range(1, 500), range(501, 503));
    expect(joined).toHaveLength(500);
    expect(joined[0]?.seq).toBe(4);
    expect(joined.at(-1)?.seq).toBe(503);
  });
});

describe('createLogStore', () => {
  it('stays idle until someone listens', () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    expect(store.getSnapshot()).toBe(LOADING_LOG);
    expect(rs.api.onLog).not.toHaveBeenCalled();
    expect(rs.api.getLog).not.toHaveBeenCalled();
  });

  it('subscribes to onLog before reading the history, then shows the history', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(vi.mocked(rs.api.onLog).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(rs.api.getLog).mock.invocationCallOrder[0] ?? 0,
    );
    expect(store.getSnapshot().phase).toBe('loading');
    await rs.answer({ ok: true, value: range(1, 3) });
    expect(store.getSnapshot()).toEqual({ phase: 'ready', entries: range(1, 3), error: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('joins entries that arrived before the history without duplicates or gaps', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    store.subscribe(() => undefined);
    // 3 and 4 arrive while getLog is under way; the history already holds 3.
    rs.push(entry(3));
    rs.push(entry(4));
    expect(store.getSnapshot().entries).toEqual([]);
    await rs.answer({ ok: true, value: range(1, 3) });
    expect(seqs(store.getSnapshot().entries)).toEqual([1, 2, 3, 4]);
  });

  it('appends the live stream after the history and ignores a repeated entry', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    store.subscribe(() => undefined);
    await rs.answer({ ok: true, value: range(1, 2) });
    rs.push(entry(3, 'error'));
    rs.push(entry(3, 'error'));
    rs.push(entry(4, 'warn'));
    expect(seqs(store.getSnapshot().entries)).toEqual([1, 2, 3, 4]);
  });

  it('drops the oldest entries beyond 500 while the window stays open', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    store.subscribe(() => undefined);
    await rs.answer({ ok: true, value: range(1, 500) });
    rs.push(entry(501));
    const { entries } = store.getSnapshot();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.seq).toBe(2);
  });

  it('a refused history is shown as failed, with the live entries still coming in', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    store.subscribe(() => undefined);
    rs.push(entry(7));
    await rs.answer({ ok: false, code: 'forbidden', error: 'Not the app page' });
    expect(store.getSnapshot()).toEqual({
      phase: 'failed',
      entries: [entry(7)],
      error: { code: 'forbidden', message: 'Not the app page' },
    });
    rs.push(entry(8));
    expect(seqs(store.getSnapshot().entries)).toEqual([7, 8]);
  });

  it('does not load forever when getLog rejects against its contract', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    store.subscribe(() => undefined);
    await rs.reject(new Error('boom'));
    expect(store.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'internal', message: 'boom' } });
  });

  it('shares one subscription, unsubscribes with the last listener and ignores a late answer', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    const stopA = store.subscribe(() => undefined);
    const stopB = store.subscribe(() => undefined);
    expect(rs.api.onLog).toHaveBeenCalledTimes(1);
    expect(rs.api.getLog).toHaveBeenCalledTimes(1);
    stopA();
    stopA();
    expect(rs.listeners.size).toBe(1);
    stopB();
    expect(rs.listeners.size).toBe(0);
    await rs.answer({ ok: true, value: range(1, 2) }, 0);
    expect(store.getSnapshot()).toBe(LOADING_LOG);
  });

  it('reads the history again when listened to again', async () => {
    const rs = fakeRs();
    const store = createLogStore(rs.api);
    const stop = store.subscribe(() => undefined);
    await rs.answer({ ok: true, value: range(1, 2) });
    stop();
    store.subscribe(() => undefined);
    expect(rs.api.getLog).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().phase).toBe('loading');
    await rs.answer({ ok: true, value: range(1, 5) });
    expect(seqs(store.getSnapshot().entries)).toEqual([1, 2, 3, 4, 5]);
  });

  it('shares one store per API object', () => {
    const rs = fakeRs();
    expect(logStoreFor(rs.api)).toBe(logStoreFor(rs.api));
    expect(logStoreFor(fakeRs().api)).not.toBe(logStoreFor(rs.api));
  });
});
