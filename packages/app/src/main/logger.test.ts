import { describe, expect, it, vi } from 'vitest';

import { createJsonLinesSink, createLogger, DEFAULT_RATE_LIMIT, MAX_VALUE_LENGTH, type LogEntry } from './logger';

const T0 = Date.parse('2026-01-02T03:04:05.000Z');

function setup(options: { minLevel?: 'debug' | 'info' | 'warn' | 'error' } = {}) {
  const entries: LogEntry[] = [];
  const clock = { now: T0 };
  const logger = createLogger({ sink: (entry) => entries.push(entry), now: () => clock.now, ...options });
  return { entries, clock, logger };
}

describe('createLogger', () => {
  it('writes level, time, message and flat context', () => {
    const { entries, logger } = setup();
    logger.info('Started');
    logger.warn('Blocked a request outside the app', { url: 'https://example.com/', attempt: 2, cached: false, id: null });
    expect(entries).toEqual([
      { level: 'info', at: '2026-01-02T03:04:05.000Z', msg: 'Started' },
      {
        level: 'warn',
        at: '2026-01-02T03:04:05.000Z',
        msg: 'Blocked a request outside the app',
        url: 'https://example.com/',
        attempt: 2,
        cached: false,
        id: null,
      },
    ]);
  });

  it('has the four levels and drops those below the minimum (info by default)', () => {
    const normal = setup();
    normal.logger.debug('d');
    normal.logger.info('i');
    normal.logger.warn('w');
    normal.logger.error('e');
    expect(normal.entries.map((entry) => entry.level)).toEqual(['info', 'warn', 'error']);

    const verbose = setup({ minLevel: 'debug' });
    verbose.logger.debug('d');
    expect(verbose.entries.map((entry) => entry.level)).toEqual(['debug']);

    const quiet = setup({ minLevel: 'error' });
    quiet.logger.warn('w');
    quiet.logger.error('e');
    expect(quiet.entries.map((entry) => entry.msg)).toEqual(['e']);
  });

  it('turns errors and other values into bounded strings', () => {
    const { entries, logger } = setup();
    logger.error('Failed', {
      detail: new RangeError('boom'),
      long: 'a'.repeat(100_000),
      longError: new Error('b'.repeat(100_000)),
      object: { a: 1, b: ['x'] },
      cyclic: (() => {
        const loop: Record<string, unknown> = {};
        loop['self'] = loop;
        return loop;
      })(),
      big: 12n,
      nan: Number.NaN,
      missing: undefined,
    });
    const [entry] = entries;
    expect(entry).toMatchObject({
      detail: 'RangeError: boom',
      object: '{"a":1,"b":["x"]}',
      cyclic: '[no JSON form]',
      big: '12',
      nan: 'NaN',
    });
    expect(entry).not.toHaveProperty('missing');
    expect(entry?.['long']).toHaveLength(MAX_VALUE_LENGTH + 1);
    expect(String(entry?.['long']).endsWith('…')).toBe(true);
    expect(entry?.['longError']).toHaveLength(MAX_VALUE_LENGTH + 1);
    expect(MAX_VALUE_LENGTH).toBeLessThanOrEqual(512);
  });

  it('cuts a long message as well', () => {
    const { entries, logger } = setup();
    logger.info('m'.repeat(10_000));
    expect(entries[0]?.msg).toHaveLength(MAX_VALUE_LENGTH + 1);
  });

  it('does not let context overwrite level, at or msg', () => {
    const { entries, logger } = setup();
    logger.info('Real', { level: 'error', at: 'never', msg: 'Fake', other: 1 });
    expect(entries).toEqual([{ level: 'info', at: '2026-01-02T03:04:05.000Z', msg: 'Real', other: 1 }]);
  });

  it('adds the context of a child to every line, the call’s own context winning', () => {
    const { entries, logger } = setup();
    const child = logger.child({ component: 'helper-client', attempt: 1 });
    child.info('Connected');
    child.child({ socket: 'a' }).warn('Lost', { attempt: 2 });
    expect(entries.map((entry) => ({ ...entry, at: undefined }))).toEqual([
      { level: 'info', at: undefined, msg: 'Connected', component: 'helper-client', attempt: 1 },
      { level: 'warn', at: undefined, msg: 'Lost', component: 'helper-client', attempt: 2, socket: 'a' },
    ]);
  });

  it('never throws when the sink does, and tells onSinkError', () => {
    const error = new Error('disk full');
    const onSinkError = vi.fn();
    const logger = createLogger({
      sink: () => {
        throw error;
      },
      onSinkError,
    });
    expect(() => {
      logger.error('x');
    }).not.toThrow();
    expect(onSinkError.mock.calls).toEqual([[error]]);

    const silent = createLogger({
      sink: () => {
        throw error;
      },
    });
    expect(() => {
      silent.limited('k').warn('x');
    }).not.toThrow();

    const doublyBroken = createLogger({
      sink: () => {
        throw error;
      },
      onSinkError: () => {
        throw new Error('handler too');
      },
    });
    expect(() => {
      doublyBroken.info('x');
    }).not.toThrow();
  });
});

