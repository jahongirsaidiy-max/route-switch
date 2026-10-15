import { describe, expect, it } from 'vitest';

import { MAX_LINE_BYTES, createJsonLinesDecoder, encodeJsonLine, type DecodedLine } from './jsonl';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const ok = (value: unknown): DecodedLine => ({ ok: true, value });
const INVALID_JSON: DecodedLine = { ok: false, error: { code: 'invalid-json', message: 'Line is not valid JSON' } };
const INVALID_UTF8: DecodedLine = { ok: false, error: { code: 'invalid-json', message: 'Line is not valid UTF-8' } };
const tooLong = (limit: number): DecodedLine => ({
  ok: false,
  error: { code: 'line-too-long', message: `Line is longer than ${String(limit)} bytes` },
});

/** Messages with 2-, 3- and 4-byte characters, escapes and nested values. */
const MESSAGES: unknown[] = [
  { id: 1, method: 'status' },
  { id: 2, method: 'setEnabled', enabled: true },
  { event: 'log', level: 'info', msg: 'Ichki tarmoq — ўзбекча ✓ 🙂 done', at: '2026-10-12T08:30:00.000Z' },
  { id: 3, ok: false, error: 'line one\nline two\r\n\ttab "quoted" \\    ' },
  { nested: { list: [1, 2.5, -3, null, true, 'é'], empty: {} } },
  '🙂',
  42,
  null,
];
const STREAM = MESSAGES.map(encodeJsonLine).join('');

const decodeAll = (chunks: readonly (Uint8Array | string)[]): DecodedLine[] => {
  const decoder = createJsonLinesDecoder();
  return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
};

