/**
 * Minimal, strict DNS message parser for the loopback DNS proxy (ADR-002 §5).
 *
 * The helper runs as root and these bytes come from local clients and from
 * upstream servers, so nothing here trusts a length or a count: every read is
 * bounds-checked and every malformed input yields `null` — no function in this
 * module throws. Only what the proxy needs is read: the header, exactly one
 * question and the A / CNAME records of the answer section. Authority,
 * additional and EDNS data are never parsed and never rebuilt; the proxy
 * forwards them as opaque bytes. The only messages built here are SERVFAIL and
 * REFUSED replies (query ID + a verbatim copy of its question).
 *
 * Pure functions, no I/O. No DNS library (ADR-002 §5: none in the root helper).
 */

/** Largest query the proxy accepts, UDP payload or TCP frame (ADR-002 §5). */
export const MAX_QUERY_BYTES = 1232;
/** Largest DNS message at all (TCP length prefix is 16 bits). */
export const MAX_MESSAGE_BYTES = 65_535;
/** Longest name on the wire, length octets and the root label included (RFC 1035 §2.3.4). */
export const MAX_NAME_WIRE_BYTES = 255;
export const MAX_LABEL_BYTES = 63;
/** Compression pointers followed while reading one name. */
export const MAX_POINTER_HOPS = 16;
/** Responses announcing more answers than this are rejected outright. */
export const MAX_ANSWERS = 64;
/** CNAME links followed by `cnameChainAddresses`. */
export const MAX_CNAME_LINKS = 8;

export const DNS_HEADER_BYTES = 12;
export const QTYPE_A = 1;
export const QTYPE_CNAME = 5;
export const QTYPE_AAAA = 28;
export const QCLASS_IN = 1;
export const OPCODE_QUERY = 0;
export const RCODE_NOERROR = 0;
export const RCODE_SERVFAIL = 2;
export const RCODE_NXDOMAIN = 3;
export const RCODE_REFUSED = 5;

const FLAG_QR = 0x8000;
const FLAG_TC = 0x0200;
const FLAG_RD = 0x0100;
const FLAG_RA = 0x0080;
const OPCODE_SHIFT = 11;
const OPCODE_MASK = 0x0f;
const RCODE_MASK = 0x000f;
const LABEL_KIND_MASK = 0xc0;
const LABEL_KIND_POINTER = 0xc0;
const POINTER_OFFSET_MASK = 0x3fff;
/** RFC 2181 §8: a TTL with the top bit set is treated as zero. */
const TTL_MAX = 0x7fff_ffff;

export interface ParsedQuery {
  readonly id: number;
  readonly flags: number;
  /** Lowercase (ASCII only), dot-separated, no trailing dot; '' is the root. */
  readonly qname: string;
  readonly qtype: number;
  readonly qclass: number;
}

export type ExpectedQuestion = Pick<ParsedQuery, 'qname' | 'qtype' | 'qclass'>;

export type AnswerType = 'A' | 'CNAME';

export interface ParsedAnswer {
  /** Owner name, normalised like `ParsedQuery.qname`. */
  readonly name: string;
  readonly type: AnswerType;
  /** Seconds; RFC 2181 values above 2^31-1 read as 0. */
  readonly ttl: number;
  /** Dotted IPv4 for A, normalised target name for CNAME. */
  readonly data: string;
}

export interface ParsedResponse {
  readonly id: number;
  readonly rcode: number;
  /** Truncated (TC bit): answers are not read; the client retries over TCP. */
  readonly tc: boolean;
  /** IN-class A and CNAME records only, in message order; every other record is skipped. */
  readonly answers: readonly ParsedAnswer[];
}

interface NameRead {
  readonly name: string;
  /** Offset just past the name's in-place bytes (after the root label or the first pointer). */
  readonly end: number;
}

const u16 = (buf: Uint8Array, offset: number): number | null => {
  const hi = buf[offset];
  const lo = buf[offset + 1];
  return hi === undefined || lo === undefined ? null : (hi << 8) | lo;
};

const u32 = (buf: Uint8Array, offset: number): number | null => {
  const hi = u16(buf, offset);
  const lo = u16(buf, offset + 2);
  return hi === null || lo === null ? null : hi * 0x1_0000 + lo;
};

/**
 * One label byte: printable ASCII except '.' (would fake a label boundary) and
 * '\' (would need escaping); A–Z fold to lowercase. Anything else rejects the name.
 */
const labelChar = (byte: number): string | null => {
  if (byte < 0x21 || byte > 0x7e || byte === 0x2e || byte === 0x5c) return null;
  const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  return String.fromCharCode(lower);
};

