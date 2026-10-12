// The one place a BrowserWindow is constructed. Callers choose layout only;
// webPreferences are fixed here and every window loads the app's own page.

import type { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences } from 'electron';

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
  readonly now?: () => number;
}

export type CreateWindow = (layout: WindowLayout) => BrowserWindow;

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

  return (layout) => {
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
    const loadApp = (): void => {
      window.loadURL(deps.runtime.entryUrl).catch(deps.onLoadError);
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

    loadApp();
    return window;
  };
}
