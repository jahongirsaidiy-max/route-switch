import { describe, expect, it } from 'vitest';

import {
  Config,
  IfaceRole,
  LIMITS,
  Rule,
  RuleKind,
  destinationKey,
  findIfaceConflicts,
  findOverlaps,
  normalizeTarget,
  type ConfigInput,
  type RuleInput,
} from './schema';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const rule = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  id: uuid(1),
  kind: 'subnet',
  target: '10.0.0.0/8',
  iface: 'ethernet',
  ...overrides,
});

const config = (rules: RuleInput[], overrides: Partial<ConfigInput> = {}): ConfigInput => ({
  version: 1,
  rules,
  ...overrides,
});

/** `path: message-code` for every issue, so assertions pin where and why. */
const issuesOf = (result: ReturnType<typeof Rule.safeParse> | ReturnType<typeof Config.safeParse>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`);

describe('IfaceRole / RuleKind', () => {
  it('accepts the known roles and kinds', () => {
    expect(IfaceRole.options).toEqual(['ethernet', 'wifi']);
    expect(RuleKind.options).toEqual(['ip', 'subnet', 'domain']);
    expect(IfaceRole.parse('wifi')).toBe('wifi');
  });

  it('rejects a device name or an unknown role', () => {
    expect(IfaceRole.safeParse('en5').success).toBe(false);
    expect(IfaceRole.safeParse('utun3').success).toBe(false);
    expect(RuleKind.safeParse('wildcard').success).toBe(false);
  });
});

describe('Rule', () => {
  it('applies defaults', () => {
    expect(Rule.parse(rule())).toEqual({
      id: uuid(1),
      enabled: true,
      kind: 'subnet',
      target: '10.0.0.0/8',
      iface: 'ethernet',
      refreshSec: 600,
    });
  });

  it('keeps explicit values', () => {
    const parsed = Rule.parse(
      rule({
        enabled: false,
        kind: 'domain',
        target: 'corp.local',
        iface: 'wifi',
        dns: '10.20.0.10',
        refreshSec: 120,
        note: 'Internal network',
      }),
    );
    expect(parsed).toEqual({
      id: uuid(1),
      enabled: false,
      kind: 'domain',
      target: 'corp.local',
      iface: 'wifi',
      dns: '10.20.0.10',
      refreshSec: 120,
      note: 'Internal network',
    });
  });

  it('drops unknown keys', () => {
    expect(Rule.parse({ ...rule(), command: 'rm -rf /' })).not.toHaveProperty('command');
  });

  describe('id', () => {
    it('accepts a UUID', () => {
      expect(Rule.safeParse(rule({ id: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })).success).toBe(true);
    });

    it.each(['', 'rule-1', '00000000-0000-4000-8000-00000000000'])('rejects %j', (id) => {
      expect(issuesOf(Rule.safeParse(rule({ id })))).toEqual(['id: invalid_format']);
    });
  });

  describe('iface and kind', () => {
    it('rejects an unknown interface role', () => {
      expect(issuesOf(Rule.safeParse({ ...rule(), iface: 'en5' }))).toEqual(['iface: invalid_value']);
    });

    it('rejects a missing interface', () => {
      const withoutIface = { id: uuid(1), kind: 'subnet', target: '10.0.0.0/8' };
      expect(issuesOf(Rule.safeParse(withoutIface))).toEqual(['iface: invalid_value']);
    });

    it('rejects an unknown kind', () => {
      expect(issuesOf(Rule.safeParse({ ...rule(), kind: 'wildcard' }))).toEqual(['kind: invalid_value']);
    });
  });

  describe('subnet target', () => {
    it.each([
      ['10.0.0.0/8', '10.0.0.0/8'],
      ['10.1.2.3/8', '10.0.0.0/8'],
      ['172.16.12.40/32', '172.16.12.40/32'],
      ['128.0.0.0/1', '128.0.0.0/1'],
    ])('accepts %s as %s', (target, expected) => {
      expect(Rule.parse(rule({ kind: 'subnet', target })).target).toBe(expected);
    });

    it.each(['10.0.0.0/33', '0.0.0.0/0', '10.0.0.0/0', '10.0.0.0', '127.0.0.0/8', '224.0.0.0/4', 'fd00::/8', 'corp.local'])(
      'rejects %s',
      (target) => {
        expect(issuesOf(Rule.safeParse(rule({ kind: 'subnet', target })))).toEqual(['target: custom']);
      },
    );
  });

  describe('ip target', () => {
    it('accepts an IPv4 address', () => {
      expect(Rule.parse(rule({ kind: 'ip', target: '172.16.12.40' })).target).toBe('172.16.12.40');
    });

    it.each(['127.0.0.1', '224.0.0.251', '0.0.0.0', '010.1.1.1', '1.2.3', '::1', '10.0.0.0/8', 'default', 'corp.local'])(
      'rejects %s',
      (target) => {
        expect(issuesOf(Rule.safeParse(rule({ kind: 'ip', target })))).toEqual(['target: custom']);
      },
    );
  });

  describe('domain target', () => {
    it.each(['corp.local', 'github.com', 'intranet'])('accepts %s', (target) => {
      expect(Rule.parse(rule({ kind: 'domain', target })).target).toBe(target);
    });

    it.each(['../etc', '.corp.local', '*.corp.local', 'Corp.Local', 'corp.local.', 'corp..local', 'corp/local', '10.0.0.1'])(
      'rejects %s',
      (target) => {
        expect(issuesOf(Rule.safeParse(rule({ kind: 'domain', target })))).toEqual(['target: custom']);
      },
    );

    it('rejects a domain longer than 253 characters', () => {
      const target = `${'a.'.repeat(126)}ab`;
      expect(target).toHaveLength(254);
      expect(issuesOf(Rule.safeParse(rule({ kind: 'domain', target })))).toEqual(['target: too_big']);
    });
  });

  it('rejects an empty target', () => {
    expect(issuesOf(Rule.safeParse(rule({ target: '' })))).toEqual(['target: too_small']);
  });

  it('reports the validation code on a rejected target', () => {
    const result = Rule.safeParse(rule({ kind: 'subnet', target: '0.0.0.0/0' }));
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue).toMatchObject({ code: 'custom', path: ['target'], params: { code: 'default-route' } });
  });

  describe('dns', () => {
    it('accepts an IPv4 address', () => {
      expect(Rule.parse(rule({ kind: 'domain', target: 'corp.local', dns: '10.20.0.10' })).dns).toBe('10.20.0.10');
    });

    it.each(['corp.local', '::1', '10.20.0.10/32', '010.20.0.10', '', '127.0.0.1', '224.0.0.251', '0.0.0.0'])(
      'rejects %j',
      (dns) => {
        expect(issuesOf(Rule.safeParse(rule({ kind: 'domain', target: 'corp.local', dns })))).toEqual(['dns: custom']);
      },
    );
  });

  describe('refreshSec', () => {
    it.each([60, 600, 86_400])('accepts %d', (refreshSec) => {
      expect(Rule.parse(rule({ refreshSec })).refreshSec).toBe(refreshSec);
    });

    it.each([
      [59, 'too_small'],
      [0, 'too_small'],
      [86_401, 'too_big'],
      [60.5, 'invalid_type'],
    ])('rejects %d', (refreshSec, code) => {
      expect(issuesOf(Rule.safeParse(rule({ refreshSec })))).toEqual([`refreshSec: ${code}`]);
    });

    it('rejects a numeric string', () => {
      expect(issuesOf(Rule.safeParse({ ...rule(), refreshSec: '600' }))).toEqual(['refreshSec: invalid_type']);
    });
  });

  describe('note', () => {
    it('accepts 200 characters', () => {
      expect(Rule.parse(rule({ note: 'n'.repeat(200) })).note).toHaveLength(200);
    });

    it('rejects 201 characters', () => {
      expect(issuesOf(Rule.safeParse(rule({ note: 'n'.repeat(201) })))).toEqual(['note: too_big']);
    });
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(issuesOf(Rule.safeParse({ ...rule(), enabled: 'yes' }))).toEqual(['enabled: invalid_type']);
  });
});

describe('normalizeTarget', () => {
  it('dispatches on the rule kind', () => {
    expect(normalizeTarget('subnet', '10.1.2.3/8')).toEqual({ ok: true, value: '10.0.0.0/8' });
    expect(normalizeTarget('ip', '172.16.12.40')).toEqual({ ok: true, value: '172.16.12.40' });
    expect(normalizeTarget('domain', 'corp.local')).toEqual({ ok: true, value: 'corp.local' });
    expect(normalizeTarget('domain', '../etc').ok).toBe(false);
  });
});

describe('Config', () => {
  it('parses the documented example and applies defaults', () => {
    const parsed = Config.parse({
      version: 1,
      enabled: true,
      rules: [
        { id: uuid(1), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', note: 'Internal network' },
        { id: uuid(2), kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' },
        { id: uuid(3), kind: 'domain', target: 'github.com', iface: 'wifi', refreshSec: 600 },
      ],
    });
    expect(parsed.rules).toHaveLength(3);
    expect(parsed.rules.map((r) => r.enabled)).toEqual([true, true, true]);
    expect(parsed.rules.map((r) => r.refreshSec)).toEqual([600, 600, 600]);
  });

  it('defaults enabled to true and accepts an empty rule list', () => {
    expect(Config.parse(config([]))).toEqual({ version: 1, enabled: true, rules: [] });
  });

  it('normalises rule targets', () => {
    expect(Config.parse(config([rule({ target: '10.1.2.3/8' })])).rules[0]?.target).toBe('10.0.0.0/8');
  });

  it('reports an invalid rule with its index', () => {
    const result = Config.safeParse(config([rule(), rule({ id: uuid(2), target: '10.0.0.0/33' })]));
    expect(issuesOf(result)).toEqual(['rules.1.target: custom']);
  });

  describe('version', () => {
    it.each([2, 0, '1'])('rejects %j', (version) => {
      expect(issuesOf(Config.safeParse({ ...config([]), version }))).toEqual(['version: invalid_value']);
    });

    it('rejects a missing version', () => {
      expect(issuesOf(Config.safeParse({ rules: [] }))).toEqual(['version: invalid_value']);
    });
  });

  describe('rule limit', () => {
    const manyRules = (count: number): RuleInput[] =>
      Array.from({ length: count }, (_unused, i) =>
        rule({ id: uuid(i + 1), kind: 'ip', target: `10.0.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}` }),
      );

    it(`accepts ${String(LIMITS.maxRules)} rules`, () => {
      expect(Config.parse(config(manyRules(500))).rules).toHaveLength(500);
    });

    it('rejects 501 rules', () => {
      expect(issuesOf(Config.safeParse(config(manyRules(501))))).toEqual(['rules: too_big']);
    });
  });

  describe('ifaceOverrides', () => {
    it('accepts an override for one role', () => {
      expect(Config.parse(config([], { ifaceOverrides: { ethernet: 'en5' } })).ifaceOverrides).toEqual({
        ethernet: 'en5',
      });
    });

    it('accepts overrides for both roles', () => {
      const ifaceOverrides = { ethernet: 'en7', wifi: 'en0' };
      expect(Config.parse(config([], { ifaceOverrides })).ifaceOverrides).toEqual(ifaceOverrides);
    });

    it.each(['utun3', 'en', 'en5; rm -rf /', 'EN5', 'lo0', ''])('rejects device %j', (device) => {
      expect(issuesOf(Config.safeParse(config([], { ifaceOverrides: { ethernet: device } })))).toEqual([
        'ifaceOverrides.ethernet: invalid_format',
      ]);
    });

    it('rejects an unknown role key', () => {
      const result = Config.safeParse({ ...config([]), ifaceOverrides: { vpn: 'en5' } });
      expect(result.success).toBe(false);
    });
  });

  describe('same target on two interfaces', () => {
    it('rejects the same subnet bound to ethernet and wifi', () => {
      const result = Config.safeParse(config([rule(), rule({ id: uuid(2), iface: 'wifi' })]));
      expect(issuesOf(result)).toEqual(['rules.1.target: custom']);
      expect(result.success ? undefined : result.error.issues[0]).toMatchObject({
        params: { code: 'iface-conflict', first: 0, second: 1 },
      });
    });

    it('compares normalised targets', () => {
      const result = Config.safeParse(
        config([rule({ target: '10.1.2.3/8' }), rule({ id: uuid(2), target: '10.200.0.0/8', iface: 'wifi' })]),
      );
      expect(issuesOf(result)).toEqual(['rules.1.target: custom']);
    });

    it('treats an ip rule and its /32 subnet as the same target', () => {
      const result = Config.safeParse(
        config([
          rule({ kind: 'ip', target: '172.16.12.40' }),
          rule({ id: uuid(2), kind: 'subnet', target: '172.16.12.40/32', iface: 'wifi' }),
        ]),
      );
      expect(issuesOf(result)).toEqual(['rules.1.target: custom']);
    });

    it('rejects the same domain bound to two interfaces', () => {
      const result = Config.safeParse(
        config([
          rule({ kind: 'domain', target: 'corp.local' }),
          rule({ id: uuid(2), kind: 'domain', target: 'corp.local', iface: 'wifi' }),
        ]),
      );
      expect(issuesOf(result)).toEqual(['rules.1.target: custom']);
    });

    it('rejects the conflict even when one of the rules is disabled', () => {
      const result = Config.safeParse(config([rule({ enabled: false }), rule({ id: uuid(2), iface: 'wifi' })]));
      expect(result.success).toBe(false);
    });

    it('reports every later rule that conflicts with the first one', () => {
      const result = Config.safeParse(
        config([rule(), rule({ id: uuid(2), iface: 'wifi' }), rule({ id: uuid(3), iface: 'wifi' })]),
      );
      expect(issuesOf(result)).toEqual(['rules.1.target: custom', 'rules.2.target: custom']);
    });

    it('accepts the same target twice on the same interface', () => {
      expect(Config.safeParse(config([rule(), rule({ id: uuid(2) })])).success).toBe(true);
    });

    it('accepts overlapping subnets on different interfaces', () => {
      const result = Config.safeParse(
        config([
          rule({ target: '10.0.0.0/8' }),
          rule({ id: uuid(2), target: '10.20.0.0/16', iface: 'wifi' }),
          rule({ id: uuid(3), kind: 'ip', target: '10.20.0.10', iface: 'ethernet' }),
        ]),
      );
      expect(result.success).toBe(true);
    });
  });
});

describe('destinationKey', () => {
  it('builds one key per routing destination', () => {
    expect(destinationKey({ kind: 'subnet', target: '10.0.0.0/8' })).toBe('net:10.0.0.0/8');
    expect(destinationKey({ kind: 'ip', target: '172.16.12.40' })).toBe('net:172.16.12.40/32');
    expect(destinationKey({ kind: 'domain', target: 'corp.local' })).toBe('domain:corp.local');
  });

  it('returns null for an invalid IP target', () => {
    expect(destinationKey({ kind: 'ip', target: 'not-an-ip' })).toBeNull();
  });
});

describe('findIfaceConflicts', () => {
  it('returns no conflicts for distinct targets', () => {
    expect(
      findIfaceConflicts([
        { kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
        { kind: 'subnet', target: '192.168.0.0/16', iface: 'wifi' },
      ]),
    ).toEqual([]);
  });

  it('skips rules with an invalid target', () => {
    expect(
      findIfaceConflicts([
        { kind: 'ip', target: 'bogus', iface: 'ethernet' },
        { kind: 'ip', target: 'bogus', iface: 'wifi' },
      ]),
    ).toEqual([]);
  });
});

describe('findOverlaps', () => {
  const net = (target: string, kind: 'ip' | 'subnet' | 'domain' = 'subnet') => ({ kind, target });

  it('returns nothing for disjoint rules', () => {
    expect(findOverlaps([net('10.0.0.0/8'), net('192.168.0.0/16'), net('172.16.12.40', 'ip')])).toEqual([]);
  });

  it('reports a subnet nested in a wider one, whatever the order', () => {
    const wide = net('10.0.0.0/8');
    const narrow = net('10.20.0.0/16');
    expect(findOverlaps([wide, narrow])).toEqual([{ wider: wide, narrower: narrow }]);
    expect(findOverlaps([narrow, wide])).toEqual([{ wider: wide, narrower: narrow }]);
  });

  it('reports an ip rule inside a subnet', () => {
    const wide = net('10.0.0.0/8');
    const host = net('10.20.0.10', 'ip');
    expect(findOverlaps([host, wide])).toEqual([{ wider: wide, narrower: host }]);
  });

  it('reports identical destinations with the earlier rule as the wider one', () => {
    const first = net('172.16.12.40', 'ip');
    const second = net('172.16.12.40/32');
    expect(findOverlaps([first, second])).toEqual([{ wider: first, narrower: second }]);
  });

  it('reports every pair of a nested chain', () => {
    const a = net('10.0.0.0/8');
    const b = net('10.20.0.0/16');
    const c = net('10.20.0.10', 'ip');
    expect(findOverlaps([a, b, c])).toEqual([
      { wider: a, narrower: b },
      { wider: a, narrower: c },
      { wider: b, narrower: c },
    ]);
  });

  it('skips domain rules and invalid targets', () => {
    expect(findOverlaps([net('10.0.0.0/8'), net('corp.local', 'domain'), net('10.0.0.0/33'), net('', 'ip')])).toEqual(
      [],
    );
  });

  it('returns the rule objects it was given', () => {
    const parsed = Config.parse(config([rule(), rule({ id: uuid(2), target: '10.20.0.0/16', iface: 'wifi' })]));
    const [overlap] = findOverlaps(parsed.rules);
    expect(overlap?.wider.id).toBe(uuid(1));
    expect(overlap?.narrower.id).toBe(uuid(2));
  });
});
