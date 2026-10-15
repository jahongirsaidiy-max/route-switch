import { LIMITS, type Config, type Rule, type TestResult } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { CONFIG, ID, STATE, ruleState } from '../MenuBar/fixtures';
import {
  acceptedValues,
  checkForm,
  commandPreview,
  describeTest,
  firstErrorField,
  formOfRule,
  NEW_RULE_FORM,
  ruleInputOf,
  testAddressOf,
  type RuleForm,
} from './model';
import { VALIDATION_TEXT } from '../../text';

const NEW_ID = '77777777-7777-4777-8777-777777777777';
const form = (extra: Partial<RuleForm> = {}): RuleForm => ({ ...NEW_RULE_FORM, ...extra });
const check = (extra: Partial<RuleForm>, config: Config | null = null, id = NEW_ID) => checkForm(form(extra), id, config);
const ruleOf = (id: string): Rule => {
  const rule = CONFIG.rules.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(id);
  return rule;
};

describe('checkForm — the rule (shared Rule schema)', () => {
  it('accepts a subnet and stores it normalised, saying so', () => {
    const result = check({ kind: 'subnet', target: '10.1.2.3/8' });
    expect(result.errors).toEqual({});
    expect(result.rule).toMatchObject({ id: NEW_ID, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: true });
    expect(result.normalisedTarget).toBe('10.0.0.0/8');
    expect(check({ kind: 'subnet', target: '10.0.0.0/8' }).normalisedTarget).toBeNull();
  });

  it.each([
    ['subnet', '10.0.0.0/33', VALIDATION_TEXT['invalid-prefix']],
    ['subnet', '0.0.0.0/0', VALIDATION_TEXT['default-route']],
    ['subnet', '10.0.0.0/7', VALIDATION_TEXT['prefix-too-wide']],
    ['subnet', '10.0.0.0', VALIDATION_TEXT['invalid-cidr']],
    ['subnet', '127.0.0.0/8', VALIDATION_TEXT.loopback],
    ['subnet', '169.254.0.0/16', VALIDATION_TEXT['link-local']],
    ['ip', '224.0.0.1', VALIDATION_TEXT.multicast],
    ['ip', '255.255.255.255', VALIDATION_TEXT.broadcast],
    ['ip', '0.1.2.3', VALIDATION_TEXT['this-network']],
    ['ip', '010.1.1.1', VALIDATION_TEXT['invalid-ipv4']],
    ['domain', '../etc', VALIDATION_TEXT['invalid-domain']],
    ['domain', 'corp.local/x', VALIDATION_TEXT['invalid-domain']],
    ['domain', '*.com', VALIDATION_TEXT['invalid-wildcard-domain']],
    ['domain', 'a.*.corp.local', VALIDATION_TEXT['invalid-wildcard-domain']],
    ['domain', 'Corp.Local', 'Domenni kichik harflarda yozing, masalan corp.local.'],
    ['ip', '', 'Manzilni kiriting.'],
  ] as const)('%s %s is refused and not saved', (kind, target, text) => {
    const result = check({ kind, target });
    expect(result.rule).toBeNull();
    expect(result.errors.target).toBe(text);
  });

  it('a target longer than the schema allows', () => {
    expect(check({ kind: 'domain', target: `${'a'.repeat(250)}.com` }).errors.target).toBe(`Manzil ${String(LIMITS.targetMaxLength)} belgidan oshmasin.`);
  });

  it('white space around the address and the DNS server is dropped; nothing else is rewritten', () => {
    expect(check({ kind: 'ip', target: ' 172.16.12.40 ' }).rule?.target).toBe('172.16.12.40');
    const domain = check({ kind: 'domain', target: 'corp.local', useDns: true, dns: ' 10.20.0.10\t' });
    expect(domain.rule?.dns).toBe('10.20.0.10');
  });

  it('DNS block: a refused or empty server, a refresh outside 60..86400', () => {
    expect(check({ kind: 'domain', target: 'corp.local', useDns: true, dns: '' }).errors.dns).toContain('DNS server manzilini kiriting');
    expect(check({ kind: 'domain', target: 'corp.local', useDns: true, dns: '127.0.0.1' }).errors.dns).toBe(VALIDATION_TEXT.loopback);
    expect(check({ kind: 'domain', target: 'corp.local', useDns: true, dns: 'dns.local' }).errors.dns).toBe(VALIDATION_TEXT['invalid-ipv4']);
    for (const refreshSec of ['59', '86401', 'abc', '', '6e2', '60.5']) {
      const result = check({ kind: 'domain', target: 'corp.local', refreshSec });
      expect(result.errors.refreshSec, refreshSec).toContain('60 dan 86400 gacha');
      expect(result.rule).toBeNull();
    }
    const ok = check({ kind: 'domain', target: 'corp.local', refreshSec: ' 60 ', useDns: true, dns: '10.20.0.10' });
    expect(ok.rule).toMatchObject({ refreshSec: 60, dns: '10.20.0.10' });
  });

  it('reports the target even when another field is refused (zod stops before the rule check)', () => {
    const result = check({ kind: 'domain', target: '*.com', useDns: true, dns: 'x' });
    expect(result.errors).toEqual({ target: VALIDATION_TEXT['invalid-wildcard-domain'], dns: VALIDATION_TEXT['invalid-ipv4'] });
    expect(firstErrorField(result.errors)).toBe('target');
    expect(firstErrorField(check({ kind: 'domain', target: 'corp.local', useDns: true, dns: 'x' }).errors)).toBe('dns');
    expect(firstErrorField({})).toBeNull();
  });

  it('a note over 200 characters is refused; a blank note is left out', () => {
    expect(check({ target: '10.0.0.0/8', note: 'x'.repeat(201) }).errors.note).toBe('Izoh 200 belgidan oshmasin.');
    expect(check({ target: '10.0.0.0/8', note: '   ' }).rule).not.toHaveProperty('note');
    expect(check({ target: '10.0.0.0/8', note: ' Ichki ' }).rule?.note).toBe('Ichki');
  });

  it('a refusal on a field the form does not show still blocks the save', () => {
    const result = check({ target: '10.0.0.0/8' }, null, 'not-a-uuid');
    expect(result.rule).toBeNull();
    expect(result.formError).toBe('Qoida yaroqsiz.');
  });
});

