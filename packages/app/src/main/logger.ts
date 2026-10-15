// The main-process logger: one JSON object per line — `level`, `at`, `msg` and
// flat context fields — the same shape the helper logs in. Nothing in the main
// process writes to the console.
//
// Two things here exist because part of what is logged is chosen by a web
// page (a URL it requested, a download it started): every value is cut to a
// bounded length, and lines can be rate-limited by key so that a page cannot
// fill the log by repeating itself.
//
// `packages/helper` has its own logger; the package boundary keeps the two
// apart on purpose.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Context values are logged flat; anything that is not a number, boolean or null becomes a bounded string. */
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogEntry {
  readonly level: LogLevel;
  /** ISO-8601, UTC. */
  readonly at: string;
  readonly msg: string;
  readonly [field: string]: string | number | boolean | null;
}

export type LogSink = (entry: LogEntry) => void;

type LogMethod = (msg: string, context?: LogContext) => void;

export interface Logger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  /** A logger that adds `context` to every line. */
  readonly child: (context: LogContext) => Logger;
  /**
   * A logger whose lines share one rate-limit budget, named by `key`. Use it
   * for anything a web page or a socket peer can trigger at will. Keys are
   * constants of the code, never input.
   */
  readonly limited: (key: string) => Logger;
}

/** Longest string value of a line; longer ones are cut and end in `…`. */
export const MAX_VALUE_LENGTH = 300;

export interface RateLimit {
  /** Lines let through per key in one interval. */
  readonly burst: number;
  /** Length of the interval, in milliseconds. */
  readonly intervalMs: number;
}

/**
 * Per key: the first `burst` lines of an interval are written, then one notice
 * that the rest is being dropped, then nothing until the interval is over. The
 * first line of a later interval carries the number dropped as `suppressed`.
 * So a key costs at most `burst + 1` lines per interval, however often it fires.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = { burst: 5, intervalMs: 60_000 };

export interface LoggerOptions {
  readonly sink: LogSink;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  readonly minLevel?: LogLevel;
  readonly rateLimit?: RateLimit;
  /** Called when the sink throws; the logger itself never throws. */
  readonly onSinkError?: (error: unknown) => void;
}

const RESERVED = new Set(['level', 'at', 'msg']);

const NO_JSON_FORM = '[no JSON form]';

const cut = (text: string): string =>
  text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;

const UNREADABLE = '[unreadable]';

const describe = (value: object): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  // `JSON.stringify` is typed as returning a string but yields undefined for a function.
  const json = JSON.stringify(value) as string | undefined;
  return json ?? NO_JSON_FORM;
};

// Never throws: a getter, a `toJSON` or a proxy in the value is someone else's code.
const toField = (value: unknown): string | number | boolean | null => {
  try {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'string') return cut(value);
    if (typeof value === 'object' || typeof value === 'function') return cut(describe(value));
    return typeof value === 'bigint' ? value.toString() : cut(typeof value);
  } catch {
    return typeof value === 'object' && value !== null && !(value instanceof Error) ? NO_JSON_FORM : UNREADABLE;
  }
};

interface Budget {
  windowStart: number;
  written: number;
  suppressed: number;
}

export function createLogger(options: LoggerOptions): Logger {
  const { sink, onSinkError } = options;
  const now = options.now ?? Date.now;
  const minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const budgets = new Map<string, Budget>();

  /**
   * Reads the contexts one field at a time (later ones win): a getter that
   * throws costs its own field, not the line. The contexts are never spread.
   */
  const fieldsOf = (contexts: readonly LogContext[]): Record<string, string | number | boolean | null> => {
    const fields: Record<string, string | number | boolean | null> = {};
    for (const context of contexts) {
      let names: string[];
      try {
        names = Object.keys(context);
      } catch {
        fields['context'] = UNREADABLE;
        continue;
      }
      for (const name of names) {
        if (RESERVED.has(name)) continue;
        let value: unknown;
        try {
          value = context[name];
        } catch {
          fields[name] = UNREADABLE;
          continue;
        }
        if (value !== undefined) fields[name] = toField(value);
      }
    }
    return fields;
  };

  const write = (level: LogLevel, msg: string, contexts: readonly LogContext[], at: number): void => {
    const entry: LogEntry = { level, at: new Date(at).toISOString(), msg: cut(msg), ...fieldsOf(contexts) };
    try {
      sink(entry);
    } catch (error) {
      try {
        onSinkError?.(error);
      } catch {
        // A logger has nowhere left to report that its error handler failed.
      }
    }
  };

  const emit = (level: LogLevel, msg: string, contexts: readonly LogContext[], rateKey: string | null): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const at = now();
    if (rateKey === null) {
      write(level, msg, contexts, at);
      return;
    }

    let budget = budgets.get(rateKey);
    if (budget === undefined) {
      budget = { windowStart: at, written: 0, suppressed: 0 };
      budgets.set(rateKey, budget);
    }
    let carried = 0;
    if (at - budget.windowStart >= rateLimit.intervalMs || at < budget.windowStart) {
      carried = budget.suppressed;
      budget.windowStart = at;
      budget.written = 0;
      budget.suppressed = 0;
    }
    if (budget.written < rateLimit.burst) {
      budget.written += 1;
      write(level, msg, carried > 0 ? [...contexts, { suppressed: carried }] : contexts, at);
      return;
    }
    if (budget.suppressed === 0) {
      write('warn', 'Further log lines of this kind are suppressed for a while', [{ kind: rateKey }], at);
    }
    budget.suppressed += 1;
  };

  const build = (contexts: readonly LogContext[], rateKey: string | null): Logger => {
    const method =
      (level: LogLevel): LogMethod =>
      (msg, extra) => {
        // Total: logging must never be the thing that fails.
        try {
          emit(level, msg, extra === undefined ? contexts : [...contexts, extra], rateKey);
        } catch {
          // A broken clock, say: the line is lost, the caller is not.
        }
      };
    return {
      debug: method('debug'),
      info: method('info'),
      warn: method('warn'),
      error: method('error'),
      child: (extra) => build([...contexts, extra], rateKey),
      limited: (key) => build(contexts, key),
    };
  };

  return build([], null);
}

/** Writes each entry as one JSON line. */
export function createJsonLinesSink(write: (line: string) => void): LogSink {
  return (entry) => {
    write(`${JSON.stringify(entry)}\n`);
  };
}
