import {
  normalizeHostAddress,
  normalizeIpv4,
  parseIpv4Destination,
  PROTOCOL_LIMITS,
  type AdapterInfo,
  type IfaceRole,
  type InterfaceState,
} from '@routeswitch/shared';

import { ALLOWED_BINARIES, type CommandResult, type CommandRunner } from './exec';
import type { Logger } from './logger';

/**
 * Answers "which device plays each interface role right now, and can routes go
 * through it?". Read-only: it runs `networksetup -listallhardwareports` and
 * `ipconfig getifaddr|getoption`, nothing else.
 *
 * How a role gets its device:
 * - `wifi` — the hardware port named `Wi-Fi` (compared without regard to
 *   case; the child environment pins `LANG=C`, so the name is not localised).
 * - `ethernet` — the first `en*` hardware port, in the order `networksetup`
 *   lists them, that is not the Wi-Fi port, is not the device of the `wifi`
 *   role, and has an IPv4 address. Port names are not interpreted: an `en*`
 *   Thunderbolt port or a tethered phone qualifies as soon as it has an
 *   address. Pin the role with `ifaceOverrides` when that picks the wrong one.
 * - An override (`role -> en<digits>`) always wins over the heuristic, even
 *   when the device has no address. A device claimed by an override is never
 *   given to the other role.
 *
 * Error model: nothing here throws or rejects for a runtime condition. A
 * command that fails, times out or prints something unexpected degrades the
 * affected field to `null` (and the role to "not usable") with a log line,
 * and sets `degraded` on the result. Every value taken from command output is
 * re-validated with the strict IPv4 helpers before it is returned, and a
 * device name reaches an argv only after matching `en<digits>`.
 */

/** How long a detection result is served from the cache. */
export const NETINFO_CACHE_TTL_MS = 5_000;
/** Timeout for each command of a detection; all of them normally finish in milliseconds. */
export const NETINFO_COMMAND_TIMEOUT_MS = 5_000;

/**
 * `ipconfig getifaddr <dev>` and `ipconfig getoption <dev> <option>` exit with
 * code 1 and print nothing when there is no value: the interface has no IPv4
 * address, no DHCP lease carrying the option, or does not exist. Observed on
 * macOS 26.3.1. That is an ordinary answer, so it is logged at `debug`.
 */
const IPCONFIG_NO_VALUE_EXIT_CODE = 1;
const IPCONFIG_EXPECTED_EXIT_CODES: readonly number[] = [IPCONFIG_NO_VALUE_EXIT_CODE];

const DEVICE_NAME = /^en\d+$/;
/** Same bound as the wire schema's device name. */
const DEVICE_NAME_MAX_LENGTH = 16;
const WIFI_PORT_NAME = 'wi-fi';
const LOGGED_INPUT_LIMIT = 64;

const PORT_KEY = 'Hardware Port:';
const DEVICE_KEY = 'Device:';
/** Heading of the section after the port list; its blocks are not hardware ports. */
const VLAN_SECTION = 'VLAN Configurations';

/**
 * Why a role cannot be used for routing; `null` on a usable role.
 * - `hardware-ports-unavailable` — `networksetup` failed or listed no port.
 * - `no-device` — no port can play the role (no Wi-Fi port; no `en*` port
 *   other than Wi-Fi).
 * - `invalid-override` — the override is not an `en<digits>` name.
 * - `override-not-found` — the overridden device is not a hardware port now.
 * - `override-conflict` — the device belongs to the other role's override.
 * - `no-address` — the device (or, for the Ethernet heuristic, every
 *   candidate) has no IPv4 address: cable unplugged, Wi-Fi not associated.
 * - `address-lookup-failed` — the address query itself failed.
 * - `no-gateway` — an address but no router from DHCP.
 * - `gateway-lookup-failed` — the router query failed or returned something
 *   that is not a usable IPv4 address.
 */
export type InterfaceDownReason =
  | 'hardware-ports-unavailable'
  | 'no-device'
  | 'invalid-override'
  | 'override-not-found'
  | 'override-conflict'
  | 'no-address'
  | 'address-lookup-failed'
  | 'no-gateway'
  | 'gateway-lookup-failed';

