// The settings screen's main-process side: the login item, and the network
// service order behind "make Wi‑Fi the default".
//
// Making Wi‑Fi the default changes the service order, which needs root
// (`networksetup -ordernetworkservices`). The app runs no privileged command
// and the helper protocol has no such method (decision GAP-04, 2026-10-12):
// the app only READS the order (`-listnetworkserviceorder`, no root needed)
// and shows the command for the user to run. It never runs it.

import { execFile } from 'node:child_process';

import type { RsNetworkService, RsServiceOrder } from '../renderer/src/rs';
import type { Logger } from './logger';

/** The binary, by absolute path: no PATH lookup, no shell. */
export const NETWORKSETUP = '/usr/sbin/networksetup';
export const LIST_SERVICE_ORDER_ARGS = ['-listnetworkserviceorder'] as const;

/** Bounds for parsing: the output comes from the system, but nothing unbounded is passed on. */
export const SERVICE_ORDER_LIMITS = {
  maxServices: 64,
  maxNameLength: 255,
  maxOutputBytes: 256 * 1024,
  timeoutMs: 5000,
} as const;

/**
 * Characters a name may not hold: C0 and C1 controls, DEL, the line and
 * paragraph separators, and the bidirectional controls. The command is shown
 * for the user to run with `sudo`; any of these could break it across lines
 * or make it read differently from what it does.
 */
const isForbiddenChar = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x200e ||
  code === 0x200f ||
  code === 0x061c ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** `true` when the name is printable text a shell-quoted argument can carry. */
export const isPlainName = (name: string): boolean =>
  name.trim().length > 0 &&
  name.length <= SERVICE_ORDER_LIMITS.maxNameLength &&
  !Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)).some(isForbiddenChar);

/** The start of a service line: `(1) ` for an enabled service, `(*) ` for a disabled one. */
const SERVICE_START = /^\((\d+|\*)\) /;
/** Anything that looks like a service line, even malformed (`(1)` without a name, ` (2) x`). */
const SERVICE_LIKE = /^\s*\((\d+|\*)\)/;
const PORT_LINE = /^\(Hardware Port: (.*), Device: (.*)\)$/;

/**
 * The services of `networksetup -listnetworkserviceorder`, in order, or null
 * when the output is not in the expected shape. Disabled services (`(*)`)
 * are kept: `-ordernetworkservices` takes every service.
 *
 * Names are taken exactly as printed (no trimming): the command must name
 * every service as it is. A service line that cannot be read whole makes the
 * whole result null rather than a shorter list.
 */
export function parseServiceOrder(output: string): RsNetworkService[] | null {
  const services: RsNetworkService[] = [];
  const lines = output.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const start = SERVICE_START.exec(line);
    if (start === null) {
      if (SERVICE_LIKE.test(line)) return null;
      continue;
    }
    const position = start[1] ?? '';
    const name = line.slice(start[0].length);
    if (!isPlainName(name)) return null;
    const port = PORT_LINE.exec(lines[i + 1] ?? '');
    const device = port?.[2]?.trim() ?? '';
    services.push({
      name,
      hardwarePort: port?.[1] ?? null,
      device: device === '' ? null : device,
      enabled: position !== '*',
    });
    if (services.length > SERVICE_ORDER_LIMITS.maxServices) return null;
  }
  if (services.length === 0) return null;
  const names = new Set(services.map((service) => service.name));
  return names.size === services.length ? services : null;
}

/** A single-quoted shell word: safe to paste whatever the name holds. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Wi‑Fi service: the one on the Wi‑Fi role's device when it is known,
 * else the one whose hardware port is Wi‑Fi.
 */
export function findWifiService(services: readonly RsNetworkService[], wifiDevice: string | null): RsNetworkService | null {
  if (wifiDevice !== null) {
    const byDevice = services.find((service) => service.device === wifiDevice);
    if (byDevice !== undefined) return byDevice;
  }
  return services.find((service) => service.hardwarePort === 'Wi-Fi' || service.hardwarePort === 'AirPort') ?? null;
}

