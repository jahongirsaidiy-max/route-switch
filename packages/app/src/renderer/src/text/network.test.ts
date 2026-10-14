import type { EngineState } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { CONFIG, ID, NOW, STATE, ruleState } from '../screens/MenuBar/fixtures';
import { LAST_KNOWN_SHOWN, lastKnownShort, lastKnownText, networkWarnings, sameSubnetGateway } from './network';

const MINUTE = 60_000;
const down = { device: 'en5', ip: null, gateway: null, up: false } as const;

const withEthernet = (ethernet: EngineState['interfaces']['ethernet'], waitingIds: string[], reasonCode: 'interface-down' | 'no-gateway' = 'interface-down'): EngineState => ({
  ...STATE,
  interfaces: { ...STATE.interfaces, ethernet },
  rules: STATE.rules.map((rule) => (waitingIds.includes(rule.ruleId) ? ruleState(rule.ruleId, { status: 'pending', reasonCode }) : rule)),
});

describe('networkWarnings — rules waiting for an interface', () => {
  it('names the role and counts its waiting rules from the config', () => {
    expect(networkWarnings(withEthernet(down, [ID.subnet, ID.host]), CONFIG)).toEqual([
      { id: 'waiting-ethernet', title: 'Ethernet ulanmagan', text: "2 ta qoida kutilmoqda — interfeys ulanganda avtomatik qo'llanadi." },
    ]);
  });

  it("says why: no adapter, or up without a gateway", () => {
    const missing = networkWarnings(withEthernet({ device: null, ip: null, gateway: null, up: false }, [ID.subnet]), CONFIG);
    expect(missing[0]?.title).toBe('Ethernet adapteri topilmadi');
    const noGateway = networkWarnings(withEthernet({ device: 'en5', ip: '10.20.4.37', gateway: null, up: true }, [ID.subnet], 'no-gateway'), CONFIG);
    expect(noGateway[0]?.title).toBe("Ethernet'da gateway yo'q");
  });

  it('each role on its own: a Wi‑Fi rule waiting does not count for Ethernet', () => {
    const state: EngineState = {
      ...STATE,
      interfaces: { ...STATE.interfaces, wifi: { device: 'en0', ip: null, gateway: null, up: false } },
      rules: STATE.rules.map((rule) => (rule.ruleId === ID.domain ? ruleState(ID.domain, { status: 'pending', reasonCode: 'interface-down' }) : rule)),
    };
    expect(networkWarnings(state, CONFIG).map((warning) => [warning.id, warning.title, warning.text])).toEqual([
      ['waiting-wifi', 'Wi‑Fi ulanmagan', "1 ta qoida kutilmoqda — interfeys ulanganda avtomatik qo'llanadi."],
    ]);
  });

  it('nothing for a rule that is resolving, nothing with routing off, nothing when no rule waits', () => {
    // The interface is down, but no rule of it waits (say, all switched off).
    expect(networkWarnings(withEthernet(down, []), CONFIG)).toEqual([]);
    const resolving = { ...STATE, rules: [ruleState(ID.domain, { status: 'pending', reasonCode: 'resolving' })] };
    expect(networkWarnings(resolving, CONFIG)).toEqual([]);
    expect(networkWarnings({ ...withEthernet(down, [ID.subnet]), enabled: false }, CONFIG)).toEqual([]);
  });

  it('without the config: no count, and only for an interface that is not usable', () => {
    const warnings = networkWarnings(withEthernet(down, [ID.subnet]), null);
    expect(warnings).toEqual([
      { id: 'waiting-ethernet', title: 'Ethernet ulanmagan', text: "Unga bog'langan qoidalar kutilmoqda — interfeys ulanganda avtomatik qo'llanadi." },
    ]);
  });
});