/** One block of `networksetup -listallhardwareports`. */
export interface HardwarePort {
  /** Hardware port name, e.g. `Wi-Fi` or `USB 10/100/1000 LAN`. */
  readonly port: string;
  /** BSD device name as printed, e.g. `en0` or `bridge0`. Not validated. */
  readonly device: string;
}

export interface InterfaceInfo {
  readonly role: IfaceRole;
  /** `en<digits>`, or `null` when no device plays the role. */
  readonly device: string | null;
  /** Hardware port name of `device`; `null` when the device is not a listed port. */
  readonly port: string | null;
  readonly ip: string | null;
  /** Next hop for routes through this role. */
  readonly gateway: string | null;
  /** Dotted subnet mask, e.g. `255.255.255.0`; `null` when unknown or not contiguous. */
  readonly netmask: string | null;
  /** Connected subnet in canonical CIDR form, e.g. `192.168.1.0/24`. */
  readonly subnet: string | null;
  /** The role has a device with an IPv4 address (the meaning `InterfaceState.up` has on the wire). */
  readonly up: boolean;
  /** `up` and a gateway: routes can be added through this role. */
  readonly routable: boolean;
  /** Set exactly when `routable` is false. */
  readonly reason: InterfaceDownReason | null;
  /** The device came from `ifaceOverrides`, not from the heuristic. */
  readonly overridden: boolean;
}

export interface DetectedInterfaces {
  readonly ethernet: InterfaceInfo;
  readonly wifi: InterfaceInfo;
  /** Every `en*` hardware port in `networksetup` order, at most `PROTOCOL_LIMITS.maxAdapters`. */
  readonly adapters: readonly AdapterInfo[];
  /**
   * A command failed or printed something unexpected, so part of the result
   * may be missing for a reason other than the state of the network.
   */
  readonly degraded: boolean;
}

/** Role -> device, as in `Config.ifaceOverrides`. */
export interface IfaceOverrides {
  readonly ethernet?: string | undefined;
  readonly wifi?: string | undefined;
}

export interface DetectOptions {
  readonly overrides?: IfaceOverrides | undefined;
  /**
   * Skip the cached result. A detection that is already running for the same
   * overrides is still shared; call `invalidate()` first when even that one
   * may predate the change.
   */
  readonly force?: boolean | undefined;
}

export interface NetInfo {
  /** Never rejects. Results are cached for `NETINFO_CACHE_TTL_MS` per set of overrides. */
  detectInterfaces(options?: DetectOptions): Promise<DetectedInterfaces>;
  /** Drops the cached result and detaches from any detection still running. */
  invalidate(): void;
}

export interface NetInfoDeps {
  readonly runner: CommandRunner;
  readonly logger: Logger;
  /** Millisecond clock for the cache; defaults to the monotonic `performance.now`. */
  readonly now?: () => number;
}

const isDeviceName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= DEVICE_NAME_MAX_LENGTH && DEVICE_NAME.test(value);

/**
 * Parses `networksetup -listallhardwareports`: blank-line separated blocks of
 * `Hardware Port: <name>` followed by `Device: <bsd name>`. Lines are split
 * and trimmed (no pattern matching on the whole line), so CRLF and trailing
 * whitespace are harmless. Blocks without both fields, repeated devices and
 * everything from the VLAN section on are skipped.
 */
export const parseHardwarePorts = (stdout: string): HardwarePort[] => {
  const ports: HardwarePort[] = [];
  const seen = new Set<string>();
  let pending: string | null = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === VLAN_SECTION) break;
    if (line === '') {
      pending = null;
    } else if (line.startsWith(PORT_KEY)) {
      const name = line.slice(PORT_KEY.length).trim();
      pending = name === '' ? null : name;
    } else if (line.startsWith(DEVICE_KEY) && pending !== null) {
      const device = line.slice(DEVICE_KEY.length).trim();
      if (device !== '' && !seen.has(device)) {
        seen.add(device);
        ports.push({ port: pending, device });
      }
      pending = null;
    }
  }
  return ports;
};

/**
 * Prefix length of a dotted subnet mask, or `null` when it is not strict IPv4,
 * not contiguous (`255.0.255.0`) or zero (`0.0.0.0` is not a connected subnet).
 */
