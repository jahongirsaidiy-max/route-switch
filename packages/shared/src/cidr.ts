import ipaddr from 'ipaddr.js';

/**
 * IPv4 / CIDR / domain validation and normalisation.
 *
 * Every value is parsed with `ipaddr.js` and re-serialised, so callers only
 * ever work with the canonical form (`10.1.2.3/8` becomes `10.0.0.0/8`).
 * IPv6 is out of scope for the MVP and is always rejected.
 *
 * Inputs are never trimmed or case-folded: anything that is not already in
 * canonical character form is rejected instead of being silently rewritten.
 */

export type ValidationCode =
  | 'invalid-ipv4'
  | 'invalid-cidr'
  | 'invalid-prefix'
  | 'invalid-domain'
  | 'invalid-destination'
  | 'default-route'
  | 'loopback'
  | 'multicast';

export type ForbiddenReason = Extract<
  ValidationCode,
  'invalid-destination' | 'default-route' | 'loopback' | 'multicast'
>;

export interface ValidationError {
  readonly code: ValidationCode;
  readonly message: string;
}

export type Normalised<T = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationError };

/** A parsed IPv4 destination: network address (host bits cleared) + prefix. */
export interface Destination {
  /** Canonical CIDR, always with a prefix: `10.0.0.0/8`, `172.16.12.40/32`. */
  readonly cidr: string;
  /** Network address without the prefix: `10.0.0.0`. */
  readonly address: string;
  readonly prefix: number;
  /** True for a single address (`/32`). */
  readonly isHost: boolean;
}

export const IPV4_BITS = 32;
export const MIN_SUBNET_PREFIX = 1;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_DOMAIN_LABEL_LENGTH = 63;

/** The literal `route(8)` accepts for the default route. */
export const DEFAULT_ROUTE_KEYWORD = 'default';
export const DEFAULT_ROUTE_CIDR = '0.0.0.0/0';

/**
 * Ranges that must never be added to or removed from the routing table, next
 * to the default route itself. A destination is forbidden when it lies
 * entirely inside one of them.
 */
export const FORBIDDEN_RANGES: readonly { readonly cidr: string; readonly reason: ForbiddenReason }[] = [
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
];

const MESSAGES: Record<ValidationCode, string> = {
  'invalid-ipv4': 'Must be an IPv4 address in dotted decimal form, e.g. 172.16.12.40',
  'invalid-cidr': 'Must be an IPv4 subnet in CIDR form, e.g. 10.0.0.0/8',
  'invalid-prefix': `Subnet prefix must be between ${String(MIN_SUBNET_PREFIX)} and ${String(IPV4_BITS)}`,
  'invalid-domain':
    'Must be a lower-case domain name (a-z, 0-9, "-" and "." only), e.g. corp.local; wildcards are not supported',
  'invalid-destination': 'Must be an IPv4 address or an IPv4 subnet in CIDR form',
  'default-route': 'The default route (0.0.0.0/0) must never be changed',
  loopback: 'Loopback addresses (127.0.0.0/8) must never be routed',
  multicast: 'Multicast addresses (224.0.0.0/4) must never be routed',
};

const ok = <T>(value: T): Normalised<T> => ({ ok: true, value });
const fail = (code: ValidationCode): Normalised<never> => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

const PREFIX_PATTERN = /^(?:0|[1-9]\d?)$/;

interface ParsedDestination {
  readonly network: ipaddr.IPv4;
  readonly prefix: number;
}

// `isValidFourPartDecimal` rejects everything inet_aton would otherwise accept
// loosely: octal/hex octets (`010.1.1.1`), short forms (`1.2.3`), and IPv6.
const parseAddress = (input: string): ipaddr.IPv4 | null =>
  ipaddr.IPv4.isValidFourPartDecimal(input) ? ipaddr.IPv4.parse(input) : null;

/** Parses `a.b.c.d/n` with n in 0..32. Returns the network address. */
const parseCidr = (input: string): ParsedDestination | 'invalid-cidr' | 'invalid-prefix' => {
  const parts = input.split('/');
  const [addressPart, prefixPart] = parts;
  if (parts.length !== 2 || addressPart === undefined || prefixPart === undefined) return 'invalid-cidr';

  const address = parseAddress(addressPart);
  if (address === null) return 'invalid-cidr';
  if (!PREFIX_PATTERN.test(prefixPart)) return 'invalid-prefix';

  const prefix = Number(prefixPart);
  if (prefix > IPV4_BITS) return 'invalid-prefix';

  return { network: ipaddr.IPv4.networkAddressFromCIDR(`${address.toString()}/${String(prefix)}`), prefix };
};

/** Parses a bare address (as `/32`) or a CIDR with any prefix 0..32. */
const parseDestination = (input: string): ParsedDestination | null => {
  if (input.includes('/')) {
    const parsed = parseCidr(input);
    return typeof parsed === 'string' ? null : parsed;
  }
  const address = parseAddress(input);
  return address === null ? null : { network: address, prefix: IPV4_BITS };
};

const toDestination = ({ network, prefix }: ParsedDestination): Destination => {
  const address = network.toString();
  return { cidr: `${address}/${String(prefix)}`, address, prefix, isHost: prefix === IPV4_BITS };
};

const FORBIDDEN_PARSED = FORBIDDEN_RANGES.map(({ cidr, reason }) => {
  const [network, prefix] = ipaddr.IPv4.parseCIDR(cidr);
  return { network, prefix, reason };
});