describe('networkWarnings — one subnet', () => {
  const both = (ethernet: Partial<EngineState['interfaces']['ethernet']>, wifi: Partial<EngineState['interfaces']['wifi']> = {}): EngineState => ({
    ...STATE,
    interfaces: {
      ethernet: { device: 'en5', ip: '192.168.1.20', gateway: '192.168.1.1', up: true, ...ethernet },
      wifi: { device: 'en0', ip: '192.168.1.30', gateway: '192.168.1.1', up: true, ...wifi },
    },
  });

  it('both up behind one gateway: warned, with the gateway, also with routing off', () => {
    const [warning] = networkWarnings({ ...both({}), enabled: false }, CONFIG);
    expect(warning?.id).toBe('same-subnet');
    expect(warning?.title).toBe('Ethernet va Wi‑Fi bitta tarmoqda');
    expect(warning?.text).toContain("gateway'i 192.168.1.1");
    expect(warning?.text).toContain('gateway orqali route ishonchsiz');
  });

  it.each([
    ['different gateways', both({ gateway: '10.0.0.1' })],
    ['Ethernet down', both({ up: false, ip: null, gateway: null })],
    ['Wi‑Fi down', both({}, { up: false, ip: null, gateway: null })],
    ['no gateway on either', both({ gateway: null }, { gateway: null })],
  ])('not for %s', (_name, state) => {
    expect(sameSubnetGateway(state.interfaces)).toBeNull();
    expect(networkWarnings(state, CONFIG).some((warning) => warning.id === 'same-subnet')).toBe(false);
  });
});

describe('lastKnownText / lastKnownShort — a domain rule in error', () => {
  const domain = CONFIG.rules[4];
  const withDns = CONFIG.rules[2];
  if (domain === undefined || withDns === undefined) throw new Error('fixture');
  const failed = (appliedDestinations: string[], lastResolvedAt: string | null = new Date(NOW - 12 * MINUTE).toISOString()) =>
    ruleState(domain.id, { status: 'error', reasonCode: 'resolve-failed', appliedDestinations, lastResolvedAt });

  it('names the addresses it still routes, counts the rest, and dates the last answer', () => {
    expect(lastKnownText(domain, failed(['140.82.112.3', '140.82.112.4']), NOW)).toBe(
      "Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): 140.82.112.3, 140.82.112.4 · 12 daq oldin",
    );
    const many = ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4', '1.1.1.5'];
    expect(LAST_KNOWN_SHOWN).toBe(3);
    expect(lastKnownText(domain, failed(many, null), NOW)).toBe("Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): 1.1.1.1, 1.1.1.2, 1.1.1.3 +2");
    expect(lastKnownShort(domain, failed(many))).toBe('1.1.1.1 +4');
    expect(lastKnownShort(domain, failed(['1.1.1.1']))).toBe('1.1.1.1');
  });

  it("leaves out the rule's own DNS server, which is routed too", () => {
    const state = ruleState(withDns.id, { status: 'error', reasonCode: 'no-addresses', appliedDestinations: ['10.20.0.10', '10.20.1.5'] });
    expect(lastKnownText(withDns, state, NOW)).toBe("Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): 10.20.1.5");
    expect(lastKnownShort(withDns, state)).toBe('10.20.1.5');
  });

  it('says when nothing is routed any more', () => {
    expect(lastKnownText(domain, failed([]), NOW)).toBe("Oxirgi ma'lum IP yo'q — domen hozir yo'naltirilmayapti.");
    expect(lastKnownShort(domain, failed([]))).toBeNull();
  });

  it('nothing for a rule that is not in error, or not a domain', () => {
    expect(lastKnownText(domain, ruleState(domain.id, { appliedDestinations: ['1.1.1.1'] }), NOW)).toBeNull();
    expect(lastKnownText({ kind: 'subnet' }, ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' }), NOW)).toBeNull();
    expect(lastKnownShort({ kind: 'ip' }, ruleState(ID.host, { status: 'error', reasonCode: 'route-failed', appliedDestinations: ['1.1.1.1'] }))).toBeNull();
  });
});
