import { describe, expect, it } from 'vitest';

import {
  DOMAIN_WILDCARD_PREFIX,
  FORBIDDEN_RANGES,
  MAX_DOMAIN_LENGTH,
  MIN_SUBNET_PREFIX,
  MIN_WILDCARD_BASE_LABELS,
  cidrContains,
  cidrsOverlap,
  forbiddenDestinationReason,
  isForbiddenDestination,
  normalizeCidr,
  normalizeDomain,
  normalizeDomainTarget,
  normalizeHostAddress,
  normalizeIpv4,
  normalizeQueryName,
  normalizeSubnet,
  normalizeWildcardDomain,
  isIpWildcard,
  isWildcardDomain,
  parseIpWildcard,
  parseIpv4Destination,
  wildcardBase,
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
    ['255.255.255.255/8', '255.0.0.0/8'],
    ['128.0.0.0/8', '128.0.0.0/8'],
    ['10.0.0.1/31', '10.0.0.0/31'],
  ])('normalises %s to %s', (input, expected) => {
    expect(valueOf(normalizeCidr(input))).toBe(expected);
  });

  it('keeps the minimum prefix at 8', () => {
    expect(MIN_SUBNET_PREFIX).toBe(8);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])('rejects prefix %d as too wide', (prefix) => {
    expect(codeOf(normalizeCidr(`10.0.0.0/${String(prefix)}`))).toBe('prefix-too-wide');
  });

  it.each(['0.0.0.0/1', '128.0.0.0/1', '255.255.255.255/1', '10.0.0.0/7'])('rejects %s as too wide', (input) => {
    expect(codeOf(normalizeCidr(input))).toBe('prefix-too-wide');
  });

  it('says which prefixes are allowed when the subnet is too wide', () => {
    const result = normalizeCidr('10.0.0.0/7');
    expect(result.ok ? '' : result.error.message).toMatch(/between 8 and 32/);
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
    ['0.0.0.0/8', 'this-network'],
    ['0.0.0.1', 'this-network'],
    ['0.0.0.1/32', 'this-network'],
    ['0.1.2.3/8', 'this-network'],
    ['0.10.0.0/16', 'this-network'],
    ['0.255.255.255', 'this-network'],
    ['169.254.0.0/16', 'link-local'],
    ['169.254.0.0', 'link-local'],
    ['169.254.10.0/24', 'link-local'],
    ['169.254.169.254', 'link-local'],
    ['169.254.255.255', 'link-local'],
    ['255.255.255.255', 'broadcast'],
    ['255.255.255.255/32', 'broadcast'],
    ['0.0.0.0/1', 'prefix-too-wide'],
    ['128.0.0.0/1', 'prefix-too-wide'],
    ['192.0.0.0/2', 'prefix-too-wide'],
    ['224.0.0.0/3', 'prefix-too-wide'],
    ['240.0.0.0/4', 'prefix-too-wide'],
    ['0.0.0.0/7', 'prefix-too-wide'],
    ['10.0.0.0/7', 'prefix-too-wide'],
    ['126.0.0.0/7', 'prefix-too-wide'],
    ['127.0.0.0/7', 'prefix-too-wide'],
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
    '1.0.0.0',
    '1.0.0.0/8',
    '126.0.0.0/8',
    '128.0.0.0/8',
    '169.253.255.255',
    '169.253.0.0/16',
    '169.255.0.0',
    '169.255.0.0/16',
    '255.255.255.254',
    '255.255.255.254/31',
    '240.0.0.0/8',
  ])('allows %s', (destination) => {
    expect(forbiddenDestinationReason(destination)).toBeNull();
    expect(isForbiddenDestination(destination)).toBe(false);
  });

  // "Inside" semantics: only /8 and narrower can exist, so a block can still
  // cover the two forbidden ranges that are narrower than /8.
  it.each(['169.0.0.0/8', '169.254.0.0/15', '255.0.0.0/8', '255.255.255.0/24'])(
    'allows %s, which covers a forbidden range without lying inside it',
    (destination) => {
      expect(forbiddenDestinationReason(destination)).toBeNull();
    },
  );

  it('forbids every prefix wider than the minimum, whatever the address', () => {
    for (const address of ['0.0.0.0', '10.0.0.0', '128.0.0.0', '200.0.0.0', '255.255.255.255']) {
      for (let prefix = 0; prefix < MIN_SUBNET_PREFIX; prefix += 1) {
        expect(isForbiddenDestination(`${address}/${String(prefix)}`)).toBe(true);
      }
    }
  });

  it('lists every forbidden range', () => {
    expect(FORBIDDEN_RANGES).toEqual([
      { cidr: '0.0.0.0/8', reason: 'this-network' },
      { cidr: '127.0.0.0/8', reason: 'loopback' },
      { cidr: '169.254.0.0/16', reason: 'link-local' },
      { cidr: '224.0.0.0/4', reason: 'multicast' },
      { cidr: '255.255.255.255/32', reason: 'broadcast' },
    ]);
  });
});

