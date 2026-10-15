import type { AdapterInfo, Config, SetConfigResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsResult, RsServiceOrder } from '../../rs';
import { i18nFor } from '../../../../i18n';
import { errorText } from '../../text';
import {
  copyServiceOrderCommand,
  ethernetChoices,
  saveEthernetOverride,
  setOpenAtLogin,
  uninstallHelper,
  withEthernetOverride,
  type SettingsApi,
} from './actions';

const CONFIG: Config = { version: 1, enabled: true, ifaceOverrides: { wifi: 'en0', ethernet: 'en5' }, rules: [] };
const ORDER: RsServiceOrder = {
  services: [{ name: 'Wi-Fi', hardwarePort: 'Wi-Fi', device: 'en0', enabled: true }],
  wifiService: 'Wi-Fi',
  wifiFirst: true,
  command: "sudo networksetup -ordernetworkservices 'Wi-Fi'",
};
const refused = (code: 'not-connected' | 'timeout' | 'not-implemented' | 'invalid-input' | 'operation-failed' | 'install-cancelled') =>
  Promise.resolve({ ok: false, code, error: 'English detail' } as const);

function fakeApi(overrides: Partial<SettingsApi> = {}): SettingsApi {
  return {
    getSettings: vi.fn(() => Promise.resolve({ ok: true, value: { openAtLogin: false } } as const)),
    setOpenAtLogin: vi.fn((on: boolean) => Promise.resolve({ ok: true, value: { openAtLogin: on } } as const)),
    getConfig: vi.fn(() => Promise.resolve({ ok: true, value: CONFIG } as const)),
    setIfaceOverrides: vi.fn(() =>
      Promise.resolve({ ok: true, value: {} as SetConfigResult } as RsResult<SetConfigResult>),
    ),
    getServiceOrder: vi.fn(() => Promise.resolve({ ok: true, value: ORDER } as const)),
    copyServiceOrderCommand: vi.fn(() => Promise.resolve({ ok: true, value: ORDER } as const)),
    uninstallHelper: vi.fn(() => Promise.resolve({ ok: true, value: {} } as const)),
    // No helper package by default (development): the socket uninstall is the way.
    removeHelper: vi.fn(() => Promise.resolve({ ok: false, code: 'install-unavailable', error: 'x' } as const)),
    ...overrides,
  };
}