const isUnspecifiedAddress = (address: ipaddr.IPv4): boolean => address.octets.every((octet) => octet === 0);

const forbiddenReasonOf = ({ network, prefix }: ParsedDestination): ForbiddenReason | null => {
  // Any `/0` is the default route. A bare `0.0.0.0` host is included because
  // route(8) turns a zero destination without a mask into the default route.
  if (prefix === 0 || (prefix === IPV4_BITS && isUnspecifiedAddress(network))) return 'default-route';

  for (const range of FORBIDDEN_PARSED) {
    if (prefix >= range.prefix && network.match(range.network, range.prefix)) return range.reason;
  }
  return null;
};

/**
 * Parses an arbitrary route destination: a bare IPv4 address or a CIDR with
 * any prefix (including `/0`). Returns null when it is not valid IPv4.
 */
export const parseIpv4Destination = (input: string): Destination | null => {
  const parsed = parseDestination(input);
  return parsed === null ? null : toDestination(parsed);
};

/**
 * Why a destination must never be added to or removed from the routing table,
 * or null when it is acceptable. Meant for arbitrary destinations, including
 * resolved IPs: a bare IPv4 address or a CIDR.
 *
 * Forbidden: the literal `default`, `0.0.0.0/0` (any `/0`, and the bare
 * `0.0.0.0`), anything inside `127.0.0.0/8`, anything inside `224.0.0.0/4`.
 * Fails closed: input that is not a valid IPv4 destination (IPv6, host names,
 * garbage) is reported as `invalid-destination`.
 */
export const forbiddenDestinationReason = (destination: string): ForbiddenReason | null => {
  if (destination.toLowerCase() === DEFAULT_ROUTE_KEYWORD) return 'default-route';
  const parsed = parseDestination(destination);
  return parsed === null ? 'invalid-destination' : forbiddenReasonOf(parsed);
};

export const isForbiddenDestination = (destination: string): boolean =>
  forbiddenDestinationReason(destination) !== null;

/** Syntax only: a strict dotted-decimal IPv4 address, re-serialised. */
export const normalizeIpv4 = (input: string): Normalised => {
  const address = parseAddress(input);
  return address === null ? fail('invalid-ipv4') : ok(address.toString());
};

/** Syntax only: IPv4 CIDR with prefix 1..32, host bits cleared. */
export const normalizeCidr = (input: string): Normalised => {
  const parsed = parseCidr(input);
  if (typeof parsed === 'string') return fail(parsed);
  // `/0` is the default route whatever the address part says (`10.0.0.0/0`).
  if (parsed.prefix === 0) return fail('default-route');
  return ok(toDestination(parsed).cidr);
};

const rejectForbidden = (result: Normalised): Normalised => {
  if (!result.ok) return result;
  const reason = forbiddenDestinationReason(result.value);
  return reason === null ? result : fail(reason);
};

/** A routable single address: valid IPv4 and not a forbidden destination. */
export const normalizeHostAddress = (input: string): Normalised => rejectForbidden(normalizeIpv4(input));

/** A routable subnet: valid CIDR (prefix 1..32) and not a forbidden destination. */
export const normalizeSubnet = (input: string): Normalised => rejectForbidden(normalizeCidr(input));

const DOMAIN_CHARSET = /^[a-z0-9.-]+$/;
const NUMERIC_LABEL = /^\d+$/;

const isValidLabel = (label: string): boolean =>
  label.length > 0 &&
  label.length <= MAX_DOMAIN_LABEL_LENGTH &&
  !label.startsWith('-') &&
  !label.endsWith('-');

/**
 * Validates a domain name. The value doubles as a file name under
 * `/etc/resolver/`, so the rules are deliberately strict:
 * only `[a-z0-9.-]` (no upper case, wildcard, `/`, `_` or whitespace), at most
 * 253 characters, no leading or trailing dot, no empty label (`a..b`), labels
 * of 1..63 characters that neither start nor end with `-`, and a last label
 * that is not purely numeric (so an IP address is never accepted as a domain).
 * Single-label names (`intranet`) are accepted.
 *
 * Nothing is rewritten: a valid domain is returned unchanged.
 */
export const normalizeDomain = (input: string): Normalised => {
  if (input.length === 0 || input.length > MAX_DOMAIN_LENGTH) return fail('invalid-domain');
  if (!DOMAIN_CHARSET.test(input)) return fail('invalid-domain');

  const labels = input.split('.');
  if (!labels.every(isValidLabel)) return fail('invalid-domain');

  const lastLabel = labels.at(-1);
  if (lastLabel === undefined || NUMERIC_LABEL.test(lastLabel)) return fail('invalid-domain');

  return ok(input);
};

/**
 * True when `inner` lies entirely inside `outer` (equal counts as inside).
 * Both may be a bare address or a CIDR; false when either is not valid IPv4.
 */
export const cidrContains = (outer: string, inner: string): boolean => {
  const outerParsed = parseDestination(outer);
  const innerParsed = parseDestination(inner);
  if (outerParsed === null || innerParsed === null) return false;
  return (
    innerParsed.prefix >= outerParsed.prefix && innerParsed.network.match(outerParsed.network, outerParsed.prefix)
  );
};

/** Two IPv4 blocks overlap exactly when one of them contains the other. */
export const cidrsOverlap = (a: string, b: string): boolean => cidrContains(a, b) || cidrContains(b, a);