/**
 * Reads a domain name at `start`. Compression pointers are refused when
 * `allowPointers` is false (the question); otherwise each pointer must point
 * strictly backwards, past the header, and at most `MAX_POINTER_HOPS` are
 * followed — so a loop cannot exist and a chain cannot run away.
 */
const readName = (buf: Uint8Array, start: number, allowPointers: boolean): NameRead | null => {
  const labels: string[] = [];
  let offset = start;
  let end: number | null = null;
  let wireBytes = 0;
  let hops = 0;

  for (;;) {
    const length = buf[offset];
    if (length === undefined) return null;
    const kind = length & LABEL_KIND_MASK;

    if (kind === LABEL_KIND_POINTER) {
      if (!allowPointers) return null;
      const pointer = u16(buf, offset);
      if (pointer === null) return null;
      const target = pointer & POINTER_OFFSET_MASK;
      if (target < DNS_HEADER_BYTES || target >= offset) return null;
      hops += 1;
      if (hops > MAX_POINTER_HOPS) return null;
      end ??= offset + 2;
      offset = target;
      continue;
    }
    // 0x40 / 0x80: extended and reserved label types (RFC 6891 §5) are not accepted.
    if (kind !== 0) return null;

    wireBytes += length + 1;
    if (wireBytes > MAX_NAME_WIRE_BYTES) return null;
    if (length === 0) {
      end ??= offset + 1;
      return { name: labels.join('.'), end };
    }
    if (offset + 1 + length > buf.length) return null;

    let label = '';
    for (let i = offset + 1; i <= offset + length; i += 1) {
      const char = labelChar(buf[i] ?? -1);
      if (char === null) return null;
      label += char;
    }
    labels.push(label);
    offset += 1 + length;
  }
};

interface QuestionRead {
  readonly qname: string;
  readonly qtype: number;
  readonly qclass: number;
  readonly end: number;
}

const readQuestion = (buf: Uint8Array): QuestionRead | null => {
  const name = readName(buf, DNS_HEADER_BYTES, false);
  if (name === null) return null;
  const qtype = u16(buf, name.end);
  const qclass = u16(buf, name.end + 2);
  if (qtype === null || qclass === null) return null;
  return { qname: name.name, qtype, qclass, end: name.end + 4 };
};

const opcodeOf = (flags: number): number => (flags >> OPCODE_SHIFT) & OPCODE_MASK;

interface Header {
  readonly id: number;
  readonly flags: number;
  readonly qdcount: number;
  readonly ancount: number;
  readonly nscount: number;
}

const readHeader = (buf: Uint8Array): Header | null => {
  if (buf.length < DNS_HEADER_BYTES) return null;
  const id = u16(buf, 0);
  const flags = u16(buf, 2);
  const qdcount = u16(buf, 4);
  const ancount = u16(buf, 6);
  const nscount = u16(buf, 8);
  if (id === null || flags === null || qdcount === null || ancount === null || nscount === null) return null;
  return { id, flags, qdcount, ancount, nscount };
};

/**
 * A client query: QR=0, opcode QUERY, TC clear, exactly one question and no
 * answer/authority records (additional records — EDNS — pass through unread),
 * at most `MAX_QUERY_BYTES`. The question may not use compression.
 */
export const parseQuery = (buf: Uint8Array): ParsedQuery | null => {
  if (buf.length > MAX_QUERY_BYTES) return null;
  const header = readHeader(buf);
  if (header === null) return null;
  const { id, flags } = header;
  if ((flags & FLAG_QR) !== 0 || (flags & FLAG_TC) !== 0 || opcodeOf(flags) !== OPCODE_QUERY) return null;
  if (header.qdcount !== 1 || header.ancount !== 0 || header.nscount !== 0) return null;
  const question = readQuestion(buf);
  if (question === null) return null;
  return {
    id,
    flags,
    qname: question.qname,
    qtype: question.qtype,
    qclass: question.qclass,
  };
};

const ipv4 = (buf: Uint8Array, offset: number): string | null => {
  const bytes = buf.subarray(offset, offset + 4);
  return bytes.length === 4 ? Array.from(bytes).join('.') : null;
};

/**
 * An upstream response to `expected`: QR=1, opcode QUERY, exactly one question
 * equal to `expected` (name compared case-insensitively), at most
 * `MAX_ANSWERS` answers. Every answer RR must be complete and its RDATA must
 * lie inside the message; A RDATA is exactly 4 bytes and a CNAME target must
 * fill its RDATA exactly. With TC set the answers are not read (`answers: []`).
 */