describe('createJsonLinesDecoder', () => {
  it('decodes a whole stream given as one string or one byte chunk', () => {
    expect(decodeAll([STREAM])).toEqual(MESSAGES.map(ok));
    expect(decodeAll([utf8(STREAM)])).toEqual(MESSAGES.map(ok));
  });

  it('returns each line as soon as its newline arrives', () => {
    const decoder = createJsonLinesDecoder();
    expect(decoder.push('{"id":1,')).toEqual([]);
    expect(decoder.push('"method":"status"}')).toEqual([]);
    expect(decoder.push('\n{"id":2')).toEqual([ok({ id: 1, method: 'status' })]);
    expect(decoder.push('}\n')).toEqual([ok({ id: 2 })]);
    expect(decoder.end()).toEqual([]);
  });

  it('decodes a byte stream split at every position, including inside multi-byte characters', () => {
    const bytes = utf8(STREAM);
    const expected = MESSAGES.map(ok);
    expect(bytes.length).toBeGreaterThan(STREAM.length);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      expect(decodeAll([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(expected);
    }
  });

  it('decodes a byte stream delivered one byte at a time', () => {
    const chunks = Array.from(utf8(STREAM), (byte) => Uint8Array.of(byte));
    expect(decodeAll(chunks)).toEqual(MESSAGES.map(ok));
  });

  it('decodes a byte stream split into three chunks at every pair of positions', () => {
    const bytes = utf8(`${encodeJsonLine({ msg: 'aé✓🙂' })}${encodeJsonLine({ id: 7 })}`);
    const expected = [ok({ msg: 'aé✓🙂' }), ok({ id: 7 })];
    for (let first = 0; first <= bytes.length; first += 1) {
      for (let second = first; second <= bytes.length; second += 1) {
        const chunks = [bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)];
        expect(decodeAll(chunks)).toEqual(expected);
      }
    }
  });

  it('decodes a string stream split at every position, including inside a surrogate pair', () => {
    const expected = MESSAGES.map(ok);
    for (let cut = 0; cut <= STREAM.length; cut += 1) {
      expect(decodeAll([STREAM.slice(0, cut), STREAM.slice(cut)])).toEqual(expected);
    }
    expect(decodeAll(Array.from({ length: STREAM.length }, (_unused, index) => STREAM.charAt(index)))).toEqual(expected);
  });

  it('decodes a stream that mixes string and byte chunks', () => {
    const half = Math.floor(STREAM.length / 2);
    const cut = STREAM.lastIndexOf('\n', half) + 1;
    expect(decodeAll([STREAM.slice(0, cut), utf8(STREAM.slice(cut))])).toEqual(MESSAGES.map(ok));
  });

  it('does not keep a reference to the memory of a chunk', () => {
    const decoder = createJsonLinesDecoder();
    const chunk = utf8('{"id":1');
    expect(decoder.push(chunk)).toEqual([]);
    chunk.fill(0x20);
    expect(decoder.push('}\n')).toEqual([ok({ id: 1 })]);
  });

  it('tolerates CRLF line endings, also when split between CR and LF', () => {
    const stream = '{"id":1}\r\n{"id":2}\r\n';
    expect(decodeAll([stream])).toEqual([ok({ id: 1 }), ok({ id: 2 })]);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      expect(decodeAll([stream.slice(0, cut), stream.slice(cut)])).toEqual([ok({ id: 1 }), ok({ id: 2 })]);
    }
  });

  it('ignores empty and blank lines', () => {
    expect(decodeAll(['\n\n{"id":1}\n\r\n \t \n\n{"id":2}\n\n'])).toEqual([ok({ id: 1 }), ok({ id: 2 })]);
    expect(decodeAll(['\n', '\r\n', '\n'])).toEqual([]);
    expect(decodeAll([''])).toEqual([]);
    expect(decodeAll([new Uint8Array(0)])).toEqual([]);
  });

  it('reports invalid JSON as an error value and keeps decoding', () => {
    const lines = decodeAll(['{"id":1}\n{"id":\n{not json}\nstatus\n{"id":2}\n']);
    expect(lines).toEqual([ok({ id: 1 }), INVALID_JSON, INVALID_JSON, INVALID_JSON, ok({ id: 2 })]);
  });

  it('reports every kind of malformed line without throwing', () => {
    const decoder = createJsonLinesDecoder();
    const malformed = ['{', '}', '[1,', '"open', "{'id':1}", '{"id":1}}', 'undefined', 'NaN', '{"a":1,}', '\u0000'];
    for (const line of malformed) {
      expect(decoder.push(`${line}\n`)).toEqual([INVALID_JSON]);
    }
    expect(decoder.push('{"id":3}\n')).toEqual([ok({ id: 3 })]);
  });

  it('reports a deeply nested line as an error or a value, never by throwing', () => {
    const decoder = createJsonLinesDecoder();
    const depth = 200_000;
    const [line] = decoder.push(`${'['.repeat(depth)}${']'.repeat(depth)}\n`);
    expect(line?.ok === true || line?.error.code === 'invalid-json').toBe(true);
    expect(decoder.push('{"id":1}\n')).toEqual([ok({ id: 1 })]);
  });

  it('reports bytes that are not UTF-8 as invalid JSON and keeps decoding', () => {
    const decoder = createJsonLinesDecoder();
    const broken = Uint8Array.of(0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a);
    const truncated = Uint8Array.of(0x22, 0xf0, 0x9f, 0x99, 0x22, 0x0a);
    expect(decoder.push(broken)).toEqual([INVALID_UTF8]);
    expect(decoder.push(truncated)).toEqual([INVALID_UTF8]);
    expect(decoder.push('{"id":1}\n')).toEqual([ok({ id: 1 })]);
  });

  it('replaces a high surrogate that is never completed instead of failing', () => {
    const high = '🙂'.charAt(0);
    expect(decodeAll([`"a${high}`, utf8('"\n')])).toEqual([ok('a�')]);
    expect(decodeAll([`"a${high}`, `b"\n`])).toEqual([ok('a�b')]);
    expect(decodeAll([`"a"\n"${high}`])).toEqual([ok('a'), INVALID_JSON]);
  });

  describe('line length limit', () => {
    const limit = 16;
    const decoderOf = () => createJsonLinesDecoder({ maxLineBytes: limit });

    it('accepts a line of exactly the limit and rejects one byte more', () => {
      const exact = JSON.stringify('x'.repeat(limit - 2));
      expect(utf8(exact)).toHaveLength(limit);
      expect(decoderOf().push(`${exact}\n`)).toEqual([ok('x'.repeat(limit - 2))]);

      const over = JSON.stringify('x'.repeat(limit - 1));
      expect(decoderOf().push(`${over}\n`)).toEqual([tooLong(limit)]);
    });

    it('applies the limit to the content for both line endings', () => {
      const exact = JSON.stringify('x'.repeat(limit - 2));
      const over = JSON.stringify('x'.repeat(limit - 1));
      expect(decoderOf().push(`${exact}\r\n`)).toEqual([ok('x'.repeat(limit - 2))]);
      expect(decoderOf().push(`${over}\r\n`)).toEqual([tooLong(limit)]);

      for (const stream of [`${exact}\r\n{"id":1}\r\n`, `${exact}\n{"id":1}\n`]) {
        for (let cut = 0; cut <= stream.length; cut += 1) {
          const decoder = decoderOf();
          const lines = [...decoder.push(stream.slice(0, cut)), ...decoder.push(stream.slice(cut)), ...decoder.end()];
          expect(lines).toEqual([ok('x'.repeat(limit - 2)), ok({ id: 1 })]);
        }
      }
    });

    it('tolerates one byte beyond the limit only while it is a carriage return awaiting its newline', () => {
      const exact = JSON.stringify('x'.repeat(limit - 2));

      const followed = decoderOf();
      expect(followed.push(`${exact}\r`)).toEqual([]);
      expect(followed.push('x')).toEqual([tooLong(limit)]);
      expect(followed.push('\n{"id":1}\n')).toEqual([ok({ id: 1 })]);

      const doubled = decoderOf();
      expect(doubled.push(`${exact}\r\r\n{"id":1}\n`)).toEqual([tooLong(limit), ok({ id: 1 })]);

      const unterminated = decoderOf();
      expect(unterminated.push(`${'x'.repeat(limit)}\r`)).toEqual([]);
      expect(unterminated.memory().pendingBytes).toBe(limit + 1);
      expect(unterminated.end()).toEqual([INVALID_JSON]);

      const ended = decoderOf();
      expect(ended.push(`${exact}\r`)).toEqual([]);
      expect(ended.end()).toEqual([ok('x'.repeat(limit - 2))]);
    });

    it('counts bytes, not characters', () => {
      const line = JSON.stringify('🙂🙂🙂🙂');
      expect(line.length).toBeLessThanOrEqual(limit);
      expect(utf8(line).length).toBeGreaterThan(limit);
      expect(decoderOf().push(`${line}\n`)).toEqual([tooLong(limit)]);
    });

    it('recovers at the next newline after an oversized line', () => {
      const stream = `{"id":1}\n"${'x'.repeat(100)}"\n{"id":2}\n`;
      expect(decoderOf().push(stream)).toEqual([ok({ id: 1 }), tooLong(limit), ok({ id: 2 })]);
    });

    it('recovers wherever the oversized stream is split', () => {
      const stream = `{"id":1}\n"${'x'.repeat(40)}"\r\n{"id":2}\n`;
      const expected = [ok({ id: 1 }), tooLong(limit), ok({ id: 2 })];
      for (let cut = 0; cut <= stream.length; cut += 1) {
        const decoder = decoderOf();
        const lines = [...decoder.push(stream.slice(0, cut)), ...decoder.push(stream.slice(cut)), ...decoder.end()];
        expect(lines).toEqual(expected);
      }
    });

    it('reports the error once, as soon as the limit is crossed, without waiting for a newline', () => {
      const decoder = decoderOf();
      expect(decoder.push('x'.repeat(limit))).toEqual([]);
      expect(decoder.push('x')).toEqual([tooLong(limit)]);
      for (let index = 0; index < 1000; index += 1) {
        expect(decoder.push('x'.repeat(1024))).toEqual([]);
      }
      expect(decoder.push('tail\n{"id":1}\n')).toEqual([ok({ id: 1 })]);
    });

    it('drops an oversized line that never ends', () => {
      const decoder = decoderOf();
      expect(decoder.push('x'.repeat(limit + 1))).toEqual([tooLong(limit)]);
      expect(decoder.end()).toEqual([]);
      expect(decoder.push('{"id":1}\n')).toEqual([ok({ id: 1 })]);
    });

    it('reports each oversized line separately', () => {
      const long = 'y'.repeat(limit + 1);
      expect(decoderOf().push(`${long}\n${long}\n`)).toEqual([tooLong(limit), tooLong(limit)]);
    });

    it('uses a default limit of 4 MiB', () => {
      expect(MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
      const decoder = createJsonLinesDecoder();
      const fits = JSON.stringify('x'.repeat(MAX_LINE_BYTES - 2));
      expect(decoder.push(`${fits}\n`)).toEqual([ok('x'.repeat(MAX_LINE_BYTES - 2))]);
      expect(decoder.push(`${JSON.stringify('x'.repeat(MAX_LINE_BYTES - 1))}\n`)).toEqual([tooLong(MAX_LINE_BYTES)]);
      expect(decoder.push('{"id":1}\n')).toEqual([ok({ id: 1 })]);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses the limit %s', (maxLineBytes) => {
      expect(() => createJsonLinesDecoder({ maxLineBytes })).toThrow(RangeError);
    });
  });

  describe('memory', () => {
    it('holds nothing before the first chunk and after a completed line', () => {
      const decoder = createJsonLinesDecoder();
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });
      decoder.push('{"id":1}\n');
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });
    });

    it('keeps one buffer of at most twice the pending bytes, however small the chunks are', () => {
      const decoder = createJsonLinesDecoder();
      const byte = Uint8Array.of(0x78);
      const total = 1024 * 1024;
      for (let pushed = 1; pushed <= total; pushed += 1) {
        decoder.push(byte);
        if (pushed % 4099 === 0 || pushed === total) {
          const { pendingBytes, capacityBytes } = decoder.memory();
          expect(pendingBytes).toBe(pushed);
          expect(capacityBytes).toBeGreaterThanOrEqual(pushed);
          expect(capacityBytes).toBeLessThanOrEqual(Math.max(2 * pushed, 1024));
        }
      }
    });

    it('never lets the buffer grow beyond the limit plus one byte', () => {
      const limit = 5000;
      const decoder = createJsonLinesDecoder({ maxLineBytes: limit });
      const chunk = utf8('x'.repeat(7));
      let reported = 0;
      for (let index = 0; index < 2000; index += 1) {
        reported += decoder.push(chunk).length;
        expect(decoder.memory().capacityBytes).toBeLessThanOrEqual(limit + 1);
        expect(decoder.memory().pendingBytes).toBeLessThanOrEqual(limit + 1);
      }
      expect(reported).toBe(1);
      expect(decoder.memory().pendingBytes).toBe(0);
    });

    it('holds a line of the default limit delivered in small chunks in one buffer of that size', () => {
      const decoder = createJsonLinesDecoder();
      const chunk = utf8('x'.repeat(16));
      const pushes = MAX_LINE_BYTES / chunk.length;
      for (let index = 0; index < pushes; index += 1) decoder.push(chunk);
      expect(decoder.memory()).toEqual({ pendingBytes: MAX_LINE_BYTES, capacityBytes: MAX_LINE_BYTES });
      expect(decoder.push('\n')).toEqual([INVALID_JSON]);
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });
    });

    it('reuses a small buffer and releases a large one once its line is complete', () => {
      const decoder = createJsonLinesDecoder();
      decoder.push('{"id":');
      expect(decoder.memory()).toEqual({ pendingBytes: 6, capacityBytes: 1024 });
      decoder.push('1}\n');
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 1024 });

      decoder.push(`"${'x'.repeat(100_000)}`);
      expect(decoder.memory().capacityBytes).toBeGreaterThan(64 * 1024);
      decoder.push('"\n');
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });
    });

    it('releases the buffer when an oversized line is dropped and when the stream ends', () => {
      const decoder = createJsonLinesDecoder({ maxLineBytes: 200_000 });
      decoder.push('x'.repeat(150_000));
      expect(decoder.memory().pendingBytes).toBe(150_000);
      expect(decoder.push('x'.repeat(100_000))).toEqual([tooLong(200_000)]);
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });

      decoder.push('\n{"id":');
      decoder.end();
      expect(decoder.memory()).toEqual({ pendingBytes: 0, capacityBytes: 0 });
    });

    it('decodes many lines delivered byte by byte in linear time', () => {
      const decoder = createJsonLinesDecoder();
      const bytes = utf8('{"id":1,"method":"status"}\n'.repeat(20_000));
      let lines = 0;
      for (const byte of bytes) lines += decoder.push(Uint8Array.of(byte)).length;
      expect(lines).toBe(20_000);
    });
  });

  describe('end', () => {
    it('decodes a final line that has no newline', () => {
      const decoder = createJsonLinesDecoder();
      expect(decoder.push('{"id":1}\n{"id":2}')).toEqual([ok({ id: 1 })]);
      expect(decoder.end()).toEqual([ok({ id: 2 })]);
    });

    it('reports a truncated final line as invalid JSON', () => {
      const decoder = createJsonLinesDecoder();
      expect(decoder.push('{"id":1}\n{"id":')).toEqual([ok({ id: 1 })]);
      expect(decoder.end()).toEqual([INVALID_JSON]);
    });

    it('returns nothing for an empty stream and resets the decoder', () => {
      const decoder = createJsonLinesDecoder();
      expect(decoder.end()).toEqual([]);
      expect(decoder.push('{"id":')).toEqual([]);
      expect(decoder.end()).toEqual([INVALID_JSON]);
      expect(decoder.push('{"id":4}\n')).toEqual([ok({ id: 4 })]);
      expect(decoder.end()).toEqual([]);
    });
  });
});

