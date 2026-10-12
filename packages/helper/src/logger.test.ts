import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJsonLinesFileSink,
  createJsonLinesSink,
  createLogger,
  createMemorySink,
  formatJsonLine,
  isLevelEnabled,
  LOG_LEVELS,
  withMinLevel,
  type LogEntry,
  type SinkFailure,
} from './logger';

const FIXED_NOW = new Date('2026-01-02T03:04:05.678Z');
const fixedClock = (): Date => FIXED_NOW;

describe('createLogger', () => {
  it('emits level, ISO timestamp, message and context for every level', () => {
    const memory = createMemorySink();
    const logger = createLogger({ sinks: [memory.sink], now: fixedClock });

    logger.debug('d');
    logger.info('i', { reason: 'config-change' });
    logger.warn('w', { ruleId: 'r1' });
    logger.error('e', { dst: '10.0.0.0/8', gateway: '192.0.2.1' });

    expect(memory.entries).toEqual([
      { level: 'debug', at: '2026-01-02T03:04:05.678Z', msg: 'd' },
      { level: 'info', at: '2026-01-02T03:04:05.678Z', msg: 'i', context: { reason: 'config-change' } },
      { level: 'warn', at: '2026-01-02T03:04:05.678Z', msg: 'w', context: { ruleId: 'r1' } },
      {
        level: 'error',
        at: '2026-01-02T03:04:05.678Z',
        msg: 'e',
        context: { dst: '10.0.0.0/8', gateway: '192.0.2.1' },
      },
    ]);
    expect(memory.entries.map((entry) => entry.level)).toEqual([...LOG_LEVELS]);
  });

  it('uses the real clock by default and produces a parseable ISO timestamp', () => {
    const memory = createMemorySink();
    createLogger({ sinks: [memory.sink] }).log('info', 'now');

    const at = memory.entries[0]?.at ?? '';
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(at).toISOString()).toBe(at);
  });

  it('drops entries below minLevel', () => {
    const memory = createMemorySink();
    const logger = createLogger({ sinks: [memory.sink], minLevel: 'warn', now: fixedClock });

    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    expect(memory.entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('delivers to every sink and lets sinks be attached and detached at runtime', () => {
    const first = createMemorySink();
    const second = createMemorySink();
    const logger = createLogger({ sinks: [first.sink], now: fixedClock });

    logger.info('one');
    const detach = logger.addSink(second.sink);
    logger.info('two');
    detach();
    logger.info('three');

    expect(first.entries.map((entry) => entry.msg)).toEqual(['one', 'two', 'three']);
    expect(second.entries.map((entry) => entry.msg)).toEqual(['two']);
  });

  it('child loggers share sinks and merge bound context under call context', () => {
    const memory = createMemorySink();
    const root = createLogger({ now: fixedClock });
    const child = root.child({ component: 'exec', attempt: 1 });
    const grandchild = child.child({ ruleId: 'r1' });
    root.addSink(memory.sink);

    child.info('a');
    child.info('b', { attempt: 2 });
    grandchild.warn('c');

    expect(memory.entries.map((entry) => entry.context)).toEqual([
      { component: 'exec', attempt: 1 },
      { component: 'exec', attempt: 2 },
      { component: 'exec', attempt: 1, ruleId: 'r1' },
    ]);
  });

  it('survives a throwing sink, still feeds the others and reports the failure once', () => {
    const memory = createMemorySink();
    const failures: SinkFailure[] = [];
    let broken = true;
    const flaky = (): void => {
      if (broken) {
        throw new Error('disk full');
      }
    };
    const logger = createLogger({
      sinks: [flaky, memory.sink],
      now: fixedClock,
      onSinkError: (failure) => failures.push(failure),
    });

    expect(() => {
      logger.info('one');
      logger.info('two');
    }).not.toThrow();
    expect(memory.entries.map((entry) => entry.msg)).toEqual(['one', 'two']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry.msg).toBe('one');
    expect(failures[0]?.error).toBeInstanceOf(Error);

    broken = false;
    logger.info('three');
    broken = true;
    logger.info('four');

    expect(failures.map((failure) => failure.entry.msg)).toEqual(['one', 'four']);
  });

  it('does not throw when the sink-error reporter itself throws', () => {
    const logger = createLogger({
      sinks: [
        () => {
          throw new Error('sink');
        },
      ],
      onSinkError: () => {
        throw new Error('reporter');
      },
    });

    expect(() => {
      logger.error('still alive');
    }).not.toThrow();
  });

  describe('default sink-error reporter', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('writes one JSON line to stderr and nothing about the entry context', () => {
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const logger = createLogger({
        sinks: [
          () => {
            throw new Error('disk full');
          },
        ],
        now: fixedClock,
      });

      logger.info('hello', { detail: 'context-value' });

      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0]?.[0]);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toEqual({
        level: 'error',
        at: '2026-01-02T03:04:05.678Z',
        msg: 'log sink failed',
        error: 'Error: disk full',
      });
    });
  });
});

