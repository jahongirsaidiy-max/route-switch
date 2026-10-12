import { describe, expect, it, vi } from 'vitest';

import { createDevelopmentRuntime } from './development';
import { APP_ENTRY_URL, PRODUCTION_RUNTIME, type Runtime } from './runtime';
import { fakeBrowserWindowClass } from './test-utils';
import {
  createWindowFactory,
  hardenedWebPreferences,
  MAX_RECOVERIES,
  RECOVERY_WINDOW_MS,
  type WindowLayout,
} from './windows';

const PRELOAD = '/opt/routeswitch/preload/index.cjs';

const HARDENED = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  disableBlinkFeatures: 'FileSystemAccessLocal',
  devTools: false,
};

const developmentRuntime = (): Runtime => {
  const runtime = createDevelopmentRuntime('http://localhost:5173/');
  if (runtime === null) throw new Error('expected a development runtime');
  return runtime;
};

function factory(runtime: Runtime = PRODUCTION_RUNTIME, load?: (url: string) => Promise<void>) {
  const fake = fakeBrowserWindowClass(load);
  const onLoadError = vi.fn();
  const onForeignDocument = vi.fn();
  const onUnrecoverable = vi.fn();
  const clock = { now: 1_000_000 };
  const createWindow = createWindowFactory({
    BrowserWindow: fake.ctor,
    runtime,
    preloadPath: PRELOAD,
    onLoadError,
    onForeignDocument,
    onUnrecoverable,
    now: () => clock.now,
  });
  return { createWindow, windows: fake.windows, onLoadError, onForeignDocument, onUnrecoverable, clock };
}

// What a careless or hostile caller might try to get past the type checker.
const weaken = (options: Record<string, unknown>): WindowLayout => options;

describe('hardenedWebPreferences', () => {
  it('is exactly the hardened set', () => {
    expect(hardenedWebPreferences({ preloadPath: PRELOAD, devTools: false })).toEqual(HARDENED);
  });

  it('changes nothing but devTools in development', () => {
    expect(hardenedWebPreferences({ preloadPath: PRELOAD, devTools: true })).toEqual({ ...HARDENED, devTools: true });
  });

  it('never mentions the removed remote module', () => {
    expect(hardenedWebPreferences({ preloadPath: PRELOAD, devTools: true })).not.toHaveProperty('enableRemoteModule');
  });
});