describe('normalizeHostAddress', () => {
  it.each(['172.16.12.40', '1.0.0.0', '169.253.255.255', '169.255.0.0', '255.255.255.254'])(
    'accepts the routable address %s',
    (input) => {
      expect(valueOf(normalizeHostAddress(input))).toBe(input);
    },
  );

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback'],
    ['224.0.0.1', 'multicast'],
    ['239.0.0.1', 'multicast'],
    ['0.0.0.0', 'default-route'],
    ['0.0.0.1', 'this-network'],
    ['0.255.255.255', 'this-network'],
    ['169.254.0.0', 'link-local'],
    ['169.254.255.255', 'link-local'],
    ['255.255.255.255', 'broadcast'],
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

  it('accepts prefix 8 and prefix 32', () => {
    expect(valueOf(normalizeSubnet('1.0.0.0/8'))).toBe('1.0.0.0/8');
    expect(valueOf(normalizeSubnet('128.200.0.1/8'))).toBe('128.0.0.0/8');
    expect(valueOf(normalizeSubnet('172.16.12.40/32'))).toBe('172.16.12.40/32');
  });

  it.each(['169.253.0.0/16', '169.255.0.0/16', '169.0.0.0/8', '255.255.255.254/32', '240.0.0.0/8'])(
    'accepts %s next to a forbidden range',
    (input) => {
      expect(valueOf(normalizeSubnet(input))).toBe(input);
    },
  );

  it.each([
    ['0.0.0.0/0', 'default-route'],
    ['0.0.0.0/32', 'default-route'],
    ['10.0.0.0/33', 'invalid-prefix'],
    ['127.0.0.0/8', 'loopback'],
    ['127.0.0.1/32', 'loopback'],
    ['224.0.0.0/4', 'multicast'],
    ['232.0.0.0/8', 'multicast'],
    ['0.0.0.0/8', 'this-network'],
    ['0.1.2.3/8', 'this-network'],
    ['0.0.0.1/32', 'this-network'],
    ['169.254.0.0/16', 'link-local'],
    ['169.254.10.0/24', 'link-local'],
    ['169.254.1.1/16', 'link-local'],
    ['255.255.255.255/32', 'broadcast'],
    ['0.0.0.0/1', 'prefix-too-wide'],
    ['128.0.0.0/1', 'prefix-too-wide'],
    ['10.0.0.0/7', 'prefix-too-wide'],
    ['126.0.0.0/7', 'prefix-too-wide'],
    ['224.0.0.0/3', 'prefix-too-wide'],
    ['10.0.0.0', 'invalid-cidr'],
  ])('rejects %s (%s)', (input, code) => {
    expect(codeOf(normalizeSubnet(input))).toBe(code);
  });
});

