import { describe, expect, it } from 'vitest';

import {
  CHAIN_OFFSETS,
  QUERY_WWW_A,
  RESPONSE_WWW_CNAME_CHAIN,
  aRecord,
  buildQuery,
  buildResponse,
  cnameRecord,
  createRandom,
  encodeName,
  header,
  pointer,
  question,
  rr,
  u16be,
} from './packet-fixtures';
import {
  MAX_ANSWERS,
  MAX_CNAME_LINKS,
  MAX_POINTER_HOPS,
  MAX_QUERY_BYTES,
  type ExpectedQuestion,
  type ParsedAnswer,
  cnameChainAddresses,
  parseQuery,
  parseResponse,
  refused,
  servfail,
  withId,
} from './packet';

const WWW: ExpectedQuestion = { qname: 'www.example.com', qtype: 1, qclass: 1 };
const HOST: ExpectedQuestion = {
  qname: 'host.corp.local',
  qtype: 1,
  qclass: 1,
};

const mutate = (buf: Buffer, offset: number, ...bytes: number[]): Buffer => {
  const copy = Buffer.from(buf);
  bytes.forEach((byte, i) => {
    copy[offset + i] = byte;
  });
  return copy;
};

const setU16 = (buf: Buffer, offset: number, value: number): Buffer => {
  const copy = Buffer.from(buf);
  copy.writeUInt16BE(value, offset);
  return copy;
};

const answer = (name: string, type: ParsedAnswer['type'], data: string, ttl = 300): ParsedAnswer => ({
  name,
  type,
  ttl,
  data,
});

describe('parseQuery', () => {
  it('reads a real-shaped query with an EDNS record left unread', () => {
    expect(parseQuery(QUERY_WWW_A)).toEqual({
      id: 0x1a2b,
      flags: 0x0120,
      qname: 'www.example.com',
      qtype: 1,
      qclass: 1,
    });
  });

  it('folds the name to lowercase (ASCII only) and keeps qtype/qclass as numbers', () => {
    expect(parseQuery(buildQuery('HoSt.CORP.local', 28))).toMatchObject({
      qname: 'host.corp.local',
      qtype: 28,
      qclass: 1,
    });
    expect(parseQuery(Buffer.concat([header(), question('_ldap._tcp.corp.local', 33, 3)]))).toMatchObject({
      qname: '_ldap._tcp.corp.local',
      qtype: 33,
      qclass: 3,
    });
  });

  it('accepts the root name', () => {
    expect(parseQuery(buildQuery('', 2))).toMatchObject({
      qname: '',
      qtype: 2,
    });
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['header only', header()],
    ['11 bytes', header().subarray(0, 11)],
    ['question cut inside a label', QUERY_WWW_A.subarray(0, 18)],
    ['question cut before qtype', QUERY_WWW_A.subarray(0, 29)],
    ['question cut inside qclass', QUERY_WWW_A.subarray(0, 32)],
    ['QR=1', buildQuery('example.com', 1, { flags: 0x8100 })],
    ['TC=1', buildQuery('example.com', 1, { flags: 0x0300 })],
    ['opcode IQUERY', buildQuery('example.com', 1, { flags: 0x0900 })],
    ['opcode STATUS', buildQuery('example.com', 1, { flags: 0x1100 })],
    ['opcode NOTIFY', buildQuery('example.com', 1, { flags: 0x2100 })],
    ['opcode UPDATE', buildQuery('example.com', 1, { flags: 0x2900 })],
    ['QDCOUNT=0', buildQuery('example.com', 1, { qd: 0 })],
    ['QDCOUNT=2', Buffer.concat([header({ qd: 2 }), question('example.com'), question('corp.local')])],
    ['ANCOUNT=1', buildQuery('example.com', 1, { an: 1 })],
    ['NSCOUNT=1', buildQuery('example.com', 1, { ns: 1 })],
    [
      'compression pointer in the question',
      Buffer.concat([header(), Buffer.from([3, 0x77, 0x77, 0x77]), pointer(12), u16be(1), u16be(1)]),
    ],
    ['extended label type 0x40', Buffer.concat([header(), Buffer.from([0x41, 0]), u16be(1), u16be(1)])],
    ['reserved label type 0x80', Buffer.concat([header(), Buffer.from([0x81, 0]), u16be(1), u16be(1)])],
    ['dot inside a label', buildQuery(Buffer.from([3, 0x61, 0x2e, 0x62, 0]))],
    ['backslash inside a label', buildQuery(Buffer.from([1, 0x5c, 0]))],
    ['NUL byte inside a label', buildQuery(Buffer.from([1, 0x00, 0]))],
    ['space inside a label', buildQuery(Buffer.from([1, 0x20, 0]))],
    ['non-ASCII byte inside a label', buildQuery(Buffer.from([1, 0xc4, 0]))],
  ])('rejects %s', (_label, buf) => {
    expect(parseQuery(buf)).toBeNull();
  });

  it('allows a 63-byte label and rejects 64 (which reads as an extended label type)', () => {
    expect(parseQuery(buildQuery(`${'a'.repeat(63)}.example.com`))?.qname).toBe(`${'a'.repeat(63)}.example.com`);
    expect(parseQuery(buildQuery(`${'a'.repeat(64)}.example.com`))).toBeNull();
  });

  it('allows a 255-byte wire name and rejects 256', () => {
    // 4 × (1 + 62) = 252, + (1 + 1) + root 1 = 255.
    const name255 = [...Array<string>(4).fill('a'.repeat(62)), 'b'].join('.');
    expect(encodeName(name255)).toHaveLength(255);
    expect(parseQuery(buildQuery(name255))?.qname).toBe(name255);
    const name256 = [...Array<string>(4).fill('a'.repeat(62)), 'bb'].join('.');
    expect(encodeName(name256)).toHaveLength(256);
    expect(parseQuery(buildQuery(name256))).toBeNull();
  });

  it(`accepts exactly ${String(MAX_QUERY_BYTES)} bytes and rejects one more`, () => {
    const base = buildQuery('example.com', 1, { ar: 1 });
    const atCap = Buffer.concat([base, Buffer.alloc(MAX_QUERY_BYTES - base.length)]);
    expect(parseQuery(atCap)).not.toBeNull();
    expect(parseQuery(Buffer.concat([atCap, Buffer.alloc(1)]))).toBeNull();
  });
});

