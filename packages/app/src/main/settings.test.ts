import { describe, expect, it, vi } from 'vitest';

import type { RsNetworkService } from '../renderer/src/rs';
import { memoryLogger } from './helperClient.fixtures';
import {
  NETWORKSETUP,
  SERVICE_ORDER_LIMITS,
  buildServiceOrder,
  createSettings,
  findWifiService,
  listServiceOrderWithNetworksetup,
  parseServiceOrder,
  shellQuote,
} from './settings';

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: childProcess.execFile }));

const OUTPUT = [
  'An asterisk (*) denotes that a network service is disabled.',
  '(1) USB 10/100/1000 LAN',
  '(Hardware Port: USB 10/100/1000 LAN, Device: en5)',
  '',
  '(2) Wi-Fi',
  '(Hardware Port: Wi-Fi, Device: en0)',
  '',
  '(*) Thunderbolt Bridge',
  '(Hardware Port: Thunderbolt Bridge, Device: bridge0)',
  '',
  '(3) Some VPN',
  '(Hardware Port: com.example.vpn, Device: )',
  '',
].join('\n');

const service = (name: string, extra: Partial<RsNetworkService> = {}): RsNetworkService => ({
  name,
  hardwarePort: name,
  device: null,
  enabled: true,
  ...extra,
});

describe('parseServiceOrder', () => {
  it('reads every service in order, disabled ones included', () => {
    expect(parseServiceOrder(OUTPUT)).toEqual([
      { name: 'USB 10/100/1000 LAN', hardwarePort: 'USB 10/100/1000 LAN', device: 'en5', enabled: true },
      { name: 'Wi-Fi', hardwarePort: 'Wi-Fi', device: 'en0', enabled: true },
      { name: 'Thunderbolt Bridge', hardwarePort: 'Thunderbolt Bridge', device: 'bridge0', enabled: false },
      { name: 'Some VPN', hardwarePort: 'com.example.vpn', device: null, enabled: true },
    ]);
  });

  it('keeps a name with parentheses and a missing port line', () => {
    expect(parseServiceOrder('(1) Office (2nd floor)\n')).toEqual([
      { name: 'Office (2nd floor)', hardwarePort: null, device: null, enabled: true },
    ]);
  });

  it('refuses output that lists nothing or repeats a name', () => {
    expect(parseServiceOrder('')).toBeNull();
    expect(parseServiceOrder('networksetup: command failed')).toBeNull();
    expect(parseServiceOrder('(1) A\n(2) A\n')).toBeNull();
  });

  it('takes names exactly as printed, without trimming', () => {
    expect(parseServiceOrder('(1) Wi-Fi \n(Hardware Port: Wi-Fi, Device: en0)\n(2)  LAN\n')?.map((s) => s.name)).toEqual([
      'Wi-Fi ',
      ' LAN',
    ]);
    expect(parseServiceOrder('(1) Office\u00a0LAN\u00a0\n')?.[0]?.name).toBe('Office\u00a0LAN\u00a0');
  });

  it('drops only a trailing carriage return', () => {
    expect(parseServiceOrder('(1) LAN\r\n(Hardware Port: LAN, Device: en5)\r\n')).toEqual([
      { name: 'LAN', hardwarePort: 'LAN', device: 'en5', enabled: true },
    ]);
  });

  it.each([
    ['an empty name', '(1) A\n(2) \n'],
    ['a name of spaces', '(1) A\n(2)   \n'],
    ['a service line without a name', '(1) A\n(2)\n'],
    ['an indented service line', '(1) A\n  (2) B\n'],
    ['a service line without the space', '(1) A\n(2)B\n'],
  ])('refuses the whole output for %s rather than a shorter list', (_name, output) => {
    expect(parseServiceOrder(output)).toBeNull();
  });

  it.each([
    ['a C0 control', '\u0007'],
    ['DEL', '\u007f'],
    ['a C1 control (NEL)', '\u0085'],
    ['a C1 control (CSI)', '\u009b'],
    ['the line separator', '\u2028'],
    ['the paragraph separator', '\u2029'],
    ['a left-to-right mark', '\u200e'],
    ['a right-to-left mark', '\u200f'],
    ['the Arabic letter mark', '\u061c'],
    ['a right-to-left override', '\u202e'],
    ['a left-to-right embedding', '\u202a'],
    ['a first-strong isolate', '\u2068'],
    ['a pop directional isolate', '\u2069'],
  ])('refuses a name holding %s', (_name, char) => {
    expect(parseServiceOrder(`(1) Wi-Fi\n(2) bad${char}name\n`)).toBeNull();
  });

  it('refuses a name with control characters or over the length limit', () => {
    expect(parseServiceOrder('(1) bad\u0007name\n')).toBeNull();
    expect(parseServiceOrder(`(1) ${'x'.repeat(SERVICE_ORDER_LIMITS.maxNameLength + 1)}\n`)).toBeNull();
  });

  it('refuses more services than the limit', () => {
    const many = Array.from({ length: SERVICE_ORDER_LIMITS.maxServices + 1 }, (_, i) => `(${String(i + 1)}) S${String(i)}`);
    expect(parseServiceOrder(many.join('\n'))).toBeNull();
    expect(parseServiceOrder(many.slice(1).join('\n'))).toHaveLength(SERVICE_ORDER_LIMITS.maxServices);
  });
});

