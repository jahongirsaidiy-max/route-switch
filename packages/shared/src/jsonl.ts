/**
 * JSON-lines framing for the helper socket: one JSON document per line,
 * terminated by `\n`.
 *
 * Transport-agnostic on purpose (no `node:net`, no `Buffer`): the helper's
 * socket server and the app's helper client both feed it whatever chunks
 * their stream delivers. Only web-standard globals are used (`TextEncoder`,
 * `TextDecoder`, `Uint8Array`), and a Node `Buffer` is a `Uint8Array`.
 *
 * The decoder never throws on input and never lets one bad line end the
 * stream: every problem is returned as an error value and decoding resumes
 * at the next newline.
 */

/**
 * Longest accepted line, in UTF-8 bytes of content: the terminator (`\n` or
 * `\r\n`) is not counted.
 *
 * The largest legitimate message is the response to `setConfig`, which holds
 * a 500-rule config and the state of those 500 rules. With every field at its
 * schema limit and every character JSON-escaped it is about 2.1 MiB (the
 * tests build it, next to the largest request and `state` event), so 4 MiB
 * leaves close to a factor of two while keeping the buffer of a misbehaving
 * peer bounded.
 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type JsonLineErrorCode = 'invalid-json' | 'line-too-long';

export interface JsonLineError {
  readonly code: JsonLineErrorCode;
  readonly message: string;
}

/** One decoded line: the parsed JSON value, or why the line was dropped. */
export type DecodedLine =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonLineError };

export interface JsonLinesDecoderOptions {
  /** Overrides `MAX_LINE_BYTES`. A positive safe integer. */
  readonly maxLineBytes?: number;
}

/** What a decoder currently holds in memory for the unfinished line. */
export interface JsonLinesDecoderMemory {
  /** Bytes of the unfinished line received so far. */
  readonly pendingBytes: number;
  /** Size of the one buffer allocated for it; never more than the line limit plus one byte. */
  readonly capacityBytes: number;
}

export interface JsonLinesDecoder {
  /**
   * Feeds the next chunk of the stream and returns the lines it completed, in
   * order. Chunks may be split anywhere, including inside a multi-byte
   * character (bytes) or inside a surrogate pair (strings).
   */
  push(chunk: Uint8Array | string): DecodedLine[];
  /**
   * Signals the end of the stream: a final line without a terminating newline
   * is decoded as a line. The decoder is reset and can be reused afterwards.
   */
  end(): DecodedLine[];
  /** For diagnostics and tests: the memory held between calls. */
  memory(): JsonLinesDecoderMemory;
}

const LF = 0x0a;
const CR = 0x0d;
const BLANK_LINE = /^[ \t\r]*$/;

/** First allocation for an unfinished line; doubled as the line grows. */
const INITIAL_CAPACITY = 1024;
/** A buffer larger than this is released once its line is complete instead of being kept for reuse. */
const RETAINED_CAPACITY = 64 * 1024;

const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const fail = (code: JsonLineErrorCode, message: string): DecodedLine => ({ ok: false, error: { code, message } });

/**
 * Creates an incremental decoder for one stream (one socket connection).
 * Empty and blank lines are ignored and a trailing `\r` is dropped, so both
 * `\n` and `\r\n` terminated streams work.
 *
 * A line longer than the limit is reported once as `line-too-long`, as soon
 * as the limit is crossed; what was buffered is discarded and everything up
 * to the next `\n` is skipped without being stored. A line that is not UTF-8
 * or not JSON is reported as `invalid-json`.
 *
 * Memory: between calls the decoder holds one byte buffer for the unfinished
 * line and nothing else. Its capacity grows by doubling and never exceeds the
 * limit plus one byte (room for the `\r` of a `\r\n` terminator), however
 * small the chunks are; while it grows, the old and the new buffer exist
 * together for a moment. Chunks are copied into it, never referenced. On top
 * of that come the caller's chunk and, for each completed line, its decoded
 * text and parsed value.
 */