describe('parseResponse', () => {
  it('reads a compressed response with a CNAME chain and skips the OPT record', () => {
    expect(parseResponse(RESPONSE_WWW_CNAME_CHAIN, WWW)).toEqual({
      id: 0x1a2b,
      rcode: 0,
      tc: false,
      answers: [
        answer('www.example.com', 'CNAME', 'edge.example.com', 300),
        answer('edge.example.com', 'CNAME', 'cdn.example.net', 60),
        answer('cdn.example.net', 'A', '192.0.2.10', 20),
        answer('cdn.example.net', 'A', '192.0.2.11', 20),
      ],
    });
  });

  it('matches the question case-insensitively and lowercases owner names', () => {
    const response = buildResponse('HOST.Corp.Local', [aRecord(pointer(12), '10.1.2.3')]);
    expect(parseResponse(response, { ...HOST, qname: 'host.CORP.local' })?.answers).toEqual([
      answer('host.corp.local', 'A', '10.1.2.3'),
    ]);
  });

  it('skips AAAA, non-IN and other record types as opaque data', () => {
    const response = buildResponse('host.corp.local', [
      rr(pointer(12), 28, 1, 300, Buffer.alloc(16, 0xfe)),
      rr(pointer(12), 1, 3, 300, Buffer.from([10, 9, 9, 9])),
      rr(pointer(12), 46, 1, 300, Buffer.alloc(40, 7)),
      rr(pointer(12), 1, 3, 300, Buffer.alloc(7)),
      aRecord(pointer(12), '10.1.2.3'),
    ]);
    expect(parseResponse(response, HOST)?.answers).toEqual([answer('host.corp.local', 'A', '10.1.2.3')]);
  });

  it('returns the rcode and answers of an NXDOMAIN / SERVFAIL response', () => {
    expect(parseResponse(buildResponse('host.corp.local', [], { flags: 0x8183 }), HOST)).toEqual({
      id: 0x1234,
      rcode: 3,
      tc: false,
      answers: [],
    });
    expect(parseResponse(buildResponse('host.corp.local', [], { flags: 0x8182 }), HOST)?.rcode).toBe(2);
  });

  it('does not read the answers of a truncated (TC) response, even if they are cut', () => {
    const full = buildResponse('host.corp.local', [aRecord(pointer(12), '10.1.2.3')], { flags: 0x8380 });
    expect(parseResponse(full, HOST)).toEqual({
      id: 0x1234,
      rcode: 0,
      tc: true,
      answers: [],
    });
    expect(parseResponse(full.subarray(0, full.length - 3), HOST)?.tc).toBe(true);
  });

  it('reads TTLs: 0, 2^31-1, and treats the top bit as zero (RFC 2181)', () => {
    const response = buildResponse('host.corp.local', [
      aRecord(pointer(12), '10.0.0.1', 0),
      aRecord(pointer(12), '10.0.0.2', 0x7fffffff),
      aRecord(pointer(12), '10.0.0.3', 0x80000000),
      aRecord(pointer(12), '10.0.0.4', 0xffffffff),
    ]);
    expect(parseResponse(response, HOST)?.answers.map((a) => a.ttl)).toEqual([0, 0x7fffffff, 0, 0]);
  });

  it('follows a chain of backward pointers up to the hop limit', () => {
    // Each record's owner points at the previous record's owner; the first points at the question.
    const build = (records: number): Buffer => {
      const parts = [header({ flags: 0x8180, an: records }), question('host.corp.local')];
      let length = 12 + encodeName('host.corp.local').length + 4;
      let previous = 12;
      for (let i = 0; i < records; i += 1) {
        const record = aRecord(pointer(previous), '10.0.0.1');
        previous = length;
        length += record.length;
        parts.push(record);
      }
      return Buffer.concat(parts);
    };
    expect(parseResponse(build(MAX_POINTER_HOPS), HOST)?.answers).toHaveLength(MAX_POINTER_HOPS);
    expect(parseResponse(build(MAX_POINTER_HOPS + 1), HOST)).toBeNull();
  });

  it(`accepts ${String(MAX_ANSWERS)} answers and rejects ANCOUNT ${String(MAX_ANSWERS + 1)} or a huge ANCOUNT`, () => {
    const records = Array.from({ length: MAX_ANSWERS }, (_v, i) => aRecord(pointer(12), `10.0.0.${String(i)}`));
    expect(parseResponse(buildResponse('host.corp.local', records), HOST)?.answers).toHaveLength(MAX_ANSWERS);
    const more = [...records, aRecord(pointer(12), '10.0.1.0')];
    expect(parseResponse(buildResponse('host.corp.local', more), HOST)).toBeNull();
    expect(parseResponse(buildResponse('host.corp.local', [], { an: 0xffff }), HOST)).toBeNull();
  });

  it('rejects an answer count larger than the records present', () => {
    expect(parseResponse(setU16(RESPONSE_WWW_CNAME_CHAIN, 6, 6), WWW)).toBeNull();
  });

  it.each([
    ['QR=0', setU16(RESPONSE_WWW_CNAME_CHAIN, 2, 0x0180)],
    ['opcode NOTIFY', setU16(RESPONSE_WWW_CNAME_CHAIN, 2, 0xa180)],
    ['QDCOUNT=0', setU16(RESPONSE_WWW_CNAME_CHAIN, 4, 0)],
    ['QDCOUNT=2', setU16(RESPONSE_WWW_CNAME_CHAIN, 4, 2)],
    ['header cut', RESPONSE_WWW_CNAME_CHAIN.subarray(0, 11)],
    ['question cut', RESPONSE_WWW_CNAME_CHAIN.subarray(0, 30)],
    ['answer owner cut', RESPONSE_WWW_CNAME_CHAIN.subarray(0, CHAIN_OFFSETS.answer1 + 1)],
    ['answer fixed fields cut', RESPONSE_WWW_CNAME_CHAIN.subarray(0, CHAIN_OFFSETS.answer1 + 9)],
    ['A RDATA cut', RESPONSE_WWW_CNAME_CHAIN.subarray(0, CHAIN_OFFSETS.answer4 + 13)],
    ['RDLENGTH past the end', setU16(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer3RdLength, 0xffff)],
    [
      'skipped (AAAA) RDATA running past the end',
      buildResponse('www.example.com', [rr(pointer(12), 28, 1, 60, Buffer.alloc(16))]).subarray(0, -4),
    ],
    ['A RDLENGTH 3', buildResponse('www.example.com', [rr(pointer(12), 1, 1, 60, Buffer.from([10, 0, 0]))])],
    ['A RDLENGTH 5', buildResponse('www.example.com', [rr(pointer(12), 1, 1, 60, Buffer.from([10, 0, 0, 1, 0]))])],
    ['CNAME target shorter than RDLENGTH', setU16(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1RdLength, 6)],
    ['CNAME RDLENGTH 0', buildResponse('www.example.com', [rr(pointer(12), 5, 1, 60, Buffer.alloc(0))])],
    [
      'CNAME target with bytes after its end',
      buildResponse('www.example.com', [
        rr(pointer(12), 5, 1, 60, Buffer.concat([encodeName('a.corp.local'), Buffer.from([0])])),
      ]),
    ],
    ['forward pointer', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xc0, CHAIN_OFFSETS.answer2)],
    ['pointer to itself', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xc0, CHAIN_OFFSETS.answer1)],
    ['pointer into the header', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xc0, 0x02)],
    // Offset 4 holds QDCOUNT's high byte (0x00), which would otherwise decode as a root name.
    ['pointer into the header that would decode', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xc0, 0x04)],
    ['pointer past the end', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xff, 0xff)],
    [
      'pointer cut after one byte',
      Buffer.concat([RESPONSE_WWW_CNAME_CHAIN.subarray(0, CHAIN_OFFSETS.answer1), Buffer.from([0xc0])]),
    ],
    ['CNAME RDATA pointer forward', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1RdataPointer, 0xc0, 0x60)],
    ['extended label type in an answer', mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0x41, 0x00)],
    ['compression in the question', setU16(RESPONSE_WWW_CNAME_CHAIN, 12, 0xc00c)],
  ])('rejects %s', (_label, buf) => {
    expect(parseResponse(buf, WWW)).toBeNull();
  });

  it('rejects a two-pointer loop (a -> b -> a) even though each step alone is in range', () => {
    // Owner of answer 2 points back at answer 1's owner; answer 1's owner is mutated to point at answer 2.
    const loop = mutate(RESPONSE_WWW_CNAME_CHAIN, CHAIN_OFFSETS.answer1, 0xc0, CHAIN_OFFSETS.answer2);
    const loop2 = mutate(loop, CHAIN_OFFSETS.answer2, 0xc0, CHAIN_OFFSETS.answer1);
    expect(parseResponse(loop2, WWW)).toBeNull();
  });

  it('rejects a decoded answer name longer than 255 bytes built through pointers', () => {
    // 62-byte label + pointer to the question, repeated: every step is backward but the total grows.
    const parts: Buffer[] = [header({ flags: 0x8180, an: 5 }), question('host.corp.local')];
    let previous = 12;
    let length = 12 + encodeName('host.corp.local').length + 4;
    for (let i = 0; i < 5; i += 1) {
      const owner = Buffer.concat([Buffer.from([62]), Buffer.alloc(62, 0x61), pointer(previous)]);
      parts.push(aRecord(owner, '10.0.0.1'));
      previous = length;
      length += owner.length + 14;
    }
    expect(parseResponse(Buffer.concat(parts), HOST)).toBeNull();
    // Three steps (3 × 63 + 17 = 206 bytes) still fit.
    const fits = Buffer.concat(parts.slice(0, 5));
    expect(parseResponse(setU16(fits, 6, 3), HOST)?.answers).toHaveLength(3);
  });

  it.each([
    ['another name', { ...WWW, qname: 'www.example.net' }],
    ['a parent name', { ...WWW, qname: 'example.com' }],
    ['another qtype', { ...WWW, qtype: 28 }],
    ['another qclass', { ...WWW, qclass: 3 }],
  ])('rejects a response whose question is %s', (_label, expected) => {
    expect(parseResponse(RESPONSE_WWW_CNAME_CHAIN, expected)).toBeNull();
  });

  it('rejects messages over 65 535 bytes', () => {
    expect(parseResponse(Buffer.concat([RESPONSE_WWW_CNAME_CHAIN, Buffer.alloc(65_536)]), WWW)).toBeNull();
  });
});

