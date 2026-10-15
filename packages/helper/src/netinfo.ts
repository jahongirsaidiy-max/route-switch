import {
  cidrContains,
  DEVICE_NAME,
  IPV4_BITS,
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
 * through it?". Read-only: it runs `networksetup -listallhardwareports`,
 * `ipconfig getifaddr|getoption`, only when the DHCP lease has no router or
 * no subnet mask for a role `netstat -rn -f inet` (once per detection), and
 * only when the caller asks for DNS servers `scutil --dns` (once per detection).
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
 * Where gateway and connected subnet come from:
 * - First the DHCP lease: `ipconfig getoption <dev> router|subnet_mask`.
 * - `ipconfig getoption` only reads the lease, so an interface with a manually
 *   configured (static) address has neither. When an option has no value (not
 *   when its query failed), the routing table is the fallback: the gateway is
 *   the one of the device's `default` row, the connected subnet is the
 *   device's `link#N` network row that contains the interface address.
 * - Nothing read from the routing table is ever put into an argv.
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

const WIFI_PORT_NAME = 'wi-fi';
const LOGGED_INPUT_LIMIT = 64;

const PORT_KEY = 'Hardware Port:';
const DEVICE_KEY = 'Device:';
/** Heading of the section after the port list; its blocks are not hardware ports. */
const VLAN_SECTION = 'VLAN Configurations';

/** The IPv4 routing table, numeric: the fallback source for gateway and connected subnet. */
const NETSTAT_ROUTES_ARGS: readonly string[] = ['-rn', '-f', 'inet'];
/** Title line of the IPv4 section of `netstat -rn`. */
const NETSTAT_INET_SECTION = 'Internet:';
/** First cell of the column header line; also the name of the destination column. */
const NETSTAT_DESTINATION_COLUMN = 'Destination';
const NETSTAT_GATEWAY_COLUMN = 'Gateway';
const NETSTAT_FLAGS_COLUMN = 'Flags';
const NETSTAT_NETIF_COLUMN = 'Netif';
const NETSTAT_DEFAULT_DESTINATION = 'default';
/** Gateway cell of a directly connected route: `link#<interface index>`. */
const NETSTAT_LINK_PREFIX = 'link#';
const NETSTAT_LINK_INDEX_MAX_DIGITS = 10;
/** `RTF_IFSCOPE`: the route applies only to traffic bound to its interface. */
const NETSTAT_SCOPED_FLAG = 'I';
/**
 * Bounds on the work done for one table. A real row is under 100 characters
 * and a table that fits the runner's output limit has far fewer lines than
 * this; a longer line is skipped, a longer output is not trusted at all.
 */
export const NETSTAT_MAX_LINE_LENGTH = 512;
export const NETSTAT_MAX_LINES = 20_000;
const OCTET_MAX = 255;
const OCTET_MAX_DIGITS = 3;
const PREFIX_MAX_DIGITS = 2;
const BITS_PER_OCTET = 8;
/** Highest first octet of class A, B and C: the networks `netstat` prints without a prefix. */
const CLASS_A_MAX = 127;
const CLASS_B_MAX = 191;
const CLASS_C_MAX = 223;

/** The DNS configuration of the system resolver: every resolver, its servers and its interface. */
const SCUTIL_DNS_ARGS: readonly string[] = ['--dns'];
/** Title of a section of `scutil --dns`; the scoped one is `DNS configuration (for scoped queries)`. */
const SCUTIL_SECTION_TITLE = 'DNS configuration';
const SCUTIL_SCOPED_SECTION_TITLE = 'DNS configuration (for scoped queries)';
/** What `scutil --dns` prints when the system has no DNS configuration at all. */
const SCUTIL_NO_CONFIGURATION = 'No DNS configuration available';
const SCUTIL_RESOLVER_PREFIX = 'resolver #';
const SCUTIL_DOMAIN_KEY = 'domain';
const SCUTIL_IF_INDEX_KEY = 'if_index';
const SCUTIL_NAMESERVER_PREFIX = 'nameserver[';
const SCUTIL_INDEX_MAX_DIGITS = 10;
/** Prefix of an IPv4-mapped IPv6 address, compared in lower case. */
const IPV4_MAPPED_PREFIX = '::ffff:';
/**
 * Bounds on one `scutil --dns` output. A real one has a few dozen lines and
 * resolvers with one to three servers; output beyond these is not trusted at
 * all (the result is "not known"), because dropping part of it would drop DNS
 * servers from the list of addresses that are never routed.
 */
export const SCUTIL_MAX_LINES = 4096;
export const SCUTIL_MAX_LINE_LENGTH = 512;
export const SCUTIL_MAX_RESOLVERS = 128;
/** `nameserver[n]` with `n` below this. */
export const SCUTIL_MAX_NAMESERVERS_PER_RESOLVER = 16;
/** DNS servers reported for one role, in the order they are asked. */
export const MAX_DNS_SERVERS_PER_ROLE = 8;
/** DNS servers reported besides those of the two roles. */
export const MAX_OTHER_DNS_SERVERS = 32;

/**
 * Why a role cannot be used for routing; `null` on a usable role.
 * - `hardware-ports-unavailable` — `networksetup` failed or listed no port.
 * - `no-device` — no port can play the role (no Wi-Fi port; no `en*` port
 *   other than Wi-Fi).
 * - `invalid-override` — the override is not an `en<digits>` name, or the
 *   options passed to `detectInterfaces` could not be read at all.
 * - `override-not-found` — the overridden device is not a hardware port now.
 * - `override-conflict` — the device belongs to the other role's override.
 * - `no-address` — the device (or, for the Ethernet heuristic, every
 *   candidate) has no IPv4 address: cable unplugged, Wi-Fi not associated.
 * - `address-lookup-failed` — the address query itself failed.
 * - `no-gateway` — an address, but neither a router in the DHCP lease nor a
 *   `default` route through the device in the routing table.
 * - `gateway-lookup-failed` — the router query (or, for the fallback, reading
 *   the routing table) failed or returned something that is not a usable IPv4
 *   address.
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
  /** Next hop for routes through this role: the DHCP router, else the device's default route. */
  readonly gateway: string | null;
  /** Dotted subnet mask, e.g. `255.255.255.0`; `null` when unknown or not contiguous. */
  readonly netmask: string | null;
  /**
   * Connected subnet in canonical CIDR form, e.g. `192.168.1.0/24`: from the
   * DHCP mask, else from the routing table. `null` when neither gives one.
   */
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
  /**
   * Only when the detection was asked for it (`DetectOptions.dns`): the DNS
   * servers of each role's interface, as usable IPv4 addresses, in the order
   * the system asks them (the first answers, the next ones are the failover).
   * They come from `scutil --dns`: the resolvers scoped to the role's device
   * (`if_index : <n> (<device>)`) that are not for one domain only — so a
   * second server of the lease and servers set by hand in the network
   * settings are included. At most `MAX_DNS_SERVERS_PER_ROLE`.
   * Empty: the role has no address, or no resolver of its device has a
   * server. `null`: the DNS configuration could not be read or was not
   * understood, so nothing is known.
   * Internal like `subnet`: it is not part of the wire `InterfaceState`.
   *
   * A failed lookup does not make the detection `degraded`: these servers are
   * not used to decide about any route, only about whom to ask for a name
   * and which answers never to route, and rules that name their destination
   * must not wait for them.
   */
  readonly dnsServers?: Readonly<Record<IfaceRole, readonly string[] | null>>;
  /**
   * Present exactly when `dnsServers` is: every other DNS server of the
   * system's DNS configuration — the resolvers for one domain only
   * (supplemental: a VPN, `/etc/resolver/<domain>`), those of interfaces that
   * play no role, and the default ones not scoped to a role's device. Never
   * asked by the helper; only kept out of answers. At most
   * `MAX_OTHER_DNS_SERVERS`; `null` exactly when the roles' lists are.
   */
  readonly otherDnsServers?: readonly string[] | null;
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
  /**
   * Also report the DNS servers of the system (one `scutil --dns` per
   * detection). Off by default, so a caller that has no use for them runs
   * exactly the commands it ran before.
   */
  readonly dns?: boolean | undefined;
}

