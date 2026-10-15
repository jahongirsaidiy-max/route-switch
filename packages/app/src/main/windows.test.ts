import { describe, expect, it, vi } from 'vitest';

import { createDevelopmentRuntime } from './development';
import { APP_ENTRY_URL, PRODUCTION_RUNTIME, type Runtime } from './runtime';
import { fakeBrowserWindowClass } from './test-utils';
import { memoryLogger } from './helperClient.fixtures';
import {
  BLUR_CLICK_GRACE_MS,
  createWindowFactory,
  createWindowManager,
  hardenedWebPreferences,
  MAX_RECOVERIES,
  POPOVER_LAYOUT,
  POPOVER_OFFSET_Y,
  popoverPosition,
  RECOVERY_WINDOW_MS,
  RULES_LAYOUT,
  viewUrl,
  type ManagedWindow,
  type WindowLayout,
  type WindowView,
} from './windows';

const PRELOAD = '/opt/routeswitch/preload/index.cjs';
const POPOVER_URL = `${APP_ENTRY_URL}?view=popover`;

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
  const onRendererGone = vi.fn();
  const clock = { now: 1_000_000 };
  const createWindow = createWindowFactory({
    BrowserWindow: fake.ctor,
    runtime,
    preloadPath: PRELOAD,
    onLoadError,
    onForeignDocument,
    onUnrecoverable,
    onRendererGone,
    now: () => clock.now,
  });
  return { createWindow, windows: fake.windows, onLoadError, onForeignDocument, onUnrecoverable, onRendererGone, clock };
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
    const window = createWindow({ width: 360, height: 600, frame: false, show: false, resizable: false }, 'popover');
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
    createWindow({ width: 360, height: 600 }, 'popover');
    createWindow({ width: 1040, height: 680 }, 'popover');
    const [first, second] = windows.map((window) => window.options.webPreferences);
    expect(first).toEqual(HARDENED);
    expect(second).toEqual(HARDENED);
    expect(first).not.toBe(second);
    if (first !== undefined) first.nodeIntegration = true;
    createWindow({}, 'popover');
    expect(windows[2]?.options.webPreferences).toEqual(HARDENED);
  });

  it('enables DevTools only in development', () => {
    const production = factory(PRODUCTION_RUNTIME);
    production.createWindow({}, 'popover');
    expect(production.windows[0]?.options.webPreferences?.devTools).toBe(false);

    const development = factory(developmentRuntime());
    development.createWindow({}, 'popover');
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
    expect(() => createWindow(weaken(options), 'popover')).toThrow(TypeError);
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
    createWindow(weaken(lying), 'popover');
    expect(windows[0]?.options).toEqual({ width: 360, webPreferences: HARDENED });
    expect(Object.keys(windows[0]?.options ?? {}).sort()).toEqual(['webPreferences', 'width']);
  });

  it('passes nothing outside the allowlist from an object whose keys cannot be listed at all', () => {
    const hidden = new Proxy<Record<string, unknown>>(
      { height: 600, kiosk: true, fullscreen: true, webPreferences: { sandbox: false } },
      { ownKeys: () => [] },
    );
    const { createWindow, windows } = factory();
    createWindow(weaken(hidden), 'popover');
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
    createWindow(weaken(counting), 'popover');
    expect(windows[0]?.options).toEqual({ width: 360, show: false, webPreferences: HARDENED });
    expect(reads.filter((key) => key === 'width')).toHaveLength(1);
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).not.toContain('webPreferences');
    expect(reads).not.toContain('kiosk');
  });

  it('drops layout options given as undefined', () => {
    const { createWindow, windows } = factory();
    createWindow(weaken({ width: 360, height: undefined }), 'popover');
    expect(windows[0]?.options).toEqual({ width: 360, webPreferences: HARDENED });
  });

  it('names the rejected options', () => {
    const { createWindow } = factory();
    expect(() => createWindow(weaken({ width: 1, webPreferences: {}, kiosk: true }), 'popover')).toThrow(
      'Not a window layout option: webPreferences, kiosk',
    );
  });

  it('loads the app page — and only that — into every window', () => {
    const production = factory();
    production.createWindow({}, 'popover');
    expect(production.windows[0]?.loadURL.mock.calls).toEqual([[POPOVER_URL]]);

    const development = factory(developmentRuntime());
    development.createWindow({}, 'popover');
    expect(development.windows[0]?.loadURL.mock.calls).toEqual([['http://localhost:5173/?view=popover']]);
  });

  it.each(['about:blank', 'https://evil.example/', 'file:///etc/passwd', 'app://routeswitch/other.html'])(
    'sends a window that ended up on %s back to the app page and reports it',
    (url) => {
      const { createWindow, windows, onForeignDocument } = factory();
      createWindow({}, 'popover');
      windows[0]?.emitContents('did-navigate', {}, url);
      expect(windows[0]?.loadURL.mock.calls).toEqual([[POPOVER_URL], [POPOVER_URL]]);
      expect(onForeignDocument.mock.calls).toEqual([[url]]);
    },
  );

  it.each([
    ['about:srcdoc', -300],
    ['app://routeswitch/index.html', -6],
    ['http://localhost:5173/', -102],
  ])('sends a window back when its main frame fails to load %s (%d)', (url, errorCode) => {
    const { createWindow, windows, onForeignDocument } = factory();
    createWindow({}, 'popover');
    windows[0]?.emitContents('did-fail-load', {}, errorCode, 'ERR', url, true);
    expect(windows[0]?.loadURL.mock.calls).toEqual([[POPOVER_URL], [POPOVER_URL]]);
    expect(onForeignDocument.mock.calls).toEqual([[url]]);
  });

  it('ignores a failed subframe and a load that was merely cancelled', () => {
    const { createWindow, windows, onForeignDocument } = factory();
    createWindow({}, 'popover');
    windows[0]?.emitContents('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'about:srcdoc', false);
    windows[0]?.emitContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://evil.example/', true);
    expect(windows[0]?.loadURL).toHaveBeenCalledTimes(1);
    expect(onForeignDocument).not.toHaveBeenCalled();
  });

  it('closes a window that keeps leaving the app page instead of reloading it for ever', () => {
    const { createWindow, windows, onForeignDocument, onUnrecoverable, clock } = factory();
    createWindow({}, 'popover');
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
    createWindow({}, 'popover');
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
    createWindow({}, 'popover');
    createWindow({}, 'popover');
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
    createWindow({}, 'popover');
    windows[0]?.emitContents('did-navigate', {}, APP_ENTRY_URL);
    windows[0]?.emitContents('did-navigate', {}, `${APP_ENTRY_URL}?view=rules`);
    expect(windows[0]?.loadURL).toHaveBeenCalledTimes(1);
    expect(onForeignDocument).not.toHaveBeenCalled();
  });

  it('reports a failed load instead of leaving the rejection unhandled', async () => {
    const error = new Error('ERR_FILE_NOT_FOUND');
    const { createWindow, onLoadError } = factory(PRODUCTION_RUNTIME, () => Promise.reject(error));
    createWindow({}, 'popover');
    await vi.waitFor(() => {
      expect(onLoadError.mock.calls).toEqual([[error]]);
    });
  });
});