export const netmaskToPrefix = (mask: string): number | null => {
  const normalised = normalizeIpv4(mask);
  if (!normalised.ok) return null;
  const [a = 0, b = 0, c = 0, d = 0] = normalised.value.split('.').map(Number);
  const hostBits = ~((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  // A contiguous mask leaves host bits of the form 0…01…1, i.e. 2^k - 1.
  if ((hostBits & (hostBits + 1)) !== 0) return null;
  const prefix = Math.clz32(hostBits);
  return prefix === 0 ? null : prefix;
};

/** The wire form of one role: what `EngineState.interfaces` carries. */
export const toInterfaceState = (info: InterfaceInfo): InterfaceState => ({
  device: info.device,
  ip: info.ip,
  gateway: info.gateway,
  up: info.up,
});

/** The `interfaces` and `adapters` fields of `EngineState`. */
export const toWireInterfaces = (
  detected: DetectedInterfaces,
): { interfaces: { ethernet: InterfaceState; wifi: InterfaceState }; adapters: AdapterInfo[] } => ({
  interfaces: { ethernet: toInterfaceState(detected.ethernet), wifi: toInterfaceState(detected.wifi) },
  adapters: detected.adapters.map((adapter) => ({ ...adapter })),
});

/** The only line of a single-value command output; `null` for none or several. */
const singleLine = (stdout: string): string | null => {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [first] = lines;
  return lines.length === 1 && first !== undefined ? first : null;
};

const describeInput = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, LOGGED_INPUT_LIMIT) : `<${typeof value}>`;

const describeThrown = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const overrideOf = (overrides: unknown, role: IfaceRole): unknown =>
  typeof overrides === 'object' && overrides !== null
    ? (overrides as Readonly<Record<string, unknown>>)[role]
    : undefined;

/** Cache identity of a set of overrides; anything that is not a string counts as one "invalid" value. */
const overridesKey = (overrides: unknown): string =>
  JSON.stringify(
    (['ethernet', 'wifi'] as const).map((role) => {
      const value = overrideOf(overrides, role);
      if (value === undefined) return null;
      return typeof value === 'string' ? value : false;
    }),
  );

type IpconfigQuery = 'address' | 'router' | 'subnet_mask';

interface Lookup {
  /** Trimmed output; `null` when there is no value. */
  readonly value: string | null;
  /** The query did not give a trustworthy answer (as opposed to "no value"). */
  readonly failed: boolean;
}

const NO_VALUE: Lookup = { value: null, failed: false };
const FAILED: Lookup = { value: null, failed: true };

/** What a role resolves to before any address is looked at. */
interface RoleChoice {
  readonly device: string | null;
  readonly port: string | null;
  readonly overridden: boolean;
  readonly reason: InterfaceDownReason | null;
}

interface EnPort {
  readonly device: string;
  readonly port: string;
  readonly isWifi: boolean;
}

const down = (role: IfaceRole, choice: RoleChoice, reason: InterfaceDownReason): InterfaceInfo => ({
  role,
  device: choice.device,
  port: choice.port,
  ip: null,
  gateway: null,
  netmask: null,
  subnet: null,
  up: false,
  routable: false,
  reason,
  overridden: choice.overridden,
});

const NOTHING: RoleChoice = { device: null, port: null, overridden: false, reason: null };

const freezeResult = (result: DetectedInterfaces): DetectedInterfaces => {
  for (const adapter of result.adapters) Object.freeze(adapter);
  Object.freeze(result.adapters);
  Object.freeze(result.ethernet);
  Object.freeze(result.wifi);
  return Object.freeze(result);
};

export const createNetInfo = (deps: NetInfoDeps): NetInfo => {
  const { runner } = deps;
  const logger = deps.logger.child({ component: 'netinfo' });
  const now = deps.now ?? (() => performance.now());

  let generation = 0;
  let cache: { key: string; at: number; value: DetectedInterfaces } | null = null;
  let inFlight: { key: string; generation: number; promise: Promise<DetectedInterfaces> } | null = null;
  let lastSummary: string | null = null;

  /** Runs a command; a refused call (a bug here, not a system condition) is logged and reported as `null`. */
  const run = async (
    bin: Parameters<CommandRunner['run']>[0],
    args: readonly string[],
    expectedExitCodes?: readonly number[],
  ): Promise<CommandResult | null> => {
    try {
      return await runner.run(bin, args, {
        timeoutMs: NETINFO_COMMAND_TIMEOUT_MS,
        ...(expectedExitCodes === undefined ? {} : { expectedExitCodes }),
      });
    } catch (error) {
      logger.error('command could not be started', { bin, error: describeThrown(error) });
      return null;
    }
  };

  /**
   * The single place that puts a device name into an argv. `device` is checked
   * again here, whatever the caller did.
   */
  const ipconfig = async (device: string, query: IpconfigQuery): Promise<Lookup> => {
    if (!isDeviceName(device)) {
      logger.error('refusing to query a device with an unexpected name', { device: describeInput(device), query });
      return FAILED;
    }
    const args = query === 'address' ? ['getifaddr', device] : ['getoption', device, query];
    const result = await run(ALLOWED_BINARIES.ipconfig, args, IPCONFIG_EXPECTED_EXIT_CODES);
    if (result === null) return FAILED;

    if (result.ok) {
      const value = singleLine(result.stdout);
      if (value === null) {
        logger.warn('unexpected output from ipconfig', { device, query });
        return FAILED;
      }
      return { value, failed: false };
    }
    // Exit 1 with no output at all is "no value". ipconfig also exits 1 for a
    // usage error, but then it prints its usage text on stderr.
    if (
      result.failure === 'nonzero-exit' &&
      result.exitCode === IPCONFIG_NO_VALUE_EXIT_CODE &&
      result.stdout.trim() === '' &&
      result.stderr.trim() === ''
    ) {
      return NO_VALUE;
    }
    logger.warn('ipconfig query failed', { device, query, failure: result.failure, exitCode: result.exitCode });
    return FAILED;
  };

  const lookupAddress = async (device: string): Promise<Lookup> => {
    const lookup = await ipconfig(device, 'address');
    if (lookup.value === null) return lookup;
    const address = normalizeIpv4(lookup.value);
    if (address.ok) return { value: address.value, failed: false };
    logger.warn('ipconfig returned an address that is not IPv4', { device, value: describeInput(lookup.value) });
    return FAILED;
  };

  /** A gateway must be an address `route` will accept as a next hop, not merely IPv4 syntax. */
  const lookupGateway = async (device: string): Promise<Lookup> => {
    const lookup = await ipconfig(device, 'router');
    if (lookup.value === null) return lookup;
    const gateway = normalizeHostAddress(lookup.value);
    if (gateway.ok) return { value: gateway.value, failed: false };
    logger.warn('ipconfig returned an unusable gateway', {
      device,
      value: describeInput(lookup.value),
      reason: gateway.error.code,
    });
    return FAILED;
  };

  const lookupSubnet = async (
    device: string,
    ip: string,
  ): Promise<{ netmask: string | null; subnet: string | null; failed: boolean }> => {
    const lookup = await ipconfig(device, 'subnet_mask');
    if (lookup.value === null) return { netmask: null, subnet: null, failed: lookup.failed };
    const prefix = netmaskToPrefix(lookup.value);
    const subnet = prefix === null ? null : (parseIpv4Destination(`${ip}/${String(prefix)}`)?.cidr ?? null);
    const netmask = normalizeIpv4(lookup.value);
    if (subnet === null || !netmask.ok) {
      logger.warn('ipconfig returned an unusable subnet mask', { device, value: describeInput(lookup.value) });
      return { netmask: null, subnet: null, failed: true };
    }
    return { netmask: netmask.value, subnet, failed: false };
  };

  const listHardwarePorts = async (): Promise<HardwarePort[] | null> => {
    const result = await run(ALLOWED_BINARIES.networksetup, ['-listallhardwareports']);
    if (result === null) return null;
    if (!result.ok) {
      logger.warn('could not list hardware ports', { failure: result.failure, exitCode: result.exitCode });
      return null;
    }
    const ports = parseHardwarePorts(result.stdout);
    if (ports.length === 0) {
      logger.warn('no hardware port found in networksetup output', { outputLength: result.stdout.length });
      return null;
    }
    return ports;
  };

  /** Overrides first: ethernet, then wifi; a device already claimed is refused to the second role. */
  const resolveOverride = (
    role: IfaceRole,
    raw: unknown,
    enPorts: ReadonlyMap<string, EnPort>,
    claimed: string | null,
  ): RoleChoice | null => {
    if (raw === undefined) return null;
    if (!isDeviceName(raw)) {
      logger.warn('interface override is not a device name', { role, value: describeInput(raw) });
      return { device: null, port: null, overridden: true, reason: 'invalid-override' };
    }
    const port = enPorts.get(raw)?.port ?? null;
    if (raw === claimed) {
      logger.warn('both roles are overridden to the same device', { role, device: raw });
      return { device: raw, port, overridden: true, reason: 'override-conflict' };
    }
    if (port === null) {
      logger.warn('overridden device is not a hardware port', { role, device: raw });
      return { device: raw, port: null, overridden: true, reason: 'override-not-found' };
    }
    return { device: raw, port, overridden: true, reason: null };
  };

  const describeRole = async (
    role: IfaceRole,
    choice: RoleChoice,
    addresses: ReadonlyMap<string, Lookup>,
  ): Promise<{ info: InterfaceInfo; degraded: boolean }> => {
    if (choice.reason !== null || choice.device === null) {
      return { info: down(role, choice, choice.reason ?? 'no-device'), degraded: false };
    }
    const { device } = choice;
    const address = addresses.get(device) ?? FAILED;
    if (address.value === null) {
      const reason = address.failed ? 'address-lookup-failed' : 'no-address';
      return { info: down(role, choice, reason), degraded: address.failed };
    }
    const ip = address.value;
    const [gateway, subnet] = await Promise.all([lookupGateway(device), lookupSubnet(device, ip)]);
    const noGatewayReason = gateway.failed ? 'gateway-lookup-failed' : 'no-gateway';
    return {
      info: {
        role,
        device,
        port: choice.port,
        ip,
        gateway: gateway.value,
        netmask: subnet.netmask,
        subnet: subnet.subnet,
        up: true,
        routable: gateway.value !== null,
        reason: gateway.value === null ? noGatewayReason : null,
        overridden: choice.overridden,
      },
      degraded: gateway.failed || subnet.failed,
    };
  };

  const detect = async (overrides: unknown): Promise<DetectedInterfaces> => {
    const ports = await listHardwarePorts();
    if (ports === null) {
      return {
        ethernet: down('ethernet', NOTHING, 'hardware-ports-unavailable'),
        wifi: down('wifi', NOTHING, 'hardware-ports-unavailable'),
        adapters: [],
        degraded: true,
      };
    }

    // Only `en<digits>` devices are ever considered; anything else in the
    // listing (bridge0, a garbled name) is dropped here.
    const enPorts = new Map<string, EnPort>();
    for (const { port, device } of ports) {
      if (isDeviceName(device)) {
        enPorts.set(device, { device, port, isWifi: port.toLowerCase() === WIFI_PORT_NAME });
      }
    }
    const listed = [...enPorts.values()].slice(0, PROTOCOL_LIMITS.maxAdapters);
    if (enPorts.size > listed.length) {
      logger.warn('more en* hardware ports than can be reported; the rest are ignored', {
        ports: enPorts.size,
        limit: PROTOCOL_LIMITS.maxAdapters,
      });
    }

    const ethernetOverride = resolveOverride('ethernet', overrideOf(overrides, 'ethernet'), enPorts, null);
    const wifiOverride = resolveOverride(
      'wifi',
      overrideOf(overrides, 'wifi'),
      enPorts,
      ethernetOverride?.device ?? null,
    );

    // One address query per listed port (the adapters list needs them all),
    // plus an overridden device that fell outside the listed ones.
    const toProbe = new Set(listed.map((port) => port.device));
    for (const override of [ethernetOverride, wifiOverride]) {
      if (override !== null && override.reason === null && override.device !== null) toProbe.add(override.device);
    }
    const addresses = new Map<string, Lookup>(
      await Promise.all([...toProbe].map(async (device) => [device, await lookupAddress(device)] as const)),
    );

    const pickWifi = (): RoleChoice => {
      const port = listed.find((candidate) => candidate.isWifi);
      if (port === undefined) return { ...NOTHING, reason: 'no-device' };
      if (port.device === ethernetOverride?.device) return { ...NOTHING, reason: 'override-conflict' };
      return { device: port.device, port: port.port, overridden: false, reason: null };
    };
    const wifiChoice = wifiOverride ?? pickWifi();

    const pickEthernet = (): RoleChoice => {
      const candidates = listed.filter((port) => !port.isWifi && port.device !== wifiChoice.device);
      if (candidates.length === 0) return { ...NOTHING, reason: 'no-device' };
      const port = candidates.find((candidate) => (addresses.get(candidate.device)?.value ?? null) !== null);
      if (port === undefined) return { ...NOTHING, reason: 'no-address' };
      return { device: port.device, port: port.port, overridden: false, reason: null };
    };
    const ethernetChoice = ethernetOverride ?? pickEthernet();

    const [ethernet, wifi] = await Promise.all([
      describeRole('ethernet', ethernetChoice, addresses),
      describeRole('wifi', wifiChoice, addresses),
    ]);

    return {
      ethernet: ethernet.info,
      wifi: wifi.info,
      adapters: listed.map((port) => ({
        device: port.device,
        port: port.port.slice(0, PROTOCOL_LIMITS.adapterPortMaxLength),
        ip: addresses.get(port.device)?.value ?? null,
      })),
      degraded: ethernet.degraded || wifi.degraded || [...addresses.values()].some((lookup) => lookup.failed),
    };
  };

  const summaryOf = ({ device, ip, gateway, subnet, reason }: InterfaceInfo) => ({ device, ip, gateway, subnet, reason });

  /**
   * One line per actual detection: `info` when the outcome differs from the
   * previous detection of this instance (or is the first), `debug` when it is
   * the same — the 60 s drift check would otherwise repeat it forever.
   */
  const logSummary = (result: DetectedInterfaces, durationMs: number): void => {
    const context = {
      ethernet: summaryOf(result.ethernet),
      wifi: summaryOf(result.wifi),
      adapters: result.adapters.length,
      degraded: result.degraded,
    };
    const summary = JSON.stringify(context);
    logger.log(summary === lastSummary ? 'debug' : 'info', 'interfaces detected', { ...context, durationMs });
    lastSummary = summary;
  };

  const detectAndLog = async (overrides: unknown): Promise<DetectedInterfaces> => {
    const startedAt = now();
    let result: DetectedInterfaces;
    try {
      result = await detect(overrides);
    } catch (error) {
      // Nothing above is expected to throw; a daemon must still get an answer.
      logger.error('interface detection failed', { error: describeThrown(error) });
      result = {
        ethernet: down('ethernet', NOTHING, 'hardware-ports-unavailable'),
        wifi: down('wifi', NOTHING, 'hardware-ports-unavailable'),
        adapters: [],
        degraded: true,
      };
    }
    logSummary(result, Math.max(0, Math.round(now() - startedAt)));
    return freezeResult(result);
  };

  const detectInterfaces = (options: DetectOptions = {}): Promise<DetectedInterfaces> => {
    const overrides: unknown = options.overrides;
    const key = overridesKey(overrides);

    if (options.force !== true && cache !== null && cache.key === key) {
      const age = now() - cache.at;
      // A negative age means the clock went backwards: do not trust the entry.
      if (age >= 0 && age < NETINFO_CACHE_TTL_MS) return Promise.resolve(cache.value);
    }
    if (inFlight !== null && inFlight.key === key && inFlight.generation === generation) {
      return inFlight.promise;
    }

    const startedIn = generation;
    const promise = detectAndLog(overrides).then((value) => {
      // A result that `invalidate()` overtook is returned to its callers but not kept.
      if (startedIn === generation) cache = { key, at: now(), value };
      if (inFlight?.promise === promise) inFlight = null;
      return value;
    });
    inFlight = { key, generation, promise };
    return promise;
  };

  const invalidate = (): void => {
    generation += 1;
    cache = null;
  };

  return { detectInterfaces, invalidate };
};
