// The one place a BrowserWindow is constructed. Callers choose layout only;
// webPreferences are fixed here and every window loads the app's own page.

import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle, WebPreferences } from 'electron';

import type { Logger } from './logger';

import type { Runtime } from './runtime';
import { isAllowedNavigation } from './security';

const LAYOUT_KEYS = [
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'x',
  'y',
  'center',
  'useContentSize',
  'show',
  'frame',
  'title',
  'titleBarStyle',
  'trafficLightPosition',
  'transparent',
  'backgroundColor',
  'hasShadow',
  'roundedCorners',
  'vibrancy',
  'visualEffectState',
  'resizable',
  'movable',
  'minimizable',
  'maximizable',
  'closable',
  'focusable',
  'fullscreenable',
  'alwaysOnTop',
  'skipTaskbar',
  'acceptFirstMouse',
] as const satisfies readonly (keyof BrowserWindowConstructorOptions)[];

export type WindowLayout = Readonly<Pick<BrowserWindowConstructorOptions, (typeof LAYOUT_KEYS)[number]>>;

const LAYOUT_KEY_SET: ReadonlySet<string> = new Set(LAYOUT_KEYS);

// Chromium's code for a load that was cancelled rather than one that failed.
const ERR_ABORTED = -3;

/** A window is sent back to the app page at most this often … */
export const MAX_RECOVERIES = 3;
/** … within this many milliseconds; past that it is closed. */
export const RECOVERY_WINDOW_MS = 10_000;

export interface HardeningInputs {
  /** Absolute path of the built preload script. */
  readonly preloadPath: string;
  /** DevTools exist only in development. */
  readonly devTools: boolean;
}

export function hardenedWebPreferences(inputs: HardeningInputs): WebPreferences {
  return {
    preload: inputs.preloadPath,
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
    // Removes showSaveFilePicker / showOpenFilePicker / showDirectoryPicker:
    // the page never opens a system file dialog — the main process does.
    disableBlinkFeatures: 'FileSystemAccessLocal',
    devTools: inputs.devTools,
  };
}

export interface WindowFactoryDeps {
  readonly BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly runtime: Runtime;
  readonly preloadPath: string;
  /** Called when the app's page fails to load into a window. */
  readonly onLoadError: (error: unknown) => void;
  /** Called with the URL when a window ended up on a document that is not the app's page. */
  readonly onForeignDocument: (url: string) => void;
  /** Called when a window kept leaving the app page and was closed. */
  readonly onUnrecoverable: (url: string) => void;
  /** Called when the renderer process of a window ended (a crash, say); the window is then closed. */
  readonly onRendererGone: (reason: string) => void;
  readonly now?: () => number;
}

/**
 * Which screen of the renderer a window shows. Passed to the page as the
 * `view` query parameter of the app's entry URL: the query selects the view,
 * not the document, so navigation checks treat every view as the app page.
 */
export type WindowView = 'popover' | 'rules';

export const VIEW_PARAM = 'view';

/** The entry URL with the view selected. */
export function viewUrl(entryUrl: string, view: WindowView): string {
  const url = new URL(entryUrl);
  url.searchParams.set(VIEW_PARAM, view);
  return url.toString();
}

export type CreateWindow = (layout: WindowLayout, view: WindowView) => BrowserWindow;

/**
 * Returns the function every window is created with. The window options are
 * built from the layout allowlist — each allowed key read once from the
 * caller's object — plus the fixed webPreferences, so nothing else can reach
 * `BrowserWindow` however the caller's object behaves. Options that are not
 * layout options are also rejected outright, so a mistake is loud.
 */
