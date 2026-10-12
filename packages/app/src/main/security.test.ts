import { describe, expect, it, vi } from 'vitest';

import { createDevelopmentRuntime } from './development';
import { APP_ENTRY_URL, PRODUCTION_RUNTIME, type Runtime } from './runtime';
import {
  BLACK_HOLE_PROXY,
  isAllowedNavigation,
  lockDownSession,
  lockDownWebContents,
  WEBRTC_IP_HANDLING_POLICY,
  type LockableSession,
  type LockableWebContents,
} from './security';

const DEV_ENTRY = 'http://localhost:5173/';

const developmentRuntime = (): Runtime => {
  const runtime = createDevelopmentRuntime(DEV_ENTRY);
  if (runtime === null) throw new Error('expected a development runtime');
  return runtime;
};

describe('isAllowedNavigation (production entry)', () => {
  it.each([
    APP_ENTRY_URL,
    'app://routeswitch/index.html?view=rules',
    'app://routeswitch/index.html#/rules/new',
    'APP://routeswitch/index.html',
  ])('allows %s', (url) => {
    expect(isAllowedNavigation(url, APP_ENTRY_URL)).toBe(true);
  });

  it.each([
    'https://evil.example',
    'https://evil.example/index.html',
    'http://evil.example/index.html',
    'HTTPS://EVIL.EXAMPLE/',
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'file:///Applications/RouteSwitch.app/Contents/Resources/app/out/renderer/index.html',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'about:srcdoc',
    'blob:app://routeswitch/0b7c1c6e-7d2f-4b53-9c44-0d7f7b6f3a10',
    'chrome://settings',
    'devtools://devtools/bundled/devtools_app.html',
    'app://routeswitch.evil.example/index.html',
    'app://routeswitch@evil.example/index.html',
    'app://evil.example/index.html',
    'app://user:pass@routeswitch/index.html',
    'app://routeswitch:8080/index.html',
    'app://ROUTESWITCH/index.html',
    'app://routeswitch/',
    'app://routeswitch/other.html',
    'app://routeswitch/index.html/extra',
    'app://routeswitch/assets/index.js',
    'app://routeswitch//evil.example/index.html',
    'apps://routeswitch/index.html',
    'app:routeswitch/index.html',
    '//evil.example/index.html',
    '/index.html',
    'index.html',
    '',
    ' ',
    // The dev server is not the app in production.
    DEV_ENTRY,
    'http://localhost:5173/index.html',
    'ws://localhost:5173/',
  ])('denies %s', (url) => {
    expect(isAllowedNavigation(url, APP_ENTRY_URL)).toBe(false);
  });
});

describe('isAllowedNavigation (development entry)', () => {
  it.each([DEV_ENTRY, 'http://localhost:5173/?view=rules', 'http://localhost:5173/#x', 'HTTP://LOCALHOST:5173/'])(
    'allows %s',
    (url) => {
      expect(isAllowedNavigation(url, DEV_ENTRY)).toBe(true);
    },
  );

  it.each([
    'https://evil.example/',
    'http://localhost:5173.evil.example/',
    'http://localhost:5173@evil.example/',
    'http://user@localhost:5173/',
    'http://localhost:5174/',
    'http://localhost/',
    'http://127.0.0.1:5173/',
    'https://localhost:5173/',
    'http://localhost:5173/src/main.tsx',
    'http://localhost:5173/@fs/etc/passwd',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'about:blank',
    APP_ENTRY_URL,
  ])('denies %s', (url) => {
    expect(isAllowedNavigation(url, DEV_ENTRY)).toBe(false);
  });

  it('denies everything when the entry itself is not a URL', () => {
    expect(isAllowedNavigation(DEV_ENTRY, 'not a url')).toBe(false);
  });
});

interface FakeEvent {
  url?: string;
  preventDefault: () => void;
}

function fakeContents() {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const setWindowOpenHandler = vi.fn<(handler: (details: unknown) => unknown) => void>();
  const setWebRTCIPHandlingPolicy = vi.fn<(policy: string) => void>();
  const contents = {
    on: (event: string, listener: (event: FakeEvent) => void) => {
      expect(listeners.has(event)).toBe(false);
      listeners.set(event, listener);
      return contents;
    },
    setWindowOpenHandler,
    setWebRTCIPHandlingPolicy,
  };
  const emit = (event: string, url?: string): boolean => {
    const listener = listeners.get(event);
    if (listener === undefined) throw new Error(`no listener for ${event}`);
    const preventDefault = vi.fn();
    listener(url === undefined ? { preventDefault } : { url, preventDefault });
    return preventDefault.mock.calls.length > 0;
  };
  return {
    contents: contents as unknown as LockableWebContents,
    listeners,
    setWindowOpenHandler,
    setWebRTCIPHandlingPolicy,
    emit,
  };
}