export interface NetInfo {
  /**
   * Never rejects and never throws, whatever it is given: options that cannot
   * be read give a result with both roles down (`invalid-override`) and
   * `degraded` set. Results are cached for `NETINFO_CACHE_TTL_MS` per set of
   * overrides (and per `dns` flag).
   */
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

/** `en` + 1..14 digits: the one pattern shared with the config and wire schemas. */
const isDeviceName = (value: unknown): value is string => typeof value === 'string' && DEVICE_NAME.test(value);

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

/** A non-negative decimal number of at most `maxDigits` digits without a sign or leading zero. */
const parseDecimal = (text: string, maxDigits: number): number | null => {
  if (text.length === 0 || text.length > maxDigits) return null;
  if (text.length > 1 && text.startsWith('0')) return null;
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const digit = text.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return null;
    value = value * 10 + digit;
  }
  return value;
};

/** Dotted mask of a prefix length 0..32. */
const prefixToNetmask = (prefix: number): string => {
  const bits = prefix === 0 ? 0 : (-1 << (IPV4_BITS - prefix)) >>> 0;
  return [bits >>> 24, (bits >>> 16) & OCTET_MAX, (bits >>> 8) & OCTET_MAX, bits & OCTET_MAX].join('.');
};

/** Prefix `netstat` leaves out: the classful one of the first octet. `null` outside classes A..C. */
const naturalPrefix = (firstOctet: number): number | null => {
  if (firstOctet < 1 || firstOctet > CLASS_C_MAX) return null;
  if (firstOctet <= CLASS_A_MAX) return BITS_PER_OCTET;
  return firstOctet <= CLASS_B_MAX ? 2 * BITS_PER_OCTET : 3 * BITS_PER_OCTET;
};