export function createWindowFactory(deps: WindowFactoryDeps): CreateWindow {
  const webPreferences = hardenedWebPreferences({
    preloadPath: deps.preloadPath,
    devTools: deps.runtime.kind === 'development',
  });

  return (layout, view) => {
    const unknown = Object.keys(layout).filter((key) => !LAYOUT_KEY_SET.has(key));
    if (unknown.length > 0) {
      throw new TypeError(`Not a window layout option: ${unknown.join(', ')}`);
    }
    const picked: Partial<Record<(typeof LAYOUT_KEYS)[number], unknown>> = {};
    for (const key of LAYOUT_KEYS) {
      const value: unknown = layout[key];
      if (value !== undefined) picked[key] = value;
    }
    const window = new deps.BrowserWindow({ ...(picked as WindowLayout), webPreferences: { ...webPreferences } });
    const now = deps.now ?? Date.now;
    const pageUrl = viewUrl(deps.runtime.entryUrl, view);
    const loadApp = (): void => {
      window.loadURL(pageUrl).catch(deps.onLoadError);
    };

    // The `will-navigate` guard (security.ts) stops navigations before they
    // start, but two kinds get past it: Chromium commits a few — `about:blank`
    // is one — without ever asking, and a navigation that fails
    // (`about:srcdoc`, a page that cannot be read) leaves the window on an
    // error page. Either way the window is sent back to the app's page. A
    // window that keeps leaving — or whose own page keeps failing — is closed
    // instead of being reloaded for ever.
    let recoveries: number[] = [];
    const recover = (url: string): void => {
      deps.onForeignDocument(url);
      const since = now() - RECOVERY_WINDOW_MS;
      recoveries = recoveries.filter((at) => at > since);
      if (recoveries.length >= MAX_RECOVERIES) {
        window.destroy();
        deps.onUnrecoverable(url);
        return;
      }
      recoveries.push(now());
      loadApp();
    };

    window.webContents.on('did-navigate', (_event, url) => {
      if (!isAllowedNavigation(url, deps.runtime.entryUrl)) recover(url);
    });
    window.webContents.on('did-fail-load', (_event, errorCode, _description, url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) recover(url);
    });
    // A window whose renderer is gone shows nothing and answers nothing. It is
    // closed; whoever owns it opens a new one when it is next needed.
    window.webContents.on('render-process-gone', (_event, details) => {
      deps.onRendererGone(details.reason);
      window.destroy();
    });

    loadApp();
    return window;
  };
}

// ---------------------------------------------------------------------------
// The two windows of the menu bar app
// ---------------------------------------------------------------------------

/** The menu bar window: frameless, opened under the tray icon, hidden when it loses focus. */
export const POPOVER_LAYOUT: WindowLayout = {
  width: 360,
  height: 600,
  show: false,
  frame: false,
  // The page draws its own rounded card inside a transparent margin (RouteSwitch UI.html).
  transparent: true,
  hasShadow: false,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  title: 'RouteSwitch',
};

/** The rules window: an ordinary window, one at a time. */
export const RULES_LAYOUT: WindowLayout = {
  width: 1040,
  height: 680,
  minWidth: 820,
  minHeight: 520,
  show: false,
  center: true,
  fullscreenable: false,
  title: 'RouteSwitch — Qoidalar',
};

/**
 * A click on the tray icon while the popover is open first takes the focus
 * away from it (it hides on blur), then arrives as a click. A click this soon
 * after such a hide closes the popover instead of opening it again.
 */
export const BLUR_CLICK_GRACE_MS = 300;

/** Gap between the bottom of the tray icon and the top of the popover. */
export const POPOVER_OFFSET_Y = 4;

/** The part of a `BrowserWindow` the manager uses. */
export type ManagedWindow = Pick<
  BrowserWindow,
  'on' | 'show' | 'hide' | 'focus' | 'restore' | 'isMinimized' | 'isVisible' | 'isDestroyed' | 'setPosition' | 'destroy' | 'webContents'
>;

