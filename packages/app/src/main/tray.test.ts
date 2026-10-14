import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { EngineState, RuleState } from '@routeswitch/shared';
import type { Menu, MenuItemConstructorOptions, NativeImage, Rectangle } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { HelperClient, HelperStatus, HelperSnapshot } from './helperClient';
import { engineState, memoryLogger, RULE_ID } from './helperClient.fixtures';
import { INVOKE_CHANNELS, STATE_CHANNEL } from './ipc';
import { APP_ENTRY_URL } from './runtime';
import { createSettings } from './settings';
import {
  INITIAL_APPEARANCE,
  loadTrayImage,
  startShell,
  trayAppearance,
  type TrayAppearance,
  type TrayIconKind,
  type TrayLike,
} from './tray';
import type { WindowLayout, WindowView } from './windows';

const ruleState = (status: 'active' | 'error'): RuleState => ({
  ruleId: RULE_ID,
  status,
  reasonCode: status === 'error' ? 'route-failed' : null,
  reason: null,
  appliedDestinations: [],
  lastResolvedAt: null,
});

describe('trayAppearance', () => {
  const current: TrayAppearance = { kind: 'active', tooltip: 'previous' };
  const connected: HelperStatus = { kind: 'connected', helperVersion: '1.2.3' };

  it.each<[string, HelperStatus, EngineState | null, TrayIconKind]>([
    ['routing on, every rule fine', connected, engineState(1), 'active'],
    ['routing on, a rule active', connected, engineState(1, 1, { rules: [ruleState('active')] }), 'active'],
    ['routing switched off', connected, engineState(1, 1, { enabled: false }), 'off'],
    ['routing off even with a failing rule', connected, engineState(1, 1, { enabled: false, rules: [ruleState('error')] }), 'off'],
    ['a rule in error', connected, engineState(1, 1, { rules: [ruleState('active'), ruleState('error')] }), 'error'],
    ['helper not installed', { kind: 'not-installed' }, null, 'error'],
    ['helper not running', { kind: 'disconnected', reason: 'not-running' }, null, 'error'],
    ['no permission on the socket', { kind: 'disconnected', reason: 'permission-denied' }, null, 'error'],
    ['incompatible helper', { kind: 'incompatible', helperVersion: '9.0.0', protocolVersion: 9, expectedProtocolVersion: 1 }, null, 'error'],
  ])('%s → %s', (_name, status, state, kind) => {
    expect(trayAppearance(status, state, current).kind).toBe(kind);
  });

  it('keeps the current look while connecting or stopping, so a retried helper does not flicker the icon', () => {
    expect(trayAppearance({ kind: 'connecting' }, null, current)).toBe(current);
    expect(trayAppearance({ kind: 'stopped' }, null, current)).toBe(current);
  });

  it('says in the tooltip how many rules fail', () => {
    const state = engineState(1, 1, { rules: [ruleState('error'), ruleState('error')] });
    expect(trayAppearance(connected, state, current).tooltip).toBe('RouteSwitch — 2 ta qoidada xato');
  });

  it('starts in the neutral look', () => {
    expect(INITIAL_APPEARANCE.kind).toBe('off');
  });
});

