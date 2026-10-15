/**
 * DNS message fixtures and a tiny wire builder for `packet.test.ts`. Test-only:
 * not exported from `index.ts` and never imported by runtime code (the proxy
 * itself builds nothing but SERVFAIL/REFUSED — ADR-002 §5).
 *
 * The hex fixtures have the shape of real `dig` traffic, anonymised to
 * `example.com` / `corp.local` and documentation addresses (RFC 5737).
 */

export const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'hex');

/**
 * `dig www.example.com A` query: ID 0x1a2b, RD+AD, one question, one EDNS OPT
 * record (UDP size 1232) in the additional section.
 */
export const QUERY_WWW_A = hex(`
  1a2b 0120 0001 0000 0000 0001
  03 777777 07 6578616d706c65 03 636f6d 00 0001 0001
  00 0029 04d0 00000000 0000
`);

/**
 * Response to `QUERY_WWW_A`, with compression and a two-link CNAME chain:
 *   www.example.com.   300 CNAME edge.example.com.   (owner = pointer to the question; target "edge" + pointer)
 *   edge.example.com.   60 CNAME cdn.example.net.    (owner = pointer into the previous RDATA)
 *   cdn.example.net.    20 A     192.0.2.10          (owner = pointer into the previous RDATA)
 *   cdn.example.net.    20 A     192.0.2.11
 * plus an EDNS OPT record in the additional section (opaque, not read).
 */
export const RESPONSE_WWW_CNAME_CHAIN = hex(`
  1a2b 8180 0001 0004 0000 0001
  03 777777 07 6578616d706c65 03 636f6d 00 0001 0001
  c00c 0005 0001 0000012c 0007 04 65646765 c010
  c02d 0005 0001 0000003c 0011 03 63646e 07 6578616d706c65 03 6e6574 00
  c040 0001 0001 00000014 0004 c000020a
  c040 0001 0001 00000014 0004 c000020b
  00 0029 04d0 00000000 0000
`);

/** Byte offsets inside `RESPONSE_WWW_CNAME_CHAIN`, for targeted mutants. */
export const CHAIN_OFFSETS = Object.freeze({
  questionEnd: 33,
  answer1: 33,
  answer1RdLength: 43,
  answer1RdataPointer: 50,
  answer2: 52,
  answer3: 81,
  answer3RdLength: 91,
  answer4: 97,
  ttlOfAnswer3: 87,
});

// ---- Wire builder ---------------------------------------------------------------------------------------

export const u16be = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};

export const u32be = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

/** Uncompressed wire name; '' is the root. Labels are written as given (case kept). */
export const encodeName = (name: string): Buffer => {
  const parts = name === '' ? [] : name.split('.');
  return Buffer.concat([
    ...parts.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')])),
    Buffer.from([0]),
  ]);
};

export const pointer = (offset: number): Buffer => u16be(0xc000 | offset);

export interface HeaderFields {
  readonly id?: number;
  readonly flags?: number;
  readonly qd?: number;
  readonly an?: number;
  readonly ns?: number;
  readonly ar?: number;
}

export const header = ({ id = 0x1234, flags = 0x0100, qd = 1, an = 0, ns = 0, ar = 0 }: HeaderFields = {}): Buffer =>
  Buffer.concat([u16be(id), u16be(flags), u16be(qd), u16be(an), u16be(ns), u16be(ar)]);

export const question = (name: string | Buffer, qtype = 1, qclass = 1): Buffer =>
  Buffer.concat([typeof name === 'string' ? encodeName(name) : name, u16be(qtype), u16be(qclass)]);

export const rr = (owner: Buffer, type: number, rrClass: number, ttl: number, rdata: Buffer): Buffer =>
  Buffer.concat([owner, u16be(type), u16be(rrClass), u32be(ttl), u16be(rdata.length), rdata]);

export const aRecord = (owner: Buffer, address: string, ttl = 300): Buffer =>
  rr(owner, 1, 1, ttl, Buffer.from(address.split('.').map(Number)));

export const cnameRecord = (owner: Buffer, target: Buffer, ttl = 300): Buffer => rr(owner, 5, 1, ttl, target);

export const buildQuery = (name: string | Buffer, qtype = 1, fields: HeaderFields = {}): Buffer =>
  Buffer.concat([header(fields), question(name, qtype)]);

/** Response with the question at offset 12 (so `pointer(12)` names the question) followed by `records`. */
export const buildResponse = (
  name: string,
  records: readonly Buffer[],
  { qtype = 1, ...fields }: HeaderFields & { readonly qtype?: number } = {},
): Buffer =>
  Buffer.concat([header({ flags: 0x8180, an: records.length, ...fields }), question(name, qtype), ...records]);

/** Deterministic PRNG (mulberry32) so a failing fuzz input can be reproduced from its seed. */
export const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};