/**
 * Expands a network destination as `netstat -rn` prints it into canonical
 * CIDR form, or `null` when it is not an unambiguous network.
 *
 * macOS drops trailing zero octets, and drops the prefix when it is the
 * classful one of the address:
 * - with a prefix, 1..4 octets are padded with zeros: `172.16/12` ->
 *   `172.16.0.0/12`, `10.20.4/22` -> `10.20.4.0/22`, `192.168.1.64/26` as is;
 * - without one, the octets must be exactly the network part of the class:
 *   `10` -> `10.0.0.0/8`, `172.20` -> `172.20.0.0/16`, `192.168.1` ->
 *   `192.168.1.0/24`. Anything else without a prefix is refused instead of
 *   guessed: four octets are a host route, and `10.20.4` or `192.168` is not
 *   something `netstat` prints for a network.
 *
 * Refused as well: octets that are not plain decimals 0..255, a destination
 * whose host bits are set for its prefix, the non-contiguous `&0x…` form,
 * `default` and everything that is not IPv4.
 */
export const expandNetstatDestination = (destination: string): string | null => {
  if (destination.length > NETSTAT_MAX_LINE_LENGTH) return null;
  const parts = destination.split('/');
  const [addressPart, prefixPart] = parts;
  if (parts.length > 2 || addressPart === undefined) return null;

  const cells = addressPart.split('.');
  if (cells.length > 4) return null;
  const octets: number[] = [];
  for (const cell of cells) {
    const octet = parseDecimal(cell, OCTET_MAX_DIGITS);
    if (octet === null || octet > OCTET_MAX) return null;
    octets.push(octet);
  }

  let prefix: number | null;
  if (prefixPart === undefined) {
    prefix = naturalPrefix(octets[0] ?? 0);
    if (prefix === null || prefix !== octets.length * BITS_PER_OCTET) return null;
  } else {
    prefix = parseDecimal(prefixPart, PREFIX_MAX_DIGITS);
    if (prefix === null || prefix > IPV4_BITS) return null;
  }

  while (octets.length < 4) octets.push(0);
  const address = octets.join('.');
  const parsed = parseIpv4Destination(`${address}/${String(prefix)}`);
  return parsed !== null && parsed.address === address ? parsed.cidr : null;
};

/** One row of the IPv4 routing table that belongs to an `en<digits>` device. */
export interface RoutingTableRow {
  /** First column as printed: `default`, `192.168.1`, `10.20.4/22`. Not validated. */
  readonly destination: string;
  /** Gateway column as printed: an address, or `link#<n>`. Not validated. */
  readonly gateway: string;
  /** Flags column as printed, e.g. `UGScIg`. */
  readonly flags: string;
  /** Interface column; always matches `DEVICE_NAME`. */
  readonly device: string;
}

/** The rows of `netstat -rn -f inet` that netinfo can use, in table order. */
export interface RoutingTable {
  /** `default` rows. */
  readonly defaults: readonly RoutingTableRow[];
  /** Rows whose gateway is `link#<n>`: directly connected destinations. */
  readonly connected: readonly RoutingTableRow[];
}

/** Whitespace-separated cells of one line; spaces, tabs and a stray CR all separate. */
const splitCells = (line: string): string[] => {
  const cells: string[] = [];
  for (const part of line.replaceAll('\t', ' ').split(' ')) {
    const cell = part.trim();
    if (cell !== '') cells.push(cell);
  }
  return cells;
};

const isLinkGateway = (gateway: string): boolean =>
  gateway.startsWith(NETSTAT_LINK_PREFIX) &&
  parseDecimal(gateway.slice(NETSTAT_LINK_PREFIX.length), NETSTAT_LINK_INDEX_MAX_DIGITS) !== null;

/**
 * Parses `netstat -rn -f inet` (the wide `-l` form works too):
 *
 *     Routing tables
 *
 *     Internet:
 *     Destination        Gateway            Flags               Netif Expire
 *     default            192.168.1.1        UGScg                 en0
 *     default            10.20.4.1          UGScIg                en5
 *     192.168.1          link#15            UCS                   en0      !
 *
 * Lines are split into cells and trimmed, never pattern-matched. Rows are read
 * only inside the `Internet:` section and only after its column header, which
 * also says where the gateway, flags and interface cells are — so a missing
 * `Expire` column or extra columns do not matter. Kept are the `default` rows
 * and the `link#<n>` rows of devices named `en<digits>`; everything else (host
 * routes through a gateway, other sections, other interfaces, short or
 * over-long lines) is skipped.
 *
 * Returns `null` when the output cannot be trusted: no IPv4 section with a
 * column header, or more than `NETSTAT_MAX_LINES` lines.
 */