describe('shellQuote', () => {
  it('makes one inert shell word of any name', () => {
    expect(shellQuote('Wi-Fi')).toBe("'Wi-Fi'");
    expect(shellQuote("Bob's LAN")).toBe("'Bob'\\''s LAN'");
    expect(shellQuote('$(rm -rf ~); `x` "y"')).toBe("'$(rm -rf ~); `x` \"y\"'");
  });
});

describe('findWifiService', () => {
  const services = [service('LAN', { device: 'en5' }), service('Office Wi-Fi', { hardwarePort: 'Wi-Fi', device: 'en1' })];

  it("prefers the Wi-Fi role's device", () => {
    expect(findWifiService(services, 'en5')?.name).toBe('LAN');
  });

  it('falls back to the Wi-Fi hardware port', () => {
    expect(findWifiService(services, null)?.name).toBe('Office Wi-Fi');
    expect(findWifiService(services, 'en9')?.name).toBe('Office Wi-Fi');
    expect(findWifiService([service('Old', { hardwarePort: 'AirPort' })], null)?.name).toBe('Old');
  });

  it('is null without a Wi-Fi service', () => {
    expect(findWifiService([service('LAN')], null)).toBeNull();
  });
});

describe('buildServiceOrder', () => {
  it('puts Wi-Fi first and keeps the rest in order, quoted', () => {
    const services = parseServiceOrder(OUTPUT) ?? [];
    expect(buildServiceOrder(services, 'en0')).toEqual({
      services,
      wifiService: 'Wi-Fi',
      wifiFirst: false,
      command:
        "sudo networksetup -ordernetworkservices 'Wi-Fi' 'USB 10/100/1000 LAN' 'Thunderbolt Bridge' 'Some VPN'",
    });
  });

  it('says when Wi-Fi is already the first enabled service', () => {
    const services = [
      service('Off', { enabled: false }),
      service('Wi-Fi', { hardwarePort: 'Wi-Fi', device: 'en0' }),
      service('LAN', { device: 'en5' }),
    ];
    expect(buildServiceOrder(services, 'en0')).toMatchObject({ wifiFirst: true });
  });

  it('has no command without a Wi-Fi service', () => {
    expect(buildServiceOrder([service('LAN')], null)).toMatchObject({ wifiService: null, wifiFirst: false, command: null });
  });
});