export const createJsonLinesDecoder = (options: JsonLinesDecoderOptions = {}): JsonLinesDecoder => {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError('maxLineBytes must be a positive safe integer');
  }

  const encoder = new TextEncoder();
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  /** Longest stored line: the content limit plus the `\r` of a `\r\n` terminator. */
  const maxStoredBytes = maxLineBytes + 1;

  /** The one buffer holding the line that is still waiting for its newline. */
  let buffer = new Uint8Array(0);
  let pendingBytes = 0;
  /** True while the rest of an oversized line is being thrown away. */
  let skipping = false;
  /** A high surrogate that ended a string chunk and waits for its other half. */
  let heldSurrogate = '';

  const append = (segment: Uint8Array): void => {
    const needed = pendingBytes + segment.length;
    if (needed > buffer.length) {
      const capacity = Math.min(Math.max(needed, buffer.length * 2, INITIAL_CAPACITY), maxStoredBytes);
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(0, pendingBytes), 0);
      buffer = grown;
    }
    buffer.set(segment, pendingBytes);
    pendingBytes = needed;
  };

  const discardPending = (): void => {
    pendingBytes = 0;
    if (buffer.length > RETAINED_CAPACITY) buffer = new Uint8Array(0);
  };

  /**
   * True when the line would be longer than the limit. One byte beyond the
   * limit is tolerated only while it is a `\r` at the very end, which a
   * following `\n` turns into a terminator.
   */
  const exceedsLimit = (segment: Uint8Array): boolean => {
    const total = pendingBytes + segment.length;
    if (total <= maxLineBytes) return false;
    if (total > maxStoredBytes) return true;
    const last = segment.length > 0 ? segment.at(-1) : buffer.at(pendingBytes - 1);
    return last !== CR;
  };

  const decodeLine = (raw: Uint8Array, out: DecodedLine[]): void => {
    const bytes = raw.at(-1) === CR ? raw.subarray(0, -1) : raw;
    if (bytes.length === 0) return;

    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      out.push(fail('invalid-json', 'Line is not valid UTF-8'));
      return;
    }
    if (BLANK_LINE.test(text)) return;

    try {
      const value: unknown = JSON.parse(text);
      out.push({ ok: true, value });
    } catch {
      out.push(fail('invalid-json', 'Line is not valid JSON'));
    }
  };

  /** Decodes the unfinished line together with its last segment, then forgets it. */
  const completeLine = (segment: Uint8Array, out: DecodedLine[]): void => {
    if (pendingBytes === 0) {
      decodeLine(segment, out);
      return;
    }
    append(segment);
    decodeLine(buffer.subarray(0, pendingBytes), out);
    discardPending();
  };

  const consume = (bytes: Uint8Array, out: DecodedLine[]): void => {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(LF, start);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(start, end);

      if (!skipping && exceedsLimit(segment)) {
        discardPending();
        skipping = true;
        out.push(fail('line-too-long', `Line is longer than ${String(maxLineBytes)} bytes`));
      }

      if (newline === -1) {
        if (!skipping) append(segment);
        return;
      }

      if (skipping) skipping = false;
      else completeLine(segment, out);
      start = newline + 1;
    }
  };

  const toBytes = (chunk: Uint8Array | string): Uint8Array => {
    if (typeof chunk !== 'string') {
      if (heldSurrogate === '') return chunk;
      // Bytes after a dangling high surrogate: it can no longer be completed.
      const orphan = encoder.encode(heldSurrogate);
      heldSurrogate = '';
      const joined = new Uint8Array(orphan.length + chunk.length);
      joined.set(orphan, 0);
      joined.set(chunk, orphan.length);
      return joined;
    }

    let text = heldSurrogate + chunk;
    heldSurrogate = '';
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      heldSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    return encoder.encode(text);
  };

  return {
    push(chunk) {
      const out: DecodedLine[] = [];
      consume(toBytes(chunk), out);
      return out;
    },
    end() {
      const out: DecodedLine[] = [];
      if (heldSurrogate !== '') {
        const orphan = encoder.encode(heldSurrogate);
        heldSurrogate = '';
        consume(orphan, out);
      }
      if (!skipping) decodeLine(buffer.subarray(0, pendingBytes), out);
      buffer = new Uint8Array(0);
      pendingBytes = 0;
      skipping = false;
      return out;
    },
    memory() {
      return { pendingBytes, capacityBytes: buffer.length };
    },
  };
};

/**
 * Encodes one message as exactly one line: compact JSON followed by `\n`.
 * `JSON.stringify` escapes every line break inside strings and keys, so the
 * only raw newline in the output is the terminator.
 *
 * Throws a `TypeError` for a value that has no JSON form (`undefined`, a
 * function, a `bigint`, a cycle): that is a bug in the caller, not input.
 */
export const encodeJsonLine = (message: unknown): string => {
  // `JSON.stringify` is typed as returning a string but yields undefined for
  // values without a JSON form.
  const json = JSON.stringify(message) as string | undefined;
  if (json === undefined) throw new TypeError('Message cannot be encoded as JSON');
  return `${json}\n`;
};