export const parseRoutingTable = (stdout: string): RoutingTable | null => {
  const defaults: RoutingTableRow[] = [];
  const connected: RoutingTableRow[] = [];
  let inInet = false;
  let columns: { gateway: number; flags: number; netif: number } | null = null;
  let sawHeader = false;
  let lines = 0;

  for (const raw of stdout.split('\n')) {
    lines += 1;
    if (lines > NETSTAT_MAX_LINES) return null;
    if (raw.length > NETSTAT_MAX_LINE_LENGTH) continue;
    const cells = splitCells(raw);
    const [first] = cells;
    if (first === undefined) continue;

    if (cells.length === 1 && first.endsWith(':')) {
      inInet = first === NETSTAT_INET_SECTION;
      columns = null;
      continue;
    }
    if (first === NETSTAT_DESTINATION_COLUMN) {
      const gateway = cells.indexOf(NETSTAT_GATEWAY_COLUMN);
      const flags = cells.indexOf(NETSTAT_FLAGS_COLUMN);
      const netif = cells.indexOf(NETSTAT_NETIF_COLUMN);
      columns = inInet && gateway > 0 && flags > 0 && netif > 0 ? { gateway, flags, netif } : null;
      sawHeader ||= columns !== null;
      continue;
    }
    if (!inInet || columns === null) continue;

    const gateway = cells[columns.gateway];
    const flags = cells[columns.flags];
    const device = cells[columns.netif];
    if (gateway === undefined || flags === undefined || !isDeviceName(device)) continue;
    const row: RoutingTableRow = { destination: first, gateway, flags, device };
    if (first === NETSTAT_DEFAULT_DESTINATION) defaults.push(row);
    else if (isLinkGateway(gateway)) connected.push(row);
  }
  return sawHeader ? { defaults, connected } : null;
};

/** One `resolver #<n>` block of `scutil --dns`. Nothing in it is validated beyond its shape. */
export interface DnsResolverEntry {
  /** The block is in the `DNS configuration (for scoped queries)` section. */
  readonly scoped: boolean;
  /** `domain` of a resolver for one domain only (supplemental); `null` for a default resolver. */
  readonly domain: string | null;
  /** Interface name of `if_index : <n> (<name>)` as printed (`en0`, `utun3`); `null` without the line. */
  readonly interfaceName: string | null;
  /** The `nameserver[<n>]` values as printed, in index order; IPv6 ones too. */
  readonly nameservers: readonly string[];
}

interface ResolverDraft {
  readonly scoped: boolean;
  domain: string | null;
  interfaceName: string | null;
  sawIfIndex: boolean;
  readonly nameservers: Map<number, string>;
}

/** `<digits> (<name>)` of an `if_index` line; `null` for anything else. */
const parseIfIndex = (value: string): string | null => {
  const cells = splitCells(value);
  const [index, wrapped] = cells;
  if (cells.length !== 2 || index === undefined || wrapped === undefined) return null;
  if (parseDecimal(index, SCUTIL_INDEX_MAX_DIGITS) === null) return null;
  if (wrapped.length < 3 || !wrapped.startsWith('(') || !wrapped.endsWith(')')) return null;
  const name = wrapped.slice(1, -1);
  return name.includes('(') || name.includes(')') ? null : name;
};

/**
 * Parses `scutil --dns`:
 *
 *     DNS configuration
 *
 *     resolver #1
 *       search domain[0] : corp.local
 *       nameserver[0] : 10.20.0.10
 *       nameserver[1] : 10.20.0.11
 *       if_index : 15 (en0)
 *       flags    : Request A records
 *
 *     resolver #2
 *       domain   : corp.local
 *       nameserver[0] : 10.30.0.53
 *
 *     DNS configuration (for scoped queries)
 *
 *     resolver #1
 *       nameserver[0] : 10.20.0.10
 *       if_index : 15 (en0)
 *       flags    : Scoped, Request A records
 *
 * Lines are split at the first colon and trimmed, never pattern-matched.
 * Keys other than `domain`, `if_index` and `nameserver[<n>]` are skipped.
 * `No DNS configuration available` as the only non-blank line is an empty
 * list; next to anything else it is ambiguous.
 *
 * Returns `null` when the output is ambiguous, rather than a part of it:
 * no section title first; a line outside a resolver block that is neither a
 * section title nor `resolver #<n>`; a key line without a colon; a `domain`
 * or `if_index` given twice in one block; an `if_index` value that is not
 * `<n> (<name>)`; a `nameserver[<n>]` index that is not a plain decimal below
 * `SCUTIL_MAX_NAMESERVERS_PER_RESOLVER` or that repeats; more than
 * `SCUTIL_MAX_RESOLVERS` blocks, `SCUTIL_MAX_LINES` lines or a line over
 * `SCUTIL_MAX_LINE_LENGTH` characters.
 */