describe('a logger never throws', () => {
  const throwing = (): never => {
    throw new Error('getter');
  };

  it('keeps the line when one context getter throws', () => {
    const { entries, logger } = setup();
    const context = { fine: 1 };
    Object.defineProperty(context, 'bad', { enumerable: true, get: throwing });
    expect(() => {
      logger.warn('Line', context);
    }).not.toThrow();
    expect(entries).toEqual([{ level: 'warn', at: '2026-01-02T03:04:05.000Z', msg: 'Line', fine: 1, bad: '[unreadable]' }]);
  });

  it('keeps the line when an Error’s message, a toJSON or a proxy throws', () => {
    const { entries, logger } = setup();
    const error = new Error('x');
    Object.defineProperty(error, 'message', { get: throwing });
    const proxy = new Proxy({}, { ownKeys: throwing, get: throwing });
    expect(() => {
      logger.error('Line', { detail: error, json: { toJSON: throwing }, proxy });
      logger.child(proxy).info('Child of a proxy', { ok: true });
      logger.limited('k').info('Limited', proxy);
    }).not.toThrow();
    expect(entries.map((entry) => ({ ...entry, at: undefined }))).toEqual([
      { level: 'error', at: undefined, msg: 'Line', detail: '[unreadable]', json: '[no JSON form]', proxy: '[no JSON form]' },
      { level: 'info', at: undefined, msg: 'Child of a proxy', context: '[unreadable]', ok: true },
      { level: 'info', at: undefined, msg: 'Limited', context: '[unreadable]' },
    ]);
  });

  it('survives a clock that throws and a message that is not a string', () => {
    const entries: LogEntry[] = [];
    let broken = true;
    const logger = createLogger({
      sink: (entry) => entries.push(entry),
      now: () => {
        if (broken) throw new Error('clock');
        return T0;
      },
    });
    expect(() => {
      logger.error('lost');
    }).not.toThrow();
    broken = false;
    expect(() => {
      logger.error(42 as unknown as string);
    }).not.toThrow();
    expect(entries).toHaveLength(1);
  });
});

