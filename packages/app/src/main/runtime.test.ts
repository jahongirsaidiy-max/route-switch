import { describe, expect, it, vi } from 'vitest';

import { createDevelopmentRuntime } from './development';
import { APP_ENTRY_URL, isAppUrl, PRODUCTION_RUNTIME, resolveRuntime } from './runtime';

const DEV_URL = 'http://localhost:5173/';

describe('PRODUCTION_RUNTIME', () => {
  it('loads the bundled page and injects no policy of its own', () => {
    expect(APP_ENTRY_URL).toBe('app://routeswitch/index.html');
    expect(PRODUCTION_RUNTIME).toMatchObject({ kind: 'production', entryUrl: APP_ENTRY_URL, injectedCsp: null });
  });

  it('lets nothing bypass the black-hole proxy, loopback included', () => {
    expect(PRODUCTION_RUNTIME.proxyBypassRules).toBe('<-loopback>');
  });

  it('lets Chromium resolve no host name at all — and has no exception for any', () => {
    expect(PRODUCTION_RUNTIME.hostResolverRules).toBe('MAP * ~NOTFOUND');
    expect(PRODUCTION_RUNTIME.hostResolverRules).not.toMatch(/EXCLUDE|localhost/);
    expect(Object.isFrozen(PRODUCTION_RUNTIME)).toBe(true);
  });

  it('allows requests only to the bundle', () => {
    expect(PRODUCTION_RUNTIME.isAllowedRequest('app://routeswitch/assets/index.js')).toBe(true);
    expect(PRODUCTION_RUNTIME.isAllowedRequest(DEV_URL)).toBe(false);
    expect(PRODUCTION_RUNTIME.isAllowedRequest('ws://localhost:5173/')).toBe(false);
    expect(PRODUCTION_RUNTIME.isAllowedRequest('devtools://devtools/bundled/devtools_app.html')).toBe(false);
  });
});

describe('isAppUrl', () => {
  it.each(['app://routeswitch/', 'app://routeswitch/index.html', 'app://routeswitch/assets/a.js?x=1#y', 'APP://routeswitch/index.html'])(
    'accepts %s',
    (url) => {
      expect(isAppUrl(url)).toBe(true);
    },
  );

  it.each([
    'https://evil.example/',
    'http://routeswitch/',
    'file:///etc/passwd',
    'app://evil.example/index.html',
    'app://routeswitch.evil.example/index.html',
    'app://routeswitch@evil.example/index.html',
    'app://user:pass@routeswitch/index.html',
    'app://routeswitch:8080/index.html',
    'app://ROUTESWITCH/index.html',
    'app:routeswitch/index.html',
    'apps://routeswitch/index.html',
    'javascript:alert(1)',
    'data:text/html,hi',
    'about:blank',
    '',
  ])('rejects %s', (url) => {
    expect(isAppUrl(url)).toBe(false);
  });
});

describe('resolveRuntime', () => {
  it('is development only for a dev build, unpackaged, with a dev-server URL', () => {
    const runtime = resolveRuntime({ isPackaged: false, rendererUrl: DEV_URL, development: createDevelopmentRuntime });
    expect(runtime.kind).toBe('development');
    expect(runtime.entryUrl).toBe(DEV_URL);
  });

  it('is production in a production build, whatever the environment says', () => {
    expect(resolveRuntime({ isPackaged: false, rendererUrl: DEV_URL, development: null })).toBe(PRODUCTION_RUNTIME);
  });

  it('is production in a packaged app and does not even consult the dev factory', () => {
    const development = vi.fn(createDevelopmentRuntime);
    expect(resolveRuntime({ isPackaged: true, rendererUrl: DEV_URL, development })).toBe(PRODUCTION_RUNTIME);
    expect(development).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'https://evil.example/', 'http://evil.example:5173/', 'file:///tmp/x.html'])(
    'falls back to production when the renderer URL is %s',
    (rendererUrl) => {
      expect(resolveRuntime({ isPackaged: false, rendererUrl, development: createDevelopmentRuntime })).toBe(
        PRODUCTION_RUNTIME,
      );
    },
  );
});