describe('cnameChainAddresses', () => {
  it('collects A records along the chain from the question', () => {
    const parsed = parseResponse(RESPONSE_WWW_CNAME_CHAIN, WWW);
    expect(cnameChainAddresses('www.example.com', parsed?.answers ?? [])).toEqual(['192.0.2.10', '192.0.2.11']);
    expect(cnameChainAddresses('WWW.Example.COM', parsed?.answers ?? [])).toEqual(['192.0.2.10', '192.0.2.11']);
  });

  it('ignores A records of names not on the chain and deduplicates', () => {
    expect(
      cnameChainAddresses('host.corp.local', [
        answer('host.corp.local', 'A', '10.0.0.1'),
        answer('host.corp.local', 'A', '10.0.0.1'),
        answer('other.corp.local', 'A', '10.0.0.9'),
      ]),
    ).toEqual(['10.0.0.1']);
  });

  it('stops at a CNAME loop', () => {
    expect(
      cnameChainAddresses('a.corp.local', [
        answer('a.corp.local', 'CNAME', 'b.corp.local'),
        answer('b.corp.local', 'CNAME', 'a.corp.local'),
        answer('b.corp.local', 'A', '10.0.0.2'),
      ]),
    ).toEqual(['10.0.0.2']);
  });

  it('does not follow a name with two different CNAMEs', () => {
    expect(
      cnameChainAddresses('a.corp.local', [
        answer('a.corp.local', 'CNAME', 'b.corp.local'),
        answer('a.corp.local', 'CNAME', 'c.corp.local'),
        answer('b.corp.local', 'A', '10.0.0.2'),
      ]),
    ).toEqual([]);
  });

  it(`follows at most ${String(MAX_CNAME_LINKS)} links`, () => {
    const chain = (links: number): ParsedAnswer[] => [
      ...Array.from({ length: links }, (_v, i) =>
        answer(`n${String(i)}.corp.local`, 'CNAME', `n${String(i + 1)}.corp.local`),
      ),
      answer(`n${String(links)}.corp.local`, 'A', '10.0.0.8'),
    ];
    expect(cnameChainAddresses('n0.corp.local', chain(MAX_CNAME_LINKS))).toEqual(['10.0.0.8']);
    expect(cnameChainAddresses('n0.corp.local', chain(MAX_CNAME_LINKS + 1))).toEqual([]);
  });

  it('returns nothing for an empty answer set', () => {
    expect(cnameChainAddresses('host.corp.local', [])).toEqual([]);
  });
});