describe('views', () => {
  it('selects the view with the query of the entry URL, keeping the page', () => {
    expect(viewUrl(APP_ENTRY_URL, 'rules')).toBe(`${APP_ENTRY_URL}?view=rules`);
    expect(viewUrl('http://localhost:5173/', 'popover')).toBe('http://localhost:5173/?view=popover');
  });

  it('loads each window on its own view, and sends it back to that view', () => {
    const { createWindow, windows } = factory();
    createWindow({}, 'rules');
    windows[0]?.emitContents('did-navigate', {}, 'about:blank');
    expect(windows[0]?.loadURL.mock.calls).toEqual([[`${APP_ENTRY_URL}?view=rules`], [`${APP_ENTRY_URL}?view=rules`]]);
  });

  it('closes a window whose renderer is gone and reports why', () => {
    const { createWindow, windows, onRendererGone } = factory();
    createWindow({}, 'popover');
    windows[0]?.emitContents('render-process-gone', {}, { reason: 'oom', exitCode: 0 });
    expect(onRendererGone.mock.calls).toEqual([['oom']]);
    expect(windows[0]?.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('popoverPosition', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: 360, height: 600 };

  it('centres the popover under the tray icon', () => {
    expect(popoverPosition({ x: 1000, y: 0, width: 24, height: 24 }, workArea, size)).toEqual({ x: 832, y: 24 + POPOVER_OFFSET_Y });
  });

  it('keeps it inside the work area near the right and left edges', () => {
    expect(popoverPosition({ x: 1420, y: 0, width: 24, height: 24 }, workArea, size).x).toBe(1440 - 360);
    expect(popoverPosition({ x: 10, y: 0, width: 24, height: 24 }, workArea, size).x).toBe(0);
  });

  it('works on a second display to the left (negative coordinates)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1055 };
    expect(popoverPosition({ x: -100, y: 0, width: 22, height: 22 }, left, size)).toEqual({ x: -360, y: 26 });
  });

  it('never goes above the work area', () => {
    expect(popoverPosition({ x: 500, y: -30, width: 24, height: 24 }, workArea, size).y).toBe(25);
  });
});

describe('createWindowManager', () => {
  type Listener = () => void;

  class FakeManagedWindow {
    visible = false;
    destroyed = false;
    minimized = false;
    position: [number, number] | null = null;
    readonly calls: string[] = [];
    readonly webContents = { id: Math.random() };
    private readonly listeners = new Map<string, Listener[]>();
    constructor(
      readonly layout: WindowLayout,
      readonly view: WindowView,
    ) {}
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    show(): void {
      this.calls.push('show');
      this.visible = true;
    }
    hide(): void {
      this.calls.push('hide');
      this.visible = false;
    }
    focus(): void {
      this.calls.push('focus');
    }
    restore(): void {
      this.calls.push('restore');
      this.minimized = false;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    setPosition(x: number, y: number): void {
      this.position = [x, y];
    }
    destroy(): void {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  const ANCHOR = { x: 1000, y: 0, width: 24, height: 24 };

  function manager() {
    const created: FakeManagedWindow[] = [];
    const clock = { now: 10_000 };
    const activateApp = vi.fn();
    const { logger } = memoryLogger();
    const windows = createWindowManager({
      createWindow: (layout, view) => {
        const window = new FakeManagedWindow(layout, view);
        created.push(window);
        return window as unknown as ManagedWindow;
      },
      workAreaAt: () => ({ x: 0, y: 25, width: 1440, height: 875 }),
      activateApp,
      logger,
      now: () => clock.now,
    });
    const at = (index: number): FakeManagedWindow => {
      const window = created[index];
      if (window === undefined) throw new Error(`no window #${String(index)}`);
      return window;
    };
    return { windows, created, clock, activateApp, at };
  }

  it('opens the 360×600 frameless popover under the tray icon and focuses it', () => {
    const m = manager();
    m.windows.togglePopover(ANCHOR);
    expect(m.created).toHaveLength(1);
    expect(m.at(0).view).toBe('popover');
    expect(m.at(0).layout).toBe(POPOVER_LAYOUT);
    expect(POPOVER_LAYOUT).toMatchObject({ width: 360, height: 600, frame: false, show: false, resizable: false, skipTaskbar: true });
    expect(m.at(0).position).toEqual([832, 28]);
    expect(m.at(0).calls).toEqual(['show', 'focus']);
    expect(m.activateApp).toHaveBeenCalledTimes(1);
  });

  it('hides the popover when it loses focus, and a click right after does not reopen it', () => {
    const m = manager();
    m.windows.togglePopover(ANCHOR);
    m.at(0).emit('blur');
    expect(m.at(0).visible).toBe(false);
    // The click on the tray icon that took the focus away arrives just after.
    m.clock.now += BLUR_CLICK_GRACE_MS - 1;
    m.windows.togglePopover(ANCHOR);
    expect(m.at(0).visible).toBe(false);
    // A later click opens it again — the same window, not a new one.
    m.clock.now += 1;
    m.windows.togglePopover(ANCHOR);
    expect(m.at(0).visible).toBe(true);
    expect(m.created).toHaveLength(1);
  });

  it('a click on the tray icon while the popover is open closes it', () => {
    const m = manager();
    m.windows.togglePopover(ANCHOR);
    m.windows.togglePopover(ANCHOR);
    expect(m.at(0).visible).toBe(false);
    expect(m.at(0).calls.at(-1)).toBe('hide');
  });

  it('a blur of a hidden popover changes nothing', () => {
    const m = manager();
    m.windows.togglePopover(ANCHOR);
    m.windows.togglePopover(ANCHOR);
    m.at(0).emit('blur');
    m.windows.togglePopover(ANCHOR);
    expect(m.at(0).visible).toBe(true);
  });

  it('showPopover opens the popover whatever its state', () => {
    const m = manager();
    m.windows.showPopover(ANCHOR);
    m.windows.showPopover(ANCHOR);
    expect(m.created).toHaveLength(1);
    expect(m.at(0).visible).toBe(true);
  });

  it('opens one rules window of 1040×680; asking again brings it forward', () => {
    const m = manager();
    m.windows.openRules();
    expect(m.at(0).view).toBe('rules');
    expect(m.at(0).layout).toBe(RULES_LAYOUT);
    expect(RULES_LAYOUT).toMatchObject({ width: 1040, height: 680, show: false });
    expect(RULES_LAYOUT.frame).toBeUndefined();
    m.at(0).emit('ready-to-show');
    expect(m.at(0).calls).toEqual(['show', 'focus']);

    m.at(0).minimized = true;
    m.windows.openRules();
    expect(m.created).toHaveLength(1);
    expect(m.at(0).calls).toEqual(['show', 'focus', 'restore', 'show', 'focus']);
  });

  it('a window that was destroyed (failed navigation, crashed renderer) is replaced by a new one', () => {
    const m = manager();
    m.windows.togglePopover(ANCHOR);
    m.windows.openRules();
    m.at(0).destroy();
    m.at(1).destroy();
    m.windows.togglePopover(ANCHOR);
    m.windows.openRules();
    expect(m.created.map((window) => window.view)).toEqual(['popover', 'rules', 'popover', 'rules']);
    expect(m.at(2).visible).toBe(true);
  });

  it('a window marked destroyed without a closed event is also replaced', () => {
    const m = manager();
    m.windows.openRules();
    m.at(0).destroyed = true;
    m.windows.openRules();
    expect(m.created).toHaveLength(2);
  });

  it('lists the webContents of the open windows only, and closes them all', () => {
    const m = manager();
    expect(m.windows.contents()).toEqual([]);
    m.windows.togglePopover(ANCHOR);
    m.windows.openRules();
    expect(m.windows.contents()).toEqual([m.at(0).webContents, m.at(1).webContents]);
    m.at(0).destroyed = true;
    expect(m.windows.contents()).toEqual([m.at(1).webContents]);
    m.windows.closeAll();
    expect(m.at(1).destroyed).toBe(true);
    expect(m.windows.contents()).toEqual([]);
  });
});
