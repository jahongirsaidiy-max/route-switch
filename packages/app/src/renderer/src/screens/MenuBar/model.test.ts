import { RECONCILE_REASONS, RULE_REASON_CODES, type EngineState } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { CONFIG, ID, NOW, ORDER_WIFI_FIRST, STATE, ruleState } from './fixtures';
import {
  MENU_RULE_LIMIT,
  defaultRole,
  errorCount,
  formatAgo,
  formatClock,
  interfacesKey,
  menuRules,
  ruleDetail,
  ruleNotice,
  statusLine,
} from './model';
import { RECONCILE_REASON_TEXT, RULE_REASON_TEXT, isActiveWarning, ruleReasonText } from './ruleText';

const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const withRules = (rules: EngineState['rules'], extra: Partial<EngineState> = {}): EngineState => ({ ...STATE, rules, ...extra });

describe('reason texts', () => {
  it('every rule reason code and reconcile reason of the protocol has words', () => {
    for (const code of RULE_REASON_CODES) expect(RULE_REASON_TEXT[code].length).toBeGreaterThan(0);
    for (const reason of RECONCILE_REASONS) expect(RECONCILE_REASON_TEXT[reason].length).toBeGreaterThan(0);
    expect(Object.keys(RULE_REASON_TEXT).sort()).toEqual([...RULE_REASON_CODES].sort());
  });

  it('the active warnings (TASK-DELTA-07) are warnings, not errors', () => {
    for (const code of ['addresses-truncated', 'overridden-by-rule', 'dns-server-excluded'] as const) {
      expect(isActiveWarning({ status: 'active', reasonCode: code })).toBe(true);
    }
    expect(isActiveWarning({ status: 'active', reasonCode: null })).toBe(false);
    expect(isActiveWarning({ status: 'error', reasonCode: 'route-failed' })).toBe(false);
    expect(RULE_REASON_TEXT['overridden-by-rule']).toContain('boshqa qoida');
    expect(RULE_REASON_TEXT['dns-server-excluded']).toContain('DNS server');
  });

  it('ruleReasonText is null without a code', () => {
    expect(ruleReasonText({ reasonCode: null })).toBeNull();
    expect(ruleReasonText({ reasonCode: 'interface-down' })).toBe('Interfeys ulanmagan');
  });
});

describe('formatAgo', () => {
  it.each([
    [0, 'hozirgina'],
    [59_999, 'hozirgina'],
    [MINUTE, '1 daq oldin'],
    [2 * MINUTE + 5_000, '2 daq oldin'],
    [59 * MINUTE, '59 daq oldin'],
    [60 * MINUTE, '1 soat oldin'],
    [23 * 60 * MINUTE, '23 soat oldin'],
    [24 * 60 * MINUTE, '1 kun oldin'],
    [-5 * MINUTE, 'hozirgina'],
  ])('%i ms ago reads %s', (ms, text) => {
    expect(formatAgo(ago(ms), NOW)).toBe(text);
  });

  it('an unreadable time reads as just now', () => {
    expect(formatAgo('not a time', NOW)).toBe('hozirgina');
  });
});

describe('formatClock', () => {
  it('local HH:MM today, with the date before it on another day', () => {
    expect(formatClock(new Date(2026, 9, 14, 9, 5).toISOString(), NOW)).toBe('09:05');
    expect(formatClock(new Date(2026, 9, 13, 23, 59).toISOString(), NOW)).toBe('13.10 23:59');
    expect(formatClock(new Date(2025, 9, 14, 10, 0).toISOString(), NOW)).toBe('14.10 10:00');
    expect(formatClock('nope', NOW)).toBe('—');
  });
});

describe('ruleDetail', () => {
  const rule = (id: string) => {
    const found = CONFIG.rules.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };
  const stateOf = (id: string) => STATE.rules.find((entry) => entry.ruleId === id) ?? null;

  it('the note when there is one', () => {
    expect(ruleDetail(rule(ID.subnet), stateOf(ID.subnet), NOW)).toBe('Ichki tarmoq');
  });

  it('a blank note does not count', () => {
    expect(ruleDetail({ ...rule(ID.host), note: '   ' }, stateOf(ID.host), NOW)).toBe('');
  });

  it('a domain with its own DNS server names it', () => {
    expect(ruleDetail(rule(ID.dnsDomain), stateOf(ID.dnsDomain), NOW)).toBe('DNS: 10.20.0.10');
  });

  it('another domain says how many addresses it resolved to, and when', () => {
    expect(ruleDetail(rule(ID.domain), stateOf(ID.domain), NOW)).toBe('3 IP · 2 daq oldin');
    expect(ruleDetail(rule(ID.domain), ruleState(ID.domain), NOW)).toBe('');
    expect(ruleDetail(rule(ID.domain), null, NOW)).toBe('');
  });
});

