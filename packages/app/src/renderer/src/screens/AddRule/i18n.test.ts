// The add / edit rule dialog in its three languages (TASK-DELTA-13): field
// errors through the shared codes, the command preview (its argv lines are the
// same in every language, only the notes are words), "Sinab ko'rish", the
// refresh hint's plurals and the rendered dialog.

import type { Config, TestResult } from '@routeswitch/shared';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor, LOCALES, type Locale } from '../../../../i18n';
import { renderMarkup } from '../../components/test-utils';
import type { ConfigView } from '../../hooks/useConfig';
import type { EngineStateView } from '../../hooks/useEngineState';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import { saveErrorText, saveRule, testRoute } from './actions';
import { AddRulePanel, formStatus, refreshText, type AddRulePanelProps } from './AddRuleScreen';
import { createAddRuleController, initialAddRuleUi, type AddRuleUiState } from './controller';
import { checkForm, commandPreview, describeTest, kindOptions, NEW_RULE_FORM, targetField, testAddressOf, type RuleForm } from './model';

const UZ = i18nFor('uz');
const RU = i18nFor('ru');
const EN = i18nFor('en');
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const form = (extra: Partial<RuleForm>): RuleForm => ({ ...NEW_RULE_FORM, ...extra });

describe('field errors in every language', () => {
  it('empty, wildcard, upper case and invalid targets', () => {
    expect(checkForm(form({ target: '' }), NEW_ID, null, EN).errors.target).toBe('Enter an address.');
    expect(checkForm(form({ target: '' }), NEW_ID, null, RU).errors.target).toBe('Введите адрес.');
    expect(checkForm(form({ kind: 'domain', target: '*.com' }), NEW_ID, null, RU).errors.target).toBe(RU.t.validation['invalid-wildcard-domain']);
    expect(checkForm(form({ kind: 'domain', target: 'Corp.Local' }), NEW_ID, null, EN).errors.target).toBe(EN.t.addRule.errors.upperCase);
    // A shared validator's code reads from the shared table (`validation`) of the language.
    expect(checkForm(form({ kind: 'subnet', target: '0.0.0.0/0' }), NEW_ID, null, EN).errors.target).toBe(EN.t.validation['default-route']);
    expect(checkForm(form({ kind: 'ip', target: '10.0.0' }), NEW_ID, null, RU).errors.target).toBe(RU.t.validation['invalid-ipv4']);
  });

  it('refresh, note and DNS errors', () => {
    const domain = form({ kind: 'domain', target: 'corp.local', refreshSec: '5', useDns: true, dns: '' });
    const errors = checkForm(domain, NEW_ID, null, EN).errors;
    expect(errors.refreshSec).toBe(EN.t.addRule.errors.refresh);
    expect(errors.dns).toBe('Enter the DNS server address (or clear the check box).');
    expect(checkForm(form({ target: '10.0.0.0/8', note: 'x'.repeat(1000) }), NEW_ID, null, RU).errors.note).toBe(RU.t.addRule.errors.note);
  });

  it('one target on two interfaces names the other rule and its interface', () => {
    const config: Config = CONFIG;
    const check = checkForm(form({ kind: 'subnet', target: '10.0.0.0/8', iface: 'wifi' }), NEW_ID, config, EN);
    expect(check.errors.target).toBe('This address is already routed through Ethernet by the rule “10.0.0.0/8” — one address cannot be bound to two interfaces.');
  });

  it('hints: normalised target, the same destination twice', () => {
    expect(EN.t.addRule.normalised('10.0.0.0/8')).toBe('Will be saved as 10.0.0.0/8.');
    expect(RU.t.addRule.sameAs('10.0.0.0/8')).toContain('«10.0.0.0/8»');
  });

  it('IP wildcard (TASK-DELTA-15): the resulting CIDR, invalid-wildcard and ADR-001 words in every language', () => {
    expect(UZ.t.addRule.wildcardResult('10.0.0.0/8')).toBe('→ 10.0.0.0/8 (subnet)');
    expect(EN.t.addRule.wildcardResult('10.0.0.0/8')).toBe('→ 10.0.0.0/8 (subnet)');
    expect(RU.t.addRule.wildcardResult('10.0.0.0/8')).toBe('→ 10.0.0.0/8 (подсеть)');
    for (const i18n of [UZ, RU, EN]) {
      expect(checkForm(form({ kind: 'ip', target: '10.*.*.*' }), NEW_ID, null, i18n).wildcardCidr).toBe('10.0.0.0/8');
      expect(checkForm(form({ kind: 'ip', target: '10.*.1.*' }), NEW_ID, null, i18n).errors.target).toBe(i18n.t.validation['invalid-wildcard']);
      expect(checkForm(form({ kind: 'subnet', target: '224.*.*.*' }), NEW_ID, null, i18n).errors.target).toBe(i18n.t.validation.multicast);
      expect(targetField('ip', i18n).hint).toContain('10.*.*.*');
      expect(targetField('subnet', i18n).hint).toContain('10.*.*.*');
    }
  });
});