export const parseDnsConfiguration = (stdout: string): DnsResolverEntry[] | null => {
  const lines = stdout.split('\n');
  if (lines.length > SCUTIL_MAX_LINES) return null;
  const resolvers: DnsResolverEntry[] = [];
  let section: { readonly scoped: boolean } | null = null;
  let current: ResolverDraft | null = null;
  /** `No DNS configuration available` was read: it must stay the only non-blank line. */
  let noConfiguration = false;

  const finish = (): boolean => {
    if (current !== null) {
      if (resolvers.length >= SCUTIL_MAX_RESOLVERS) return false;
      resolvers.push({
        scoped: current.scoped,
        domain: current.domain,
        interfaceName: current.interfaceName,
        nameservers: [...current.nameservers].sort(([a], [b]) => a - b).map(([, server]) => server),
      });
    }
    current = null;
    return true;
  };

  for (const raw of lines) {
    if (raw.length > SCUTIL_MAX_LINE_LENGTH) return null;
    const line = raw.trim();
    if (line === '') {
      if (!finish()) return null;
      continue;
    }
    // Anything else next to "no configuration" is ambiguous: which of the two is true?
    if (noConfiguration) return null;
    if (line === SCUTIL_NO_CONFIGURATION) {
      if (section !== null) return null;
      noConfiguration = true;
      continue;
    }
    const indented = raw.startsWith(' ') || raw.startsWith('\t');

    if (!indented) {
      if (!finish()) return null;
      if (line === SCUTIL_SECTION_TITLE || line === SCUTIL_SCOPED_SECTION_TITLE) {
        section = { scoped: line === SCUTIL_SCOPED_SECTION_TITLE };
        continue;
      }
      if (section === null || !line.startsWith(SCUTIL_RESOLVER_PREFIX)) return null;
      if (parseDecimal(line.slice(SCUTIL_RESOLVER_PREFIX.length), SCUTIL_INDEX_MAX_DIGITS) === null) return null;
      current = { scoped: section.scoped, domain: null, interfaceName: null, sawIfIndex: false, nameservers: new Map() };
      continue;
    }

    const block: ResolverDraft | null = current;
    if (block === null) return null;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (key === SCUTIL_DOMAIN_KEY) {
      if (block.domain !== null || value === '') return null;
      block.domain = value;
    } else if (key === SCUTIL_IF_INDEX_KEY) {
      const name = block.sawIfIndex ? null : parseIfIndex(value);
      if (name === null) return null;
      block.sawIfIndex = true;
      block.interfaceName = name;
    } else if (key.startsWith(SCUTIL_NAMESERVER_PREFIX) && key.endsWith(']')) {
      const index = parseDecimal(key.slice(SCUTIL_NAMESERVER_PREFIX.length, -1), SCUTIL_INDEX_MAX_DIGITS);
      if (index === null || index >= SCUTIL_MAX_NAMESERVERS_PER_RESOLVER || block.nameservers.has(index)) return null;
      if (value === '') return null;
      block.nameservers.set(index, value);
    }
  }
  if (!finish()) return null;
  if (noConfiguration) return [];
  return section === null ? null : resolvers;
};

/** The DNS servers of a detection, by role and the rest; see `DetectedInterfaces.dnsServers`. */
export interface DnsServerReport {
  readonly ethernet: readonly string[];
  readonly wifi: readonly string[];
  readonly other: readonly string[];
  /** Values that are not usable IPv4 server addresses, as printed; IPv6 values are not listed. */
  readonly ignored: readonly string[];
}

/**
 * Splits the servers of a parsed DNS configuration by the devices of the
 * roles (`null` for a role without an address). A role gets the servers of
 * the default resolvers of its device, scoped ones first, in index order; a
 * supplemental resolver (with `domain`) is never a role's. Every other usable
 * server is in `other`. A value is usable when it is an IPv4 address that may
 * be a destination (`normalizeHostAddress`): a loopback server (a local DNS
 * proxy) could never be routed anyway. IPv6 values are skipped, except an
 * IPv4-mapped one (`::ffff:a.b.c.d`), which is that IPv4 address.
 *
 * `null` when a list would exceed its bound: a part of them cannot be dropped
 * without dropping it from the addresses that are never routed.
 */
export const dnsServersOf = (
  resolvers: readonly DnsResolverEntry[],
  devices: Readonly<Record<IfaceRole, string | null>>,
): DnsServerReport | null => {
  const ignored: string[] = [];
  const usable = (text: string): string | null => {
    // An IPv4-mapped IPv6 server (`::ffff:a.b.c.d`) is that IPv4 server; any other IPv6 one is skipped.
    const value = text.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) ? text.slice(IPV4_MAPPED_PREFIX.length) : text;
    if (value.includes(':')) return null;
    const server = normalizeHostAddress(value);
    if (server.ok) return server.value;
    if (!ignored.includes(text) && ignored.length < MAX_OTHER_DNS_SERVERS) ignored.push(text);
    return null;
  };
  const ordered = [...resolvers.filter((entry) => entry.scoped), ...resolvers.filter((entry) => !entry.scoped)];
  const forRole = (device: string | null): string[] | null => {
    const servers: string[] = [];
    if (device === null) return servers;
    for (const entry of ordered) {
      if (entry.domain !== null || entry.interfaceName !== device) continue;
      for (const value of entry.nameservers) {
        const server = usable(value);
        if (server === null || servers.includes(server)) continue;
        if (servers.length >= MAX_DNS_SERVERS_PER_ROLE) return null;
        servers.push(server);
      }
    }
    return servers;
  };
  const ethernet = forRole(devices.ethernet);
  const wifi = forRole(devices.wifi);
  if (ethernet === null || wifi === null) return null;
  const other: string[] = [];
  for (const entry of resolvers) {
    for (const value of entry.nameservers) {
      const server = usable(value);
      if (server === null || ethernet.includes(server) || wifi.includes(server) || other.includes(server)) continue;
      if (other.length >= MAX_OTHER_DNS_SERVERS) return null;
      other.push(server);
    }
  }
  return { ethernet, wifi, other, ignored };
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

