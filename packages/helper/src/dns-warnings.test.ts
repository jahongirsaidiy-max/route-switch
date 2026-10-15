import { DnsWarning, PROTOCOL_LIMITS, type IfaceRole, type Rule } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import {
  MAX_DNS_ROUTE_LOOKUPS,
  MAX_DNS_WARNINGS,
  dnsWarningsSignature,
  findDnsWarnings,
  serversToLookUp,
  type DnsWarningInput,
  type DnsWarningInterface,
  type ServerRoute,
} from './dns-warnings';

// Generic documentation-style addresses only (public repo).
const ETH_GW = '10.20.4.1';
const WIFI_GW = '192.168.1.1';

const ruleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const eth = (extra: Partial<DnsWarningInterface> = {}): DnsWarningInterface => ({
  device: 'en5',
  up: true,
  routable: true,
  ip: '10.20.4.23',
  gateway: ETH_GW,
  subnet: '10.20.4.0/24',
  ...extra,
});
const wifi = (extra: Partial<DnsWarningInterface> = {}): DnsWarningInterface => ({
  device: 'en0',
  up: true,
  routable: true,
  ip: '192.168.1.23',
  gateway: WIFI_GW,
  subnet: '192.168.1.0/24',
  ...extra,
});
const DOWN: Partial<DnsWarningInterface> = { device: null, up: false, routable: false, ip: null, gateway: null, subnet: null };

type InputRule = DnsWarningInput['rules'][number];
const domainRule = (n: number, iface: IfaceRole, dns: string | undefined, extra: Partial<Rule> = {}): InputRule => ({
  id: ruleId(n),
  kind: 'domain',
  enabled: true,
  iface,
  ...(dns === undefined ? {} : { dns }),
  ...extra,
});

const input = (extra: Partial<DnsWarningInput> = {}): DnsWarningInput => ({
  interfaces: { ethernet: eth(), wifi: wifi() },
  dnsServers: {},
  rules: [],
  applied: [],
  ...extra,
});

/** `findDnsWarnings` with the table answering `answers` (server -> route), nothing else looked up. */
const warnings = (base: DnsWarningInput, answers: Readonly<Record<string, ServerRoute>> = {}) => {
  const asked: string[] = [];
  const found = findDnsWarnings({
    ...base,
    routeOf: (server) => {
      asked.push(server);
      return Object.hasOwn(answers, server) ? answers[server] : undefined;
    },
  });
  for (const warning of found) expect(DnsWarning.safeParse(warning).success).toBe(true);
  return { found, asked };
};

