// The menu bar shell: the tray icon, the two windows it opens and the IPC the
// windows talk through. Written against the few Electron objects it needs, so
// it runs under vitest; `index.ts` passes the real ones.
//
// Closing windows never ends the app — it lives in the menu bar until the user
// quits from the tray menu — and nothing here touches the helper: the helper
// keeps routing whether the app runs or not.

import type { EngineState } from '@routeswitch/shared';
import type { Menu, MenuItemConstructorOptions, NativeImage, Rectangle } from 'electron';

import { DEFAULT_LOCALE, i18nFor, type I18n, type Locale, type Messages } from '../i18n';

import type { HelperClient, HelperStatus } from './helperClient';
import type { Installer } from './installer';
import { registerIpcHandlers, type ConfigDialogs, type IpcMainLike } from './ipc';
import type { Logger } from './logger';
import type { PreferencesStore } from './preferences';
import type { RulesBackupStore } from './rulesBackup';
import type { Settings } from './settings';
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

/** Uzbek: the default of the functions below (a caller that does not pass a language). */
const UZ: I18n = i18nFor(DEFAULT_LOCALE);

/** Before the helper client reports anything: the `off` look, "connecting". */
export const initialAppearance = (i18n: I18n = UZ): TrayAppearance => ({ kind: 'off', tooltip: i18n.t.tray.connecting });

export const INITIAL_APPEARANCE: TrayAppearance = initialAppearance();

/**
 * Rules waiting for their interface (`pending`: `interface-down`,
 * `no-gateway`), and whether both roles are up behind the same gateway (one
 * subnet: which interface a gateway route leaves through is the system's
 * choice), and DNS servers reached through the other interface
 * (`dnsWarnings`, one per server). None is an error — the icon stays `active` — but the tooltip
 * says so.
 */
function connectedNotes(state: EngineState, words: Messages['tray']): string {
  const notes: string[] = [];
  const waiting = state.rules.filter(
    (rule) => rule.status === 'pending' && (rule.reasonCode === 'interface-down' || rule.reasonCode === 'no-gateway'),
  ).length;
  if (waiting > 0) notes.push(words.rulesWaiting(waiting));
  const { ethernet, wifi } = state.interfaces;
  if (ethernet.up && wifi.up && ethernet.gateway !== null && ethernet.gateway === wifi.gateway) {
    notes.push(words.sameSubnet);
  }
  // A DNS server reached through the other interface (TASK-DELTA-21): a note, the icon keeps its look.
  const servers = new Set((state.dnsWarnings ?? []).map((warning) => warning.server)).size;
  if (servers > 0) notes.push(words.dnsWarnings(servers));
  return notes.map((note) => ` · ${note}`).join('');
}

/**
 * The icon for a connection status and the engine state that goes with it.
 * `connecting` (and `stopped`, on the way out) keep the current look, so a
 * helper that is retried every few seconds does not make the icon flicker.
 * The tooltip is in the language given (Uzbek without one).
 */
export function trayAppearance(
  status: HelperStatus,
  state: EngineState | null,
  current: TrayAppearance,
  i18n: I18n = UZ,
): TrayAppearance {
  const words = i18n.t.tray;
  switch (status.kind) {
    case 'connecting':
    case 'stopped':
      return current;
    case 'not-installed':
      return { kind: 'error', tooltip: words.notInstalled };
    case 'disconnected':
      return { kind: 'error', tooltip: words.disconnected };
    case 'incompatible':
      return { kind: 'error', tooltip: words.incompatible };
    case 'config-unreadable':
      return { kind: 'error', tooltip: words.configUnreadable };
    case 'connected': {
      if (state === null || !state.enabled) return { kind: 'off', tooltip: words.off };
      const failing = state.rules.filter((rule) => rule.status === 'error').length;
      const notes = connectedNotes(state, words);
      if (failing > 0) return { kind: 'error', tooltip: `${words.failing(failing)}${notes}` };
      return { kind: 'active', tooltip: `${words.active}${notes}` };
    }
  }
}

