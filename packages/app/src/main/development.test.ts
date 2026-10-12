import { describe, expect, it } from 'vitest';

import { buildProductionCsp } from './csp';
import {
  buildDevelopmentCsp,
  createDevelopmentRuntime,
  developmentHostResolverRules,
  isDevelopmentRequest,
  parseDevServerOrigin,
} from './development';

const ORIGIN = 'http://localhost:5173';

describe('parseDevServerOrigin', () => {
  it.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['http://127.0.0.1:5174/', 'http://127.0.0.1:5174'],
    ['http://[::1]:5173/', 'http://[::1]:5173'],
  ])('accepts %s', (value, origin) => {
    expect(parseDevServerOrigin(value)).toBe(origin);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://localhost:5173/',
    'http://localhost/',
    'http://evil.example:5173/',
    'http://localhost.evil.example:5173/',
    'http://localhost:5173@evil.example/',
    'http://user:pass@localhost:5173/',
    'http://localhost:5173/some/path',
    'http://localhost:5173/?q=1',
    'http://localhost:5173/#x',
    'http://192.168.1.10:5173/',
    'http://0.0.0.0:5173/',
    'ws://localhost:5173/',
    'file:///tmp/index.html',
    "http://localhost:5173/; script-src 'unsafe-eval'",
  ])('rejects %s', (value) => {
    expect(parseDevServerOrigin(value)).toBeNull();
  });
});

describe('buildDevelopmentCsp', () => {
  it('loosens only what the Vite dev server needs', () => {
    const production = buildProductionCsp().split('; ');
    const development = buildDevelopmentCsp(ORIGIN).split('; ');
    const changed = development.filter((directive) => !production.includes(directive));
    expect(changed).toEqual([
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://localhost:5173",
    ]);
    expect(development).toHaveLength(production.length);
  });

  it('never allows eval or a remote host', () => {
    const policy = buildDevelopmentCsp(ORIGIN);
    expect(policy).not.toMatch(/unsafe-eval|https:|\*|data:|blob:/);
    expect(policy.match(/\b(?:ws|http):\/\/[^\s;]+/g)).toEqual(['ws://localhost:5173']);
  });

  it.each(['https://evil.example', 'http://evil.example:5173', "http://localhost:5173; script-src *", 'http://localhost:5173/', ''])(
    'refuses to build a policy around %s',
    (origin) => {
      expect(() => buildDevelopmentCsp(origin)).toThrow(TypeError);
    },
  );
});

describe('isDevelopmentRequest', () => {
  it.each([
    'http://localhost:5173/',
    'http://localhost:5173/src/main.tsx',
    'http://localhost:5173/@vite/client',
    'ws://localhost:5173/?token=abc',
    'devtools://devtools/bundled/devtools_app.html',
  ])('allows %s', (url) => {
    expect(isDevelopmentRequest(url, ORIGIN)).toBe(true);
  });

  it.each([
    'https://evil.example/',
    'http://evil.example:5173/',
    'http://localhost:5174/',
    'http://localhost/',
    'http://127.0.0.1:5173/',
    'https://localhost:5173/',
    'wss://localhost:5173/',
    'http://localhost:5173.evil.example/',
    'http://localhost:5173@evil.example/',
    'http://user@localhost:5173/',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'not a url',
  ])('denies %s', (url) => {
    expect(isDevelopmentRequest(url, ORIGIN)).toBe(false);
  });
});

describe('developmentHostResolverRules', () => {
  it('excludes exactly the dev server name from the resolve-nothing rule', () => {
    expect(developmentHostResolverRules('http://localhost:5173')).toBe('MAP * ~NOTFOUND, EXCLUDE localhost');
    expect(developmentHostResolverRules('http://localhost:8080')).toBe('MAP * ~NOTFOUND, EXCLUDE localhost');
  });

  it.each(['http://127.0.0.1:5173', 'http://[::1]:5173'])('adds no exception for an IP literal: %s', (origin) => {
    expect(developmentHostResolverRules(origin)).toBe('MAP * ~NOTFOUND');
  });

  it('gives the runtime of an IP-literal dev server the production rules', () => {
    expect(createDevelopmentRuntime('http://127.0.0.1:5173/')?.hostResolverRules).toBe('MAP * ~NOTFOUND');
  });
});

describe('createDevelopmentRuntime', () => {
  it('describes the dev server', () => {
    const runtime = createDevelopmentRuntime('http://localhost:5173/');
    expect(runtime).toMatchObject({
      kind: 'development',
      entryUrl: 'http://localhost:5173/',
      injectedCsp: buildDevelopmentCsp(ORIGIN),
      proxyBypassRules: '<-loopback>;localhost:5173',
      hostResolverRules: 'MAP * ~NOTFOUND, EXCLUDE localhost',
    });
    expect(runtime?.isAllowedRequest('http://localhost:5173/src/main.tsx')).toBe(true);
    expect(runtime?.isAllowedRequest('https://evil.example/')).toBe(false);
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  it.each([undefined, 'https://evil.example/', 'http://localhost/'])('returns null for %s', (value) => {
    expect(createDevelopmentRuntime(value)).toBeNull();
  });
});