describe('findDnsWarnings — interface servers', () => {
  it('warns about an Ethernet server inside the Wi-Fi connected subnet (the motivating case), without asking the table', () => {
    const base = input({ dnsServers: { ethernet: ['192.168.1.53'] } });
    expect(serversToLookUp(base)).toEqual([]);
    const { found, asked } = warnings(base);
    expect(found).toEqual([
      { server: '192.168.1.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'other-interface-subnet' },
    ]);
    expect(asked).toEqual([]);
  });

  it('is symmetric: a Wi-Fi server inside the Ethernet subnet', () => {
    expect(warnings(input({ dnsServers: { wifi: ['10.20.4.53'] } })).found).toEqual([
      { server: '10.20.4.53', source: 'interface', role: 'wifi', via: 'ethernet', code: 'other-interface-subnet' },
    ]);
  });

  it('says nothing about a server in its own connected subnet', () => {
    const base = input({ dnsServers: { ethernet: ['10.20.4.53'], wifi: ['192.168.1.1'] } });
    expect(serversToLookUp(base)).toEqual([]);
    expect(warnings(base).found).toEqual([]);
  });

  it('says nothing when both interfaces are on the same network (equal prefixes), and asks nothing', () => {
    const base = input({
      interfaces: { ethernet: eth({ ip: '192.168.1.40', gateway: WIFI_GW, subnet: '192.168.1.0/24' }), wifi: wifi() },
      dnsServers: { ethernet: ['192.168.1.1'] },
    });
    expect(serversToLookUp(base)).toEqual([]);
    expect(warnings(base).found).toEqual([]);
    // Whichever role is judged: the tie is found whatever the order the subnets are looked at in.
    const wifiSide = { ...base, dnsServers: { wifi: ['192.168.1.1'] } };
    expect(warnings(wifiSide).found).toEqual([]);
  });

  it('warns when the other subnet is more specific than the own one that also holds the server', () => {
    const base = input({
      interfaces: { ethernet: eth({ subnet: '10.20.0.0/16' }), wifi: wifi({ ip: '10.20.5.9', gateway: '10.20.5.1', subnet: '10.20.5.0/24' }) },
      dnsServers: { ethernet: ['10.20.5.53'] },
    });
    expect(warnings(base).found).toMatchObject([{ server: '10.20.5.53', code: 'other-interface-subnet', via: 'wifi' }]);
  });

  it('says nothing when the own subnet is the more specific one', () => {
    const base = input({
      interfaces: { ethernet: eth({ ip: '10.20.5.9', gateway: '10.20.5.1', subnet: '10.20.5.0/24' }), wifi: wifi({ subnet: '10.20.0.0/16' }) },
      dnsServers: { ethernet: ['10.20.5.53'] },
    });
    expect(warnings(base).found).toEqual([]);
  });

  it('ignores a subnet of an interface that is not up', () => {
    // Wi-Fi is down but (stale) still has a subnet: it cannot carry the query.
    const base = input({
      interfaces: { ethernet: eth(), wifi: wifi({ up: false, routable: false, device: null }) },
      dnsServers: { ethernet: ['192.168.1.53'] },
    });
    expect(serversToLookUp(base)).toEqual([]);
    expect(warnings(base).found).toEqual([]);
  });

  it('ignores an unknown subnet', () => {
    const base = input({
      interfaces: { ethernet: eth(), wifi: wifi({ subnet: null }) },
      dnsServers: { ethernet: ['192.168.1.53'] },
    });
    // Nothing of ours decides any more: the table is asked.
    expect(serversToLookUp(base)).toEqual(['192.168.1.53']);
    expect(warnings(base).found).toEqual([]);
  });

  it('judges no server of a role that is down or has no gateway', () => {
    // Each condition on its own, also in combinations the detection never produces.
    for (const ethernet of [eth(DOWN), eth({ gateway: null, routable: false }), eth({ routable: false }), eth({ gateway: null }), eth({ up: false })]) {
      const base = input({ interfaces: { ethernet, wifi: wifi() }, dnsServers: { ethernet: ['192.168.1.53'] } });
      expect(serversToLookUp(base)).toEqual([]);
      expect(warnings(base).found).toEqual([]);
    }
  });

  it('says nothing for a role whose servers are not known', () => {
    expect(warnings(input({ dnsServers: { wifi: [] } })).found).toEqual([]);
  });

  it('skips values that are not a single IPv4 address', () => {
    const base = input({ dnsServers: { ethernet: ['192.168.1.0/24', 'not-an-address', '', '192.168.1.53'] } });
    expect(warnings(base).found.map((warning) => warning.server)).toEqual(['192.168.1.53']);
  });
});

describe('findDnsWarnings — applied routes', () => {
  it('says nothing once a route of ours takes the server through its own role (the fix: an `ip` rule)', () => {
    const base = input({
      dnsServers: { ethernet: ['192.168.1.53'] },
      applied: [{ dst: '192.168.1.53', gateway: ETH_GW }],
    });
    expect(warnings(base).found).toEqual([]);
  });

  it('warns about a route of ours that takes the server through the other role, even inside its own subnet', () => {
    const base = input({
      dnsServers: { ethernet: ['10.20.4.53'] },
      applied: [{ dst: '10.20.4.53', gateway: WIFI_GW }],
    });
    expect(warnings(base).found).toEqual([
      { server: '10.20.4.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'routed-via-other-interface' },
    ]);
  });

  it('lets the more specific connected subnet win over a wider route of ours', () => {
    // `10.0.0.0/8` through Ethernet, but Wi-Fi sits in 10.1.1.0/24 where the server is: the /24 wins.
    const base = input({
      interfaces: { ethernet: eth(), wifi: wifi({ ip: '10.1.1.9', gateway: '10.1.1.1', subnet: '10.1.1.0/24' }) },
      dnsServers: { ethernet: ['10.1.1.53'] },
      applied: [{ dst: '10.0.0.0/8', gateway: ETH_GW }],
    });
    expect(warnings(base).found).toMatchObject([{ server: '10.1.1.53', code: 'other-interface-subnet' }]);
  });

  it('calls it a subnet problem when a route of ours through the other role is that very subnet', () => {
    // Never added by the engine (connected-subnet guard), but an entry like it decides nothing else.
    const base = input({ dnsServers: { ethernet: ['192.168.1.53'] }, applied: [{ dst: '192.168.1.0/24', gateway: WIFI_GW }] });
    expect(warnings(base).found).toMatchObject([{ code: 'other-interface-subnet' }]);
  });

  it('counts a wider route of ours when no connected subnet holds the server', () => {
    const base = input({
      dnsServers: { ethernet: ['172.16.0.53'] },
      applied: [{ dst: '172.16.0.0/12', gateway: ETH_GW }],
    });
    expect(serversToLookUp(base)).toEqual([]);
    expect(warnings(base).found).toEqual([]);
  });

  it('ignores a route through a gateway of neither role, or of both', () => {
    const neither = input({ dnsServers: { ethernet: ['192.168.1.53'] }, applied: [{ dst: '192.168.1.53', gateway: '10.99.0.1' }] });
    expect(warnings(neither).found).toMatchObject([{ code: 'other-interface-subnet' }]);

    const shared = input({
      interfaces: { ethernet: eth({ gateway: '10.30.0.1' }), wifi: wifi({ gateway: '10.30.0.1' }) },
      dnsServers: { ethernet: ['192.168.1.53'] },
      applied: [{ dst: '192.168.1.53', gateway: '10.30.0.1' }],
    });
    expect(warnings(shared).found).toMatchObject([{ code: 'other-interface-subnet' }]);
  });

  it('ignores an applied entry that is not a destination', () => {
    const base = input({ dnsServers: { ethernet: ['192.168.1.53'] }, applied: [{ dst: 'default', gateway: ETH_GW }] });
    expect(warnings(base).found).toMatchObject([{ code: 'other-interface-subnet' }]);
  });
});

describe('findDnsWarnings — the routing table', () => {
  const OUTSIDE = input({ dnsServers: { ethernet: ['198.51.100.53'] } });

  it('asks the table only for a server none of our facts decides', () => {
    expect(serversToLookUp(OUTSIDE)).toEqual(['198.51.100.53']);
  });

  it('warns when the table takes the server through the other role', () => {
    const { found, asked } = warnings(OUTSIDE, { '198.51.100.53': { device: 'en0' } });
    expect(asked).toEqual(['198.51.100.53']);
    expect(found).toEqual([
      { server: '198.51.100.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'routed-via-other-interface' },
    ]);
  });

  it('says nothing when the table takes it through its own role, another device, gives no answer, or was not asked', () => {
    for (const answers of [{ '198.51.100.53': { device: 'en5' } }, { '198.51.100.53': { device: 'utun3' } }, { '198.51.100.53': null }, {}]) {
      expect(warnings(OUTSIDE, answers).found).toEqual([]);
    }
  });

  it('asks nothing when the other role is not up or has no device', () => {
    for (const other of [wifi(DOWN), wifi({ device: null }), wifi({ up: false, subnet: null })]) {
      const base = input({ interfaces: { ethernet: eth(), wifi: other }, dnsServers: { ethernet: ['198.51.100.53'] } });
      expect(serversToLookUp(base)).toEqual([]);
      expect(warnings(base, { '198.51.100.53': { device: 'en0' } }).found).toEqual([]);
    }
  });

  it('looks a server up once, whatever the roles and rules that name it, and at most MAX_DNS_ROUTE_LOOKUPS', () => {
    const base = input({
      dnsServers: { ethernet: ['198.51.100.53'], wifi: ['198.51.100.53'] },
      rules: [domainRule(1, 'ethernet', '198.51.100.53')],
    });
    expect(serversToLookUp(base)).toEqual(['198.51.100.53']);

    const many = Array.from({ length: 20 }, (_, index) => `198.51.100.${String(index + 1)}`);
    const wide = input({ dnsServers: { ethernet: many } });
    expect(MAX_DNS_ROUTE_LOOKUPS).toBe(16);
    expect(serversToLookUp(wide)).toEqual(many.slice(0, 16));
  });
});

describe('findDnsWarnings — rule servers', () => {
  it('warns about the `dns` of an enabled domain rule that no route of ours carries, with the rule id', () => {
    const base = input({ rules: [domainRule(1, 'ethernet', '192.168.1.53')] });
    expect(warnings(base).found).toEqual([
      { server: '192.168.1.53', source: 'rule', role: 'ethernet', via: 'wifi', ruleId: ruleId(1), code: 'other-interface-subnet' },
    ]);
  });

  it('says nothing once the engine routes the rule server through the rule interface', () => {
    const base = input({ rules: [domainRule(1, 'ethernet', '192.168.1.53')], applied: [{ dst: '192.168.1.53', gateway: ETH_GW }] });
    expect(warnings(base).found).toEqual([]);
  });

  it('skips disabled rules, rules without `dns`, non-domain rules and rules whose interface is not routable', () => {
    const base = input({
      interfaces: { ethernet: eth(), wifi: wifi() },
      rules: [
        domainRule(1, 'ethernet', '192.168.1.53', { enabled: false }),
        domainRule(2, 'ethernet', undefined),
        domainRule(3, 'ethernet', '192.168.1.54', { kind: 'ip' }),
      ],
    });
    expect(warnings(base).found).toEqual([]);
    const ethDown = input({ interfaces: { ethernet: eth(DOWN), wifi: wifi() }, rules: [domainRule(4, 'ethernet', '192.168.1.53')] });
    expect(warnings(ethDown).found).toEqual([]);
  });
});

describe('findDnsWarnings — order, duplicates and bounds', () => {
  it('reports interfaces first (Ethernet, Wi-Fi, in the order asked), then rules in config order, each server and role once', () => {
    const base = input({
      dnsServers: { ethernet: ['192.168.1.54', '192.168.1.53', '192.168.1.54'], wifi: ['10.20.4.53'] },
      rules: [
        domainRule(1, 'wifi', '10.20.4.60'),
        // Same server and role as an interface server: not reported twice.
        domainRule(2, 'ethernet', '192.168.1.53'),
        domainRule(3, 'ethernet', '192.168.1.61'),
        // Same server and role as rule 3: the first rule is the one reported.
        domainRule(4, 'ethernet', '192.168.1.61'),
      ],
    });
    const { found } = warnings(base);
    expect(found.map((warning) => [warning.source, warning.role, warning.server, warning.ruleId])).toEqual([
      ['interface', 'ethernet', '192.168.1.54', undefined],
      ['interface', 'ethernet', '192.168.1.53', undefined],
      ['interface', 'wifi', '10.20.4.53', undefined],
      ['rule', 'wifi', '10.20.4.60', ruleId(1)],
      ['rule', 'ethernet', '192.168.1.61', ruleId(3)],
    ]);
    // Stable: the same input gives the same list.
    expect(warnings(base).found).toEqual(found);
  });

  it('reports the same server once per role', () => {
    const base = input({
      interfaces: {
        ethernet: eth(),
        wifi: wifi(),
      },
      dnsServers: { ethernet: ['198.51.100.53'], wifi: ['198.51.100.53'] },
    });
    const { found } = warnings(base, { '198.51.100.53': { device: 'en0' } });
    // Through Wi-Fi: wrong for Ethernet, right for Wi-Fi.
    expect(found).toMatchObject([{ role: 'ethernet', via: 'wifi' }]);
  });

  it('stops at MAX_DNS_WARNINGS, the protocol bound', () => {
    expect(MAX_DNS_WARNINGS).toBe(PROTOCOL_LIMITS.maxDnsWarnings);
    const many = Array.from({ length: 20 }, (_, index) => `192.168.1.${String(index + 100)}`);
    const { found } = warnings(input({ dnsServers: { ethernet: many } }));
    expect(found).toHaveLength(MAX_DNS_WARNINGS);
    expect(found.map((warning) => warning.server)).toEqual(many.slice(0, MAX_DNS_WARNINGS));
  });

  it('gives nothing for no servers and no rules', () => {
    expect(warnings(input()).found).toEqual([]);
    expect(serversToLookUp(input())).toEqual([]);
  });
});

describe('dnsWarningsSignature', () => {
  it('changes with any field that is reported, and is empty for none', () => {
    const one = warnings(input({ dnsServers: { ethernet: ['192.168.1.53'] } })).found;
    const rule = warnings(input({ rules: [domainRule(1, 'ethernet', '192.168.1.53')] })).found;
    const other = warnings(input({ dnsServers: { ethernet: ['192.168.1.54'] } })).found;
    expect(dnsWarningsSignature([])).toBe('');
    expect(dnsWarningsSignature(one)).not.toBe(dnsWarningsSignature(rule));
    expect(dnsWarningsSignature(one)).not.toBe(dnsWarningsSignature(other));
    expect(dnsWarningsSignature(one)).toBe(dnsWarningsSignature([...one]));
  });
});