describe('encodeJsonLine', () => {
  it('produces compact JSON followed by exactly one newline', () => {
    expect(encodeJsonLine({ id: 1, method: 'status' })).toBe('{"id":1,"method":"status"}\n');
    expect(encodeJsonLine([1, 'a', null])).toBe('[1,"a",null]\n');
    expect(encodeJsonLine(null)).toBe('null\n');
  });

  it('never puts a raw line break inside the line', () => {
    const tricky = {
      'key\nwith\r\nbreaks': 'value\nwith\rbreaks',
      list: ['\n', '\r', '\r\n', ' ', ' ', '\u0085', '\v', '\f'],
      nested: { text: 'a\n\nb' },
    };
    const line = encodeJsonLine(tricky);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\n\r]/);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(createJsonLinesDecoder().push(line)).toEqual([ok(tricky)]);
  });

  it('keeps every character of the BMP control range on one line', () => {
    const everything = Array.from({ length: 0x250 }, (_unused, code) => String.fromCharCode(code)).join('');
    const line = encodeJsonLine({ everything });
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(line).not.toContain('\r');
    expect(createJsonLinesDecoder().push(line)).toEqual([ok({ everything })]);
  });

  it('omits properties that have no JSON form, as JSON.stringify does', () => {
    expect(encodeJsonLine({ id: 1, skipped: undefined })).toBe('{"id":1}\n');
  });

  it('throws for a message that has no JSON form', () => {
    expect(() => encodeJsonLine(undefined)).toThrow(TypeError);
    expect(() => encodeJsonLine(() => 1)).toThrow(TypeError);
    expect(() => encodeJsonLine(10n)).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => encodeJsonLine(cycle)).toThrow(TypeError);
  });
});