describe('tray icon files', () => {
  const dir = path.join(import.meta.dirname, '../../resources/tray');
  const size = (file: string): [number, number] => {
    const png = readFileSync(path.join(dir, file));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width and height, then bit depth 8 and colour type 6 (RGBA).
    expect([png[24], png[25]]).toEqual([8, 6]);
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it('has a 16×16 and a 32×32 template image for each of the three looks, and nothing else', () => {
    expect(readdirSync(dir).sort()).toEqual([
      'trayActiveTemplate.png',
      'trayActiveTemplate@2x.png',
      'trayErrorTemplate.png',
      'trayErrorTemplate@2x.png',
      'trayOffTemplate.png',
      'trayOffTemplate@2x.png',
    ]);
    for (const look of ['Active', 'Off', 'Error']) {
      expect(size(`tray${look}Template.png`)).toEqual([16, 16]);
      expect(size(`tray${look}Template@2x.png`)).toEqual([32, 32]);
    }
  });
});

describe('loadTrayImage', () => {
  const fakeImage = (empty = false) => {
    const representations: { scaleFactor: number; buffer: Buffer }[] = [];
    const image = {
      representations,
      template: false,
      addRepresentation: (options: { scaleFactor: number; buffer: Buffer }) => {
        representations.push(options);
      },
      setTemplateImage: (on: boolean) => {
        image.template = on;
      },
      isEmpty: () => empty,
    };
    return image;
  };

  it('puts both resolutions into one template image', () => {
    const image = fakeImage();
    const result = loadTrayImage(
      { createEmpty: () => image as unknown as NativeImage, readFile: (file) => Buffer.from(file) },
      { x1: 'a.png', x2: 'a@2x.png' },
    );
    expect(result).toBe(image);
    expect(image.representations.map((r) => [r.scaleFactor, r.buffer.toString()])).toEqual([
      [1, 'a.png'],
      [2, 'a@2x.png'],
    ]);
    expect(image.template).toBe(true);
  });

  it('fails loudly when the files do not make an image', () => {
    expect(() =>
      loadTrayImage(
        { createEmpty: () => fakeImage(true) as unknown as NativeImage, readFile: () => Buffer.alloc(0) },
        { x1: 'a.png', x2: 'a@2x.png' },
      ),
    ).toThrow('A tray icon image could not be read');
  });
});

// ---------------------------------------------------------------------------

type Listener = (event: unknown, bounds: Rectangle) => void;

class FakeTray implements TrayLike {
  image: NativeImage;
  tooltip = '';
  destroyed = false;
  readonly menus: Menu[] = [];
  readonly listeners = new Map<string, Listener>();
  constructor(image: NativeImage) {
    this.image = image;
  }
  setImage(image: NativeImage): void {
    this.image = image;
  }
  setToolTip(text: string): void {
    this.tooltip = text;
  }
  on(event: 'click' | 'right-click', listener: Listener): this {
    this.listeners.set(event, listener);
    return this;
  }
  popUpContextMenu(menu: Menu): void {
    this.menus.push(menu);
  }
  getBounds(): Rectangle {
    return { x: 1000, y: 0, width: 24, height: 24 };
  }
  destroy(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  click(bounds?: Rectangle): void {
    this.listeners.get('click')?.({}, bounds ?? { x: 0, y: 0, width: 0, height: 0 });
  }
}

class FakeWindow {
  visible = false;
  destroyed = false;
  readonly sent: [string, unknown][] = [];
  readonly webContents = {
    isDestroyed: () => this.destroyed,
    getURL: () => `${APP_ENTRY_URL}?view=${this.view}`,
    send: (channel: string, payload: unknown) => {
      this.sent.push([channel, payload]);
    },
  };
  private readonly listeners = new Map<string, (() => void)[]>();
  position: [number, number] | null = null;
  constructor(
    readonly layout: WindowLayout,
    readonly view: WindowView,
  ) {}
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  focus(): void {
    return undefined;
  }
  restore(): void {
    return undefined;
  }
  isMinimized(): boolean {
    return false;
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
    this.emit('closed');
  }
}

function shellHarness() {
  const images = {
    active: { name: 'active' },
    off: { name: 'off' },
    error: { name: 'error' },
  } as unknown as Record<TrayIconKind, NativeImage>;
  const trays: FakeTray[] = [];
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  let snapshot: HelperSnapshot = { status: { kind: 'connecting' }, state: null, config: null, configRevision: null };
  const statusListeners = new Set<(status: HelperStatus) => void>();
  const stateListeners = new Set<(state: EngineState) => void>();
  const helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'onStatus' | 'onState' | 'onLog'> = {
    request: () => Promise.reject(new Error('not used')),
    snapshot: () => snapshot,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onLog: () => () => undefined,
  };
  const setHelper = (status: HelperStatus, state: EngineState | null): void => {
    const statusChanged = status.kind !== snapshot.status.kind;
    snapshot = { status, state, config: null, configRevision: null };
    if (statusChanged) for (const listener of [...statusListeners]) listener(status);
    else if (state !== null) for (const listener of [...stateListeners]) listener(state);
  };
  const templates: MenuItemConstructorOptions[][] = [];
  const quit = vi.fn();
  const activateApp = vi.fn();
  const { logger, entries } = memoryLogger();
  const menuBar = startShell(
    {
      createTray: (image) => {
        const tray = new FakeTray(image);
        trays.push(tray);
        return tray;
      },
      images,
      buildMenu: (template) => {
        templates.push(template);
        return { template } as unknown as Menu;
      },
      ipcMain,
      helperClient,
      workAreaAt: () => ({ x: 0, y: 25, width: 1440, height: 875 }),
      activateApp,
      quit,
      logger,
      settings: createSettings({
        loginItem: { get: () => false, set: () => undefined },
        listServiceOrder: () => Promise.reject(new Error('not used')),
        writeClipboard: () => Promise.resolve(),
        logger,
      }),
      now: () => 50_000,
    },
    {
      createWindow: (layout, view) => {
        const window = new FakeWindow(layout, view);
        windows.push(window);
        return window as never;
      },
      entryUrl: APP_ENTRY_URL,
    },
  );
  const tray = (): FakeTray => {
    const first = trays[0];
    if (first === undefined) throw new Error('no tray');
    return first;
  };
  const menuItem = (label: string): MenuItemConstructorOptions => {
    const item = templates[0]?.find((entry) => entry.label === label);
    if (item === undefined) throw new Error(`no menu item ${label}`);
    return item;
  };
  return { menuBar, images, trays, tray, windows, handlers, ipcMain, setHelper, templates, menuItem, quit, activateApp, entries, statusListeners, stateListeners };
}

const clickItem = (item: MenuItemConstructorOptions): void => {
  (item.click as () => void)();
};

describe('startShell', () => {
  it('puts one tray icon in the menu bar, neutral until the helper answers, and opens no window', () => {
    const h = shellHarness();
    expect(h.trays).toHaveLength(1);
    expect(h.tray().image).toBe(h.images.off);
    expect(h.tray().tooltip).toBe(INITIAL_APPEARANCE.tooltip);
    expect(h.windows).toHaveLength(0);
  });

  it('registers the IPC handlers before any window exists', () => {
    const h = shellHarness();
    expect([...h.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('shows the three looks as the connection and the engine state change', () => {
    const h = shellHarness();
    h.setHelper({ kind: 'not-installed' }, null);
    expect(h.tray().image).toBe(h.images.error);
    expect(h.tray().tooltip).toBe("RouteSwitch — helper o'rnatilmagan");

    h.setHelper({ kind: 'connected', helperVersion: '1.2.3' }, engineState(1));
    expect(h.tray().image).toBe(h.images.active);

    h.setHelper({ kind: 'connected', helperVersion: '1.2.3' }, engineState(2, 1, { rules: [ruleState('error')] }));
    expect(h.tray().image).toBe(h.images.error);

    h.setHelper({ kind: 'connected', helperVersion: '1.2.3' }, engineState(3, 2, { enabled: false }));
    expect(h.tray().image).toBe(h.images.off);

    h.setHelper({ kind: 'disconnected', reason: 'connection-lost' }, null);
    expect(h.tray().image).toBe(h.images.error);
    h.setHelper({ kind: 'connecting' }, null);
    expect(h.tray().image).toBe(h.images.error);
    expect(h.entries.filter((entry) => entry.msg === 'Tray icon changed').map((entry) => entry['icon'])).toEqual([
      'error',
      'active',
      'error',
      'off',
      'error',
    ]);
  });

  it('a click on the icon opens the popover under it; another click closes it', () => {
    const h = shellHarness();
    h.tray().click({ x: 1000, y: 0, width: 24, height: 24 });
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]?.view).toBe('popover');
    expect(h.windows[0]?.visible).toBe(true);
    expect(h.windows[0]?.position).toEqual([832, 28]);
    h.tray().click({ x: 1000, y: 0, width: 24, height: 24 });
    expect(h.windows[0]?.visible).toBe(false);
  });

  it('falls back to the bounds of the tray when a click carries none', () => {
    const h = shellHarness();
    h.tray().click();
    expect(h.windows[0]?.position).toEqual([832, 28]);
  });

  it('the tray menu opens the rules window once, and quits the app', () => {
    const h = shellHarness();
    h.tray().listeners.get('right-click')?.({}, h.tray().getBounds());
    expect(h.tray().menus).toHaveLength(1);
    clickItem(h.menuItem('Qoidalarni boshqarish'));
    clickItem(h.menuItem('Qoidalarni boshqarish'));
    expect(h.windows.map((window) => window.view)).toEqual(['rules']);
    expect(h.windows[0]?.layout).toMatchObject({ width: 1040, height: 680 });
    clickItem(h.menuItem('RouteSwitch ilovasidan chiqish'));
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('"Qoidalarni boshqarish" of the menu bar window (rs:openRulesWindow) opens the same single rules window', async () => {
    const h = shellHarness();
    h.tray().click();
    const handler = h.handlers.get('rs:openRulesWindow') as (event: unknown) => Promise<unknown>;
    const fromPopover = { senderFrame: { url: `${APP_ENTRY_URL}?view=popover`, parent: null } };
    expect(await handler(fromPopover)).toEqual({ ok: true, value: null });
    expect(await handler(fromPopover)).toEqual({ ok: true, value: null });
    expect(h.windows.map((window) => window.view)).toEqual(['popover', 'rules']);
    clickItem(h.menuItem('Qoidalarni boshqarish'));
    expect(h.windows.map((window) => window.view)).toEqual(['popover', 'rules']);
  });

  it('after a window is destroyed the tray opens a new one', () => {
    const h = shellHarness();
    h.tray().click();
    h.windows[0]?.destroy();
    h.tray().click();
    expect(h.windows).toHaveLength(2);
    expect(h.windows[1]?.visible).toBe(true);
  });

  it('sends the state to the open windows', () => {
    const h = shellHarness();
    h.tray().click();
    h.setHelper({ kind: 'not-installed' }, null);
    expect(h.windows[0]?.sent).toEqual([[STATE_CHANNEL, { connection: { kind: 'not-installed' }, state: null }]]);
  });

  it('showPopover opens the popover under the tray icon', () => {
    const h = shellHarness();
    h.menuBar.showPopover();
    expect(h.windows[0]?.visible).toBe(true);
    expect(h.windows[0]?.position).toEqual([832, 28]);
  });

  it('dispose removes the icon, the windows, the handlers and the subscriptions — once', () => {
    const h = shellHarness();
    h.tray().click();
    h.menuBar.dispose();
    h.menuBar.dispose();
    expect(h.tray().destroyed).toBe(true);
    expect(h.windows[0]?.destroyed).toBe(true);
    expect(h.handlers.size).toBe(0);
    expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(INVOKE_CHANNELS.length);
    expect(h.statusListeners.size).toBe(0);
    expect(h.stateListeners.size).toBe(0);
    h.menuBar.showPopover();
    expect(h.windows).toHaveLength(1);
  });
});
