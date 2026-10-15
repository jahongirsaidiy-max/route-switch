import type { DnsResolverFactory, DnsResolverOptions } from './dns';

/**
 * Test doubles for the DNS module: a manual clock with timers and a resolver
 * factory that never touches the network. Not exported from `index.ts`.
 */

export interface FakeScheduler {
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly now: () => Date;
  /** Timers that are set and have neither fired nor been cleared. */
  pending(): number;
  /** Delays of the pending timers, relative to the current time, ascending. */
  delays(): number[];
  /** Every `setTimer` call so far. */
  readonly scheduled: number[];
  /** Moves the clock forward and fires every timer that falls due, in order. */
  advance(ms: number): void;
}

export const createFakeScheduler = (start: Date): FakeScheduler => {
  let current = start.getTime();
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  const scheduled: number[] = [];

  const earliest = (limit: number): number | null => {
    let found: number | null = null;
    for (const [id, timer] of timers) {
      if (timer.at > limit) continue;
      const best = found === null ? undefined : timers.get(found);
      if (best === undefined || timer.at < best.at) found = id;
    }
    return found;
  };

  return {
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      scheduled.push(delayMs);
      timers.set(id, { at: current + delayMs, callback });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
    now: () => new Date(current),
    pending: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.at - current).sort((a, b) => a - b),
    scheduled,
    advance: (ms) => {
      const target = current + ms;
      for (let id = earliest(target); id !== null; id = earliest(target)) {
        const timer = timers.get(id);
        timers.delete(id);
        if (timer === undefined) continue;
        current = Math.max(current, timer.at);
        timer.callback();
      }
      current = target;
    },
  };
};

/** Lets every promise callback that is ready run, and the ones they make ready. */
export const flush = async (rounds = 50): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
};

export const dnsError = (code: string): Error => Object.assign(new Error(`query${code}`), { code });

export interface FakeLookup {
  readonly hostname: string;
  /** What `setServers` was called with before the query; null when it was not called. */
  readonly servers: readonly string[] | null;
  readonly options: DnsResolverOptions;
  /** Index of the resolver instance that ran the query. */
  readonly resolver: number;
  cancelled: boolean;
  settled: boolean;
  answer(records: unknown): void;
  fail(code: string): void;
}

export interface FakeDns {
  readonly factory: DnsResolverFactory;
  /** Every query, in the order it was started. */
  readonly lookups: FakeLookup[];
  /** Resolver instances created. */
  created: number;
  /** Queries that are neither answered nor cancelled. */
  open(): FakeLookup[];
  /**
   * When set, a query is settled as soon as it starts: with the returned
   * records, or as a failure when an `Error` is returned. `undefined` leaves
   * the query open.
   */
  auto: ((hostname: string, servers: readonly string[] | null) => unknown) | null;
  /** When true, `cancel()` is recorded but the query stays open, so it can still answer late. */
  ignoreCancel: boolean;
}

export const createFakeDns = (): FakeDns => {
  const fake: FakeDns = {
    lookups: [],
    created: 0,
    auto: null,
    ignoreCancel: false,
    open: () => fake.lookups.filter((lookup) => !lookup.settled && !lookup.cancelled),
    factory: (options) => {
      const index = fake.created;
      fake.created += 1;
      let servers: readonly string[] | null = null;
      let running: FakeLookup | null = null;
      let rejectRunning: ((error: Error) => void) | null = null;
      return {
        setServers: (list) => {
          servers = [...list];
        },
        resolve4: (hostname) =>
          new Promise<unknown>((resolve, reject) => {
            const lookup: FakeLookup = {
              hostname,
              servers,
              options,
              resolver: index,
              cancelled: false,
              settled: false,
              answer: (records) => {
                lookup.settled = true;
                resolve(records);
              },
              fail: (code) => {
                lookup.settled = true;
                reject(dnsError(code));
              },
            };
            running = lookup;
            rejectRunning = reject;
            fake.lookups.push(lookup);
            const automatic = fake.auto?.(hostname, servers);
            if (automatic instanceof Error) {
              lookup.settled = true;
              reject(automatic);
            } else if (automatic !== undefined) {
              lookup.answer(automatic);
            }
          }),
        cancel: () => {
          if (running === null || running.settled) return;
          running.cancelled = true;
          if (!fake.ignoreCancel) rejectRunning?.(dnsError('ECANCELLED'));
        },
      };
    },
  };
  return fake;
};