describe('lockDownWebContents', () => {
  it('registers exactly the four navigation guards', () => {
    const { contents, listeners } = fakeContents();
    lockDownWebContents(contents, PRODUCTION_RUNTIME);
    expect([...listeners.keys()].sort()).toEqual([
      'will-attach-webview',
      'will-frame-navigate',
      'will-navigate',
      'will-redirect',
    ]);
  });

  it.each(['will-navigate', 'will-redirect', 'will-frame-navigate'])('%s: blocks everything but the app page', (event) => {
    const { contents, emit } = fakeContents();
    lockDownWebContents(contents, PRODUCTION_RUNTIME);
    expect(emit(event, APP_ENTRY_URL)).toBe(false);
    expect(emit(event, 'app://routeswitch/index.html?view=rules')).toBe(false);
    for (const url of ['https://evil.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', DEV_ENTRY]) {
      expect(emit(event, url)).toBe(true);
    }
  });

  it('in development allows only the dev-server page', () => {
    const { contents, emit } = fakeContents();
    lockDownWebContents(contents, developmentRuntime());
    expect(emit('will-navigate', DEV_ENTRY)).toBe(false);
    expect(emit('will-navigate', 'https://evil.example/')).toBe(true);
    expect(emit('will-navigate', APP_ENTRY_URL)).toBe(true);
  });

  it('always blocks <webview> attachment', () => {
    const { contents, emit } = fakeContents();
    lockDownWebContents(contents, PRODUCTION_RUNTIME);
    expect(emit('will-attach-webview')).toBe(true);
  });

  it.each([
    ['production', (): Runtime => PRODUCTION_RUNTIME],
    ['development', developmentRuntime],
  ])('keeps WebRTC off UDP in %s', (_name, runtime) => {
    const { contents, setWebRTCIPHandlingPolicy } = fakeContents();
    lockDownWebContents(contents, runtime());
    expect(WEBRTC_IP_HANDLING_POLICY).toBe('disable_non_proxied_udp');
    expect(setWebRTCIPHandlingPolicy.mock.calls).toEqual([['disable_non_proxied_udp']]);
  });

  it('denies every window.open, whatever the target', () => {
    const { contents, setWindowOpenHandler } = fakeContents();
    lockDownWebContents(contents, PRODUCTION_RUNTIME);
    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = setWindowOpenHandler.mock.calls[0]?.[0];
    for (const url of [APP_ENTRY_URL, 'https://evil.example/', 'about:blank']) {
      expect(handler?.({ url })).toEqual({ action: 'deny' });
    }
  });
});

