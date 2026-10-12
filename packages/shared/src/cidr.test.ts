import { describe, expect, it } from 'vitest';

import {
  MAX_DOMAIN_LENGTH,
  cidrContains,
  cidrsOverlap,
  forbiddenDestinationReason,
  isForbiddenDestination,
  normalizeCidr,
  normalizeDomain,
  normalizeHostAddress,
  normalizeIpv4,
  normalizeSubnet,
  parseIpv4Destination,
  type Normalised,
} from './cidr';

const valueOf = (result: Normalised): string | null => (result.ok ? result.value : null);
const codeOf = (result: Normalised): string | null => (result.ok ? null : result.error.code);

describe('normalizeIpv4', () => {
  it.each(['172.16.12.40', '10.0.0.1', '0.0.0.0', '255.255.255.255', '127.0.0.1'])('accepts %s', (input) => {
    expect(valueOf(normalizeIpv4(input))).toBe(input);
  });

  it.each([
    ['empty', ''],
    ['leading zero (octal form)', '010.1.1.1'],
    ['three parts', '1.2.3'],
    ['five parts', '1.2.3.4.5'],
    ['octet out of range', '256.1.1.1'],
    ['hex octet', '0x0a.0.0.1'],
    ['single integer', '167772161'],
    ['IPv6', '::1'],
    ['IPv4-mapped IPv6', '::ffff:10.0.0.1'],
    ['leading space', ' 10.0.0.1'],
    ['trailing newline', '10.0.0.1\n'],
    ['CIDR', '10.0.0.1/32'],
    ['negative octet', '-1.0.0.1'],
    ['host name', 'corp.local'],
  ])('rejects %s', (_label, input) => {
    expect(codeOf(normalizeIpv4(input))).toBe('invalid-ipv4');
  });

  it('carries a human-readable message with the code', () => {
    const result = normalizeIpv4('1.2.3');
    expect(result.ok ? '' : result.error.message).toMatch(/IPv4/);
  });
});

describe('normalizeCidr', () => {
  it.each([
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['10.1.2.3/8', '10.0.0.0/8'],
    ['172.16.12.40/24', '172.16.12.0/24'],
    ['172.16.12.40/32', '172.16.12.40/32'],
    ['192.168.1.129/25', '192.168.1.128/25'],
    ['255.255.255.255/1', '128.0.0.0/1'],
    ['10.0.0.1/31', '10.0.0.0/31'],
  ])('normalises %s to %s', (input, expected) => {
    expect(valueOf(normalizeCidr(input))).toBe(expected);
  });

  it.each([
    ['prefix above 32', '10.0.0.0/33', 'invalid-prefix'],
    ['three-digit prefix', '10.0.0.0/128', 'invalid-prefix'],
    ['prefix with leading zero', '10.0.0.0/08', 'invalid-prefix'],
    ['empty prefix', '10.0.0.0/', 'invalid-prefix'],
    ['negative prefix', '10.0.0.0/-1', 'invalid-prefix'],
    ['non-numeric prefix', '10.0.0.0/a', 'invalid-prefix'],
    ['netmask instead of prefix', '10.0.0.0/255.0.0.0', 'invalid-prefix'],
    ['prefix 0', '0.0.0.0/0', 'default-route'],
    ['prefix 0 with a non-zero address', '10.0.0.0/0', 'default-route'],
    ['missing prefix', '10.0.0.0', 'invalid-cidr'],
    ['two slashes', '10.0.0.0/8/8', 'invalid-cidr'],
    ['short address', '10.0/8', 'invalid-cidr'],
    ['leading-zero address', '010.0.0.0/8', 'invalid-cidr'],
    ['IPv6', 'fd00::/8', 'invalid-cidr'],
    ['empty', '', 'invalid-cidr'],
    ['space before the prefix', '10.0.0.0 /8', 'invalid-cidr'],
  ])('rejects %s', (_label, input, code) => {
    expect(codeOf(normalizeCidr(input))).toBe(code);
  });
});