describe('parseIpWildcard', () => {
  it.each([
    ['192.168.5.*', '192.168.5.0/24'],
    ['192.168.*.*', '192.168.0.0/16'],
    ['10.*.*.*', '10.0.0.0/8'],
    ['172.16.*.*', '172.16.0.0/16'],
    ['255.255.255.*', '255.255.255.0/24'],
    ['1.*.*.*', '1.0.0.0/8'],
  ])('turns %s into %s', (input, expected) => {
    expect(parseIpWildcard(input)).toEqual({ ok: true, value: expected });
  });

  // Syntax only: the forbidden ranges are `normalizeSubnet`'s job.
  it.each([
    ['224.*.*.*', '224.0.0.0/8'],
    ['127.*.*.*', '127.0.0.0/8'],
    ['0.*.*.*', '0.0.0.0/8'],
    ['169.254.*.*', '169.254.0.0/16'],
  ])('does not judge the range of %s (%s)', (input, expected) => {
    expect(valueOf(parseIpWildcard(input))).toBe(expected);
  });

  it.each([
    ['a * between octets', '192.*.1.*'],
    ['a * between octets, last fixed', '10.*.*.1'],
    ['a * in the middle only', '10.0.*.1'],
    ['a * in the first octet', '*.168.5.1'],
    ['every octet a *', '*.*.*.*'],
    ['a leading * with a fixed tail', '*.*.*.1'],
    ['too few parts', '10.*'],
    ['three parts', '10.*.*'],
    ['five parts', '10.*.*.*.*'],
    ['a double *', '10.**.*.*'],
    ['a * glued to digits', '10.1*.*.*'],
    ['a * glued to digits in the last octet', '10.0.0.1*'],
    ['a prefix', '10.*.*.*/8'],
    ['a prefix on a full wildcard', '192.168.5.*/24'],
    ['a leading space', ' 10.*.*.*'],
    ['a trailing space', '10.*.*.* '],
    ['an inner space', '10. *.*.*'],
    ['a trailing newline', '10.*.*.*\n'],
    ['empty', ''],
    ['a lone *', '*'],
    ['an empty octet', '.*.*.*'],
    ['an octet out of range', '256.*.*.*'],
    ['an octal octet', '010.*.*.*'],
    ['a hex octet', '0x0a.*.*.*'],
    ['a negative octet', '-1.*.*.*'],
    ['no * at all', '10.0.0.0'],
    ['a CIDR', '10.0.0.0/8'],
    ['a domain wildcard', '*.corp.local'],
    ['an IPv6 wildcard', 'fd00::*'],
  ])('rejects %s (%j)', (_label, input) => {
    expect(codeOf(parseIpWildcard(input))).toBe('invalid-wildcard');
  });

  it('carries a human-readable message with the code', () => {
    const result = parseIpWildcard('192.*.1.*');
    expect(result.ok ? '' : result.error.message).toMatch(/wildcard/);
  });
});