describe('ruleNotice', () => {
  it('nothing for a plain active rule or one without state', () => {
    expect(ruleNotice(ruleState(ID.host))).toBeNull();
    expect(ruleNotice(null)).toBeNull();
  });

  it('a status tag with the translated reason for pending and error', () => {
    expect(ruleNotice(ruleState(ID.host, { status: 'pending', reasonCode: 'interface-down' }))).toEqual({
      kind: 'status',
      status: 'pending',
      text: 'Interfeys ulanmagan',
    });
    expect(ruleNotice(ruleState(ID.host, { status: 'error', reasonCode: 'route-failed' }))).toEqual({
      kind: 'status',
      status: 'error',
      text: "Route qo'shilmadi",
    });
  });

  it('a warning mark for active with a warning code', () => {
    expect(ruleNotice(ruleState(ID.domain, { reasonCode: 'overridden-by-rule' }))).toEqual({
      kind: 'warning',
      text: RULE_REASON_TEXT['overridden-by-rule'],
    });
  });

  it('nothing for disabled (the global switch says it)', () => {
    expect(ruleNotice(ruleState(ID.host, { status: 'disabled', reasonCode: 'globally-disabled' }))).toBeNull();
  });
});

describe('menuRules', () => {
  it('lists the first four enabled rules in config order and counts the rest', () => {
    const rules = menuRules(CONFIG, STATE, NOW);
    expect(MENU_RULE_LIMIT).toBe(4);
    expect(rules.shown.map((rule) => rule.target)).toEqual(['10.0.0.0/8', 'corp.local', '172.16.12.40', 'github.com']);
    expect(rules.shown.map((rule) => rule.iface)).toEqual(['ethernet', 'ethernet', 'ethernet', 'wifi']);
    expect(rules.total).toBe(5);
    expect(rules.hidden).toBe(1);
    // 1 + 2 + 1 + 3 + 1 routes; the disabled rule has none.
    expect(rules.routes).toBe(8);
  });

  it('shows all when there are no more than the limit', () => {
    const rules = menuRules({ ...CONFIG, rules: CONFIG.rules.slice(0, 3) }, STATE, NOW);
    expect(rules.shown).toHaveLength(2);
    expect(rules.hidden).toBe(0);
  });

  it('a rule the state does not know yet (config one revision ahead) is listed without a notice', () => {
    const rules = menuRules(CONFIG, withRules([]), NOW);
    expect(rules.shown[0]).toEqual({ id: ID.subnet, iface: 'ethernet', target: '10.0.0.0/8', detail: 'Ichki tarmoq', notice: null });
    expect(rules.routes).toBe(0);
  });

  it('carries each rule’s notice', () => {
    const rules = menuRules(
      CONFIG,
      withRules([ruleState(ID.subnet, { status: 'error', reasonCode: 'connected-network' }), ruleState(ID.domain, { reasonCode: 'dns-server-excluded' })]),
      NOW,
    );
    expect(rules.shown[0]?.notice).toMatchObject({ kind: 'status', status: 'error' });
    expect(rules.shown[3]?.notice).toMatchObject({ kind: 'warning' });
  });
});

describe('errorCount', () => {
  it('counts only error: an active rule with a warning code and a pending rule are not errors', () => {
    const state = withRules([
      ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' }),
      ruleState(ID.host, { status: 'error', reasonCode: 'forbidden-destination' }),
      ruleState(ID.domain, { reasonCode: 'overridden-by-rule' }),
      ruleState(ID.dnsDomain, { reasonCode: 'dns-server-excluded' }),
      ruleState(ID.test, { reasonCode: 'addresses-truncated' }),
      ruleState(ID.off, { status: 'pending', reasonCode: 'interface-down' }),
    ]);
    expect(errorCount(state)).toBe(2);
    expect(errorCount(STATE)).toBe(0);
  });
});