describe('withId', () => {
  it('replaces only the two ID bytes, in a copy', () => {
    const original = Buffer.from(RESPONSE_WWW_CNAME_CHAIN);
    const copy = withId(original, 0xbeef);
    expect(copy?.subarray(0, 2)).toEqual(Buffer.from([0xbe, 0xef]));
    expect(copy?.subarray(2)).toEqual(RESPONSE_WWW_CNAME_CHAIN.subarray(2));
    expect(original).toEqual(RESPONSE_WWW_CNAME_CHAIN);
    expect(withId(original, 0)?.subarray(0, 2)).toEqual(Buffer.from([0, 0]));
  });

  it.each([-1, 0x10000, 1.5, Number.NaN])('rejects id %s', (id) => {
    expect(withId(QUERY_WWW_A, id)).toBeNull();
  });

  it('rejects buffers shorter than a header or over 65 535 bytes', () => {
    expect(withId(Buffer.alloc(11), 1)).toBeNull();
    expect(withId(Buffer.alloc(65_536), 1)).toBeNull();
  });
});

describe('servfail / refused', () => {
  it.each([
    ['servfail', servfail, 2],
    ['refused', refused, 5],
  ] as const)('%s copies the ID and question, echoes RD and drops EDNS', (_label, build, rcode) => {
    const query = buildQuery('HoSt.corp.local', 1, {
      id: 0x4242,
      flags: 0x0100,
      ar: 1,
    });
    const withOpt = Buffer.concat([query, Buffer.from('0000290400000000000000', 'hex')]);
    const reply = build(withOpt);
    expect(reply).not.toBeNull();
    expect(reply?.readUInt16BE(0)).toBe(0x4242);
    expect(reply?.readUInt16BE(2)).toBe(0x8180 | rcode);
    expect(reply?.subarray(4, 12)).toEqual(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]));
    // Original letter case preserved.
    expect(reply?.subarray(12)).toEqual(question('HoSt.corp.local'));
    // The reply is a valid response to the query.
    expect(
      parseResponse(reply ?? Buffer.alloc(0), {
        qname: 'host.corp.local',
        qtype: 1,
        qclass: 1,
      }),
    ).toEqual({
      id: 0x4242,
      rcode,
      tc: false,
      answers: [],
    });
  });

  it('clears RD when the query did not set it', () => {
    expect(servfail(buildQuery('example.com', 1, { flags: 0 }))?.readUInt16BE(2)).toBe(0x8082);
  });

  it('builds nothing for an invalid query', () => {
    expect(servfail(Buffer.alloc(5))).toBeNull();
    expect(refused(RESPONSE_WWW_CNAME_CHAIN)).toBeNull();
    expect(refused(Buffer.concat([QUERY_WWW_A, Buffer.alloc(MAX_QUERY_BYTES)]))).toBeNull();
  });
});