/** What the tray menu does; the labels come from the language. */
export interface TrayMenuActions {
  readonly openRules: () => void;
  /** The rules window at its Help section (TASK-DELTA-22). */
  readonly openHelp: () => void;
  readonly quit: () => void;
}

/** The right-click menu of the tray icon, in the language given. */
export function trayMenuTemplate(i18n: I18n, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: i18n.t.tray.manageRules,
      click: () => {
        actions.openRules();
      },
    },
    {
      label: i18n.t.tray.help,
      click: () => {
        actions.openHelp();
      },
    },
    { type: 'separator' },
    // The helper keeps routing after the app quits; only the menu bar icon goes away.
    {
      label: i18n.t.tray.quit,
      click: () => {
        actions.quit();
      },
    },
  ];
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
  readonly helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'>;
  readonly workAreaAt: WindowManagerDeps['workAreaAt'];
  readonly activateApp: () => void;
  /** Ends the app (`app.quit()`); the helper keeps running. */
  readonly quit: () => void;
  /** The login item and the network service order, for the settings screen's IPC calls. */
  readonly settings: Settings;
  /** The app's own preferences (the UI language, `userData/preferences.json`). */
  readonly preferences: PreferencesStore;
  /** The app's copy of the last config it saw (`userData/rules-backup.json`, TASK-DELTA-16). */
  readonly rulesBackup: Pick<RulesBackupStore, 'read' | 'remove'>;
  /** The system file dialogs of config import / export. */
  readonly configDialogs: ConfigDialogs;
  /** Installs / removes the helper as root (`installer.ts`). */
  readonly installer: Installer;
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
    settings: deps.settings,
    preferences: deps.preferences,
    backup: deps.rulesBackup,
    configDialogs: deps.configDialogs,
    installer: deps.installer,
    // "Qoidalarni boshqarish" of the menu bar window: the same window as the tray menu item.
    openRulesWindow: windows.openRules,
  });

  // The language of the tooltip and the menu: Uzbek until the preferences are
  // read (a few milliseconds after start), then the user's, and every change after.
  let i18n = i18nFor(DEFAULT_LOCALE);
  // The last status that set the look (`connecting` / `stopped` keep it): a
  // change of language words it again. Null: nothing reported yet.
  let source: { readonly status: HelperStatus; readonly state: EngineState | null } | null = null;

  let appearance = initialAppearance(i18n);
  const tray = deps.createTray(deps.images[appearance.kind]);
  tray.setToolTip(appearance.tooltip);

  const refresh = (): void => {
    const { status, state } = helperClient.snapshot();
    if (status.kind !== 'connecting' && status.kind !== 'stopped') source = { status, state };
    const next = source === null ? initialAppearance(i18n) : trayAppearance(source.status, source.state, appearance, i18n);
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

  const menuActions: TrayMenuActions = {
    openRules: () => {
      windows.openRules();
    },
    openHelp: () => {
      ipc.openRulesWindow({ kind: 'section', section: 'help' });
    },
    quit: () => {
      deps.quit();
    },
  };
  let menu = deps.buildMenu(trayMenuTemplate(i18n, menuActions));
  tray.on('right-click', () => {
    tray.popUpContextMenu(menu);
  });

  let disposed = false;

  /** A new language: the menu is built again and the tooltip worded again. */
  const setLocale = (locale: Locale): void => {
    if (disposed || locale === i18n.locale) return;
    i18n = i18nFor(locale);
    menu = deps.buildMenu(trayMenuTemplate(i18n, menuActions));
    logger.info('Tray language changed', { language: locale });
    refresh();
  };
  unsubscribes.push(deps.preferences.onLanguage(setLocale));
  // Never rejects (`PreferencesStore.language`).
  void deps.preferences.language().then(setLocale);

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