/** An own property of an object; inherited ones are ignored, so a polluted prototype injects nothing. */
const ownProperty = (source: unknown, key: string): unknown =>
  typeof source === 'object' && source !== null && Object.hasOwn(source, key)
    ? (source as Readonly<Record<string, unknown>>)[key]
    : undefined;

const overrideOf = (overrides: unknown, role: IfaceRole): unknown => ownProperty(overrides, role);

/** What one call asks for, read once from the caller's objects (their getters run here and nowhere else). */
interface DetectRequest {
  readonly overrides: { readonly ethernet: unknown; readonly wifi: unknown };
  readonly force: boolean;
  readonly dns: boolean;
}

/** Throws when `options` is neither `undefined` nor an object, or when reading it throws. */
const readRequest = (options: unknown): DetectRequest => {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError(`detection options must be an object, got ${options === null ? 'null' : typeof options}`);
  }
  const overrides = ownProperty(options, 'overrides');
  return {
    overrides: { ethernet: overrideOf(overrides, 'ethernet'), wifi: overrideOf(overrides, 'wifi') },
    force: ownProperty(options, 'force') === true,
    dns: ownProperty(options, 'dns') === true,
  };
};

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

/** Where a role's gateway or subnet came from; `null` when there is none. Logged, not returned. */
type ValueSource = 'dhcp' | 'routing-table' | null;

interface SubnetLookup {
  readonly netmask: string | null;
  readonly subnet: string | null;
  readonly failed: boolean;
}

interface RoleSources {
  readonly gateway: ValueSource;
  readonly subnet: ValueSource;
}

const NO_SOURCES: RoleSources = { gateway: null, subnet: null };

/** A detection result plus what is only logged about it. */
interface Detection {
  readonly result: DetectedInterfaces;
  readonly sources: { readonly ethernet: RoleSources; readonly wifi: RoleSources };
}

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

/** Both roles down for one reason, nothing listed: the answer when detection itself could not run. */
const unavailable = (reason: InterfaceDownReason): Detection => ({
  result: {
    ethernet: down('ethernet', NOTHING, reason),
    wifi: down('wifi', NOTHING, reason),
    adapters: [],
    degraded: true,
  },
  sources: { ethernet: NO_SOURCES, wifi: NO_SOURCES },
});