describe('ruleInputOf', () => {
  it('sends only what the kind uses; refreshSec of a non-domain rule is the kept one', () => {
    expect(ruleInputOf(form({ kind: 'ip', target: '10.9.9.9', useDns: true, dns: '10.20.0.10', keptRefreshSec: 900 }), NEW_ID)).toEqual({
      id: NEW_ID,
      enabled: true,
      kind: 'ip',
      target: '10.9.9.9',
      iface: 'ethernet',
      refreshSec: 900,
    });
    expect(ruleInputOf(form({ kind: 'domain', target: 'corp.local', useDns: false, dns: '10.20.0.10', refreshSec: '120' }), NEW_ID)).not.toHaveProperty('dns');
    expect(ruleInputOf(form({ kind: 'domain', target: 'corp.local', refreshSec: '120' }), NEW_ID)['refreshSec']).toBe(120);
  });
});

describe('checkForm — the config (shared Config schema)', () => {
  it('refuses a target another rule binds to the other interface (ip and /32 are the same address)', () => {
    const result = check({ kind: 'subnet', target: '172.16.12.40/32', iface: 'wifi' }, CONFIG);
    expect(result.rule).toBeNull();
    expect(result.errors.target).toBe(
      "Bu manzil «172.16.12.40» qoidasida Ethernet orqali yo'naltirilgan — bitta manzil ikki interfeysga bog'lanmaydi.",
    );
  });

  it('editing the earlier rule of a would-be conflict names the later one', () => {
    // ID.subnet is the first rule: moving github.com's interface is not the point; a conflict with a later rule is.
    const result = check({ kind: 'domain', target: 'github.com', iface: 'ethernet' }, CONFIG, ID.subnet);
    expect(result.errors.target).toContain('«github.com» qoidasida Wi‑Fi orqali');
  });

  it('editing a rule replaces it in place: no conflict with itself, and the kind may change', () => {
    const result = check({ kind: 'subnet', target: '172.16.12.40/32', iface: 'wifi' }, CONFIG, ID.host);
    expect(result.errors).toEqual({});
    expect(result.rule?.id).toBe(ID.host);
    expect(result.rule?.kind).toBe('subnet');
  });

  it('the same destination through the same interface is allowed, with a hint', () => {
    const result = check({ kind: 'subnet', target: '172.16.12.40/32', iface: 'ethernet' }, CONFIG);
    expect(result.rule).not.toBeNull();
    expect(result.sameAs).toBe('172.16.12.40');
    expect(check({ kind: 'subnet', target: '10.0.0.0/8' }, CONFIG, ID.subnet).sameAs).toBeNull();
  });

  it('a 501st rule is refused; replacing one of 500 is not', () => {
    const rules = Array.from({ length: LIMITS.maxRules }, (_, index) => ({
      ...ruleOf(ID.host),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      target: `10.1.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
      kind: 'ip' as const,
    }));
    const full: Config = { ...CONFIG, rules };
    const result = check({ kind: 'ip', target: '10.200.0.1' }, full);
    expect(result.rule).toBeNull();
    expect(result.formError).toBe("500 tadan ortiq qoida qo'shib bo'lmaydi.");
    expect(check({ kind: 'ip', target: '10.200.0.1' }, full, rules[0]?.id).rule).not.toBeNull();
  });
});

describe('formOfRule', () => {
  it('fills every field from the stored rule', () => {
    expect(formOfRule(ruleOf(ID.dnsDomain))).toEqual({
      kind: 'domain',
      target: 'corp.local',
      iface: 'ethernet',
      useDns: true,
      dns: '10.20.0.10',
      refreshSec: '600',
      note: '',
      enabled: true,
      keptRefreshSec: 600,
    });
    expect(formOfRule(ruleOf(ID.off))).toMatchObject({ enabled: false, useDns: false, dns: '', note: '' });
    expect(formOfRule(ruleOf(ID.host)).note).toBe('Firebird DB');
  });
});

describe('IP wildcard (TASK-DELTA-15) — the shared normaliser decides, the form only shows it', () => {
  it.each(['ip', 'subnet'] as const)('%s 10.*.*.* is saved as the subnet 10.0.0.0/8 and says so', (kind) => {
    const result = check({ kind, target: '10.*.*.*', iface: 'wifi' });
    expect(result.errors).toEqual({});
    expect(result.rule).toMatchObject({ kind: 'subnet', target: '10.0.0.0/8', iface: 'wifi' });
    expect(result.wildcardCidr).toBe('10.0.0.0/8');
    expect(result.normalisedTarget).toBeNull();
  });

  it('192.168.5.* and 172.16.*.* are /24 and /16; white space around is dropped', () => {
    expect(check({ kind: 'ip', target: ' 192.168.5.* ' }).rule).toMatchObject({ kind: 'subnet', target: '192.168.5.0/24' });
    expect(check({ kind: 'subnet', target: '172.16.*.*' }).wildcardCidr).toBe('172.16.0.0/16');
  });

  it.each([
    ['ip', '10.*.1.*', VALIDATION_TEXT['invalid-wildcard']],
    ['subnet', '*.*.*.*', VALIDATION_TEXT['invalid-wildcard']],
    ['ip', '10.*', VALIDATION_TEXT['invalid-wildcard']],
    ['subnet', '10.*.*.*/8', VALIDATION_TEXT['invalid-wildcard']],
    ['ip', '224.*.*.*', VALIDATION_TEXT.multicast],
    ['subnet', '127.*.*.*', VALIDATION_TEXT.loopback],
    ['ip', '169.254.*.*', VALIDATION_TEXT['link-local']],
  ] as const)('%s %s is refused with the shared code', (kind, target, text) => {
    const result = check({ kind, target });
    expect(result.rule).toBeNull();
    expect(result.errors.target).toBe(text);
    expect(result.wildcardCidr).toBeNull();
  });

  it('the wildcard is checked against the config as the subnet it is (one target, two interfaces)', () => {
    // CONFIG routes 10.0.0.0/8 through Ethernet.
    expect(check({ kind: 'ip', target: '10.*.*.*', iface: 'wifi' }, CONFIG).errors.target).toContain('«10.0.0.0/8»');
    expect(check({ kind: 'ip', target: '10.*.*.*', iface: 'ethernet' }, CONFIG).sameAs).toBe('10.0.0.0/8');
  });

  it('acceptedValues gives the saved kind: the preview is -net <cidr>, the test the first host', () => {
    const accepted = acceptedValues(form({ kind: 'ip', target: '10.*.*.*' }));
    expect(accepted).toEqual({ kind: 'subnet', target: '10.0.0.0/8', dns: null });
    expect(commandPreview(accepted.kind, accepted.target, null, 'ethernet', STATE.interfaces).lines).toEqual(['$ route -n add -net 10.0.0.0/8 10.20.4.1']);
    expect(testAddressOf(accepted.kind, accepted.target, null)).toEqual({ address: '10.0.0.1' });
    expect(acceptedValues(form({ kind: 'ip', target: '10.*.1.*' }))).toEqual({ kind: 'ip', target: null, dns: null });
  });

  it('a domain with a * is a wildcard domain, not an IP wildcard', () => {
    expect(acceptedValues(form({ kind: 'domain', target: '*.corp.local' }))).toEqual({ kind: 'domain', target: '*.corp.local', dns: null });
    expect(check({ kind: 'domain', target: '*.corp.local' }).wildcardCidr).toBeNull();
  });

  it('accepts a wildcard domain (ADR-002): saved as typed, its base named for the hint (TASK-DELTA-29)', () => {
    for (const [target, base] of [['*.corp.local', 'corp.local'], ['*.a.corp.local', 'a.corp.local'], [' *.corp.local ', 'corp.local']] as const) {
      const result = check({ kind: 'domain', target, useDns: true, dns: '10.20.0.10' });
      expect(result.errors, target).toEqual({});
      expect(result.rule).toMatchObject({ kind: 'domain', target: target.trim(), dns: '10.20.0.10' });
      expect(result.wildcardBase).toBe(base);
      expect(result.normalisedTarget).toBeNull();
    }
    expect(check({ kind: 'domain', target: 'corp.local' }).wildcardBase).toBeNull();
    // The base is named only for a valid wildcard, and only under "Domen".
    expect(check({ kind: 'domain', target: '*.com' }).wildcardBase).toBeNull();
    expect(check({ kind: 'ip', target: '10.*.*.*' }).wildcardBase).toBeNull();
  });

  it('refuses every malformed domain wildcard with the shared code, never rewriting it', () => {
    for (const target of ['*.com', 'a.*.corp.local', '*', '*.', '**.corp.local', '*corp.local', '*.Corp.local', '*.corp.local.', '*.*.corp.local']) {
      const result = check({ kind: 'domain', target });
      expect(result.errors.target, target).toBe(VALIDATION_TEXT['invalid-wildcard-domain']);
      expect(result.rule).toBeNull();
      expect(result.wildcardBase).toBeNull();
    }
  });

  it('a wildcard bound to the other interface by the same wildcard is refused; the exact base is a different rule', () => {
    const wildcard = { id: '88888888-8888-4888-8888-888888888888', enabled: true, kind: 'domain', target: '*.corp.local', iface: 'wifi', refreshSec: 600 } as const;
    const config: Config = { ...CONFIG, rules: [...CONFIG.rules, wildcard] };
    expect(check({ kind: 'domain', target: '*.corp.local', iface: 'ethernet' }, config).errors.target).toContain('*.corp.local');
    expect(check({ kind: 'domain', target: '*.corp.local', iface: 'wifi' }, config).sameAs).toBe('*.corp.local');
    const exact = check({ kind: 'domain', target: 'corp.local', iface: 'ethernet' }, config);
    expect(exact.errors.target === undefined || !exact.errors.target.includes('*.corp.local')).toBe(true);
  });
});

describe('acceptedValues', () => {
  it('the target and DNS server once the shared normalisers accept them', () => {
    expect(acceptedValues(form({ kind: 'subnet', target: '10.1.2.3/8' }))).toEqual({ kind: 'subnet', target: '10.0.0.0/8', dns: null });
    expect(acceptedValues(form({ kind: 'subnet', target: '10.0.0.0/33' })).target).toBeNull();
    expect(acceptedValues(form({ kind: 'domain', target: 'corp.local', useDns: true, dns: '10.20.0.10' })).dns).toBe('10.20.0.10');
    expect(acceptedValues(form({ kind: 'domain', target: 'corp.local', useDns: false, dns: '10.20.0.10' })).dns).toBeNull();
    expect(acceptedValues(form({ kind: 'ip', target: '10.1.1.1', useDns: true, dns: '10.20.0.10' })).dns).toBeNull();
  });
});

describe('commandPreview', () => {
  const interfaces = STATE.interfaces;
  it('is the helper command with the role gateway (route.ts argv)', () => {
    expect(commandPreview('subnet', '10.0.0.0/8', null, 'ethernet', interfaces).lines).toEqual(['$ route -n add -net 10.0.0.0/8 10.20.4.1']);
    expect(commandPreview('subnet', '10.1.2.3/32', null, 'wifi', interfaces).lines).toEqual(['$ route -n add -host 10.1.2.3 192.168.0.1']);
    expect(commandPreview('ip', '172.16.12.40', null, 'ethernet', interfaces).lines).toEqual(['$ route -n add -host 172.16.12.40 10.20.4.1']);
    expect(commandPreview('domain', 'corp.local', null, 'ethernet', interfaces).lines).toEqual(['$ route -n add -host <resolve(corp.local)> 10.20.4.1']);
    expect(commandPreview('domain', 'corp.local', '10.20.0.10', 'ethernet', interfaces)).toEqual({
      lines: ['$ route -n add -host <resolve(corp.local)> 10.20.4.1', '$ route -n add -host 10.20.0.10 10.20.4.1'],
      note: "Har bir resolve qilingan IP uchun; DNS server — o'z tarmog'ida bo'lmasa.",
    });
  });

  it('a wildcard domain: no route ahead, a note instead; its DNS server is still routed (ADR-002)', () => {
    expect(commandPreview('domain', '*.corp.local', null, 'ethernet', interfaces)).toEqual({
      lines: [],
      note: "Route'lar oldindan qo'yilmaydi: subdomen so'ralganda javobdagi har IP uchun qo'yiladi.",
    });
    expect(commandPreview('domain', '*.corp.local', '10.20.0.10', 'wifi', interfaces)).toEqual({
      lines: ['$ route -n add -host 10.20.0.10 192.168.0.1'],
      note: "Subdomenlar route'i so'rov bo'yicha qo'yiladi; DNS server route'i — darhol.",
    });
  });

  it('a placeholder while the address is not accepted', () => {
    expect(commandPreview('subnet', null, null, 'ethernet', interfaces).lines).toEqual(['$ route -n add -net <subnet> 10.20.4.1']);
    expect(commandPreview('ip', null, null, 'wifi', interfaces).lines).toEqual(['$ route -n add -host <IP> 192.168.0.1']);
    expect(commandPreview('domain', null, null, 'wifi', interfaces).lines).toEqual(['$ route -n add -host <resolve(<domen>)> 192.168.0.1']);
  });

  it('no command without a gateway, an adapter, or a helper — only why', () => {
    const noGateway = { ...interfaces, ethernet: { ...interfaces.ethernet, gateway: null } };
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', noGateway)).toEqual({
      lines: [],
      note: "Ethernet gateway'i yo'q — qoida «Kutilmoqda» bo'ladi va ulanganda qo'llanadi.",
    });
    const down = { ...interfaces, wifi: { device: 'en0', ip: null, gateway: null, up: false } };
    expect(commandPreview('ip', '10.1.1.1', null, 'wifi', down).note).toContain('Wi‑Fi ulanmagan');
    const absent = { ...interfaces, ethernet: { device: null, ip: null, gateway: null, up: false } };
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', absent).note).toContain('Ethernet adapteri topilmadi');
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', null)).toEqual({ lines: [], note: "Buyruq helper ulanganda ko'rinadi (gateway undan olinadi)." });
  });
});

describe('testAddressOf', () => {
  it('the address of an ip rule; the first host of a subnet; the address of /31 and /32', () => {
    expect(testAddressOf('ip', '172.16.12.40', null)).toEqual({ address: '172.16.12.40' });
    expect(testAddressOf('subnet', '10.0.0.0/8', null)).toEqual({ address: '10.0.0.1' });
    expect(testAddressOf('subnet', '192.168.50.0/24', null)).toEqual({ address: '192.168.50.1' });
    expect(testAddressOf('subnet', '10.1.2.4/31', null)).toEqual({ address: '10.1.2.4' });
    expect(testAddressOf('subnet', '10.1.2.3/32', null)).toEqual({ address: '10.1.2.3' });
    expect(testAddressOf('subnet', '200.255.255.0/24', null)).toEqual({ address: '200.255.255.1' });
  });

  it('nothing to test without an accepted target', () => {
    expect(testAddressOf('ip', null, null)).toEqual({ reason: "Avval to'g'ri manzil kiriting." });
  });

  it('a domain: the first routed address of the saved rule, never its DNS server', () => {
    const saved = { target: 'corp.local', kind: 'domain' as const, dns: '10.20.0.10', state: ruleState(ID.dnsDomain, { appliedDestinations: ['10.20.0.10', '10.20.1.5'] }) };
    expect(testAddressOf('domain', 'corp.local', saved)).toEqual({ address: '10.20.1.5' });
    expect(testAddressOf('domain', 'other.local', saved)).toHaveProperty('reason');
    expect(testAddressOf('domain', 'corp.local', null)).toEqual({ reason: "Domen IP'lari helper resolve qilgandan keyin sinaladi — avval saqlang." });
    expect(testAddressOf('domain', 'corp.local', { ...saved, state: ruleState(ID.dnsDomain, { appliedDestinations: ['10.20.0.10'] }) })).toEqual({
      reason: "Domen hali resolve qilinmagan yoki route qo'yilmagan.",
    });
    expect(testAddressOf('domain', 'corp.local', { ...saved, state: null })).toHaveProperty('reason');
  });
});

describe('describeTest', () => {
  const result = (extra: Partial<TestResult> = {}): TestResult => ({
    target: '10.0.0.1',
    destination: '10.0.0.0',
    gateway: '10.20.4.1',
    device: 'en5',
    role: 'ethernet',
    ruleId: ID.subnet,
    ...extra,
  });

  it('through the chosen interface: by this rule, or already', () => {
    expect(describeTest(result(), 'ethernet', ID.subnet, true)).toEqual({
      tone: 'success',
      route: '10.0.0.1 → en5 (Ethernet) · gateway 10.20.4.1',
      verdict: "Shu qoida bo'yicha Ethernet orqali ketadi.",
    });
    expect(describeTest(result({ ruleId: null }), 'ethernet', NEW_ID, false).verdict).toBe('Hozir Ethernet orqali ketadi.');
  });

  it('through another interface: before the save, and after it', () => {
    const viaWifi = result({ device: 'en0', role: 'wifi', gateway: '192.168.0.1', ruleId: null, destination: 'default' });
    expect(describeTest(viaWifi, 'ethernet', NEW_ID, false)).toEqual({
      tone: 'warning',
      route: '10.0.0.1 → en0 (Wi‑Fi) · gateway 192.168.0.1',
      verdict: "Hozir Wi‑Fi orqali ketadi — saqlangandan keyin Ethernet orqali bo'ladi.",
    });
    expect(describeTest(viaWifi, 'ethernet', NEW_ID, true).verdict).toBe('Hozir Wi‑Fi orqali ketadi, Ethernet emas.');
    expect(describeTest(result({ device: 'utun3', role: null, gateway: null }), 'ethernet', NEW_ID, false)).toMatchObject({
      tone: 'warning',
      route: "10.0.0.1 → utun3 · to'g'ridan-to'g'ri",
    });
  });
});