describe('isIpWildcard', () => {
  it('is true for any input with a *', () => {
    expect(isIpWildcard('10.*.*.*')).toBe(true);
    expect(isIpWildcard('*')).toBe(true);
    expect(isIpWildcard('192.*.1.*')).toBe(true);
  });

  it('is false without a *', () => {
    expect(isIpWildcard('10.0.0.0/8')).toBe(false);
    expect(isIpWildcard('')).toBe(false);
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

describe('normalizeWildcardDomain', () => {
  const label63 = 'a'.repeat(63);
  /** A wildcard of exactly `length` characters: `*.` + a valid base. */
  const wildcardOfLength = (length: number): string =>
    `*.${label63}.${label63}.${label63}.${'a'.repeat(length - 2 - 3 * 64)}`;

  it('pins the prefix and the minimum base depth', () => {
    expect(DOMAIN_WILDCARD_PREFIX).toBe('*.');
    expect(MIN_WILDCARD_BASE_LABELS).toBe(2);
  });

  it.each([
    '*.example.com',
    '*.corp.local',
    '*.a.example.com',
    '*.a-b.example-1.org',
    '*.xn--80ak6aa92e.com',
    '*.co.uk',
    `*.${label63}.com`,
    wildcardOfLength(MAX_DOMAIN_LENGTH),
  ])('accepts %s unchanged', (input) => {
    expect(valueOf(normalizeWildcardDomain(input))).toBe(input);
    expect(valueOf(normalizeDomainTarget(input))).toBe(input);
  });

  it.each([
    ['bare star', '*'],
    ['star and dot', '*.'],
    ['empty', ''],
    ['no star', 'example.com'],
    ['double star label', '**.example.com'],
    ['two wildcard labels', '*.*.example.com'],
    ['star inside the name', 'a.*.example.com'],
    ['star glued to a label', '*example.com'],
    ['star at the end', 'example.*'],
    ['partial label wildcard', 'a*.example.com'],
    ['star after the base', '*.example.com.*'],
    ['one-label base (TLD)', '*.com'],
    ['one-label base (.local)', '*.local'],
    ['numeric last label', '*.corp.123'],
    ['IPv4 base', '*.10.0.0.1'],
    ['upper case base', '*.Example.com'],
    ['trailing dot', '*.example.com.'],
    ['leading dot', '.*.example.com'],
    ['dot after the star missing a label', '*..example.com'],
    ['underscore', '*.my_host.example.com'],
    ['space', '* .example.com'],
    ['trailing newline', '*.example.com\n'],
    ['NUL byte', '*.example.com\u0000'],
    ['non-ASCII base', '*.café.com'],
    ['full-width star', '＊.example.com'],
    ['slash', '*.corp/local.com'],
    ['path traversal', '*./../etc'],
    ['label of 64 characters', `*.${'a'.repeat(64)}.com`],
    ['label ending with a hyphen', '*.corp-.local'],
    ['more than 253 characters', wildcardOfLength(MAX_DOMAIN_LENGTH + 1)],
  ])('rejects %s', (_label, input) => {
    expect(codeOf(normalizeWildcardDomain(input))).toBe('invalid-wildcard-domain');
  });

  it('measures the length with the prefix: a base of 252 characters is valid alone, not behind "*."', () => {
    const input = wildcardOfLength(MAX_DOMAIN_LENGTH + 1);
    expect(normalizeDomain(input.slice(2)).ok).toBe(true);
    expect(normalizeWildcardDomain(input).ok).toBe(false);
  });
});

describe('normalizeDomainTarget', () => {
  it('takes an exact name through normalizeDomain', () => {
    expect(valueOf(normalizeDomainTarget('corp.local'))).toBe('corp.local');
    expect(valueOf(normalizeDomainTarget('intranet'))).toBe('intranet');
    expect(codeOf(normalizeDomainTarget('Corp.Local'))).toBe('invalid-domain');
    expect(codeOf(normalizeDomainTarget('../etc'))).toBe('invalid-domain');
  });

  it('takes anything with a star through the wildcard rules', () => {
    expect(valueOf(normalizeDomainTarget('*.corp.local'))).toBe('*.corp.local');
    expect(codeOf(normalizeDomainTarget('a.*.corp.local'))).toBe('invalid-wildcard-domain');
    expect(codeOf(normalizeDomainTarget('*'))).toBe('invalid-wildcard-domain');
    expect(codeOf(normalizeDomainTarget('*.com'))).toBe('invalid-wildcard-domain');
  });

  it('never lets normalizeDomain accept a wildcard (resolver file names, lookups)', () => {
    expect(codeOf(normalizeDomain('*.corp.local'))).toBe('invalid-domain');
  });
});

describe('isWildcardDomain / wildcardBase', () => {
  it.each([
    ['*.example.com', true, 'example.com'],
    ['*.a.example.com', true, 'a.example.com'],
    ['a.*.example.com', true, null],
    ['*.com', true, null],
    ['*', true, null],
    ['example.com', false, null],
    ['', false, null],
  ])('%s', (input, wildcard, base) => {
    expect(isWildcardDomain(input)).toBe(wildcard);
    expect(wildcardBase(input)).toBe(base);
  });
});

describe('normalizeQueryName', () => {
  it.each([
    ['foo.example.com', 'foo.example.com'],
    ['FOO.Example.COM', 'foo.example.com'],
    ['foo.example.com.', 'foo.example.com'],
    ['Foo.Example.Com.', 'foo.example.com'],
    ['intranet', 'intranet'],
  ])('folds %s to %s', (input, folded) => {
    expect(normalizeQueryName(input)).toBe(folded);
  });

  it.each([
    ['empty', ''],
    ['root only', '.'],
    ['two trailing dots', 'foo.example.com..'],
    ['leading dot', '.foo.example.com'],
    ['wildcard', '*.example.com'],
    ['underscore (SRV)', '_ldap._tcp.example.com'],
    ['non-ASCII', 'café.example.com'],
    ['dotted I folds only in ASCII', 'İ.example.com'],
    ['IPv4 address', '10.0.0.1'],
    ['space', 'foo .example.com'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeQueryName(input)).toBeNull();
  });

  it('accepts 253 characters plus the root dot, nothing longer', () => {
    const name = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}`;
    expect(name).toHaveLength(MAX_DOMAIN_LENGTH);
    expect(normalizeQueryName(`${name}.`)).toBe(name);
    expect(normalizeQueryName(`${name}a.`)).toBeNull();
    expect(normalizeQueryName(`${name}..`)).toBeNull();
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
