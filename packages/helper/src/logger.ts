import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Severity levels, lowest first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Structured fields attached to an entry (`reason`, `ruleId`, `dst`, `gateway`, ...). */
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogEntry {
  readonly level: LogLevel;
  /** ISO 8601 timestamp (UTC). */
  readonly at: string;
  readonly msg: string;
  readonly context?: LogContext;
}

/**
 * A sink receives every entry the logger accepts. Sinks are synchronous; a
 * sink that throws is isolated by the logger and never reaches the caller.
 */
export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  log(level: LogLevel, msg: string, context?: LogContext): void;
  /** A logger that shares this logger's sinks and adds `context` to every entry. */
  child(context: LogContext): Logger;
  /** Attaches a sink at runtime (log file, IPC `log` events); returns a detach function. */
  addSink(sink: LogSink): () => void;
}

export interface SinkFailure {
  readonly error: unknown;
  /** The entry the sink failed to handle. */
  readonly entry: LogEntry;
}

export interface LoggerOptions {
  readonly sinks?: readonly LogSink[];
  /** Entries below this level are dropped before reaching any sink. Default: `debug`. */
  readonly minLevel?: LogLevel;
  /** Clock used for `at`; injectable for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Called when a sink throws. Invoked once when a sink starts failing and
   * again only after it has recovered, so a permanently broken sink cannot
   * flood the report channel. Default: one JSON line on stderr.
   */
  readonly onSinkError?: (failure: SinkFailure) => void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export const isLevelEnabled = (level: LogLevel, minLevel: LogLevel): boolean =>
  LEVEL_RANK[level] >= LEVEL_RANK[minLevel];

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
};

/**
 * Serialises an entry as one JSON object without a trailing newline. Context
 * fields are flattened next to `level`/`at`/`msg`; a context key with one of
 * those three names is dropped rather than allowed to overwrite the entry.
 * Context that cannot be serialised (e.g. a circular structure) is replaced by
 * a `contextError` field so the entry itself is never lost.
 */
export const formatJsonLine = (entry: LogEntry): string => {
  const base = { level: entry.level, at: entry.at, msg: entry.msg };
  if (entry.context === undefined) {
    return JSON.stringify(base);
  }
  try {
    return JSON.stringify({ ...entry.context, ...base }, jsonReplacer);
  } catch (error) {
    return JSON.stringify({ ...base, contextError: describeError(error) });
  }
};

/** The subset of a writable stream the JSON-lines sink needs. */
export interface LineWritable {
  write(chunk: string): unknown;
}

/** Sink that writes one JSON object per line to a stream. */
export const createJsonLinesSink =
  (stream: LineWritable): LogSink =>
  (entry) => {
    stream.write(`${formatJsonLine(entry)}\n`);
  };

export interface JsonLinesFileSinkOptions {
  /** Mode for a newly created log file. Default: `0o644`. */
  readonly fileMode?: number;
  /** Mode for a newly created parent directory. Default: `0o755`. */
  readonly dirMode?: number;
}

/**
 * Sink that appends one JSON object per line to `filePath`, creating the
 * parent directory on first use. Writes are synchronous: the helper logs a
 * few lines per reconcile, and a synchronous append keeps entries ordered and
 * turns every I/O failure into a throw that the logger isolates and reports.
 */
export const createJsonLinesFileSink = (
  filePath: string,
  options: JsonLinesFileSinkOptions = {},
): LogSink => {
  const fileMode = options.fileMode ?? 0o644;
  const dirMode = options.dirMode ?? 0o755;
  let directoryReady = false;
  return (entry) => {
    if (!directoryReady) {
      mkdirSync(dirname(filePath), { recursive: true, mode: dirMode });
      directoryReady = true;
    }
    appendFileSync(filePath, `${formatJsonLine(entry)}\n`, { encoding: 'utf8', mode: fileMode });
  };
};

export interface MemorySink {
  readonly sink: LogSink;
  /** Entries received so far, oldest first. */
  readonly entries: readonly LogEntry[];
  clear(): void;
}

/** Sink that keeps entries in memory; intended for tests. */
export const createMemorySink = (): MemorySink => {
  const entries: LogEntry[] = [];
  return {
    sink: (entry) => {
      entries.push(entry);
    },
    entries,
    clear: () => {
      entries.length = 0;
    },
  };
};

/** Wraps a sink so it only receives entries at `minLevel` or above. */
export const withMinLevel =
  (minLevel: LogLevel, sink: LogSink): LogSink =>
  (entry) => {
    if (isLevelEnabled(entry.level, minLevel)) {
      sink(entry);
    }
  };

const reportSinkFailureToStderr = (failure: SinkFailure): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      at: failure.entry.at,
      msg: 'log sink failed',
      error: describeError(failure.error),
    })}\n`,
  );
};

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const sinks = new Set<LogSink>(options.sinks);
  const failingSinks = new Set<LogSink>();
  const minLevel = options.minLevel ?? 'debug';
  const now = options.now ?? (() => new Date());
  const onSinkError = options.onSinkError ?? reportSinkFailureToStderr;

  const reportSinkFailure = (failure: SinkFailure): void => {
    try {
      onSinkError(failure);
    } catch {
      // Last resort: the sink failed and so did the channel for reporting that
      // failure. Nothing is left to report to, and logging must never take the
      // helper down, so the failure stops here.
    }
  };

  const dispatch = (entry: LogEntry): void => {
    for (const sink of sinks) {
      try {
        sink(entry);
        failingSinks.delete(sink);
      } catch (error) {
        if (!failingSinks.has(sink)) {
          failingSinks.add(sink);
          reportSinkFailure({ error, entry });
        }
      }
    }
  };

  const build = (bound: LogContext | undefined): Logger => {
    const log = (level: LogLevel, msg: string, context?: LogContext): void => {
      if (!isLevelEnabled(level, minLevel)) {
        return;
      }
      const at = now().toISOString();
      const merged = bound === undefined ? context : { ...bound, ...context };
      dispatch(merged === undefined ? { level, at, msg } : { level, at, msg, context: merged });
    };
    return {
      log,
      debug: (msg, context) => {
        log('debug', msg, context);
      },
      info: (msg, context) => {
        log('info', msg, context);
      },
      warn: (msg, context) => {
        log('warn', msg, context);
      },
      error: (msg, context) => {
        log('error', msg, context);
      },
      child: (context) => build(bound === undefined ? context : { ...bound, ...context }),
      addSink: (sink) => {
        sinks.add(sink);
        return () => {
          sinks.delete(sink);
          failingSinks.delete(sink);
        };
      },
    };
  };

  return build(undefined);
};