describe('createWindowFactory', () => {
  it('creates a window with the hardened webPreferences and the caller’s layout', () => {
    const { createWindow, windows } = factory();
    const window = createWindow({ width: 360, height: 600, frame: false, show: false, resizable: false });
    expect(windows).toHaveLength(1);
    expect(window).toBe(windows[0]);
    expect(windows[0]?.options).toEqual({
      width: 360,
      height: 600,
      frame: false,
      show: false,
      resizable: false,
      webPreferences: HARDENED,
    });
  });

  it('gives every window the same preferences, and no window a shared mutable object', () => {
    const { createWindow, windows } = factory();
    createWindow({ width: 360, height: 600 });
    createWindow({ width: 1040, height: 680 });
    const [first, second] = windows.map((window) => window.options.webPreferences);
    expect(first).toEqual(HARDENED);
    expect(second).toEqual(HARDENED);
    expect(first).not.toBe(second);
    if (first !== undefined) first.nodeIntegration = true;
    createWindow({});
    expect(windows[2]?.options.webPreferences).toEqual(HARDENED);
  });

  it('enables DevTools only in development', () => {
    const production = factory(PRODUCTION_RUNTIME);
    production.createWindow({});
    expect(production.windows[0]?.options.webPreferences?.devTools).toBe(false);

    const development = factory(developmentRuntime());
    development.createWindow({});
    expect(development.windows[0]?.options.webPreferences).toEqual({ ...HARDENED, devTools: true });
  });

  it.each([
    ['webPreferences', { webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } }],
    ['an empty webPreferences', { webPreferences: {} }],
    ['webPreferences next to layout', { width: 100, webPreferences: { webSecurity: false } }],
    ['a top-level nodeIntegration', { nodeIntegration: true }],
    ['a top-level sandbox', { sandbox: false }],
    ['a top-level preload', { preload: '/tmp/evil.js' }],
    ['kiosk', { kiosk: true }],
    ['parent', { parent: {} }],
    ['an unknown option', { somethingNew: 1 }],
  ])('rejects %s and creates no window', (_name, options) => {
    const { createWindow, windows } = factory();
    expect(() => createWindow(weaken(options))).toThrow(TypeError);
    expect(windows).toHaveLength(0);
  });

  it('passes nothing outside the allowlist even when the caller’s object lies about its keys', () => {
    // First `ownKeys` answer hides `kiosk` (so the check passes); later ones show it.
    let asked = 0;
    const lying = new Proxy<Record<string, unknown>>(
      { width: 360, kiosk: true, webPreferences: { nodeIntegration: true } },
      {
        ownKeys: (target) => {
          asked += 1;
          return asked === 1 ? ['width'] : Reflect.ownKeys(target);
        },
      },
    );
    const { createWindow, windows } = factory();
    createWindow(weaken(lying));
    expect(windows[0]?.options).toEqual({ width: 360, webPreferences: HARDENED });
    expect(Object.keys(windows[0]?.options ?? {}).sort()).toEqual(['webPreferences', 'width']);
  });

  it('passes nothing outside the allowlist from an object whose keys cannot be listed at all', () => {
    const hidden = new Proxy<Record<string, unknown>>(
      { height: 600, kiosk: true, fullscreen: true, webPreferences: { sandbox: false } },
      { ownKeys: () => [] },
    );
    const { createWindow, windows } = factory();
    createWindow(weaken(hidden));
    expect(windows[0]?.options).toEqual({ height: 600, webPreferences: HARDENED });
  });

  it('reads each allowed key from the caller’s object exactly once', () => {
    const reads: string[] = [];
    const counting = new Proxy<Record<string, unknown>>(
      { width: 360, show: false },
      {
        get: (target, key, receiver) => {
          if (typeof key === 'string') reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const { createWindow, windows } = factory();
    createWindow(weaken(counting));
    expect(windows[0]?.options).toEqual({ width: 360, show: false, webPreferences: HARDENED });
    expect(reads.filter((key) => key === 'width')).toHaveLength(1);
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).not.toContain('webPreferences');
    expect(reads).not.toContain('kiosk');
  });

  it('drops layout options given as undefined', () => {
    const { createWindow, windows } = factory();
    createWindow(weaken({ width: 360, height: undefined }));
    expect(windows[0]?.options).toEqual({ width: 360, webPreferences: HARDENED });
  });

  it('names the rejected options', () => {
    const { createWindow } = factory();
    expect(() => createWindow(weaken({ width: 1, webPreferences: {}, kiosk: true }))).toThrow(
      'Not a window layout option: webPreferences, kiosk',
    );
  });

  it('loads the app page — and only that — into every window', () => {
    const production = factory();
    production.createWindow({});
    expect(production.windows[0]?.loadURL.mock.calls).toEqual([[APP_ENTRY_URL]]);

    const development = factory(developmentRuntime());
    development.createWindow({});
    expect(development.windows[0]?.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
  });

  it.each(['about:blank', 'https://evil.example/', 'file:///etc/passwd', 'app://routeswitch/other.html'])(
    'sends a window that ended up on %s back to the app page and reports it',
    (url) => {
      const { createWindow, windows, onForeignDocument } = factory();
      createWindow({});
      windows[0]?.emitContents('did-navigate', {}, url);
      expect(windows[0]?.loadURL.mock.calls).toEqual([[APP_ENTRY_URL], [APP_ENTRY_URL]]);
      expect(onForeignDocument.mock.calls).toEqual([[url]]);
    },
  );

  it.each([
    ['about:srcdoc', -300],
    ['app://routeswitch/index.html', -6],
    ['http://localhost:5173/', -102],
  ])('sends a window back when its main frame fails to load %s (%d)', (url, errorCode) => {
    const { createWindow, windows, onForeignDocument } = factory();
    createWindow({});
    windows[0]?.emitContents('did-fail-load', {}, errorCode, 'ERR', url, true);
    expect(windows[0]?.loadURL.mock.calls).toEqual([[APP_ENTRY_URL], [APP_ENTRY_URL]]);
    expect(onForeignDocument.mock.calls).toEqual([[url]]);
  });

  it('ignores a failed subframe and a load that was merely cancelled', () => {
    const { createWindow, windows, onForeignDocument } = factory();
    createWindow({});
    windows[0]?.emitContents('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'about:srcdoc', false);
    windows[0]?.emitContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://evil.example/', true);
    expect(windows[0]?.loadURL).toHaveBeenCalledTimes(1);
    expect(onForeignDocument).not.toHaveBeenCalled();
  });

  it('closes a window that keeps leaving the app page instead of reloading it for ever', () => {
    const { createWindow, windows, onForeignDocument, onUnrecoverable, clock } = factory();
    createWindow({});
    const window = windows[0];
    if (window === undefined) throw new Error('expected a window');

    for (let attempt = 1; attempt <= MAX_RECOVERIES; attempt += 1) {
      clock.now += 100;
      window.emitContents('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', APP_ENTRY_URL, true);
      expect(window.loadURL).toHaveBeenCalledTimes(1 + attempt);
      expect(window.destroy).not.toHaveBeenCalled();
    }

    clock.now += 100;
    window.emitContents('did-navigate', {}, 'about:blank');
    expect(window.loadURL).toHaveBeenCalledTimes(1 + MAX_RECOVERIES);
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(onUnrecoverable.mock.calls).toEqual([['about:blank']]);
    expect(onForeignDocument).toHaveBeenCalledTimes(MAX_RECOVERIES + 1);
  });

  it('forgets old recoveries: an occasional one never closes the window', () => {
    const { createWindow, windows, onUnrecoverable, clock } = factory();
    createWindow({});
    for (let attempt = 1; attempt <= MAX_RECOVERIES * 4; attempt += 1) {
      clock.now += RECOVERY_WINDOW_MS / MAX_RECOVERIES + 1;
      windows[0]?.emitContents('did-navigate', {}, 'about:blank');
    }
    expect(windows[0]?.loadURL).toHaveBeenCalledTimes(1 + MAX_RECOVERIES * 4);
    expect(windows[0]?.destroy).not.toHaveBeenCalled();
    expect(onUnrecoverable).not.toHaveBeenCalled();
  });

  it('counts recoveries per window', () => {
    const { createWindow, windows, clock } = factory();
    createWindow({});
    createWindow({});
    for (let attempt = 0; attempt <= MAX_RECOVERIES; attempt += 1) {
      clock.now += 1;
      windows[0]?.emitContents('did-navigate', {}, 'about:blank');
    }
    expect(windows[0]?.destroy).toHaveBeenCalledTimes(1);
    windows[1]?.emitContents('did-navigate', {}, 'about:blank');
    expect(windows[1]?.destroy).not.toHaveBeenCalled();
    expect(windows[1]?.loadURL).toHaveBeenCalledTimes(2);
  });

  it('leaves a window alone when it commits the app page', () => {
    const { createWindow, windows, onForeignDocument } = factory();
    createWindow({});
    windows[0]?.emitContents('did-navigate', {}, APP_ENTRY_URL);
    windows[0]?.emitContents('did-navigate', {}, `${APP_ENTRY_URL}?view=rules`);
    expect(windows[0]?.loadURL).toHaveBeenCalledTimes(1);
    expect(onForeignDocument).not.toHaveBeenCalled();
  });

  it('reports a failed load instead of leaving the rejection unhandled', async () => {
    const error = new Error('ERR_FILE_NOT_FOUND');
    const { createWindow, onLoadError } = factory(PRODUCTION_RUNTIME, () => Promise.reject(error));
    createWindow({});
    await vi.waitFor(() => {
      expect(onLoadError.mock.calls).toEqual([[error]]);
    });
  });
});