describe('forbiddenDestinationReason', () => {
  it.each([
    ['0.0.0.0/0', 'default-route'],
    ['default', 'default-route'],
    ['DEFAULT', 'default-route'],
    ['0.0.0.0', 'default-route'],
    ['0.0.0.0/32', 'default-route'],
    ['10.0.0.0/0', 'default-route'],
    ['127.0.0.0/8', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['127.10.0.0/16', 'loopback'],
    ['127.1.2.3/8', 'loopback'],
    ['224.0.0.0/4', 'multicast'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['239.1.0.0/16', 'multicast'],
    ['', 'invalid-destination'],
    ['::/0', 'invalid-destination'],
    ['::1', 'invalid-destination'],
    ['corp.local', 'invalid-destination'],
    ['10.0.0.0/33', 'invalid-destination'],
    ['../etc', 'invalid-destination'],
    ['-interface', 'invalid-destination'],
  ])('forbids %s (%s)', (destination, reason) => {
    expect(forbiddenDestinationReason(destination)).toBe(reason);
    expect(isForbiddenDestination(destination)).toBe(true);
  });

  it.each([
    '10.0.0.0/8',
    '172.16.12.40',
    '172.16.12.40/32',
    '126.255.255.255',
    '128.0.0.1',
    '223.255.255.255',
    '240.0.0.1',
    '0.0.0.0/1',
    '128.0.0.0/1',
    '126.0.0.0/7',
    '192.0.0.0/2',
  ])('allows %s', (destination) => {
    expect(forbiddenDestinationReason(destination)).toBeNull();
    expect(isForbiddenDestination(destination)).toBe(false);
  });
});

describe('normalizeHostAddress', () => {
  it('accepts a routable address', () => {
    expect(valueOf(normalizeHostAddress('172.16.12.40'))).toBe('172.16.12.40');
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback'],
    ['224.0.0.1', 'multicast'],
    ['239.0.0.1', 'multicast'],
    ['0.0.0.0', 'default-route'],
    ['10.0.0.0/8', 'invalid-ipv4'],
    ['::1', 'invalid-ipv4'],
  ])('rejects %s (%s)', (input, code) => {
    expect(codeOf(normalizeHostAddress(input))).toBe(code);
  });
});

describe('normalizeSubnet', () => {
  it('accepts and normalises a routable subnet', () => {
    expect(valueOf(normalizeSubnet('10.1.2.3/8'))).toBe('10.0.0.0/8');
  });

  it('accepts prefix 1 and prefix 32', () => {
    expect(valueOf(normalizeSubnet('0.0.0.0/1'))).toBe('0.0.0.0/1');
    expect(valueOf(normalizeSubnet('172.16.12.40/32'))).toBe('172.16.12.40/32');
  });

  it.each([
    ['0.0.0.0/0', 'default-route'],
    ['0.0.0.0/32', 'default-route'],
    ['10.0.0.0/33', 'invalid-prefix'],
    ['127.0.0.0/8', 'loopback'],
    ['127.0.0.1/32', 'loopback'],
    ['224.0.0.0/4', 'multicast'],
    ['232.0.0.0/8', 'multicast'],
    ['10.0.0.0', 'invalid-cidr'],
  ])('rejects %s (%s)', (input, code) => {
    expect(codeOf(normalizeSubnet(input))).toBe(code);
  });
});

describe('normalizeDomain', () => {
  const label63 = 'a'.repeat(63);

  it.each([
    'corp.local',
    'stat.local',
    'github.com',
    'intranet',
    'a-b.example-1.org',
    '1st.example.org',
    'xn--80ak6aa92e.com',
    `${label63}.com`,
    `${label63}.${label63}.${label63}.${'a'.repeat(MAX_DOMAIN_LENGTH - 3 * 64)}`,
  ])('accepts %s', (input) => {
    expect(valueOf(normalizeDomain(input))).toBe(input);
  });

  it.each([
    ['empty', ''],
    ['path traversal', '../etc'],
    ['traversal without a slash', '..'],
    ['single dot', '.'],
    ['slash', 'corp/local'],
    ['absolute path', '/etc/resolver'],
    ['backslash', 'corp\\local'],
    ['leading dot', '.corp.local'],
    ['trailing dot', 'corp.local.'],
    ['empty label', 'corp..local'],
    ['wildcard', '*.corp.local'],
    ['bare wildcard', '*'],
    ['upper case', 'Corp.Local'],
    ['underscore', 'my_host.local'],
    ['space', 'corp local'],
    ['leading space', ' corp.local'],
    ['trailing newline', 'corp.local\n'],
    ['NUL byte', 'corp.local\u0000'],
    ['non-ASCII', 'café.local'],
    ['label starting with a hyphen', '-corp.local'],
    ['label ending with a hyphen', 'corp-.local'],
    ['hyphen only', '-'],
    ['label of 64 characters', `${'a'.repeat(64)}.com`],
    ['more than 253 characters', `${label63}.${label63}.${label63}.${'a'.repeat(MAX_DOMAIN_LENGTH - 3 * 64 + 1)}`],
    ['IPv4 address', '10.0.0.1'],
    ['loopback address', '127.0.0.1'],
    ['numeric last label', 'corp.123'],
    ['port', 'corp.local:53'],
    ['URL', 'https://corp.local'],
  ])('rejects %s', (_label, input) => {
    expect(codeOf(normalizeDomain(input))).toBe('invalid-domain');
  });
});

describe('parseIpv4Destination', () => {
  it('treats a bare address as a /32 host', () => {
    expect(parseIpv4Destination('172.16.12.40')).toEqual({
      cidr: '172.16.12.40/32',
      address: '172.16.12.40',
      prefix: 32,
      isHost: true,
    });
  });

  it('clears host bits of a subnet', () => {
    expect(parseIpv4Destination('10.1.2.3/8')).toEqual({
      cidr: '10.0.0.0/8',
      address: '10.0.0.0',
      prefix: 8,
      isHost: false,
    });
  });

  it('parses prefix 0 so the default route can be recognised', () => {
    expect(parseIpv4Destination('0.0.0.0/0')?.cidr).toBe('0.0.0.0/0');
  });

  it.each(['', 'default', '::1', '10.0.0.0/33', '1.2.3', 'corp.local'])('returns null for %s', (input) => {
    expect(parseIpv4Destination(input)).toBeNull();
  });
});

describe('cidrContains / cidrsOverlap', () => {
  it.each([
    ['10.0.0.0/8', '10.20.0.0/16', true],
    ['10.0.0.0/8', '10.20.0.10', true],
    ['10.0.0.0/8', '10.0.0.0/8', true],
    ['172.16.12.40', '172.16.12.40/32', true],
    ['10.20.0.0/16', '10.0.0.0/8', false],
    ['10.0.0.0/8', '11.0.0.0/8', false],
    ['10.0.0.0/8', '172.16.12.40', false],
    ['10.0.0.0/8', 'corp.local', false],
    ['nonsense', '10.0.0.1', false],
  ])('cidrContains(%s, %s) is %s', (outer, inner, expected) => {
    expect(cidrContains(outer, inner)).toBe(expected);
  });

  it('overlap is symmetric', () => {
    expect(cidrsOverlap('10.20.0.0/16', '10.0.0.0/8')).toBe(true);
    expect(cidrsOverlap('10.0.0.0/8', '10.20.0.0/16')).toBe(true);
    expect(cidrsOverlap('10.0.0.0/8', '192.168.0.0/16')).toBe(false);
  });
});