type BeforeRequest = (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void;
type HeadersReceived = (
  details: { responseHeaders?: Record<string, string[]> },
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
) => void;

type WillDownload = (event: { preventDefault: () => void }, item: { getURL: () => string }) => void;

function fakeSession(setProxyResult: (config: Record<string, string>) => Promise<void> = () => Promise.resolve()) {
  const setPermissionRequestHandler =
    vi.fn<(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void) => void>();
  const setPermissionCheckHandler = vi.fn<(handler: (...args: unknown[]) => boolean) => void>();
  const onBeforeRequest = vi.fn<(listener: BeforeRequest) => void>();
  const onHeadersReceived = vi.fn<(listener: HeadersReceived) => void>();
  const order: string[] = [];
  const setProxy = vi.fn<(config: Record<string, string>) => Promise<void>>((config) => {
    order.push('setProxy');
    return setProxyResult(config);
  });
  const sessionListeners = new Map<string, WillDownload>();
  const session = {
    setPermissionRequestHandler,
    setPermissionCheckHandler,
    webRequest: { onBeforeRequest, onHeadersReceived },
    setProxy,
    on: (event: string, listener: WillDownload) => {
      order.push(`on:${event}`);
      sessionListeners.set(event, listener);
      return session;
    },
  };
  return {
    session: session as unknown as LockableSession,
    setProxy,
    sessionListeners,
    order,
    setPermissionRequestHandler,
    setPermissionCheckHandler,
    onBeforeRequest,
    onHeadersReceived,
  };
}

describe('lockDownSession', () => {
  it('denies every permission request and check', async () => {
    const fake = fakeSession();
    await lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() });

    const request = fake.setPermissionRequestHandler.mock.calls[0]?.[0];
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen']) {
      const callback = vi.fn();
      request?.({}, permission, callback);
      expect(callback.mock.calls).toEqual([[false]]);
    }

    const check = fake.setPermissionCheckHandler.mock.calls[0]?.[0];
    expect(check?.({}, 'media', 'app://routeswitch', {})).toBe(false);
    expect(check?.(null, 'clipboard-read', '', {})).toBe(false);
  });

  it('in production cancels every request outside app://routeswitch and reports it', async () => {
    const fake = fakeSession();
    const onBlockedRequest = vi.fn();
    await lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest, onBlockedDownload: vi.fn() });
    const listener = fake.onBeforeRequest.mock.calls[0]?.[0];
    const cancelled = (url: string): boolean | undefined => {
      const callback = vi.fn<(response: { cancel?: boolean }) => void>();
      listener?.({ url }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0]?.[0].cancel;
    };

    expect(cancelled('app://routeswitch/index.html')).toBe(false);
    expect(cancelled('app://routeswitch/assets/index.js')).toBe(false);
    expect(onBlockedRequest).not.toHaveBeenCalled();

    const hostile = [
      'https://evil.example/x.js',
      'http://localhost:5173/',
      'ws://localhost:5173/',
      'file:///etc/passwd',
      'app://evil.example/index.html',
      'devtools://devtools/bundled/devtools_app.html',
      'not a url',
    ];
    for (const url of hostile) expect(cancelled(url)).toBe(true);
    expect(onBlockedRequest.mock.calls.map(([url]) => url as unknown)).toEqual(hostile);
  });

  it('in production leaves response headers alone', async () => {
    const fake = fakeSession();
    await lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() });
    expect(fake.onHeadersReceived).not.toHaveBeenCalled();
  });

  it('in development lets the dev server through and replaces its CSP with the development policy', async () => {
    const fake = fakeSession();
    const runtime = developmentRuntime();
    await lockDownSession(fake.session, { runtime, onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() });

    const before = fake.onBeforeRequest.mock.calls[0]?.[0];
    const allow = vi.fn<(response: { cancel?: boolean }) => void>();
    before?.({ url: 'http://localhost:5173/src/main.tsx' }, allow);
    before?.({ url: 'https://evil.example/' }, allow);
    expect(allow.mock.calls.map(([response]) => response.cancel)).toEqual([false, true]);

    const headers = fake.onHeadersReceived.mock.calls[0]?.[0];
    const callback = vi.fn<(response: { responseHeaders?: Record<string, string[]> }) => void>();
    headers?.(
      {
        responseHeaders: {
          'content-type': ['text/html'],
          'content-security-policy': ["default-src *; script-src * 'unsafe-eval'"],
          'Content-Security-Policy-Report-Only': ['default-src *'],
        },
      },
      callback,
    );
    headers?.({}, callback);
    expect(callback.mock.calls.map(([response]) => response.responseHeaders)).toEqual([
      { 'content-type': ['text/html'], 'Content-Security-Policy': [runtime.injectedCsp] },
      { 'Content-Security-Policy': [runtime.injectedCsp] },
    ]);
  });

  it('cancels every download and reports its URL', async () => {
    const fake = fakeSession();
    const onBlockedDownload = vi.fn();
    await lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest: vi.fn(), onBlockedDownload });
    const listener = fake.sessionListeners.get('will-download');
    expect(listener).toBeDefined();
    for (const url of ['blob:app://routeswitch/0b7c1c6e', 'data:text/plain,hi', 'app://routeswitch/index.html']) {
      const preventDefault = vi.fn();
      listener?.({ preventDefault }, { getURL: () => url });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(onBlockedDownload.mock.calls).toEqual([
      ['blob:app://routeswitch/0b7c1c6e'],
      ['data:text/plain,hi'],
      ['app://routeswitch/index.html'],
    ]);
  });

  it('in production sends every connection of the session to the black-hole proxy, loopback included', async () => {
    const fake = fakeSession();
    await lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() });
    expect(BLACK_HOLE_PROXY).toBe('socks5://127.0.0.1:9');
    expect(fake.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' }],
    ]);
  });

  it('in development bypasses the proxy for the dev server only', async () => {
    const fake = fakeSession();
    await lockDownSession(fake.session, { runtime: developmentRuntime(), onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() });
    expect(fake.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>;localhost:5173' }],
    ]);
  });

  it('has every handler in place before it waits for the proxy, and resolves only once the proxy is set', async () => {
    let finishProxy: () => void = () => undefined;
    const fake = fakeSession(() => new Promise<void>((resolve) => (finishProxy = resolve)));
    let settled = false;
    const done = lockDownSession(fake.session, {
      runtime: PRODUCTION_RUNTIME,
      onBlockedRequest: vi.fn(),
      onBlockedDownload: vi.fn(),
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(fake.order).toEqual(['on:will-download', 'setProxy']);
    expect(fake.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(fake.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finishProxy();
    await done;
    expect(settled).toBe(true);
  });

  it('rejects when the proxy cannot be set', async () => {
    const error = new Error('proxy');
    const fake = fakeSession(() => Promise.reject(error));
    await expect(
      lockDownSession(fake.session, { runtime: PRODUCTION_RUNTIME, onBlockedRequest: vi.fn(), onBlockedDownload: vi.fn() }),
    ).rejects.toBe(error);
  });
});