const freezeResult = (result: DetectedInterfaces): DetectedInterfaces => {
  for (const adapter of result.adapters) Object.freeze(adapter);
  Object.freeze(result.adapters);
  Object.freeze(result.ethernet);
  Object.freeze(result.wifi);
  if (result.dnsServers !== undefined) {
    if (result.dnsServers.ethernet !== null) Object.freeze(result.dnsServers.ethernet);
    if (result.dnsServers.wifi !== null) Object.freeze(result.dnsServers.wifi);
    Object.freeze(result.dnsServers);
  }
  if (result.otherDnsServers !== undefined && result.otherDnsServers !== null) Object.freeze(result.otherDnsServers);
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
  let lastIgnoredDns: string | null = null;

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

  const lookupSubnet = async (device: string, ip: string): Promise<SubnetLookup> => {
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

  /**
   * The system's DNS configuration, split by the devices of the roles. `null`
   * when it could not be read or was not understood: then nothing is known
   * about any server, which is not the same as "no server".
   */
  const lookupDnsServers = async (devices: Readonly<Record<IfaceRole, string | null>>): Promise<DnsServerReport | null> => {
    const result = await run(ALLOWED_BINARIES.scutil, SCUTIL_DNS_ARGS);
    if (result === null) return null;
    if (!result.ok) {
      logger.warn('could not read the DNS configuration', { failure: result.failure, exitCode: result.exitCode });
      return null;
    }
    const resolvers = parseDnsConfiguration(result.stdout);
    if (resolvers === null) {
      logger.warn('unexpected output from scutil --dns', { outputLength: result.stdout.length });
      return null;
    }
    const report = dnsServersOf(resolvers, devices);
    if (report === null) {
      logger.warn('the DNS configuration lists more DNS servers than can be used', {
        perRole: MAX_DNS_SERVERS_PER_ROLE,
        other: MAX_OTHER_DNS_SERVERS,
      });
      return null;
    }
    // A local DNS proxy (127.0.0.1) is an ordinary setup: said once, not on every detection.
    const ignored = JSON.stringify(report.ignored);
    if (report.ignored.length > 0) {
      logger.log(ignored === lastIgnoredDns ? 'debug' : 'warn', 'DNS servers that are not usable addresses are ignored', {
        values: report.ignored.map(describeInput),
      });
    }
    lastIgnoredDns = ignored;
    return report;
  };

  /** `null` when the table could not be read or does not look like one. */
  const loadRoutingTable = async (): Promise<RoutingTable | null> => {
    const result = await run(ALLOWED_BINARIES.netstat, NETSTAT_ROUTES_ARGS);
    if (result === null) return null;
    if (!result.ok) {
      logger.warn('could not read the routing table', { failure: result.failure, exitCode: result.exitCode });
      return null;
    }
    const table = parseRoutingTable(result.stdout);
    if (table === null) {
      logger.warn('unexpected output from netstat', { outputLength: result.stdout.length });
    }
    return table;
  };

  /**
   * Gateway of the device's `default` route. With several such rows the choice
   * is fixed: rows that are not interface-scoped (no `I` flag — the route the
   * system itself uses) before scoped ones, then table order; the first row
   * whose gateway is a usable next hop wins. An on-link default (`link#<n>`)
   * has no next hop and counts as "no gateway"; any other unusable gateway is
   * a failed lookup, as it is for the DHCP router.
   */
  const gatewayFromRoutingTable = (table: RoutingTable | null, device: string): Lookup => {
    if (table === null) return FAILED;
    const rows = table.defaults.filter((row) => row.device === device);
    const ordered = [
      ...rows.filter((row) => !row.flags.includes(NETSTAT_SCOPED_FLAG)),
      ...rows.filter((row) => row.flags.includes(NETSTAT_SCOPED_FLAG)),
    ];
    let unusable: RoutingTableRow | null = null;
    for (const row of ordered) {
      const gateway = normalizeHostAddress(row.gateway);
      if (gateway.ok) {
        logger.debug('gateway taken from the routing table', { device, gateway: gateway.value, candidates: rows.length });
        return { value: gateway.value, failed: false };
      }
      if (!isLinkGateway(row.gateway)) unusable ??= row;
    }
    if (unusable === null) return NO_VALUE;
    logger.warn('the routing table has an unusable default gateway', {
      device,
      value: describeInput(unusable.gateway),
    });
    return FAILED;
  };

  /**
   * Connected subnet of the device: its `link#<n>` network row that contains
   * the interface address. Host rows (`/32`, bare addresses) and `/0` are not
   * subnets; rows for other networks of the device (`169.254`, `224.0.0/4`)
   * do not contain the address. When several rows do, the most specific one
   * is the subnet the address is in. No such row is "unknown", not an error.
   */
  const subnetFromRoutingTable = (table: RoutingTable | null, device: string, ip: string): SubnetLookup => {
    if (table === null) return { netmask: null, subnet: null, failed: true };
    let best: { cidr: string; prefix: number } | null = null;
    for (const row of table.connected) {
      if (row.device !== device) continue;
      const cidr = expandNetstatDestination(row.destination);
      const prefix = cidr === null ? null : (parseIpv4Destination(cidr)?.prefix ?? null);
      if (cidr === null || prefix === null || prefix === 0 || prefix === IPV4_BITS) continue;
      if (!cidrContains(cidr, ip)) continue;
      if (best === null || prefix > best.prefix) best = { cidr, prefix };
    }
    if (best === null) {
      logger.debug('no connected subnet for the address in the routing table', { device });
      return { netmask: null, subnet: null, failed: false };
    }
    logger.debug('connected subnet taken from the routing table', { device, subnet: best.cidr });
    return { netmask: prefixToNetmask(best.prefix), subnet: best.cidr, failed: false };
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
    routingTable: () => Promise<RoutingTable | null>,
  ): Promise<{ info: InterfaceInfo; degraded: boolean; sources: RoleSources }> => {
    if (choice.reason !== null || choice.device === null) {
      return { info: down(role, choice, choice.reason ?? 'no-device'), degraded: false, sources: NO_SOURCES };
    }
    const { device } = choice;
    const address = addresses.get(device) ?? FAILED;
    if (address.value === null) {
      const reason = address.failed ? 'address-lookup-failed' : 'no-address';
      return { info: down(role, choice, reason), degraded: address.failed, sources: NO_SOURCES };
    }
    const ip = address.value;
    const [leaseGateway, leaseSubnet] = await Promise.all([lookupGateway(device), lookupSubnet(device, ip)]);
    // The routing table is consulted only for what the lease does not have. A
    // lease query that failed is not "no value": it stays failed.
    const gatewayMissing = leaseGateway.value === null && !leaseGateway.failed;
    const subnetMissing = leaseSubnet.subnet === null && !leaseSubnet.failed;
    const table = gatewayMissing || subnetMissing ? await routingTable() : null;
    const gateway = gatewayMissing ? gatewayFromRoutingTable(table, device) : leaseGateway;
    const subnet = subnetMissing ? subnetFromRoutingTable(table, device, ip) : leaseSubnet;
    const sourceOf = (present: boolean, fromTable: boolean): ValueSource => {
      if (!present) return null;
      return fromTable ? 'routing-table' : 'dhcp';
    };
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
      sources: {
        gateway: sourceOf(gateway.value !== null, gatewayMissing),
        subnet: sourceOf(subnet.subnet !== null, subnetMissing),
      },
    };
  };

  const detect = async (overrides: DetectRequest['overrides'], wantDns: boolean): Promise<Detection> => {
    const ports = await listHardwarePorts();
    if (ports === null) return unavailable('hardware-ports-unavailable');

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

    // At most one `netstat` per detection, and none when no role needs it.
    let tableLoad: Promise<RoutingTable | null> | null = null;
    const routingTable = (): Promise<RoutingTable | null> => (tableLoad ??= loadRoutingTable());

    // A role's servers are those of its device once it has an address, as `up` means on the wire.
    const dnsDevice = (choice: RoleChoice): string | null =>
      choice.reason === null && choice.device !== null && (addresses.get(choice.device)?.value ?? null) !== null
        ? choice.device
        : null;
    const [ethernet, wifi, dns] = await Promise.all([
      describeRole('ethernet', ethernetChoice, addresses, routingTable),
      describeRole('wifi', wifiChoice, addresses, routingTable),
      wantDns ? lookupDnsServers({ ethernet: dnsDevice(ethernetChoice), wifi: dnsDevice(wifiChoice) }) : null,
    ]);

    return {
      result: {
        ethernet: ethernet.info,
        wifi: wifi.info,
        adapters: listed.map((port) => ({
          device: port.device,
          port: port.port.slice(0, PROTOCOL_LIMITS.adapterPortMaxLength),
          ip: addresses.get(port.device)?.value ?? null,
        })),
        degraded: ethernet.degraded || wifi.degraded || [...addresses.values()].some((lookup) => lookup.failed),
        ...(wantDns
          ? {
              dnsServers: { ethernet: dns?.ethernet ?? null, wifi: dns?.wifi ?? null },
              otherDnsServers: dns?.other ?? null,
            }
          : {}),
      },
      sources: { ethernet: ethernet.sources, wifi: wifi.sources },
    };
  };

  const summaryOf = ({ device, ip, gateway, subnet, reason }: InterfaceInfo, sources: RoleSources) => ({
    device,
    ip,
    gateway,
    subnet,
    reason,
    gatewaySource: sources.gateway,
    subnetSource: sources.subnet,
  });

  /**
   * One line per actual detection: `info` when the outcome differs from the
   * previous detection of this instance (or is the first), `debug` when it is
   * the same — the 60 s drift check would otherwise repeat it forever.
   */
  const logSummary = ({ result, sources }: Detection, durationMs: number): void => {
    const context = {
      ethernet: summaryOf(result.ethernet, sources.ethernet),
      wifi: summaryOf(result.wifi, sources.wifi),
      adapters: result.adapters.length,
      degraded: result.degraded,
      ...(result.dnsServers === undefined ? {} : { dnsServers: result.dnsServers, otherDnsServers: result.otherDnsServers }),
    };
    const summary = JSON.stringify(context);
    logger.log(summary === lastSummary ? 'debug' : 'info', 'interfaces detected', { ...context, durationMs });
    lastSummary = summary;
  };

  const detectAndLog = async (overrides: DetectRequest['overrides'], wantDns: boolean): Promise<DetectedInterfaces> => {
    const startedAt = now();
    let detection: Detection;
    try {
      detection = await detect(overrides, wantDns);
    } catch (error) {
      // Nothing above is expected to throw; a daemon must still get an answer.
      logger.error('interface detection failed', { error: describeThrown(error) });
      detection = unavailable('hardware-ports-unavailable');
    }
    logSummary(detection, Math.max(0, Math.round(now() - startedAt)));
    return freezeResult(detection.result);
  };

  /** The uncached answer to a call that could not be served at all; never a detection result. */
  const refused = (message: string, reason: InterfaceDownReason, error: unknown): DetectedInterfaces => {
    logger.error(message, { error: describeThrown(error) });
    return freezeResult(unavailable(reason).result);
  };

  const start = (options: unknown): Promise<DetectedInterfaces> => {
    let request: DetectRequest;
    try {
      request = readRequest(options);
    } catch (error) {
      return Promise.resolve(refused('detection options could not be read', 'invalid-override', error));
    }
    const { overrides } = request;
    // A detection without the DNS servers cannot answer a call that wants them.
    const key = `${overridesKey(overrides)}${request.dns ? '|dns' : ''}`;

    if (!request.force && cache !== null && cache.key === key) {
      const age = now() - cache.at;
      // A negative age means the clock went backwards: do not trust the entry.
      if (age >= 0 && age < NETINFO_CACHE_TTL_MS) return Promise.resolve(cache.value);
    }
    if (inFlight !== null && inFlight.key === key && inFlight.generation === generation) {
      return inFlight.promise;
    }

    const startedIn = generation;
    const promise: Promise<DetectedInterfaces> = detectAndLog(overrides, request.dns)
      .then((value) => {
        if (inFlight?.promise === promise) inFlight = null;
        // A result that `invalidate()` overtook is returned to its callers but not kept.
        if (startedIn === generation) cache = { key, at: now(), value };
        return value;
      })
      .catch((error: unknown) => {
        if (inFlight?.promise === promise) inFlight = null;
        return refused('interface detection failed', 'hardware-ports-unavailable', error);
      });
    inFlight = { key, generation, promise };
    return promise;
  };

  const detectInterfaces = (options?: DetectOptions): Promise<DetectedInterfaces> => {
    try {
      return start(options);
    } catch (error) {
      return Promise.resolve(refused('interface detection failed', 'hardware-ports-unavailable', error));
    }
  };

  const invalidate = (): void => {
    generation += 1;
    cache = null;
  };

  return { detectInterfaces, invalidate };
};
