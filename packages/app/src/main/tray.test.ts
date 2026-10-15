import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { EngineState, RuleState } from '@routeswitch/shared';
import type { Menu, MenuItemConstructorOptions, NativeImage, Rectangle } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { HelperClient, HelperStatus, HelperSnapshot } from './helperClient';
import { engineState, memoryLogger, RULE_ID } from './helperClient.fixtures';
import { INVOKE_CHANNELS, STATE_CHANNEL } from './ipc';
import { APP_ENTRY_URL } from './runtime';
import { i18nFor, type Locale } from '../i18n';
import { createSettings } from './settings';
import {
  INITIAL_APPEARANCE,
  initialAppearance,
  loadTrayImage,
  startShell,
  trayAppearance,
  trayMenuTemplate,
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

const waiting = (reasonCode: 'interface-down' | 'no-gateway' | 'resolving'): RuleState => ({
  ruleId: RULE_ID,
  status: 'pending',
  reasonCode,
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
    ['stored config unreadable (TASK-300)', { kind: 'config-unreadable', helperVersion: '1.2.3' }, null, 'error'],
    ['a rule waiting for its interface is not an error', connected, engineState(1, 1, { rules: [waiting('interface-down')] }), 'active'],
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

  it('says why the stored config stops everything', () => {
    expect(trayAppearance({ kind: 'config-unreadable', helperVersion: '1.2.3' }, null, current).tooltip).toBe(
      "RouteSwitch — helper config'i buzilgan, qoidalar qo'llanmaydi",
    );
  });

  it('notes rules waiting for an interface (down or without a gateway) — not those resolving — and errors first', () => {
    const state = engineState(1, 1, { rules: [waiting('interface-down'), waiting('no-gateway'), waiting('resolving')] });
    expect(trayAppearance(connected, state, current)).toEqual({ kind: 'active', tooltip: 'RouteSwitch — faol · 2 ta qoida interfeysni kutmoqda' });
    const failing = engineState(1, 1, { rules: [ruleState('error'), waiting('interface-down')] });
    expect(trayAppearance(connected, failing, current).tooltip).toBe('RouteSwitch — 1 ta qoidada xato · 1 ta qoida interfeysni kutmoqda');
  });

  it('notes both interfaces on one subnet (one gateway, both up), and only then', () => {
    const base = engineState(1);
    const both = (ethernetGateway: string | null, wifiUp = true): EngineState => ({
      ...base,
      interfaces: {
        ethernet: { device: 'en5', ip: '192.168.1.20', gateway: ethernetGateway, up: true },
        wifi: { device: 'en0', ip: wifiUp ? '192.168.1.30' : null, gateway: wifiUp ? '192.168.1.1' : null, up: wifiUp },
      },
    });
    expect(trayAppearance(connected, both('192.168.1.1'), current).tooltip).toBe('RouteSwitch — faol · Ethernet va Wi‑Fi bitta tarmoqda');
    expect(trayAppearance(connected, both('10.0.0.1'), current).tooltip).toBe('RouteSwitch — faol');
    expect(trayAppearance(connected, both(null), current).tooltip).toBe('RouteSwitch — faol');
    expect(trayAppearance(connected, both('192.168.1.1', false), current).tooltip).toBe('RouteSwitch — faol');
  });

  // TASK-DELTA-21
  it('notes DNS servers reached through the other interface, once per server; the icon keeps its look', () => {
    const base = engineState(1);
    const warning = (server: string, role: 'ethernet' | 'wifi', source: 'interface' | 'rule' = 'interface') => ({
      server,
      source,
      role,
      via: role === 'ethernet' ? ('wifi' as const) : ('ethernet' as const),
      code: 'other-interface-subnet' as const,
      ...(source === 'rule' ? { ruleId: RULE_ID } : {}),
    });
    const two = { ...base, dnsWarnings: [warning('10.0.0.53', 'ethernet'), warning('10.0.0.53', 'ethernet', 'rule'), warning('10.0.0.54', 'ethernet')] };
    expect(trayAppearance(connected, two, current)).toEqual({ kind: 'active', tooltip: 'RouteSwitch — faol · 2 ta DNS server boshqa interfeysdan ketmoqda' });
    expect(trayAppearance(connected, { ...base, dnsWarnings: [] }, current).tooltip).toBe('RouteSwitch — faol');
    const failing = engineState(1, 1, { rules: [ruleState('error')], dnsWarnings: [warning('10.0.0.53', 'ethernet')] });
    expect(trayAppearance(connected, failing, current).kind).toBe('error');
    const ru = i18nFor('ru');
    const ruTip = (count: number) =>
      trayAppearance(connected, { ...base, dnsWarnings: Array.from({ length: count }, (_, i) => warning(`10.0.0.${String(i + 1)}`, 'wifi')) }, current, ru).tooltip;
    expect(ruTip(1)).toBe('RouteSwitch — активно · 1 DNS-сервер идёт через другой интерфейс');
    expect(ruTip(2)).toBe('RouteSwitch — активно · 2 DNS-сервера идут через другой интерфейс');
    expect(ruTip(5)).toBe('RouteSwitch — активно · 5 DNS-серверов идут через другой интерфейс');
    expect(trayAppearance(connected, two, current, i18nFor('en')).tooltip).toBe('RouteSwitch — active · 2 DNS servers go through the other interface');
    // Off: routing is off, no note.
    expect(trayAppearance(connected, { ...two, enabled: false }, current).tooltip).toBe('RouteSwitch — o\'chirilgan');
  });

  it('starts in the neutral look', () => {
    expect(INITIAL_APPEARANCE.kind).toBe('off');
  });

  // TASK-DELTA-12
  it.each<[Locale, string, string, string, string]>([
    ['uz', 'RouteSwitch — ulanmoqda…', 'RouteSwitch — 2 ta qoidada xato · 1 ta qoida interfeysni kutmoqda', "RouteSwitch — helper o'rnatilmagan", 'RouteSwitch — faol · 5 ta qoida interfeysni kutmoqda'],
    ['ru', 'RouteSwitch — подключение…', 'RouteSwitch — ошибка в 2 правилах · 1 правило ждёт интерфейс', 'RouteSwitch — helper не установлен', 'RouteSwitch — активно · 5 правил ждут интерфейс'],
    ['en', 'RouteSwitch — connecting…', 'RouteSwitch — 2 rules failing · 1 rule is waiting for an interface', 'RouteSwitch — helper not installed', 'RouteSwitch — active · 5 rules are waiting for an interface'],
  ])('%s: the tooltips, with plurals', (locale, initial, failing, notInstalled, waitingFive) => {
    const i18n = i18nFor(locale);
    expect(initialAppearance(i18n)).toEqual({ kind: 'off', tooltip: initial });
    const state = engineState(1, 1, { rules: [ruleState('error'), ruleState('error'), waiting('no-gateway')] });
    expect(trayAppearance(connected, state, current, i18n).tooltip).toBe(failing);
    expect(trayAppearance({ kind: 'not-installed' }, null, current, i18n).tooltip).toBe(notInstalled);
    const five = engineState(1, 1, { rules: Array.from({ length: 5 }, () => waiting('interface-down')) });
    expect(trayAppearance(connected, five, current, i18n).tooltip).toBe(waitingFive);
  });

  it('Russian plurals of the waiting rules: 1, 2, 5, 21', () => {
    const ru = i18nFor('ru');
    const tooltip = (count: number) =>
      trayAppearance(connected, engineState(1, 1, { rules: Array.from({ length: count }, () => waiting('interface-down')) }), current, ru).tooltip;
    expect(tooltip(1)).toBe('RouteSwitch — активно · 1 правило ждёт интерфейс');
    expect(tooltip(2)).toBe('RouteSwitch — активно · 2 правила ждут интерфейс');
    expect(tooltip(5)).toBe('RouteSwitch — активно · 5 правил ждут интерфейс');
    expect(tooltip(21)).toBe('RouteSwitch — активно · 21 правило ждёт интерфейс');
  });

  it('every look has its own words in every language', () => {
    const statuses: HelperStatus[] = [
      { kind: 'not-installed' },
      { kind: 'disconnected', reason: 'timeout' },
      { kind: 'incompatible', helperVersion: '9.0.0', protocolVersion: 9, expectedProtocolVersion: 1 },
      { kind: 'config-unreadable', helperVersion: '1.2.3' },
    ];
    for (const locale of ['ru', 'en'] as const) {
      const i18n = i18nFor(locale);
      for (const status of statuses) {
        const own = trayAppearance(status, null, current, i18n);
        expect(own.kind).toBe(trayAppearance(status, null, current).kind);
        expect(own.tooltip).not.toBe(trayAppearance(status, null, current).tooltip);
      }
      expect(trayAppearance(connected, engineState(1, 1, { enabled: false }), current, i18n).tooltip).toBe(i18n.t.tray.off);
    }
  });
});

describe('trayMenuTemplate', () => {
  it('names the rules item as the menu bar window names its button, in every language', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const { t } = i18nFor(locale);
      expect(t.tray.manageRules.toLowerCase()).toBe(t.menuBar.manageRules.toLowerCase());
    }
  });

  it.each<[Locale, string, string]>([
    ['uz', 'Qoidalarni boshqarish', 'RouteSwitch ilovasidan chiqish'],
    ['ru', 'Открыть правила', 'Выйти из RouteSwitch'],
    ['en', 'Manage Rules', 'Quit RouteSwitch'],
  ])('%s: the two items and a separator', (locale, rules, quitLabel) => {
    const openRules = vi.fn();
    const quit = vi.fn();
    const template = trayMenuTemplate(i18nFor(locale), { openRules, quit });
    expect(template.map((item) => item.label ?? item.type)).toEqual([rules, 'separator', quitLabel]);
    (template[0]?.click as () => void)();
    (template[2]?.click as () => void)();
    expect(openRules).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
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

function shellHarness(options: { language?: Promise<Locale> } = {}) {
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
  const helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'> = {
    request: () => Promise.reject(new Error('not used')),
    snapshot: () => snapshot,
    reconnectNow: () => undefined,
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
  const languageListeners = new Set<(language: Locale) => void>();
  const setLanguage = (language: Locale): void => {
    for (const listener of [...languageListeners]) listener(language);
  };
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
      preferences: {
        language: () => options.language ?? Promise.resolve('uz'),
        setLanguage: (language) => Promise.resolve(language),
        dismissedBackupAt: () => Promise.resolve(null),
        setDismissedBackupAt: () => Promise.resolve(),
        onLanguage: (listener) => {
          languageListeners.add(listener);
          return () => languageListeners.delete(listener);
        },
      },
      rulesBackup: { read: () => Promise.resolve(null), remove: () => Promise.resolve(true) },
      configDialogs: { chooseImportFile: () => Promise.resolve(null), chooseExportFile: () => Promise.resolve(null) },
      installer: {
        install: () => Promise.reject(new Error('not used')),
        uninstall: () => Promise.reject(new Error('not used')),
      },
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
  return {
    menuBar,
    images,
    trays,
    tray,
    windows,
    handlers,
    ipcMain,
    setHelper,
    setLanguage,
    languageListeners,
    templates,
    menuItem,
    quit,
    activateApp,
    entries,
    statusListeners,
    stateListeners,
  };
}

const clickItem = (item: MenuItemConstructorOptions): void => {
  (item.click as () => void)();
};

describe('startShell — the language (TASK-DELTA-12)', () => {
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  const labels = (template: MenuItemConstructorOptions[] | undefined) => template?.map((item) => item.label ?? item.type);

  it('takes the stored language once it is read: the menu is built again and the tooltip worded again', async () => {
    const h = shellHarness({ language: Promise.resolve('ru') });
    // Before the read: Uzbek.
    expect(h.tray().tooltip).toBe('RouteSwitch — ulanmoqda…');
    await settle();
    expect(h.tray().tooltip).toBe('RouteSwitch — подключение…');
    expect(h.templates).toHaveLength(2);
    expect(labels(h.templates.at(-1))).toEqual(['Открыть правила', 'separator', 'Выйти из RouteSwitch']);
    // The menu shown on a right-click is the new one.
    h.tray().listeners.get('right-click')?.({}, h.tray().getBounds());
    expect(h.tray().menus.at(-1)).toEqual({ template: h.templates.at(-1) });
  });

  it('a change of language rebuilds the menu and rewords the current tooltip, also while connecting', async () => {
    const h = shellHarness();
    await settle();
    // Uzbek was already on: nothing was rebuilt.
    expect(h.templates).toHaveLength(1);
    h.setHelper({ kind: 'not-installed' }, null);
    h.setHelper({ kind: 'connecting' }, null);
    expect(h.tray().tooltip).toBe("RouteSwitch — helper o'rnatilmagan");
    h.setLanguage('en');
    expect(h.tray().tooltip).toBe('RouteSwitch — helper not installed');
    expect(h.tray().image).toBe(h.images.error);
    expect(labels(h.templates.at(-1))).toEqual(['Manage Rules', 'separator', 'Quit RouteSwitch']);
    h.setHelper({ kind: 'connected', helperVersion: '1.2.3' }, engineState(1));
    expect(h.tray().tooltip).toBe('RouteSwitch — active');
    // The same language again: nothing is rebuilt.
    const built = h.templates.length;
    h.setLanguage('en');
    expect(h.templates).toHaveLength(built);
    // The new menu still works.
    const item = h.templates.at(-1)?.[2];
    if (item !== undefined) clickItem(item);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.entries.some((entry) => entry.msg === 'Tray language changed' && entry['language'] === 'en')).toBe(true);
  });

  it('dispose stops listening to the language; a late read changes nothing', async () => {
    let answer: (locale: Locale) => void = () => undefined;
    const h = shellHarness({ language: new Promise<Locale>((resolve) => (answer = resolve)) });
    // The tray's own and the `rs:language` push of the IPC.
    expect(h.languageListeners.size).toBe(2);
    h.menuBar.dispose();
    expect(h.languageListeners.size).toBe(0);
    answer('ru');
    await settle();
    expect(h.templates).toHaveLength(1);
    expect(h.tray().tooltip).toBe('RouteSwitch — ulanmoqda…');
  });
});

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

  it('sends the state to the open windows', async () => {
    const h = shellHarness();
    h.tray().click();
    h.setHelper({ kind: 'not-installed' }, null);
    // The journal line waits for the language (TASK-DELTA-12).
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(h.windows[0]?.sent).toEqual([
      [STATE_CHANNEL, { connection: { kind: 'not-installed' }, state: null }],
      // The app's own journal line about it (TASK-300).
      ['rs:log', { seq: 1, level: 'warn', msg: "Helper o'rnatilmagan — qoidalar qo'llanmaydi", at: expect.any(String) as string, source: 'app' }],
    ]);
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