export interface WindowManagerDeps {
  /** `createWindowFactory(...)`: every window is made by it. */
  readonly createWindow: (layout: WindowLayout, view: WindowView) => ManagedWindow;
  /** Work area of the display nearest to a point (`screen.getDisplayNearestPoint(point).workArea`). */
  readonly workAreaAt: (point: { readonly x: number; readonly y: number }) => Rectangle;
  /** Brings the app to the front; an app without a Dock icon is not activated by `focus()` alone. */
  readonly activateApp: () => void;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface WindowManager {
  /** Opens the popover under `anchor` (the tray icon), or hides it when it is open. */
  readonly togglePopover: (anchor: Rectangle) => void;
  /** Opens the popover under `anchor`, whatever its state. */
  readonly showPopover: (anchor: Rectangle) => void;
  /** Opens the rules window, or brings the one that is open to the front. */
  readonly openRules: () => void;
  /** The `webContents` of every open window. */
  readonly contents: () => ManagedWindow['webContents'][];
  /** Closes both windows. */
  readonly closeAll: () => void;
}

/** Top-left corner of the popover: centred under the anchor, kept inside the work area. */
export function popoverPosition(anchor: Rectangle, workArea: Rectangle, size: { width: number; height: number }) {
  const centred = Math.round(anchor.x + anchor.width / 2 - size.width / 2);
  const x = Math.min(Math.max(centred, workArea.x), workArea.x + workArea.width - size.width);
  const below = Math.round(anchor.y + anchor.height + POPOVER_OFFSET_Y);
  const y = Math.min(Math.max(below, workArea.y), workArea.y + workArea.height - size.height);
  return { x, y };
}

export function createWindowManager(deps: WindowManagerDeps): WindowManager {
  const now = deps.now ?? Date.now;
  const logger = deps.logger.child({ component: 'windows' });
  let popover: ManagedWindow | null = null;
  let rules: ManagedWindow | null = null;
  let hiddenOnBlurAt = Number.NEGATIVE_INFINITY;

  const live = (window: ManagedWindow | null): ManagedWindow | null =>
    window !== null && !window.isDestroyed() ? window : null;

  const popoverWindow = (): ManagedWindow => {
    const existing = live(popover);
    if (existing !== null) return existing;
    const window = deps.createWindow(POPOVER_LAYOUT, 'popover');
    window.on('blur', () => {
      if (!window.isDestroyed() && window.isVisible()) {
        hiddenOnBlurAt = now();
        window.hide();
      }
    });
    window.on('closed', () => {
      if (popover === window) popover = null;
    });
    popover = window;
    return window;
  };

  const showPopover = (anchor: Rectangle): void => {
    const window = popoverWindow();
    const width = POPOVER_LAYOUT.width ?? 0;
    const height = POPOVER_LAYOUT.height ?? 0;
    const { x, y } = popoverPosition(anchor, deps.workAreaAt({ x: anchor.x, y: anchor.y }), { width, height });
    window.setPosition(x, y, false);
    deps.activateApp();
    window.show();
    window.focus();
  };

  const togglePopover = (anchor: Rectangle): void => {
    const open = live(popover);
    if (open?.isVisible() === true) {
      open.hide();
      return;
    }
    if (now() - hiddenOnBlurAt < BLUR_CLICK_GRACE_MS) return;
    showPopover(anchor);
  };

  const openRules = (): void => {
    const existing = live(rules);
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      deps.activateApp();
      existing.show();
      existing.focus();
      return;
    }
    const window = deps.createWindow(RULES_LAYOUT, 'rules');
    window.on('ready-to-show', () => {
      if (window.isDestroyed()) return;
      deps.activateApp();
      window.show();
      window.focus();
    });
    window.on('closed', () => {
      if (rules === window) rules = null;
    });
    rules = window;
    logger.info('Opened the rules window');
  };

  return {
    togglePopover,
    showPopover,
    openRules,
    contents: () => [live(popover), live(rules)].flatMap((window) => (window === null ? [] : [window.webContents])),
    closeAll: () => {
      for (const window of [live(popover), live(rules)]) window?.destroy();
    },
  };
}