describe('ethernetChoices', () => {
  const adapters: AdapterInfo[] = [
    { device: 'en0', port: 'Wi-Fi', ip: '192.168.0.10' },
    { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.0.0.5' },
    { device: 'en7', port: 'Thunderbolt Ethernet', ip: null },
  ];

  it('leaves out the Wi-Fi adapter, by device and by port', () => {
    expect(ethernetChoices(adapters, 'en0').map((adapter) => adapter.device)).toEqual(['en5', 'en7']);
    expect(ethernetChoices(adapters, null).map((adapter) => adapter.device)).toEqual(['en5', 'en7']);
  });

  it("leaves out the Wi-Fi role's device even when its port is not called Wi-Fi", () => {
    const usbWifi: AdapterInfo[] = [
      { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.0.0.5' },
      { device: 'en8', port: 'USB LAN', ip: '192.168.0.20' },
    ];
    expect(ethernetChoices(usbWifi, 'en8').map((adapter) => adapter.device)).toEqual(['en5']);
    expect(ethernetChoices(usbWifi, null).map((adapter) => adapter.device)).toEqual(['en5', 'en8']);
  });
});

describe('withEthernetOverride', () => {
  it('sets, replaces and removes only the Ethernet override', () => {
    expect(withEthernetOverride(undefined, 'en7')).toEqual({ ethernet: 'en7' });
    expect(withEthernetOverride({ wifi: 'en0', ethernet: 'en5' }, 'en7')).toEqual({ wifi: 'en0', ethernet: 'en7' });
    expect(withEthernetOverride({ wifi: 'en0', ethernet: 'en5' }, null)).toEqual({ wifi: 'en0' });
    expect(withEthernetOverride({ ethernet: 'en5' }, null)).toEqual({});
  });
});

describe('setOpenAtLogin', () => {
  it('reports the value macOS kept', async () => {
    const rs = fakeApi();
    expect(await setOpenAtLogin(rs, true)).toMatchObject({ openAtLogin: true, feedback: { tone: 'success' } });
    expect(rs.setOpenAtLogin).toHaveBeenCalledWith(true);
  });

  it('says so when macOS did not take the change', async () => {
    const rs = fakeApi({ setOpenAtLogin: () => Promise.resolve({ ok: true, value: { openAtLogin: false } }) });
    expect(await setOpenAtLogin(rs, true)).toMatchObject({ openAtLogin: false, feedback: { tone: 'danger' } });
  });

  it('a failed call keeps the old value', async () => {
    const rs = fakeApi({ setOpenAtLogin: () => refused('operation-failed') });
    expect(await setOpenAtLogin(rs, true)).toEqual({ openAtLogin: null, feedback: { tone: 'danger', text: 'Amal bajarilmadi.' } });
  });
});

describe('saveEthernetOverride', () => {
  it('reads the config fresh and sends the overrides with only Ethernet changed', async () => {
    const rs = fakeApi();
    expect(await saveEthernetOverride(rs, 'en7')).toMatchObject({ tone: 'success' });
    expect(rs.setIfaceOverrides).toHaveBeenCalledWith({ wifi: 'en0', ethernet: 'en7' });
    await saveEthernetOverride(rs, null);
    expect(rs.setIfaceOverrides).toHaveBeenLastCalledWith({ wifi: 'en0' });
  });

  it('sends nothing when the config cannot be read', async () => {
    const rs = fakeApi({ getConfig: () => refused('not-connected') });
    expect(await saveEthernetOverride(rs, 'en7')).toMatchObject({ tone: 'danger' });
    expect(rs.setIfaceOverrides).not.toHaveBeenCalled();
  });

  it('shows a refusal', async () => {
    const rs = fakeApi({ setIfaceOverrides: () => refused('invalid-input') });
    expect(await saveEthernetOverride(rs, 'en7')).toEqual({ tone: 'danger', text: 'Qiymat qabul qilinmadi.' });
  });
});

describe('copyServiceOrderCommand', () => {
  it('asks the main process to copy and passes no text', async () => {
    const rs = fakeApi();
    expect(await copyServiceOrderCommand(rs)).toMatchObject({ order: ORDER, feedback: { tone: 'success' } });
    expect(rs.copyServiceOrderCommand).toHaveBeenCalledWith();
  });

  it('shows a failure', async () => {
    const rs = fakeApi({ copyServiceOrderCommand: () => refused('operation-failed') });
    expect(await copyServiceOrderCommand(rs)).toMatchObject({ order: null, feedback: { tone: 'danger' } });
  });
});

describe('uninstallHelper', () => {
  it('reports success', async () => {
    expect(await uninstallHelper(fakeApi())).toMatchObject({ tone: 'success' });
  });

  it('the full removal (administrator password) comes first; then the socket uninstall is not used (TASK-214)', async () => {
    const rs = fakeApi({ removeHelper: vi.fn(() => Promise.resolve({ ok: true, value: null } as const)) });
    expect(await uninstallHelper(rs)).toMatchObject({ tone: 'success', text: expect.stringContaining('butunlay') as unknown });
    expect(rs.uninstallHelper).not.toHaveBeenCalled();
    const cancelled = fakeApi({ removeHelper: () => refused('install-cancelled') });
    expect(await uninstallHelper(cancelled)).toMatchObject({ tone: 'danger', text: errorText('install-cancelled') });
    expect(cancelled.uninstallHelper).not.toHaveBeenCalled();
  });

  it('a helper that cannot uninstall yet, or an unknown outcome, is a normal error', async () => {
    expect(await uninstallHelper(fakeApi({ uninstallHelper: () => refused('not-implemented') }))).toEqual({
      tone: 'danger',
      text: errorText('not-implemented'),
    });
    expect(await uninstallHelper(fakeApi({ uninstallHelper: () => refused('timeout') }))).toMatchObject({
      text: expect.stringContaining("noma'lum") as unknown,
    });
  });
});

describe('the settings actions in every language (TASK-DELTA-14)', () => {
  it.each([
    ['uz', "RouteSwitch login'da ishga tushadi.", "Login'da ishga tushish o'chirildi.", 'Ethernet roli endi en7 da.', "Buyruq nusxalandi — Terminal'ga qo'ying."],
    ['ru', 'RouteSwitch будет запускаться при входе.', 'Запуск при входе выключен.', 'Роль Ethernet теперь у en7.', 'Команда скопирована — вставьте её в Терминал.'],
    ['en', 'RouteSwitch will open at login.', 'Open at login is turned off.', 'The Ethernet role is now on en7.', 'Command copied — paste it into Terminal.'],
  ] as const)('%s', async (locale, on, off, saved, copied) => {
    const i18n = i18nFor(locale);
    expect((await setOpenAtLogin(fakeApi(), true, i18n)).feedback.text).toBe(on);
    expect((await setOpenAtLogin(fakeApi(), false, i18n)).feedback.text).toBe(off);
    expect(await saveEthernetOverride(fakeApi(), 'en7', i18n)).toEqual({ tone: 'success', text: saved });
    expect((await saveEthernetOverride(fakeApi(), null, i18n)).text).toBe(i18n.t.settings.ethernet.savedAuto);
    expect((await copyServiceOrderCommand(fakeApi(), i18n)).feedback.text).toBe(copied);
  });

  it('refusals and a setting macOS did not take are worded in the language given', async () => {
    const ru = i18nFor('ru');
    expect((await setOpenAtLogin(fakeApi({ setOpenAtLogin: () => refused('timeout') }), true, ru)).feedback.text).toBe(errorText('timeout', ru));
    const ignored = fakeApi({ setOpenAtLogin: () => Promise.resolve({ ok: true, value: { openAtLogin: false } } as const) });
    expect((await setOpenAtLogin(ignored, true, ru)).feedback.text).toContain('Объекты входа');
    expect(await saveEthernetOverride(fakeApi({ getConfig: () => refused('not-connected') }), 'en7', ru)).toEqual({
      tone: 'danger',
      text: errorText('not-connected', ru),
    });
    expect((await uninstallHelper(fakeApi(), i18nFor('en'))).text).toBe('Helper removed: its routes and resolver files are gone. Routing has stopped.');
  });
});