describe('isLevelEnabled / withMinLevel', () => {
  it('orders levels debug < info < warn < error', () => {
    expect(isLevelEnabled('debug', 'debug')).toBe(true);
    expect(isLevelEnabled('info', 'warn')).toBe(false);
    expect(isLevelEnabled('warn', 'warn')).toBe(true);
    expect(isLevelEnabled('error', 'info')).toBe(true);
  });

  it('filters a single sink without affecting the others', () => {
    const all = createMemorySink();
    const userFacing = createMemorySink();
    const logger = createLogger({
      sinks: [all.sink, withMinLevel('info', userFacing.sink)],
      now: fixedClock,
    });

    logger.debug('noise');
    logger.info('news');

    expect(all.entries.map((entry) => entry.msg)).toEqual(['noise', 'news']);
    expect(userFacing.entries.map((entry) => entry.msg)).toEqual(['news']);
  });
});

describe('createMemorySink', () => {
  it('clears collected entries', () => {
    const memory = createMemorySink();
    memory.sink({ level: 'info', at: FIXED_NOW.toISOString(), msg: 'x' });
    expect(memory.entries).toHaveLength(1);

    memory.clear();

    expect(memory.entries).toHaveLength(0);
  });
});

describe('formatJsonLine', () => {
  const entry = (context?: Record<string, unknown>): LogEntry =>
    context === undefined
      ? { level: 'info', at: FIXED_NOW.toISOString(), msg: 'm' }
      : { level: 'info', at: FIXED_NOW.toISOString(), msg: 'm', context };

  it('flattens context next to level/at/msg on a single line', () => {
    const line = formatJsonLine(entry({ ruleId: 'r1', note: 'two\nlines' }));

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      at: '2026-01-02T03:04:05.678Z',
      msg: 'm',
      ruleId: 'r1',
      note: 'two\nlines',
    });
  });

  it('formats an entry without context', () => {
    expect(JSON.parse(formatJsonLine(entry()))).toEqual({
      level: 'info',
      at: '2026-01-02T03:04:05.678Z',
      msg: 'm',
    });
  });

  it('does not let context overwrite level, at or msg', () => {
    const parsed: unknown = JSON.parse(
      formatJsonLine(entry({ level: 'debug', at: 'never', msg: 'forged', extra: 1 })),
    );

    expect(parsed).toEqual({ level: 'info', at: '2026-01-02T03:04:05.678Z', msg: 'm', extra: 1 });
  });

  it('serialises Error and bigint values', () => {
    const parsed = JSON.parse(
      formatJsonLine(entry({ cause: new RangeError('bad'), big: 12n })),
    ) as { cause: { name: string; message: string; stack: string }; big: string };

    expect(parsed.cause.name).toBe('RangeError');
    expect(parsed.cause.message).toBe('bad');
    expect(parsed.cause.stack).toContain('RangeError: bad');
    expect(parsed.big).toBe('12');
  });

  it('keeps the entry when the context cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const parsed = JSON.parse(formatJsonLine(entry({ circular }))) as Record<string, unknown>;

    expect(parsed['msg']).toBe('m');
    expect(parsed['level']).toBe('info');
    expect(parsed['contextError']).toMatch(/^TypeError: /);
    expect(parsed).not.toHaveProperty('circular');
  });
});

describe('createJsonLinesSink', () => {
  it('writes one newline-terminated JSON object per entry', () => {
    const chunks: string[] = [];
    const logger = createLogger({
      sinks: [createJsonLinesSink({ write: (chunk) => chunks.push(chunk) })],
      now: fixedClock,
    });

    logger.info('first', { n: 1 });
    logger.warn('second');

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.endsWith('\n') && chunk.indexOf('\n') === chunk.length - 1)).toBe(true);
    expect(chunks.map((chunk) => JSON.parse(chunk) as unknown)).toEqual([
      { level: 'info', at: '2026-01-02T03:04:05.678Z', msg: 'first', n: 1 },
      { level: 'warn', at: '2026-01-02T03:04:05.678Z', msg: 'second' },
    ]);
  });
});

describe('createJsonLinesFileSink', () => {
  const tempDirs: string[] = [];
  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'routeswitch-logger-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the directory and appends JSON lines to the file', () => {
    const file = join(makeTempDir(), 'nested', 'helper.log');
    const logger = createLogger({ sinks: [createJsonLinesFileSink(file)], now: fixedClock });

    logger.info('first');
    logger.error('second', { ruleId: 'r1' });

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: 'info', at: '2026-01-02T03:04:05.678Z', msg: 'first' },
      { level: 'error', at: '2026-01-02T03:04:05.678Z', msg: 'second', ruleId: 'r1' },
    ]);
    // Group/other write bits must be clear whatever the process umask is.
    expect(statSync(file).mode & 0o022).toBe(0);
  });

  it('reports an unwritable path through the logger instead of throwing', () => {
    const dir = makeTempDir();
    const failures: SinkFailure[] = [];
    // The target is a directory, so appending to it fails.
    const logger = createLogger({
      sinks: [createJsonLinesFileSink(dir)],
      onSinkError: (failure) => failures.push(failure),
    });

    expect(() => {
      logger.info('lost');
    }).not.toThrow();
    expect(failures).toHaveLength(1);
  });
});
