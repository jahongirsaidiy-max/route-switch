import { describe, expect, it, vi } from 'vitest';

import { startApp, type BootstrapDeps } from './bootstrap';
import { buildProductionCsp } from './csp';
import { createDevelopmentRuntime } from './development';
import { createLogger } from './logger';
import { APP_ENTRY_URL } from './runtime';
import { fakeBrowserWindowClass } from './test-utils';
import type { ShellContext } from './tray';
import { POPOVER_LAYOUT } from './windows';

const POPOVER_URL = `${APP_ENTRY_URL}?view=popover`;

type Listener = (...args: unknown[]) => void;

interface Options {
  readonly lock?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly dock?: boolean;
  readonly isPackaged?: boolean;
  readonly development?: BootstrapDeps['development'];
  readonly rendererUrl?: string;
  readonly getDefaultSession?: () => never;
  readonly proxyFails?: boolean;
  /** `setProxy` stays pending until `releaseProxy()` is called. */
  readonly holdProxy?: boolean;
  /** `startShell` throws this. */
  readonly shellFails?: Error;
}

function harness(options: Options = {}) {
  const order: string[] = [];
  const listeners = new Map<string, Listener>();
  const dockHide = vi.fn(() => order.push('dock.hide'));
  const app = {
    isPackaged: options.isPackaged ?? false,
    dock: options.dock === false ? undefined : { hide: dockHide },
    commandLine: {
      appendSwitch: vi.fn<(name: string, value?: string) => void>((name) => {
        order.push(`switch:${name}`);
      }),
    },
    requestSingleInstanceLock: vi.fn(() => options.lock ?? true),
    quit: vi.fn(),
    exit: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return app;
    }),
    whenReady: vi.fn(() => {
      order.push('whenReady');
      return Promise.resolve();
    }),
  };
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(() => order.push('registerSchemesAsPrivileged')),
    handle: vi.fn<(scheme: string, handler: (request: Request) => Promise<Response>) => void>(() => {
      order.push('protocol.handle');
    }),
  };
  let releaseProxy: () => void = () => undefined;
  const proxyGate = new Promise<void>((resolve) => {
    releaseProxy = resolve;
  });
  const fakeSession = (name: string) => {
    const sessionListeners = new Map<string, Listener>();
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn<(listener: (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) => void>(),
        onHeadersReceived: vi.fn(),
      },
      // Like the real one, the proxy takes effect some time after the call.
      setProxy: vi.fn(async () => {
        order.push(`setProxy:${name}`);
        await (options.holdProxy === true ? proxyGate : new Promise((resolve) => setTimeout(resolve, 5)));
        if (options.proxyFails === true) throw new Error('proxy');
        order.push(`proxySet:${name}`);
      }),
      on: vi.fn((event: string, listener: Listener) => {
        sessionListeners.set(event, listener);
        return session;
      }),
      sessionListeners,
    };
    return session;
  };
  const session = fakeSession('default');
  // Like Electron, the first access to the default session emits
  // `session-created` synchronously, before the caller gets the session back.
  let defaultSessionCreated = false;
  const getDefaultSession = () => {
    if (!defaultSessionCreated) {
      defaultSessionCreated = true;
      order.push('session-created');
      listeners.get('session-created')?.(session);
    }
    return session;
  };
  const fake = fakeBrowserWindowClass(
    () => {
      order.push('loadURL');
      return Promise.resolve();
    },
    () => order.push('construct'),
  );
  // `report(level, msg, context)` — one call per line the app logs.
  const report = vi.fn();
  const logger = createLogger({
    sink: (entry) => {
      const context: Record<string, unknown> = { ...entry };
      for (const field of ['level', 'at', 'msg']) Reflect.deleteProperty(context, field);
      report(entry.level, entry.msg, context);
    },
    now: () => 0,
  });
  const helperClient = {
    start: vi.fn(() => order.push('helperClient.start')),
    stop: vi.fn(() => order.push('helperClient.stop')),
  };
  const readFile = vi.fn(() => Promise.resolve(new Uint8Array(new TextEncoder().encode('<!doctype html>'))));
  // Stands in for tray.ts: records its context and opens the popover at once,
  // as a click on the tray icon would, so the window path is exercised too.
  const shellFake = {
    contexts: [] as ShellContext[],
    showPopover: vi.fn(() => order.push('shell.showPopover')),
    dispose: vi.fn(() => order.push('shell.dispose')),
  };
  const startShell = vi.fn((context: ShellContext) => {
    order.push('startShell');
    if (options.shellFails !== undefined) throw options.shellFails;
    shellFake.contexts.push(context);
    context.createWindow(POPOVER_LAYOUT, 'popover');
    return { showPopover: shellFake.showPopover, dispose: shellFake.dispose };
  });

  startApp({
    app,
    BrowserWindow: fake.ctor,
    protocol,
    getDefaultSession: options.getDefaultSession ?? getDefaultSession,
    platform: options.platform ?? 'darwin',
    development: options.development ?? null,
    rendererUrl: options.rendererUrl,
    preloadPath: '/opt/routeswitch/preload/index.cjs',
    rendererRoot: '/opt/routeswitch/renderer',
    readFile,
    realpath: (filePath: string) => Promise.resolve(filePath),
    logger,
    helperClient,
    startShell,
  } as unknown as BootstrapDeps);

  const emit = (event: string, ...args: unknown[]): void => {
    const listener = listeners.get(event);
    if (listener === undefined) throw new Error(`no listener for ${event}`);
    listener(...args);
  };
  const ready = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  return {
    app,
    protocol,
    session,
    fakeSession,
    windows: fake.windows,
    report,
    helperClient,
    menuBar: shellFake,
    startShell,
    readFile,
    dockHide,
    order,
    listeners,
    emit,
    ready,
    releaseProxy: () => {
      releaseProxy();
    },
  };
}

