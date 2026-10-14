// The menu bar shell: the tray icon, the two windows it opens and the IPC the
// windows talk through. Written against the few Electron objects it needs, so
// it runs under vitest; `index.ts` passes the real ones.
//
// Closing windows never ends the app — it lives in the menu bar until the user
// quits from the tray menu — and nothing here touches the helper: the helper
// keeps routing whether the app runs or not.

import type { EngineState } from '@routeswitch/shared';
import type { Menu, MenuItemConstructorOptions, NativeImage, Rectangle } from 'electron';

import type { HelperClient, HelperStatus } from './helperClient';
import { registerIpcHandlers, type IpcMainLike } from './ipc';
import type { Logger } from './logger';
import { createWindowManager, type CreateWindow, type WindowManagerDeps } from './windows';

// ---------------------------------------------------------------------------
// What the icon shows
// ---------------------------------------------------------------------------

/** The three looks of the tray icon. */
export type TrayIconKind = 'active' | 'off' | 'error';

export interface TrayAppearance {
  readonly kind: TrayIconKind;
  readonly tooltip: string;
}

export const INITIAL_APPEARANCE: TrayAppearance = { kind: 'off', tooltip: 'RouteSwitch — ulanmoqda…' };

/**
 * The icon for a connection status and the engine state that goes with it.
 * `connecting` (and `stopped`, on the way out) keep the current look, so a
 * helper that is retried every few seconds does not make the icon flicker.
 */
export function trayAppearance(status: HelperStatus, state: EngineState | null, current: TrayAppearance): TrayAppearance {
  switch (status.kind) {
    case 'connecting':
    case 'stopped':
      return current;
    case 'not-installed':
      return { kind: 'error', tooltip: "RouteSwitch — helper o'rnatilmagan" };
    case 'disconnected':
      return { kind: 'error', tooltip: "RouteSwitch — helper bilan aloqa yo'q" };
    case 'incompatible':
      return { kind: 'error', tooltip: 'RouteSwitch — helper versiyasi mos emas' };
    case 'connected': {
      if (state === null || !state.enabled) return { kind: 'off', tooltip: "RouteSwitch — o'chirilgan" };
      const failing = state.rules.filter((rule) => rule.status === 'error').length;
      if (failing > 0) return { kind: 'error', tooltip: `RouteSwitch — ${String(failing)} ta qoidada xato` };
      return { kind: 'active', tooltip: 'RouteSwitch — faol' };
    }
  }
}

// ---------------------------------------------------------------------------
// Icon images
// ---------------------------------------------------------------------------

/** The PNG files of one look: 16×16 and 32×32, black on transparent, named `…Template…` (macOS tints them). */
export interface TrayImageFiles {
  readonly x1: string;
  readonly x2: string;
}

export interface TrayImageDeps {
  readonly createEmpty: () => NativeImage;
  readonly readFile: (path: string) => Buffer;
}

/** Builds one template image holding both resolutions, so the menu bar picks the right one for the screen. */
export function loadTrayImage(deps: TrayImageDeps, files: TrayImageFiles): NativeImage {
  const image = deps.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: deps.readFile(files.x1) });
  image.addRepresentation({ scaleFactor: 2, buffer: deps.readFile(files.x2) });
  image.setTemplateImage(true);
  if (image.isEmpty()) throw new Error('A tray icon image could not be read');
  return image;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** The part of an Electron `Tray` used here. */
export interface TrayLike {
  setImage(image: NativeImage): void;
  setToolTip(text: string): void;
  on(event: 'click' | 'right-click', listener: (event: unknown, bounds: Rectangle) => void): unknown;
  popUpContextMenu(menu: Menu): void;
  getBounds(): Rectangle;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface ShellDeps {
  readonly createTray: (image: NativeImage) => TrayLike;
  readonly images: Readonly<Record<TrayIconKind, NativeImage>>;
  readonly buildMenu: (template: MenuItemConstructorOptions[]) => Menu;
  readonly ipcMain: IpcMainLike;
  readonly helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'onStatus' | 'onState' | 'onLog'>;
  readonly workAreaAt: WindowManagerDeps['workAreaAt'];
  readonly activateApp: () => void;
  /** Ends the app (`app.quit()`); the helper keeps running. */
  readonly quit: () => void;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** What the lifecycle (`bootstrap.ts`) knows only once the app is ready. */
export interface ShellContext {
  readonly createWindow: CreateWindow;
  /** The app's page (`Runtime.entryUrl`). */
  readonly entryUrl: string;
}

export interface Shell {
  /** Opens the popover under the tray icon (a second launch of the app does this). */
  readonly showPopover: () => void;
  /** Removes the tray icon, the windows, the IPC handlers and the subscriptions. Idempotent. */
  readonly dispose: () => void;
}

export function startShell(deps: ShellDeps, context: ShellContext): Shell {
  const logger = deps.logger.child({ component: 'tray' });
  const { helperClient } = deps;

  const windows = createWindowManager({
    createWindow: context.createWindow,
    workAreaAt: deps.workAreaAt,
    activateApp: deps.activateApp,
    logger: deps.logger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  // Before any window exists, so no page can call a channel nobody answers.
  const ipc = registerIpcHandlers({
    ipcMain: deps.ipcMain,
    helperClient,
    entryUrl: context.entryUrl,
    logger: deps.logger,
    listRecipients: windows.contents,
  });

  let appearance = INITIAL_APPEARANCE;
  const tray = deps.createTray(deps.images[appearance.kind]);
  tray.setToolTip(appearance.tooltip);

  const refresh = (): void => {
    const { status, state } = helperClient.snapshot();
    const next = trayAppearance(status, state, appearance);
    if (next.kind === appearance.kind && next.tooltip === appearance.tooltip) return;
    if (next.kind !== appearance.kind) logger.info('Tray icon changed', { icon: next.kind, status: status.kind });
    appearance = next;
    if (tray.isDestroyed()) return;
    tray.setImage(deps.images[next.kind]);
    tray.setToolTip(next.tooltip);
  };
  const unsubscribes = [helperClient.onStatus(refresh), helperClient.onState(refresh)];
  refresh();

  /** The tray icon's own rectangle; `bounds` of a click when Electron gives them. */
  const anchor = (bounds?: Rectangle): Rectangle =>
    bounds !== undefined && bounds.width > 0 && bounds.height > 0 ? bounds : tray.getBounds();

  tray.on('click', (_event, bounds) => {
    windows.togglePopover(anchor(bounds));
  });

  const menu = deps.buildMenu([
    {
      label: 'Qoidalarni boshqarish',
      click: () => {
        windows.openRules();
      },
    },
    { type: 'separator' },
    // The helper keeps routing after the app quits; only the menu bar icon goes away.
    {
      label: 'RouteSwitch ilovasidan chiqish',
      click: () => {
        deps.quit();
      },
    },
  ]);
  tray.on('right-click', () => {
    tray.popUpContextMenu(menu);
  });

  let disposed = false;
  return {
    showPopover: () => {
      if (disposed || tray.isDestroyed()) return;
      windows.showPopover(anchor());
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      ipc.dispose();
      windows.closeAll();
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
