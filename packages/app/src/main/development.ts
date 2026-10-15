// Everything that exists only for `electron-vite dev`. `index.ts` references
// this module behind `import.meta.env.DEV`, so a production build drops it:
// the development policy is not merely unused there, it is absent.

import { PRODUCTION_DIRECTIVES, serializeCsp } from './csp';
import { PROXY_NOTHING_BYPASSED, RESOLVE_NOTHING, type Runtime } from './runtime';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns the origin of a loopback http dev-server URL, or `null` for anything else. */
export function parseDevServerOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain =
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  return plain ? url.origin : null;
}

// The Vite dev server needs three things the production policy forbids: the
// inline React-refresh preamble, <style> elements injected for CSS modules and
// the HMR websocket. Nothing else is loosened, and `unsafe-eval` stays out.
export function buildDevelopmentCsp(devServerOrigin: string): string {
  if (parseDevServerOrigin(devServerOrigin) !== devServerOrigin) {
    throw new TypeError('The development CSP needs a loopback http origin with an explicit port.');
  }
  const overrides = new Map<string, readonly string[]>([
    ['script-src', ["'self'", "'unsafe-inline'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['connect-src', ["'self'", devServerOrigin.replace(/^http:/, 'ws:')]],
  ]);
  return serializeCsp(
    PRODUCTION_DIRECTIVES.map(([name, ...sources]) => [name, ...(overrides.get(name) ?? sources)]),
  );
}

/** The dev server, its HMR websocket and DevTools' own pages — nothing else. */
export function isDevelopmentRequest(value: string, devServerOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'devtools:') return true;
  return (url.protocol === 'http:' || url.protocol === 'ws:') && url.host === new URL(devServerOrigin).host;
}

/** Production rules plus the dev server's own name, when it has one (an IP literal needs no lookup). */
export function developmentHostResolverRules(devServerOrigin: string): string {
  const { hostname } = new URL(devServerOrigin);
  return hostname === 'localhost' ? `${RESOLVE_NOTHING}, EXCLUDE ${hostname}` : RESOLVE_NOTHING;
}

export function createDevelopmentRuntime(rendererUrl: string | undefined): Runtime | null {
  const devServerOrigin = parseDevServerOrigin(rendererUrl);
  if (devServerOrigin === null) return null;
  return Object.freeze({
    kind: 'development',
    entryUrl: `${devServerOrigin}/`,
    isAllowedRequest: (url: string) => isDevelopmentRequest(url, devServerOrigin),
    injectedCsp: buildDevelopmentCsp(devServerOrigin),
    // Only the dev server itself stays reachable; nothing else on loopback does.
    proxyBypassRules: `${PROXY_NOTHING_BYPASSED};${new URL(devServerOrigin).host}`,
    hostResolverRules: developmentHostResolverRules(devServerOrigin),
  });
}