/** The order with Wi‑Fi first and the command that would set it (for the user to run). */
export function buildServiceOrder(services: readonly RsNetworkService[], wifiDevice: string | null): RsServiceOrder {
  const wifi = findWifiService(services, wifiDevice);
  if (wifi === null) return { services, wifiService: null, wifiFirst: false, command: null };
  const firstEnabled = services.find((service) => service.enabled);
  const wanted = [wifi, ...services.filter((service) => service !== wifi)];
  const command = ['sudo', 'networksetup', '-ordernetworkservices', ...wanted.map((service) => shellQuote(service.name))].join(
    ' ',
  );
  return { services, wifiService: wifi.name, wifiFirst: firstEnabled === wifi, command };
}

// ---------------------------------------------------------------------------

export type ServiceOrderResult =
  | { readonly ok: true; readonly value: RsServiceOrder }
  | { readonly ok: false; readonly code: 'operation-failed'; readonly error: string };

export interface SettingsDeps {
  /** `app.getLoginItemSettings().openAtLogin` / `app.setLoginItemSettings({ openAtLogin })`. */
  readonly loginItem: {
    readonly get: () => boolean;
    readonly set: (openAtLogin: boolean) => void;
  };
  /** Runs `networksetup -listnetworkserviceorder` (read-only) and returns its output. */
  readonly listServiceOrder: () => Promise<string>;
  /** Puts text on the system clipboard (`clipboard.writeText`). */
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly logger: Logger;
}

export interface Settings {
  readonly openAtLogin: () => boolean;
  /** Sets the login item and returns the value read back. */
  readonly setOpenAtLogin: (openAtLogin: boolean) => boolean;
  readonly serviceOrder: (wifiDevice: string | null) => Promise<ServiceOrderResult>;
  /** Puts the Wi‑Fi-first command on the clipboard, built here from a fresh read: the page names no text. */
  readonly copyServiceOrderCommand: (wifiDevice: string | null) => Promise<ServiceOrderResult>;
}

export function createSettings(deps: SettingsDeps): Settings {
  const logger = deps.logger.child({ component: 'settings' });
  const readLog = logger.limited('settings-service-order');

  const serviceOrder = async (wifiDevice: string | null): Promise<ServiceOrderResult> => {
    let output: string;
    try {
      output = await deps.listServiceOrder();
    } catch (error) {
      readLog.warn('Could not read the network service order', { binary: NETWORKSETUP, detail: error });
      return { ok: false, code: 'operation-failed', error: 'Could not read the network service order' };
    }
    const services = parseServiceOrder(output);
    if (services === null) {
      readLog.warn('The network service order was not in the expected shape', { bytes: output.length });
      return { ok: false, code: 'operation-failed', error: 'The network service order could not be read' };
    }
    return { ok: true, value: buildServiceOrder(services, wifiDevice) };
  };

  return {
    openAtLogin: () => deps.loginItem.get(),
    setOpenAtLogin(openAtLogin) {
      deps.loginItem.set(openAtLogin);
      const now = deps.loginItem.get();
      logger.info('Open at login changed', { requested: openAtLogin, openAtLogin: now });
      return now;
    },
    serviceOrder,
    async copyServiceOrderCommand(wifiDevice) {
      const result = await serviceOrder(wifiDevice);
      if (!result.ok) return result;
      if (result.value.command === null) {
        return { ok: false, code: 'operation-failed', error: 'There is no Wi-Fi service to put first' };
      }
      try {
        await deps.writeClipboard(result.value.command);
      } catch (error) {
        logger.warn('Could not copy to the clipboard', { detail: error });
        return { ok: false, code: 'operation-failed', error: 'Could not copy to the clipboard' };
      }
      logger.info('Copied the service order command', { services: result.value.services.length });
      return result;
    },
  };
}

/** The real reader: `execFile` with an absolute path and an argument array, bounded in time and size. */
export function listServiceOrderWithNetworksetup(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      NETWORKSETUP,
      [...LIST_SERVICE_ORDER_ARGS],
      {
        timeout: SERVICE_ORDER_LIMITS.timeoutMs,
        maxBuffer: SERVICE_ORDER_LIMITS.maxOutputBytes,
        encoding: 'utf8',
        shell: false,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
      },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`${NETWORKSETUP} ${LIST_SERVICE_ORDER_ARGS.join(' ')} failed: ${error.message}`, { cause: error }));
      },
    );
  });
}
