// TASK-DELTA-21: the DNS warning's banner words, its one-click add-rule offer
// and the menu bar's DNS offer in the rules window. Sample addresses are
// generic (10.0.0.53, 192.168.0.53).

import type { Config, DnsWarning, EngineState } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor, type Locale } from '../../../../i18n';
import { dnsWarningBanners } from '../../text';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import { createAddRuleController, initialAddRuleUiFor, type AddRuleUiState } from './controller';
import {
  dnsRuleForm,
  dnsRuleOffer,
  dnsWarningViews,
  NEW_RULE_FORM,
  requestedForm,
} from './model';

// STATE: Ethernet en5 10.20.4.37 → 10.20.4.1; Wi‑Fi en0 192.168.0.104 → 192.168.0.1.
const ethernetDns = (extra: Partial<DnsWarning> = {}): DnsWarning => ({
  server: '192.168.0.53',
  source: 'interface',
  role: 'ethernet',
  via: 'wifi',
  code: 'other-interface-subnet',
  ...extra,
});
const ruleDns: DnsWarning = { server: '10.20.0.10', source: 'rule', role: 'ethernet', via: 'wifi', ruleId: ID.dnsDomain, code: 'routed-via-other-interface' };
const withWarnings = (dnsWarnings: DnsWarning[], extra: Partial<EngineState> = {}): EngineState => ({ ...STATE, dnsWarnings, ...extra });

describe('dnsWarningBanners — one banner per server, words by source and code', () => {
  it('names the interface or the rule (by its domain), the other interface, and why', () => {
    const banners = dnsWarningBanners(withWarnings([ethernetDns(), ruleDns]), CONFIG);
    expect(banners.map(({ id, server, role, title }) => ({ id, server, role, title }))).toEqual([
      { id: 'dns-192.168.0.53', server: '192.168.0.53', role: 'ethernet', title: 'Ethernet DNS serveri (192.168.0.53) Wi‑Fi orqali ketmoqda' },
      { id: 'dns-10.20.0.10', server: '10.20.0.10', role: 'ethernet', title: '«corp.local» qoidasining DNS serveri (10.20.0.10) Wi‑Fi orqali ketmoqda' },
    ]);
    expect(banners[0]?.text).toContain("192.168.0.53 — Wi‑Fi tarmog'ida");
    expect(banners[0]?.text).toContain('192.168.0.53 uchun Ethernet orqali IP qoida');
    expect(banners[1]?.text).toContain('Route jadvali 10.20.0.10 ni Wi‑Fi orqali yuboradi');
  });

  it('shows a server once, the first warning winning', () => {
    const banners = dnsWarningBanners(withWarnings([ethernetDns(), ethernetDns({ source: 'rule', ruleId: ID.dnsDomain, code: 'routed-via-other-interface' })]), CONFIG);
    expect(banners).toHaveLength(1);
    expect(banners[0]?.title).toContain('Ethernet DNS serveri');
  });

  it('a rule not in the config (or no config yet) is named generically; a null `via` is the other role', () => {
    const [banner] = dnsWarningBanners(withWarnings([{ ...ruleDns, via: null }]), null);
    expect(banner?.title).toBe('Qoidaning DNS serveri (10.20.0.10) Wi‑Fi orqali ketmoqda');
    const [wifi] = dnsWarningBanners(withWarnings([ethernetDns({ server: '10.20.4.53', role: 'wifi', via: null })]), CONFIG);
    expect(wifi?.title).toBe('Wi‑Fi DNS serveri (10.20.4.53) Ethernet orqali ketmoqda');
  });

  it('nothing without warnings (an older helper sends none)', () => {
    expect(dnsWarningBanners(STATE, CONFIG)).toEqual([]);
    expect(dnsWarningViews(withWarnings([]), CONFIG)).toEqual([]);
  });

  it.each<Locale>(['ru', 'en'])('%s: every word is translated', (locale) => {
    const i18n = i18nFor(locale);
    const views = dnsWarningViews(withWarnings([ethernetDns(), ruleDns, ethernetDns({ server: '10.20.4.1', role: 'wifi', via: 'ethernet' })]), CONFIG, i18n);
    const words = views.flatMap((view) => [view.title, view.text, view.offer.kind === 'offer' ? view.offer.label : view.offer.text]).join(' ');
    for (const uzbek of ['serveri', 'orqali', 'ketmoqda', 'qoidasini', 'tarmog', 'Yechim', 'taklif']) expect(words).not.toContain(uzbek);
  });
});