describe('fuzz: never throws, always a typed result', () => {
  const isAnswer = (a: ParsedAnswer): boolean =>
    ['A', 'CNAME'].includes(a.type) &&
    typeof a.name === 'string' &&
    typeof a.data === 'string' &&
    Number.isInteger(a.ttl) &&
    a.ttl >= 0 &&
    a.ttl <= 0x7fffffff;

  const exercise = (buf: Buffer): void => {
    const query = parseQuery(buf);
    if (query !== null) {
      expect(query.qname).toBe(query.qname.toLowerCase());
      expect(servfail(buf)).not.toBeNull();
    } else {
      expect(refused(buf)).toBeNull();
    }
    for (const expected of [WWW, HOST, query ?? WWW]) {
      const response = parseResponse(buf, expected);
      if (response !== null) {
        expect(response.answers.length).toBeLessThanOrEqual(MAX_ANSWERS);
        expect(response.answers.every(isAnswer)).toBe(true);
        expect(cnameChainAddresses(expected.qname, response.answers).length).toBeLessThanOrEqual(
          response.answers.length,
        );
      }
    }
    expect(withId(buf, 7) === null || withId(buf, 7)?.length === buf.length).toBe(true);
  };

  it('survives 12 000 random and mutated messages within a time bound', () => {
    const random = createRandom(0x5eed);
    const int = (max: number): number => Math.floor(random() * max);
    const seeds = [
      RESPONSE_WWW_CNAME_CHAIN,
      QUERY_WWW_A,
      buildResponse('host.corp.local', [
        cnameRecord(pointer(12), encodeName('a.corp.local')),
        aRecord(pointer(33), '10.0.0.1'),
      ]),
    ];
    const started = performance.now();
    let accepted = 0;

    for (let i = 0; i < 12_000; i += 1) {
      let buf: Buffer;
      const mode = i % 4;
      if (mode === 0) {
        // Pure random bytes (header-sized and up).
        buf = Buffer.from(Array.from({ length: int(600) }, () => int(256)));
      } else {
        const seed = seeds[int(seeds.length)] ?? QUERY_WWW_A;
        buf = Buffer.from(seed);
        const edits = 1 + int(6);
        for (let e = 0; e < edits; e += 1) {
          const at = int(buf.length);
          if (mode === 1) buf[at] = int(256);
          else if (mode === 2) buf = buf.subarray(0, at);
          else buf[at] = [0xc0, 0x3f, 0x40, 0x00, 0xff, 0x0c][int(6)] ?? 0;
        }
      }
      expect(() => {
        exercise(buf);
      }).not.toThrow();
      if (parseQuery(buf) !== null || parseResponse(buf, WWW) !== null) accepted += 1;
    }

    // Some mutants stay valid (the fuzzer really reaches the accept paths), and the whole run is fast.
    expect(accepted).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