describe('statusLine', () => {
  it('last apply time and what triggered it', () => {
    expect(statusLine(STATE, NOW)).toEqual({
      tone: 'success',
      text: "Oxirgi qo'llash: 10:58 · tarmoq o'zgarganda",
      errors: null,
    });
  });

  it('errors are counted, warnings are not', () => {
    const state = withRules([
      ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' }),
      ruleState(ID.domain, { reasonCode: 'overridden-by-rule' }),
    ]);
    expect(statusLine(state, NOW)).toMatchObject({ tone: 'danger', errors: '1 ta qoidada xato' });
    expect(statusLine(withRules([ruleState(ID.domain, { reasonCode: 'dns-server-excluded' })]), NOW)).toMatchObject({
      tone: 'success',
      errors: null,
    });
  });

  it('before the first apply, and without a trigger', () => {
    expect(statusLine({ ...STATE, lastApplyAt: null }, NOW).text).toBe("Hali qo'llanmagan");
    expect(statusLine({ ...STATE, lastReconcileReason: null }, NOW).text).toBe("Oxirgi qo'llash: 10:58");
  });

  it('with routing off it says so instead', () => {
    expect(statusLine({ ...STATE, enabled: false }, NOW)).toEqual({
      tone: 'neutral',
      text: "Routing o'chirilgan — qoidalar qo'llanmaydi",
      errors: null,
    });
  });
});

describe('defaultRole', () => {
  it('the first enabled service of the order whose role is connected', () => {
    expect(defaultRole(ORDER_WIFI_FIRST, STATE.interfaces)).toBe('wifi');
    const ethernetFirst = { ...ORDER_WIFI_FIRST, services: [...ORDER_WIFI_FIRST.services].reverse() };
    expect(defaultRole(ethernetFirst, STATE.interfaces)).toBe('ethernet');
  });

  it('skips services that are switched off or whose interface carries no traffic', () => {
    const [wifi, lan] = ORDER_WIFI_FIRST.services;
    if (wifi === undefined || lan === undefined) throw new Error('fixture');
    expect(defaultRole({ ...ORDER_WIFI_FIRST, services: [{ ...wifi, enabled: false }, lan] }, STATE.interfaces)).toBe('ethernet');
    const noWifiGateway = { ...STATE.interfaces, wifi: { ...STATE.interfaces.wifi, gateway: null } };
    expect(defaultRole(ORDER_WIFI_FIRST, noWifiGateway)).toBe('ethernet');
    const wifiDown = { ...STATE.interfaces, wifi: { device: 'en0', ip: null, gateway: null, up: false } };
    expect(defaultRole(ORDER_WIFI_FIRST, wifiDown)).toBe('ethernet');
  });

  it('null when the order is unknown or no role is connected', () => {
    expect(defaultRole(null, STATE.interfaces)).toBeNull();
    const none = {
      ethernet: { device: null, ip: null, gateway: null, up: false },
      wifi: { device: 'en0', ip: null, gateway: null, up: false },
    };
    expect(defaultRole(ORDER_WIFI_FIRST, none)).toBeNull();
    expect(defaultRole({ ...ORDER_WIFI_FIRST, services: [{ name: 'X', hardwarePort: null, device: null, enabled: true }] }, STATE.interfaces)).toBeNull();
  });
});

describe('interfacesKey', () => {
  it('changes with device, link, address or gateway of either role, and only then', () => {
    const base = interfacesKey(STATE.interfaces);
    expect(interfacesKey({ ...STATE.interfaces })).toBe(base);
    const variants = [
      { ...STATE.interfaces, wifi: { ...STATE.interfaces.wifi, device: 'en1' } },
      { ...STATE.interfaces, wifi: { ...STATE.interfaces.wifi, gateway: '192.168.0.254' } },
      { ...STATE.interfaces, ethernet: { ...STATE.interfaces.ethernet, ip: '10.20.4.38' } },
      { ...STATE.interfaces, ethernet: { device: 'en5', ip: null, gateway: null, up: false } },
    ];
    for (const variant of variants) expect(interfacesKey(variant)).not.toBe(base);
  });
});