describe('createSettings', () => {
  const make = (overrides: { order?: () => Promise<string>; clipboardFails?: boolean } = {}) => {
    let openAtLogin = false;
    const clipboard: string[] = [];
    const { logger, entries } = memoryLogger();
    const set = vi.fn((value: boolean) => {
      openAtLogin = value;
    });
    const settings = createSettings({
      loginItem: { get: () => openAtLogin, set },
      listServiceOrder: overrides.order ?? (() => Promise.resolve(OUTPUT)),
      writeClipboard: (text) => {
        if (overrides.clipboardFails === true) return Promise.reject(new Error('pasteboard busy'));
        clipboard.push(text);
        return Promise.resolve();
      },
      logger,
    });
    return { settings, set, clipboard, entries };
  };

  it('sets the login item and reads it back', () => {
    const { settings, set, entries } = make();
    expect(settings.openAtLogin()).toBe(false);
    expect(settings.setOpenAtLogin(true)).toBe(true);
    expect(set).toHaveBeenCalledWith(true);
    expect(entries.some((entry) => entry.msg === 'Open at login changed')).toBe(true);
  });

  it('answers the value read back, not the one asked for', () => {
    const { logger } = memoryLogger();
    const set = vi.fn();
    const settings = createSettings({
      // macOS ignored the request (e.g. the app is not in /Applications).
      loginItem: { get: () => false, set },
      listServiceOrder: () => Promise.resolve(OUTPUT),
      writeClipboard: () => Promise.resolve(),
      logger,
    });
    expect(settings.setOpenAtLogin(true)).toBe(false);
    expect(set).toHaveBeenCalledWith(true);
  });

  it('reports a failed or unreadable order as operation-failed and logs it', async () => {
    const failed = make({ order: () => Promise.reject(new Error('timeout')) });
    expect(await failed.settings.serviceOrder(null)).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(failed.entries.some((entry) => entry.level === 'warn' && entry.msg === 'Could not read the network service order')).toBe(
      true,
    );
    const garbled = make({ order: () => Promise.resolve('garbage') });
    expect(await garbled.settings.serviceOrder(null)).toMatchObject({ ok: false, code: 'operation-failed' });
  });

  it('copies the command only when there is one', async () => {
    const withWifi = make();
    expect((await withWifi.settings.copyServiceOrderCommand('en0')).ok).toBe(true);
    expect(withWifi.clipboard).toHaveLength(1);
    expect(withWifi.clipboard[0]).toMatch(/^sudo networksetup -ordernetworkservices 'Wi-Fi' /);

    const noWifi = make({ order: () => Promise.resolve('(1) LAN\n(Hardware Port: LAN, Device: en5)\n') });
    expect(await noWifi.settings.copyServiceOrderCommand(null)).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(noWifi.clipboard).toEqual([]);
  });

  it('a clipboard that refuses is operation-failed and logged', async () => {
    const broken = make({ clipboardFails: true });
    expect(await broken.settings.copyServiceOrderCommand('en0')).toMatchObject({ ok: false, code: 'operation-failed' });
    expect(broken.entries.some((entry) => entry.msg === 'Could not copy to the clipboard')).toBe(true);
  });
});

describe('listServiceOrderWithNetworksetup', () => {
  it('runs only the read-only listing, by absolute path, without a shell, bounded', async () => {
    childProcess.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(null, OUTPUT);
      },
    );
    await expect(listServiceOrderWithNetworksetup()).resolves.toBe(OUTPUT);
    const [file, args, options] = (childProcess.execFile.mock.lastCall ?? []) as [string?, string[]?, unknown?];
    expect(file).toBe(NETWORKSETUP);
    expect(NETWORKSETUP).toBe('/usr/sbin/networksetup');
    expect(args).toEqual(['-listnetworkserviceorder']);
    expect(options).toMatchObject({
      shell: false,
      timeout: SERVICE_ORDER_LIMITS.timeoutMs,
      maxBuffer: SERVICE_ORDER_LIMITS.maxOutputBytes,
    });
  });

  it('passes a failure on', async () => {
    const error = new Error('spawn ENOENT');
    childProcess.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(error, '');
      },
    );
    await expect(listServiceOrderWithNetworksetup()).rejects.toMatchObject({ cause: error, message: expect.stringContaining('spawn ENOENT') as unknown });
  });
});