describe('command preview: argv is never translated', () => {
  const interfaces = STATE.interfaces;

  it('the lines are the same in every language; the notes are words', () => {
    for (const locale of LOCALES) {
      const i18n = i18nFor(locale);
      expect(commandPreview('domain', 'corp.local', '10.20.0.10', 'ethernet', interfaces, i18n)).toEqual({
        lines: ['$ route -n add -host <resolve(corp.local)> 10.20.4.1', '$ route -n add -host 10.20.0.10 10.20.4.1'],
        note: i18n.t.addRule.previewEachIpDns,
      });
      expect(commandPreview('subnet', null, null, 'wifi', interfaces, i18n).lines).toEqual(['$ route -n add -net <subnet> 192.168.0.1']);
    }
  });

  it('why there is no command, in Russian and English', () => {
    const noGateway = { ...interfaces, ethernet: { ...interfaces.ethernet, gateway: null } };
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', noGateway, EN).note).toBe(
      'Ethernet has no gateway — the rule will be “Pending” and is applied once it connects.',
    );
    const down = { ...interfaces, wifi: { device: 'en0', ip: null, gateway: null, up: false } };
    expect(commandPreview('ip', '10.1.1.1', null, 'wifi', down, RU).note).toBe('Wi‑Fi не подключён — правило будет «Ожидает» и применится после подключения.');
    const absent = { ...interfaces, ethernet: { device: null, ip: null, gateway: null, up: false } };
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', absent, EN).note).toMatch(/^No Ethernet adapter found/);
    expect(commandPreview('ip', '10.1.1.1', null, 'ethernet', null, RU).note).toBe(RU.t.addRule.previewNoHelper);
  });
});

describe('"Sinab ko\'rish" in every language', () => {
  const result = (extra: Partial<TestResult> = {}): TestResult => ({
    target: '10.0.0.1',
    destination: '10.0.0.0',
    gateway: '10.20.4.1',
    device: 'en5',
    role: 'ethernet',
    ruleId: ID.subnet,
    ...extra,
  });

  it('reasons there is nothing to test', () => {
    expect(testAddressOf('ip', null, null, EN)).toEqual({ reason: 'Enter a valid address first.' });
    expect(testAddressOf('domain', 'corp.local', null, RU)).toEqual({ reason: RU.t.addRule.testDomainSaveFirst });
  });

  it('verdicts: the route line keeps addresses and devices; words around them translate', () => {
    expect(describeTest(result(), 'ethernet', ID.subnet, true, EN)).toEqual({
      tone: 'success',
      route: '10.0.0.1 → en5 (Ethernet) · gateway 10.20.4.1',
      verdict: 'Goes through Ethernet by this rule.',
    });
    const viaWifi = result({ device: 'en0', role: 'wifi', gateway: '192.168.0.1', ruleId: null });
    expect(describeTest(viaWifi, 'ethernet', NEW_ID, true, RU).verdict).toBe('Сейчас идёт через Wi‑Fi, а не через Ethernet.');
    expect(describeTest(viaWifi, 'ethernet', NEW_ID, false, EN).verdict).toBe('Goes through Wi‑Fi now — after saving it goes through Ethernet.');
    expect(describeTest(result({ device: 'utun3', role: null, gateway: null }), 'ethernet', NEW_ID, false, RU).route).toBe('10.0.0.1 → utun3 · напрямую');
  });

  it('a failed test and a refused save say why', async () => {
    const rs = {
      test: vi.fn().mockResolvedValueOnce({ ok: false, code: 'operation-failed' }).mockResolvedValueOnce({ ok: false, code: 'busy' }),
      saveRule: vi.fn().mockResolvedValue({ ok: false, code: 'invalid-config' }),
    };
    expect(await testRoute(rs, '10.0.0.1', EN)).toEqual({ ok: false, text: 'No route found for this address.' });
    expect(await testRoute(rs, '10.0.0.1', RU)).toEqual({ ok: false, text: `Проверить не удалось: ${RU.t.errors.busy}` });
    expect(await saveRule(rs, { id: NEW_ID, kind: 'ip', target: '10.0.0.1', iface: 'ethernet', enabled: true, refreshSec: 600 }, EN)).toEqual({
      tone: 'danger',
      text: EN.t.addRule.saveRefused,
    });
    expect(saveErrorText('busy', RU)).toBe(`Правило не сохранено: ${RU.t.errors.busy}`);
  });

  it('the controller writes in the language of the moment the answer arrives', async () => {
    let state: AddRuleUiState = initialAddRuleUi(form({ kind: 'ip', target: '10.0.0.1' }));
    let language: Locale = 'uz';
    let settle: (value: unknown) => void = () => undefined;
    const rs = { saveRule: vi.fn(() => new Promise((resolve) => (settle = resolve))), test: vi.fn() };
    const controller = createAddRuleController(rs as never, NEW_ID, (change) => (state = change(state)), () => state, vi.fn(), () => i18nFor(language));
    const saving = controller.save(null);
    language = 'en';
    settle({ ok: false, code: 'busy' });
    await saving;
    expect(state.feedback).toEqual({ tone: 'danger', text: `Rule not saved: ${EN.t.errors.busy}` });
  });
});