describe('dnsRuleOffer — what the button fills in, or why there is none', () => {
  it('offers an `ip` rule for the server through its role, noted "DNS server", saved by nobody yet', () => {
    const offer = dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, STATE.interfaces, CONFIG);
    expect(offer).toEqual({
      kind: 'offer',
      label: "192.168.0.53 → Ethernet qoidasini qo'shish",
      form: { ...NEW_RULE_FORM, kind: 'ip', target: '192.168.0.53', iface: 'ethernet', note: 'DNS server' },
    });
    expect(dnsRuleForm('10.0.0.53', 'wifi', i18nFor('ru')).note).toBe('DNS-сервер');
  });

  it('no offer for the gateway or the own address of either interface (the helper would refuse the route)', () => {
    expect(dnsRuleOffer({ server: '192.168.0.1', role: 'ethernet' }, STATE.interfaces, CONFIG)).toEqual({
      kind: 'blocked',
      text: "Qoida taklif qilinmaydi: 192.168.0.1 — Wi‑Fi gateway'i, unga route qo'shib bo'lmaydi.",
    });
    expect(dnsRuleOffer({ server: '10.20.4.1', role: 'wifi' }, STATE.interfaces, CONFIG)).toMatchObject({ kind: 'blocked', text: expect.stringContaining("Ethernet gateway'i") as unknown });
    expect(dnsRuleOffer({ server: '192.168.0.104', role: 'ethernet' }, STATE.interfaces, CONFIG)).toMatchObject({
      kind: 'blocked',
      text: expect.stringContaining("Wi‑Fi interfeysining o'z manzili") as unknown,
    });
  });

  it('no offer while the role is down or has no gateway', () => {
    const down = { ...STATE.interfaces, ethernet: { device: 'en5', ip: null, gateway: null, up: false } };
    expect(dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, down, CONFIG)).toEqual({
      kind: 'blocked',
      text: "Qoida taklif qilinmaydi: Ethernet ulanmagan yoki gateway'i yo'q.",
    });
    const noGateway = { ...STATE.interfaces, ethernet: { ...STATE.interfaces.ethernet, gateway: null } };
    expect(dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, noGateway, CONFIG).kind).toBe('blocked');
  });

  it('the shared schema decides like the form: a forbidden address, a target bound to the other interface, the rule limit', () => {
    const forbidden = dnsRuleOffer({ server: '127.0.0.53', role: 'ethernet' }, STATE.interfaces, CONFIG);
    expect(forbidden.kind).toBe('blocked');
    expect(forbidden.kind === 'blocked' && forbidden.text.startsWith('Qoida taklif qilinmaydi: ')).toBe(true);

    const bound: Config = { ...CONFIG, rules: [...CONFIG.rules, { id: '88888888-8888-4888-8888-888888888888', kind: 'ip', target: '192.168.0.53', iface: 'wifi', enabled: true, refreshSec: 600 }] };
    const conflict = dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, STATE.interfaces, bound);
    expect(conflict).toMatchObject({ kind: 'blocked', text: expect.stringContaining('192.168.0.53') as unknown });

    const full: Config = {
      ...CONFIG,
      rules: Array.from({ length: 500 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        kind: 'ip' as const,
        target: `10.1.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
        iface: 'ethernet' as const,
        enabled: true,
        refreshSec: 600,
      })),
    };
    expect(dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, STATE.interfaces, full).kind).toBe('blocked');
  });

  it('a rule for the same destination through the same role exists: not offered again (off, or failing)', () => {
    const existing: Config = { ...CONFIG, rules: [...CONFIG.rules, { id: '88888888-8888-4888-8888-888888888888', kind: 'subnet', target: '192.168.0.53/32', iface: 'ethernet', enabled: false, refreshSec: 600 }] };
    expect(dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, STATE.interfaces, existing)).toMatchObject({
      kind: 'blocked',
      text: expect.stringContaining('allaqachon bor') as unknown,
    });
  });

  it('without a config only the rule is checked (main and the helper check the config again)', () => {
    expect(dnsRuleOffer({ server: '192.168.0.53', role: 'ethernet' }, STATE.interfaces, null).kind).toBe('offer');
  });
});

describe('the form an offer opens — filled in, never saved by itself', () => {
  it('starts filled in and loaded, nothing touched, submitted or sent', () => {
    const form = dnsRuleForm('192.168.0.53', 'ethernet');
    const ui = initialAddRuleUiFor({ mode: 'add', prefill: form });
    expect(ui).toMatchObject({ form, loaded: true, submitted: false, saving: false, feedback: null });
    expect(ui.touched.size).toBe(0);
    expect(initialAddRuleUiFor({ mode: 'add' }).form).toEqual(NEW_RULE_FORM);
    expect(initialAddRuleUiFor({ mode: 'edit' }).loaded).toBe(false);
  });

  it('no saveRule until the user presses "Saqlash"; then exactly the offered rule', async () => {
    const rs = {
      saveRule: vi.fn(() => Promise.resolve({ ok: true as const, value: { config: CONFIG, state: STATE } })),
      test: vi.fn(),
    };
    let ui: AddRuleUiState = initialAddRuleUiFor({ mode: 'add', prefill: dnsRuleForm('192.168.0.53', 'ethernet') });
    const onSaved = vi.fn();
    const id = '99999999-9999-4999-8999-999999999999';
    const controller = createAddRuleController(
      rs,
      id,
      (change) => {
        ui = change(ui);
      },
      () => ui,
      onSaved,
    );
    controller.blur('target');
    controller.setIface('ethernet');
    await Promise.resolve();
    expect(rs.saveRule).not.toHaveBeenCalled();
    await controller.save(CONFIG);
    expect(rs.saveRule).toHaveBeenCalledTimes(1);
    expect(rs.saveRule).toHaveBeenCalledWith({ id, enabled: true, kind: 'ip', target: '192.168.0.53', iface: 'ethernet', refreshSec: 600, note: 'DNS server' });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("the rules window's form for a menu bar DNS offer", () => {
  it("opens only the offer the window's own state makes for that server and role", () => {
    const views = dnsWarningViews(withWarnings([ethernetDns(), ethernetDns({ server: '192.168.0.1' })]), CONFIG);
    expect(requestedForm({ server: '192.168.0.53', role: 'ethernet' }, views)).toEqual(dnsRuleForm('192.168.0.53', 'ethernet'));
    // The same server for the other role, a server with no warning, a warning that offers no rule.
    expect(requestedForm({ server: '192.168.0.53', role: 'wifi' }, views)).toBeNull();
    expect(requestedForm({ server: '10.0.0.53', role: 'ethernet' }, views)).toBeNull();
    expect(requestedForm({ server: '192.168.0.1', role: 'ethernet' }, views)).toBeNull();
  });
});