describe('startApp', () => {
  it('quits at once when another instance holds the lock', async () => {
    const h = harness({ lock: false });
    await h.ready();
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.app.whenReady).not.toHaveBeenCalled();
    expect(h.protocol.registerSchemesAsPrivileged).not.toHaveBeenCalled();
    expect(h.windows).toHaveLength(0);
  });

  it('registers the app:// scheme before the app is ready', async () => {
    const h = harness();
    expect(h.order.slice(0, 3)).toEqual(['registerSchemesAsPrivileged', 'switch:host-resolver-rules', 'whenReady']);
    await h.ready();
  });

  it('hides the Dock icon on macOS', async () => {
    const h = harness({ platform: 'darwin' });
    await h.ready();
    expect(h.dockHide).toHaveBeenCalledTimes(1);
  });

  it.each(['linux', 'win32'] as const)('does not touch the Dock on %s, where app.dock does not exist', async (platform) => {
    const h = harness({ platform, dock: false });
    await h.ready();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.app.exit).not.toHaveBeenCalled();
    expect(h.windows).toHaveLength(1);
  });

  it('does not hide a Dock that another platform happens to expose', async () => {
    const h = harness({ platform: 'linux' });
    await h.ready();
    expect(h.dockHide).not.toHaveBeenCalled();
  });

  it('in production serves app://, locks the session down and opens one hardened window on the app page', async () => {
    const h = harness();
    await h.ready();

    expect(h.protocol.handle).toHaveBeenCalledTimes(1);
    const [scheme, handler] = h.protocol.handle.mock.calls[0] ?? [];
    expect(scheme).toBe('app');
    const response = await handler?.(new Request(APP_ENTRY_URL));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Security-Policy')).toBe(buildProductionCsp());
    expect(h.readFile.mock.calls).toEqual([['/opt/routeswitch/renderer/index.html']]);

    expect(h.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(h.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(h.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(h.session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(h.session.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' }],
    ]);
    expect([...h.session.sessionListeners.keys()]).toEqual(['will-download']);

    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]?.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      preload: '/opt/routeswitch/preload/index.cjs',
    });
    expect(h.windows[0]?.loadURL.mock.calls).toEqual([[POPOVER_URL]]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('reports requests the session blocked', async () => {
    const h = harness();
    await h.ready();
    const listener = h.session.webRequest.onBeforeRequest.mock.calls[0]?.[0];
    const callback = vi.fn();
    listener?.({ url: 'https://evil.example/x.js' }, callback);
    expect(callback.mock.calls).toEqual([[{ cancel: true }]]);
    expect(h.report.mock.calls).toEqual([['warn', 'Blocked a request outside the app', { url: 'https://evil.example/x.js' }]]);
  });

  it('starts up in exactly this order: nothing is constructed or loaded before the proxy is in force', async () => {
    const h = harness();
    await h.ready();
    expect(h.order).toEqual([
      'registerSchemesAsPrivileged',
      'switch:host-resolver-rules',
      'whenReady',
      'dock.hide',
      'session-created',
      'setProxy:default',
      'proxySet:default',
      'protocol.handle',
      'startShell',
      'construct',
      'loadURL',
      'helperClient.start',
    ]);
    expect(h.session.setProxy).toHaveBeenCalledTimes(1);
  });

  it('waits for the lockdown that `session-created` started — however long the proxy takes', async () => {
    const h = harness({ holdProxy: true });
    await h.ready();
    await h.ready();
    // The lockdown is in flight (started by `session-created`), not finished.
    expect(h.order.slice(-2)).toEqual(['session-created', 'setProxy:default']);
    expect(h.windows).toHaveLength(0);
    expect(h.protocol.handle).not.toHaveBeenCalled();

    h.releaseProxy();
    await h.ready();
    expect(h.order.slice(-6)).toEqual([
      'proxySet:default',
      'protocol.handle',
      'startShell',
      'construct',
      'loadURL',
      'helperClient.start',
    ]);
    expect(h.windows).toHaveLength(1);
    expect(h.session.setProxy).toHaveBeenCalledTimes(1);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('fails startup once, without a window, when the session cannot be locked down', async () => {
    const h = harness({ proxyFails: true });
    await h.ready();
    expect(h.windows).toHaveLength(0);
    expect(h.protocol.handle).not.toHaveBeenCalled();
    expect(h.report.mock.calls.map(([level, msg]) => [level, msg] as unknown)).toEqual([
      ['error', 'A session could not be locked down'],
    ]);
    expect(h.app.exit.mock.calls).toEqual([[1]]);
  });

  it.each([
    ['production', {}, 'MAP * ~NOTFOUND'],
    ['development', { development: createDevelopmentRuntime, rendererUrl: 'http://localhost:5173/' }, 'MAP * ~NOTFOUND, EXCLUDE localhost'],
    ['a packaged app with a dev URL', { isPackaged: true, development: createDevelopmentRuntime, rendererUrl: 'http://localhost:5173/' }, 'MAP * ~NOTFOUND'],
    ['a production build with a dev URL', { development: null, rendererUrl: 'http://localhost:5173/' }, 'MAP * ~NOTFOUND'],
  ])('tells Chromium before the app is ready to resolve no host names (%s)', async (_name, options, rules) => {
    const h = harness(options);
    expect(h.app.commandLine.appendSwitch.mock.calls).toEqual([['host-resolver-rules', rules]]);
    expect(h.order.indexOf('switch:host-resolver-rules')).toBeLessThan(h.order.indexOf('whenReady'));
    await h.ready();
    expect(h.app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
  });

  it('stays alive when a window had to be closed for leaving the app page — the tray opens a new one', async () => {
    const h = harness();
    await h.ready();
    const window = h.windows[0];
    if (window === undefined) throw new Error('expected a window');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      window.emitContents('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'about:srcdoc', true);
    }
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls.filter(([level]) => level === 'error')).toEqual([
      ['error', 'A window kept leaving the app page and was closed', { url: 'about:srcdoc' }],
    ]);
    expect(h.app.exit).not.toHaveBeenCalled();
    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.helperClient.stop).not.toHaveBeenCalled();
    // The factory still makes windows afterwards.
    h.menuBar.contexts[0]?.createWindow(POPOVER_LAYOUT, 'popover');
    expect(h.windows).toHaveLength(2);
    expect(h.windows[1]?.loadURL.mock.calls).toEqual([[POPOVER_URL]]);
  });

  it('closes a window whose renderer ended, logs it and stays alive', async () => {
    const h = harness();
    await h.ready();
    const window = h.windows[0];
    if (window === undefined) throw new Error('expected a window');
    window.emitContents('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls).toEqual([['error', 'The page of a window ended and the window was closed', { reason: 'crashed' }]]);
    expect(h.app.exit).not.toHaveBeenCalled();
    expect(h.app.quit).not.toHaveBeenCalled();
    h.menuBar.contexts[0]?.createWindow(POPOVER_LAYOUT, 'popover');
    expect(h.windows).toHaveLength(2);
  });

  it('cancels downloads and reports them', async () => {
    const h = harness();
    await h.ready();
    const preventDefault = vi.fn();
    h.session.sessionListeners.get('will-download')?.({ preventDefault }, { getURL: () => 'blob:app://routeswitch/1' });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls).toEqual([['warn', 'Blocked a download', { url: 'blob:app://routeswitch/1' }]]);
  });

  it('locks down every other session the moment it is created, and each session only once', async () => {
    const h = harness();
    await h.ready();
    h.emit('session-created', h.session);
    expect(h.session.setProxy).toHaveBeenCalledTimes(1);
    expect(h.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);

    const other = h.fakeSession('other');
    h.emit('session-created', other);
    await h.ready();
    expect(other.setProxy.mock.calls).toEqual(h.session.setProxy.mock.calls);
    expect(other.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(other.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(other.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect([...other.sessionListeners.keys()]).toEqual(['will-download']);
    expect(h.app.exit).not.toHaveBeenCalled();
  });

  it('locks down a session created before the app is ready, and does not repeat it at startup', () => {
    const h = harness();
    h.emit('session-created', h.session);
    return h.ready().then(() => {
      expect(h.session.setProxy).toHaveBeenCalledTimes(1);
      expect(h.windows).toHaveLength(1);
    });
  });

  it('exits when a later session cannot be locked down', async () => {
    const h = harness();
    await h.ready();
    const broken = h.fakeSession('broken');
    broken.setProxy.mockRejectedValueOnce(new Error('proxy'));
    h.emit('session-created', broken);
    await h.ready();
    expect(h.report.mock.calls.map(([level, msg]) => [level, msg] as unknown)).toEqual([
      ['error', 'A session could not be locked down'],
    ]);
    expect(h.app.exit.mock.calls).toEqual([[1]]);
  });

  it('in development loads the dev server and does not serve app://', async () => {
    const h = harness({ development: createDevelopmentRuntime, rendererUrl: 'http://localhost:5173/' });
    await h.ready();
    expect(h.protocol.handle).not.toHaveBeenCalled();
    expect(h.session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(h.windows[0]?.loadURL.mock.calls).toEqual([['http://localhost:5173/?view=popover']]);
    expect(h.menuBar.contexts[0]?.entryUrl).toBe('http://localhost:5173/');
    expect(h.windows[0]?.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    });
  });

  it.each([
    ['a packaged app', { isPackaged: true, development: createDevelopmentRuntime, rendererUrl: 'http://localhost:5173/' }],
    ['a production build', { development: null, rendererUrl: 'http://localhost:5173/' }],
    ['a remote renderer URL', { development: createDevelopmentRuntime, rendererUrl: 'https://evil.example/' }],
  ])('stays in production for %s', async (_name, options) => {
    const h = harness(options);
    await h.ready();
    expect(h.protocol.handle).toHaveBeenCalledTimes(1);
    expect(h.session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(h.windows[0]?.loadURL.mock.calls).toEqual([[POPOVER_URL]]);
    expect(h.windows[0]?.options.webPreferences?.devTools).toBe(false);
  });

  it('locks down every webContents the app creates', async () => {
    const h = harness();
    await h.ready();
    const events: string[] = [];
    const contents = {
      on: vi.fn((event: string) => {
        events.push(event);
        return contents;
      }),
      setWindowOpenHandler: vi.fn<(handler: () => unknown) => void>(),
      setWebRTCIPHandlingPolicy: vi.fn<(policy: string) => void>(),
    };
    h.emit('web-contents-created', {}, contents);
    expect(events.sort()).toEqual(['will-attach-webview', 'will-frame-navigate', 'will-navigate', 'will-redirect']);
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' });
    expect(contents.setWebRTCIPHandlingPolicy.mock.calls).toEqual([['disable_non_proxied_udp']]);
  });

  it('shows the popover when a second instance starts, without reading its command line', async () => {
    const h = harness();
    h.emit('second-instance');
    expect(h.menuBar.showPopover).not.toHaveBeenCalled();
    await h.ready();
    h.emit('second-instance', {}, ['--evil'], '/tmp');
    expect(h.menuBar.showPopover).toHaveBeenCalledTimes(1);
    expect(h.menuBar.showPopover.mock.calls[0]).toEqual([]);
  });

  it('stays in the menu bar when the last window closes, and leaves the helper client alone', async () => {
    const h = harness();
    await h.ready();
    h.emit('window-all-closed');
    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.app.exit).not.toHaveBeenCalled();
    expect(h.helperClient.stop).not.toHaveBeenCalled();
  });

  it('starts the shell once, after the lockdown, with the window factory and the app page', async () => {
    const h = harness();
    await h.ready();
    expect(h.startShell).toHaveBeenCalledTimes(1);
    expect(h.menuBar.contexts[0]?.entryUrl).toBe(APP_ENTRY_URL);
    expect(h.order.indexOf('startShell')).toBeGreaterThan(h.order.indexOf('proxySet:default'));
  });

  it('ends startup when the shell cannot start', async () => {
    const h = harness({ shellFails: new Error('no tray') });
    await h.ready();
    expect(h.report.mock.calls).toEqual([['error', 'Startup failed', { detail: 'Error: no tray' }]]);
    expect(h.app.exit.mock.calls).toEqual([[1]]);
    expect(h.helperClient.start).not.toHaveBeenCalled();
  });

  it('reports a startup failure and exits non-zero', async () => {
    const error = new Error('no session');
    const h = harness({
      getDefaultSession: () => {
        throw error;
      },
    });
    await h.ready();
    expect(h.report.mock.calls).toEqual([['error', 'Startup failed', { detail: 'Error: no session' }]]);
    expect(h.app.exit.mock.calls).toEqual([[1]]);
    expect(h.windows).toHaveLength(0);
  });

  it('starts the helper client only after the window is open, and never before the lockdown', async () => {
    const h = harness({ holdProxy: true });
    await h.ready();
    expect(h.helperClient.start).not.toHaveBeenCalled();
    h.releaseProxy();
    await h.ready();
    expect(h.helperClient.start).toHaveBeenCalledTimes(1);
    expect(h.order.indexOf('helperClient.start')).toBeGreaterThan(h.order.indexOf('loadURL'));
  });

  it('does not start the helper client when startup fails or another instance is running', async () => {
    const failed = harness({ proxyFails: true });
    await failed.ready();
    expect(failed.helperClient.start).not.toHaveBeenCalled();
    const second = harness({ lock: false });
    await second.ready();
    expect(second.helperClient.start).not.toHaveBeenCalled();
  });

  it('takes the shell down and stops the helper client when the app quits', async () => {
    const h = harness();
    await h.ready();
    expect(h.helperClient.stop).not.toHaveBeenCalled();
    h.emit('will-quit');
    expect(h.order.slice(-2)).toEqual(['shell.dispose', 'helperClient.stop']);
    h.emit('will-quit');
    expect(h.menuBar.dispose).toHaveBeenCalledTimes(1);
    expect(h.helperClient.stop).toHaveBeenCalledTimes(2);
  });

  it('logs blocked requests under a budget: a page cannot fill the log', async () => {
    const h = harness();
    await h.ready();
    const listener = h.session.webRequest.onBeforeRequest.mock.calls[0]?.[0];
    for (let i = 0; i < 500; i += 1) listener?.({ url: `https://evil.example/${String(i)}` }, vi.fn());
    const download = h.session.sessionListeners.get('will-download');
    for (let i = 0; i < 500; i += 1) download?.({ preventDefault: vi.fn() }, { getURL: () => `blob:app://routeswitch/${String(i)}` });
    const lines = h.report.mock.calls.map(([, msg]) => msg as string);
    expect(lines.filter((msg) => msg === 'Blocked a request outside the app')).toHaveLength(5);
    expect(lines.filter((msg) => msg === 'Blocked a download')).toHaveLength(5);
    expect(lines).toHaveLength(12);
  });

  it('listens to nothing beyond the lifecycle events (IPC is the shell’s)', async () => {
    const h = harness();
    await h.ready();
    expect([...h.listeners.keys()].sort()).toEqual([
      'second-instance',
      'session-created',
      'web-contents-created',
      'will-quit',
      'window-all-closed',
    ]);
  });
});