describe('refresh hint: plurals', () => {
  it.each([
    [60, 'IP обновляются каждую 1 минуту.'],
    [120, 'IP обновляются каждые 2 минуты.'],
    [300, 'IP обновляются каждые 5 минут.'],
    [1260, 'IP обновляются каждую 21 минуту.'],
    [90, 'IP обновляются каждые 90 секунд.'],
    [61, 'IP обновляются каждую 61 секунду.'],
  ])('ru %i s', (seconds, text) => {
    expect(refreshText(seconds, RU)).toBe(text);
  });

  it('en and uz', () => {
    expect(refreshText(60, EN)).toBe('IPs are refreshed every minute.');
    expect(refreshText(600, EN)).toBe('IPs are refreshed every 10 minutes.');
    expect(refreshText(90, EN)).toBe('IPs are refreshed every 90 seconds.');
    expect(refreshText(600, UZ)).toBe("IP'lar har 10 daqiqada yangilanadi.");
  });
});

describe('the dialog rendered in Russian and English', () => {
  const connected: EngineStateView = { helper: 'connected', connection: { kind: 'connected', helperVersion: '0.1.0' }, state: STATE, error: null };
  const props = (extra: Partial<AddRulePanelProps>): AddRulePanelProps => ({
    mode: 'add',
    ruleId: NEW_ID,
    status: { kind: 'ready' },
    engine: connected,
    config: CONFIG,
    ui: initialAddRuleUi(form({ kind: 'domain', target: 'corp.local', useDns: true, dns: '10.20.0.10' })),
    onKind: vi.fn(),
    onIface: vi.fn(),
    onField: vi.fn(),
    onBlur: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onTest: vi.fn(),
    ...extra,
  });
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  const UZBEK = ['Yangi qoida', 'Turi', 'Interfeys', 'Izoh', "Saqlash va qo'llash", 'Bekor qilish', "Sinab ko'rish", 'yangilanadi', 'fayli yaratiladi'];

  it.each([
    ['ru', RU, ['Новое правило', 'Тип', 'Домен', 'Интерфейс', 'Заметка', 'Сохранить и применить', 'Отмена', 'Проверить', 'Будет создан файл /etc/resolver/corp.local.']],
    ['en', EN, ['New rule', 'Type', 'Domain', 'Interface', 'Note', 'Save and apply', 'Cancel', 'Test', 'The file /etc/resolver/corp.local will be created.']],
  ] as const)('%s', (_, i18n, expected) => {
    const html = words(renderMarkup(createElement(AddRulePanel, props({ i18n }))));
    for (const word of expected) expect(html).toContain(word);
    for (const word of UZBEK) expect(html).not.toContain(word);
    // The argv of the preview is the same as in Uzbek.
    expect(html).toContain('$ route -n add -host &lt;resolve(corp.local)&gt; 10.20.4.1');
  });

  it('edit title, a helper that is away, a missing rule', () => {
    const away: EngineStateView = { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null };
    const html = words(renderMarkup(createElement(AddRulePanel, props({ mode: 'edit', engine: away, status: { kind: 'missing' }, i18n: EN }))));
    expect(html).toContain('Edit rule');
    expect(html).toContain(`${EN.t.helperStatus['not-installed']} — the rule cannot be saved.`);
    expect(html).toContain(EN.t.addRule.missingRule);
  });

  it('formStatus, the kind options and the address field', () => {
    const idle = { phase: 'idle', config: null, revision: null, error: null } as ConfigView;
    expect(formStatus({ mode: 'edit', id: ID.host }, idle, false, RU)).toEqual({ kind: 'unavailable', text: RU.t.addRule.readNoHelper });
    expect(kindOptions(EN).map((option) => option.label)).toEqual(['IP', 'Subnet', 'Domain']);
    expect(targetField('subnet', RU)).toEqual({ label: 'Подсеть (CIDR)', placeholder: '10.0.0.0/8', hint: RU.t.addRule.targetField.subnet.hint });
  });
});
