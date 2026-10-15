import type { EngineState } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { CONFIG, ID, NOW, ORDER_WIFI_FIRST, STATE, ruleState } from './fixtures';
import {
  MENU_RULE_LIMIT,
  defaultRole,
  errorCount,
  interfacesKey,
  menuRules,
  ruleDetail,
  ruleNotice,
  statusLine,
} from './model';
import { i18nFor } from '../../../../i18n';
import { RULE_REASON_TEXT } from '../../text';

const withRules = (rules: EngineState['rules'], extra: Partial<EngineState> = {}): EngineState => ({ ...STATE, rules, ...extra });

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

describe('in Russian and English (TASK-DELTA-12)', () => {
  const ru = i18nFor('ru');
  const en = i18nFor('en');
  const rule = (id: string) => {
    const found = CONFIG.rules.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };
  const stateOf = (id: string) => STATE.rules.find((entry) => entry.ruleId === id) ?? null;

  it('ruleDetail: the DNS server, and what a domain resolved to (plural, time ago)', () => {
    expect(ruleDetail(rule(ID.dnsDomain), stateOf(ID.dnsDomain), NOW, ru)).toBe('DNS: 10.20.0.10');
    expect(ruleDetail(rule(ID.domain), stateOf(ID.domain), NOW, ru)).toBe('3 IP · 2 минуты назад');
    expect(ruleDetail(rule(ID.domain), stateOf(ID.domain), NOW, en)).toBe('3 IPs · 2 min ago');
    const one = { ...(stateOf(ID.domain) ?? ruleState(ID.domain)), appliedDestinations: ['10.0.0.5/32'] };
    expect(ruleDetail(rule(ID.domain), one, NOW, en)).toMatch(/^1 IP · /);
    // The user's note is never translated.
    expect(ruleDetail(rule(ID.subnet), stateOf(ID.subnet), NOW, en)).toBe('Ichki tarmoq');
  });

  it('ruleNotice: the reason in the language', () => {
    const state = ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' });
    expect(ruleNotice(state, rule(ID.subnet), NOW, en)).toEqual({ kind: 'status', status: 'error', text: en.t.ruleReason['route-failed'] });
    expect(ruleNotice(state, rule(ID.subnet), NOW, ru)?.text).toBe(ru.t.ruleReason['route-failed']);
  });

  it('statusLine: last apply, its trigger and the error count, with plurals', () => {
    expect(statusLine(STATE, NOW, ru)).toEqual({ tone: 'success', text: 'Последнее применение: 10:58 · при изменении сети', errors: null });
    expect(statusLine(STATE, NOW, en).text).toBe('Last applied: 10:58 · when the network changed');
    const failing = (count: number) =>
      withRules(Array.from({ length: count }, (_, i) => ruleState(`r${String(i)}`, { status: 'error', reasonCode: 'route-failed' })));
    expect(statusLine(failing(1), NOW, ru).errors).toBe('Ошибка в 1 правиле');
    expect(statusLine(failing(2), NOW, ru).errors).toBe('Ошибка в 2 правилах');
    expect(statusLine(failing(1), NOW, en).errors).toBe('1 rule failing');
    expect(statusLine(failing(2), NOW, en).errors).toBe('2 rules failing');
    expect(statusLine({ ...STATE, lastApplyAt: null }, NOW, en).text).toBe('Not applied yet');
    expect(statusLine({ ...STATE, enabled: false }, NOW, ru).text).toBe('Маршрутизация выключена — правила не применяются');
  });

  it('menuRules passes the language to every row', () => {
    const rows = menuRules(CONFIG, STATE, NOW, MENU_RULE_LIMIT, en).shown;
    expect(rows.find((row) => row.id === ID.domain)?.detail).toBe('3 IPs · 2 min ago');
  });
});

describe('ruleDetail — a wildcard domain rule (TASK-DELTA-29)', () => {
  const WILD = '99999999-9999-4999-8999-999999999999';
  const wildcard = { id: WILD, kind: 'domain', target: '*.corp.local', iface: 'ethernet', enabled: true, refreshSec: 600, dns: '10.20.0.10' } as const;

  it('how many addresses it learned, less its DNS server, and when the last answer came', () => {
    const state = ruleState(WILD, { appliedDestinations: ['10.20.0.10', '10.20.1.5'], lastResolvedAt: new Date(NOW - 120_000).toISOString() });
    expect(ruleDetail(wildcard, state, NOW)).toBe("1 ta o'rganilgan IP · 2 daq oldin");
    expect(ruleDetail(wildcard, ruleState(WILD), NOW)).toBe("0 ta o'rganilgan IP");
    expect(ruleDetail(wildcard, ruleState(WILD), NOW, i18nFor('en'))).toBe('0 learned IPs');
    expect(ruleDetail(wildcard, ruleState(WILD, { appliedDestinations: ['10.20.1.5', '10.20.1.6'] }), NOW, i18nFor('ru'))).toBe('2 найденных IP');
  });

  it('without a state yet, its DNS server; in error, its last known addresses', () => {
    expect(ruleDetail(wildcard, null, NOW)).toBe('DNS: 10.20.0.10');
    const failing = ruleState(WILD, { status: 'error', reasonCode: 'dns-proxy-unavailable', reason: 'x', appliedDestinations: ['10.20.1.5'] });
    expect(ruleDetail(wildcard, failing, NOW)).toBe('10.20.1.5');
    expect(ruleNotice(failing, wildcard, NOW)?.text).toContain(RULE_REASON_TEXT['dns-proxy-unavailable']);
  });
});
