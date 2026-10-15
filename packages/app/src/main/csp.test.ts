import { describe, expect, it } from 'vitest';

import { buildProductionCsp, productionCspMetaTag, PRODUCTION_DIRECTIVES, serializeCsp } from './csp';

const parse = (policy: string): Map<string, string[]> =>
  new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );

// Nothing that would let a script or a remote host in.
const FORBIDDEN = [/unsafe-eval/, /unsafe-inline/, /unsafe-hashes/, /wasm-unsafe-eval/, /\bws:/, /\bwss:/, /\bhttp:/, /\bhttps:/, /\bdata:/, /\bblob:/, /\bfile:/, /\*/];

describe('buildProductionCsp', () => {
  it('contains every required directive with exactly the expected sources', () => {
    expect(Object.fromEntries(parse(buildProductionCsp()))).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-src': ["'none'"],
      'worker-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it.each(['header', 'meta'] as const)('has no forbidden source in the %s variant', (delivery) => {
    const policy = buildProductionCsp(delivery);
    for (const pattern of FORBIDDEN) expect(policy).not.toMatch(pattern);
  });

  it('is a single line with no stray separators', () => {
    const policy = buildProductionCsp();
    expect(policy).not.toMatch(/[\r\n,]/);
    expect(policy.endsWith(';')).toBe(false);
  });

  it('drops only frame-ancestors from the meta variant', () => {
    const header = parse(buildProductionCsp('header'));
    const meta = parse(buildProductionCsp('meta'));
    expect(meta.has('frame-ancestors')).toBe(false);
    header.delete('frame-ancestors');
    expect([...meta]).toEqual([...header]);
  });
});

describe('productionCspMetaTag', () => {
  it('describes the <meta> element the build writes into index.html', () => {
    expect(productionCspMetaTag()).toEqual({
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: buildProductionCsp('meta') },
    });
  });

  it('carries the strict policy', () => {
    const { content } = productionCspMetaTag().attrs;
    expect(content.startsWith("default-src 'self'; script-src 'self';")).toBe(true);
    for (const pattern of FORBIDDEN) expect(content).not.toMatch(pattern);
  });
});

describe('serializeCsp', () => {
  it('joins directives in order', () => {
    expect(serializeCsp([['default-src', "'self'"], ['img-src', "'self'", 'data:']])).toBe(
      "default-src 'self'; img-src 'self' data:",
    );
  });

  it('does not mutate the production directives', () => {
    const before = JSON.stringify(PRODUCTION_DIRECTIVES);
    serializeCsp(PRODUCTION_DIRECTIVES, 'meta');
    expect(JSON.stringify(PRODUCTION_DIRECTIVES)).toBe(before);
  });
});