describe('rate limiting by key', () => {
  const { burst, intervalMs } = DEFAULT_RATE_LIMIT;

  it('writes the first lines of an interval, one notice, then nothing', () => {
    const { entries, logger } = setup();
    const limited = logger.limited('blocked-request');
    for (let i = 0; i < 10_000; i += 1) limited.warn('Blocked a request outside the app', { url: `https://evil.example/${String(i)}` });
    expect(entries).toHaveLength(burst + 1);
    expect(entries.slice(0, burst).map((entry) => entry['url'])).toEqual(
      Array.from({ length: burst }, (_unused, i) => `https://evil.example/${String(i)}`),
    );
    expect(entries[burst]).toEqual({
      level: 'warn',
      at: '2026-01-02T03:04:05.000Z',
      msg: 'Further log lines of this kind are suppressed for a while',
      kind: 'blocked-request',
    });
  });

  it('starts again in the next interval and says how many lines were dropped', () => {
    const { entries, clock, logger } = setup();
    const limited = logger.limited('blocked-request');
    for (let i = 0; i < burst + 37; i += 1) limited.warn('Blocked', { n: i });
    clock.now += intervalMs - 1;
    limited.warn('Blocked', { n: 'still inside' });
    expect(entries).toHaveLength(burst + 1);

    clock.now += 1;
    limited.warn('Blocked', { n: 'next interval' });
    limited.warn('Blocked', { n: 'second' });
    expect(entries.slice(burst + 1)).toEqual([
      { level: 'warn', at: new Date(clock.now).toISOString(), msg: 'Blocked', n: 'next interval', suppressed: 38 },
      { level: 'warn', at: new Date(clock.now).toISOString(), msg: 'Blocked', n: 'second' },
    ]);
  });

  it('bounds the total over many intervals of constant flooding', () => {
    const { entries, clock, logger } = setup();
    const limited = logger.limited('k');
    for (let interval = 0; interval < 10; interval += 1) {
      for (let i = 0; i < 1000; i += 1) limited.warn('x');
      clock.now += intervalMs;
    }
    expect(entries).toHaveLength(10 * (burst + 1));
  });

  it('keeps a budget per key, and leaves unlimited lines alone', () => {
    const { entries, logger } = setup();
    const a = logger.limited('a');
    const b = logger.limited('b');
    for (let i = 0; i < 100; i += 1) a.warn('A');
    for (let i = 0; i < 3; i += 1) b.warn('B');
    for (let i = 0; i < 50; i += 1) logger.warn('free');
    expect(entries.filter((entry) => entry.msg === 'A')).toHaveLength(burst);
    expect(entries.filter((entry) => entry.msg === 'B')).toHaveLength(3);
    expect(entries.filter((entry) => entry.msg === 'free')).toHaveLength(50);
  });

  it('shares one budget between every logger made for the same key', () => {
    const { entries, logger } = setup();
    for (let i = 0; i < 100; i += 1) logger.limited('same').warn('x');
    for (let i = 0; i < 100; i += 1) logger.child({ c: 1 }).limited('same').error('y');
    expect(entries).toHaveLength(burst + 1);
  });

  it('does not spend the budget on lines below the minimum level', () => {
    const { entries, logger } = setup();
    const limited = logger.limited('k');
    for (let i = 0; i < 100; i += 1) limited.debug('quiet');
    limited.warn('loud');
    expect(entries.map((entry) => entry.msg)).toEqual(['loud']);
  });

  it('survives a clock that jumps backwards', () => {
    const { entries, clock, logger } = setup();
    const limited = logger.limited('k');
    for (let i = 0; i < 100; i += 1) limited.warn('x');
    clock.now -= 10 * intervalMs;
    limited.warn('after the jump');
    expect(entries.at(-1)).toMatchObject({ msg: 'after the jump', suppressed: 95 });
  });

  it('honours a custom limit', () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ sink: (entry) => entries.push(entry), now: () => 0, rateLimit: { burst: 1, intervalMs: 10 } });
    const limited = logger.limited('k');
    limited.warn('1');
    limited.warn('2');
    limited.warn('3');
    expect(entries.map((entry) => entry.msg)).toEqual(['1', 'Further log lines of this kind are suppressed for a while']);
  });
});

describe('createJsonLinesSink', () => {
  it('writes each entry as one line of JSON, level first', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: createJsonLinesSink((line) => lines.push(line)), now: () => T0 });
    logger.warn('Multi\nline', { detail: 'a\nb' });
    expect(lines).toEqual(['{"level":"warn","at":"2026-01-02T03:04:05.000Z","msg":"Multi\\nline","detail":"a\\nb"}\n']);
  });
});