export const parseResponse = (buf: Uint8Array, expected: ExpectedQuestion): ParsedResponse | null => {
  if (buf.length > MAX_MESSAGE_BYTES) return null;
  const header = readHeader(buf);
  if (header === null) return null;
  const { id, flags } = header;
  if ((flags & FLAG_QR) === 0 || opcodeOf(flags) !== OPCODE_QUERY) return null;
  if (header.qdcount !== 1 || header.ancount > MAX_ANSWERS) return null;

  const question = readQuestion(buf);
  if (question === null) return null;
  if (
    question.qname !== expected.qname.toLowerCase() ||
    question.qtype !== expected.qtype ||
    question.qclass !== expected.qclass
  ) {
    return null;
  }

  const rcode = flags & RCODE_MASK;
  const tc = (flags & FLAG_TC) !== 0;
  if (tc) return { id, rcode, tc, answers: [] };

  const answers: ParsedAnswer[] = [];
  let offset = question.end;
  for (let i = 0; i < header.ancount; i += 1) {
    const owner = readName(buf, offset, true);
    if (owner === null) return null;
    const type = u16(buf, owner.end);
    const rrClass = u16(buf, owner.end + 2);
    const rawTtl = u32(buf, owner.end + 4);
    const rdLength = u16(buf, owner.end + 8);
    if (type === null || rrClass === null || rawTtl === null || rdLength === null) return null;
    const rdStart = owner.end + 10;
    const rdEnd = rdStart + rdLength;
    if (rdEnd > buf.length) return null;
    const ttl = rawTtl > TTL_MAX ? 0 : rawTtl;

    if (rrClass === QCLASS_IN && type === QTYPE_A) {
      if (rdLength !== 4) return null;
      const address = ipv4(buf, rdStart);
      if (address === null) return null;
      answers.push({ name: owner.name, type: 'A', ttl, data: address });
    } else if (rrClass === QCLASS_IN && type === QTYPE_CNAME) {
      const target = readName(buf.subarray(0, rdEnd), rdStart, true);
      if (target?.end !== rdEnd) return null;
      answers.push({ name: owner.name, type: 'CNAME', ttl, data: target.name });
    }
    // Any other type or class (AAAA, RRSIG, …) is skipped as opaque RDATA.
    offset = rdEnd;
  }
  return { id, rcode, tc, answers };
};

/**
 * IPv4 addresses that `qname` resolves to inside this answer set: A records of
 * `qname` and of every name reached from it through CNAMEs, at most
 * `MAX_CNAME_LINKS` links. Only records in the packet are used (no lookups);
 * a loop or a name with two different CNAMEs ends the walk. Unique, in order.
 */
export const cnameChainAddresses = (qname: string, answers: readonly ParsedAnswer[]): string[] => {
  const addresses: string[] = [];
  const visited = new Set<string>();
  let current = qname.toLowerCase();

  for (let links = 0; ; links += 1) {
    visited.add(current);
    for (const answer of answers) {
      if (answer.type === 'A' && answer.name === current && !addresses.includes(answer.data)) {
        addresses.push(answer.data);
      }
    }
    if (links === MAX_CNAME_LINKS) break;
    const targets = new Set(answers.filter((a) => a.type === 'CNAME' && a.name === current).map((a) => a.data));
    if (targets.size !== 1) break;
    const [next] = targets;
    if (next === undefined || visited.has(next)) break;
    current = next;
  }
  return addresses;
};

/** A copy of `buf` with the 16-bit message ID replaced; `buf` is not modified. */
export const withId = (buf: Uint8Array, id: number): Buffer | null => {
  if (buf.length < DNS_HEADER_BYTES || buf.length > MAX_MESSAGE_BYTES) return null;
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) return null;
  const copy = Buffer.from(buf);
  copy[0] = id >> 8;
  copy[1] = id & 0xff;
  return copy;
};

const errorReply = (query: Uint8Array, rcode: number): Buffer | null => {
  if (parseQuery(query) === null) return null;
  const question = readQuestion(query);
  const queryFlags = u16(query, 2);
  if (question === null || queryFlags === null) return null;
  const reply = Buffer.alloc(question.end);
  reply[0] = query[0] ?? 0;
  reply[1] = query[1] ?? 0;
  const flags = FLAG_QR | (queryFlags & FLAG_RD) | FLAG_RA | rcode;
  reply.writeUInt16BE(flags, 2);
  reply.writeUInt16BE(1, 4);
  // The question is copied byte for byte, original letter case included (0x20 bit).
  reply.set(query.subarray(DNS_HEADER_BYTES, question.end), DNS_HEADER_BYTES);
  return reply;
};

/** SERVFAIL for a valid query (same ID, RD echoed, question copied); null for an invalid one. */
export const servfail = (query: Uint8Array): Buffer | null => errorReply(query, RCODE_SERVFAIL);

/** REFUSED for a valid query (same ID, RD echoed, question copied); null for an invalid one. */
export const refused = (query: Uint8Array): Buffer | null => errorReply(query, RCODE_REFUSED);
