// The rules window in its three languages (TASK-DELTA-13): the pure functions
// with an `i18n` argument, the controllers' messages (in the language of the
// moment the outcome arrives), and the panel and sidebar rendered in Russian
// and English with no Uzbek words left.

import type { Config, EngineState } from '@routeswitch/shared';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor, type I18n, type Locale } from '../../../../i18n';
import { renderMarkup } from '../../components/test-utils';
import type { ConfigView } from '../../hooks/useConfig';
import type { EngineStateView } from '../../hooks/useEngineState';
import { I18nProvider } from '../../hooks/useI18n';
import { CONFIG, ID, NOW, STATE, ruleState } from '../MenuBar/fixtures';
import { removeRule, setRuleEnabled } from './actions';
import { createRulesController, INITIAL_RULES_UI, type RulesUiState } from './controller';
import { kindLabel, rowDetail, rowFilterLabels, ruleRows } from './model';
import { createRecoveryController, INITIAL_RECOVERY_UI, type RecoveryUiState } from './recovery';
import { RulesPanel, type RulesPanelProps } from './RulesScreen';
import { RulesWindowFrame } from './RulesWindow';
import { createTransferController, importQuestion, importSummary, INITIAL_TRANSFER_UI, type TransferUiState } from './transfer';

const UZ = i18nFor('uz');
const RU = i18nFor('ru');
const EN = i18nFor('en');

type ConfigRule = Config['rules'][number];
const domainRule = (refreshSec: number): ConfigRule => ({ id: ID.domain, kind: 'domain', target: 'github.com', iface: 'wifi', enabled: true, refreshSec });
const configWith = (count: number): Config => ({
  ...CONFIG,
  rules: Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'ip' as const,
    target: `10.1.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
    iface: 'ethernet' as const,
    enabled: true,
    refreshSec: 600,
  })),
});

/** Some Uzbek words of the rules window that must not be left in another language. */
const UZBEK_WORDS = ["Qoida qo'shish", 'Qidirish', 'Hammasi', 'Manzil', 'Interfeys', 'Izoh', 'ta qoida faol', "Bo'limlar", 'Jurnal', 'Diagnostika', 'Sozlamalar'];

describe('model in three languages', () => {
  it('kindLabel', () => {
    const labels = (i18n: I18n) =>
      [kindLabel({ kind: 'ip' }, i18n), kindLabel({ kind: 'subnet' }, i18n), kindLabel({ kind: 'domain' }, i18n), kindLabel({ kind: 'domain', dns: '10.0.0.53' }, i18n)];
    expect(labels(UZ)).toEqual(['IP', 'Subnet', 'Domen', 'Domen + DNS']);
    expect(labels(RU)).toEqual(['IP', 'Подсеть', 'Домен', 'Домен + DNS']);
    expect(labels(EN)).toEqual(['IP', 'Subnet', 'Domain', 'Domain + DNS']);
  });

  it('rowDetail: refresh interval and address count, with Russian and English plurals', () => {
    const applied = (count: number) => ruleState(ID.domain, { appliedDestinations: Array.from({ length: count }, (_, i) => `140.82.112.${String(i + 1)}`) });
    expect(rowDetail(domainRule(600), applied(3), UZ)).toBe('3 IP · har 10 daq');
    expect(rowDetail(domainRule(600), applied(3), RU)).toBe('3 IP · каждые 10 мин');
    expect(rowDetail(domainRule(60), null, RU)).toBe('каждую 1 мин');
    expect(rowDetail(domainRule(1260), null, RU)).toBe('каждую 21 мин');
    expect(rowDetail(domainRule(600), applied(3), EN)).toBe('3 IPs · every 10 min');
    expect(rowDetail(domainRule(600), applied(1), EN)).toBe('1 IP · every 10 min');
    expect(rowDetail({ ...domainRule(600), dns: '10.20.0.10' }, null, EN)).toBe('DNS: 10.20.0.10');
  });

  it('ruleRows: the reason of a rule in the row is in the language', () => {
    const state: EngineState = { ...STATE, rules: [ruleState(ID.domain, { status: 'error', reasonCode: 'resolve-failed' })] };
    const config: Config = { ...CONFIG, rules: [domainRule(600)] };
    const [row] = ruleRows(config, state, NOW, EN);
    expect(row?.status).toEqual({ kind: 'error', text: EN.t.ruleReason['resolve-failed'] });
    expect(row?.kindLabel).toBe('Domain');
  });

  it('filters keep their order and are named in every language', () => {
    expect(Object.keys(rowFilterLabels(RU))).toEqual(['all', 'problems', 'off']);
    expect(rowFilterLabels(EN)).toEqual({ all: 'All', problems: 'With problems', off: 'Turned off' });
  });
});

describe('importQuestion: Russian plural forms of the rule count', () => {
  const question = (count: number, current: Config | null, i18n: I18n) => importQuestion(importSummary(current, configWith(count)), i18n);

  it.each([
    [1, '1 правило'],
    [2, '2 правила'],
    [4, '4 правила'],
    [5, '5 правил'],
    [11, '11 правил'],
    [21, '21 правило'],
    [22, '22 правила'],
    [25, '25 правил'],
  ])('%i → %s', (count, words) => {
    expect(question(count, null, RU)).toBe(`Импорт полностью заменит текущую конфигурацию: ${words}.`);
  });

  it('English and Uzbek; the counts and switches of the summary', () => {
    expect(question(1, null, EN)).toBe('Import replaces the current config completely: 1 rule.');
    const current: Config = { ...configWith(2), enabled: false };
    expect(question(3, current, EN)).toBe(
      'Import replaces the current config completely: 3 rules (now 2). Added: 1, removed: 0, changed: 0, unchanged: 2. Routing will be turned on.',
    );
    expect(question(3, current, RU)).toBe(
      'Импорт полностью заменит текущую конфигурацию: 3 правила (сейчас 2). Добавится: 1, удалится: 0, изменится: 0, без изменений: 2. Маршрутизация будет включена.',
    );
    expect(question(3, current, UZ)).toBe(
      "Import joriy configni to'liq almashtiradi: 3 ta qoida (hozir 2 ta). Qo'shiladi: 1, o'chiriladi: 0, o'zgaradi: 0, o'zgarmaydi: 2. Routing yoqiladi.",
    );
  });

  it('the footer count agrees with its verb in Russian', () => {
    expect(RU.t.rules.activeRules(1)).toMatch(/^1 правило активно ·/);
    expect(RU.t.rules.activeRules(3)).toMatch(/^3 правила активны ·/);
    expect(RU.t.rules.activeRules(11)).toMatch(/^11 правил активны ·/);
    expect(RU.t.rules.activeRules(21)).toMatch(/^21 правило активно ·/);
    expect(EN.t.rules.activeRules(1)).toMatch(/^1 rule active ·/);
    expect(EN.t.rules.activeRules(2)).toMatch(/^2 rules active ·/);
  });
});

describe('messages of the actions and controllers', () => {
  it('a refused switch or removal says what and why, in the language', async () => {
    const rs = {
      toggleRule: vi.fn().mockResolvedValue({ ok: false, code: 'busy' }),
      deleteRule: vi.fn().mockResolvedValue({ ok: false, code: 'rule-not-found' }),
    };
    expect(await setRuleEnabled(rs, ID.host, true, EN)).toEqual({ tone: 'danger', text: `Rule not turned on: ${EN.t.errors.busy}` });
    expect(await setRuleEnabled(rs, ID.host, false, RU)).toEqual({ tone: 'danger', text: `Правило не выключено: ${RU.t.errors.busy}` });
    expect(await removeRule(rs, ID.host, RU)).toEqual({ tone: 'danger', text: 'Правило не удалено: правила больше нет (возможно, его удалили в другом окне).' });
    expect(await removeRule(rs, ID.host)).toEqual({ tone: 'danger', text: "Qoida o'chirib tashlanmadi: qoida endi yo'q (boshqa oynada o'chirilgan bo'lishi mumkin)." });
  });

  it('the rules controller writes in the language of the moment the outcome arrives', async () => {
    let state: RulesUiState = INITIAL_RULES_UI;
    let language: Locale = 'uz';
    let settle: (value: unknown) => void = () => undefined;
    const rs = { toggleRule: vi.fn(() => new Promise((resolve) => (settle = resolve))), deleteRule: vi.fn() };
    const controller = createRulesController(
      rs as never,
      (change) => (state = change(state)),
      () => state,
      () => i18nFor(language),
    );
    const pending = controller.toggle(ID.host, true);
    language = 'en';
    settle({ ok: false, code: 'timeout' });
    await pending;
    expect(state.feedback?.text).toBe(`Rule not turned on: ${EN.t.errors.timeout}`);
  });

  it('transfer: export, import and a refused replacement in Russian; English plurals', async () => {
    let state: TransferUiState = INITIAL_TRANSFER_UI;
    const rs = {
      importConfig: vi.fn().mockResolvedValue({ ok: true, value: { token: 'T', config: configWith(5) } }),
      applyImport: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      exportConfig: vi.fn().mockResolvedValue({ ok: true, value: { rules: 21, path: '/tmp/x.json' } }),
    };
    let language: Locale = 'ru';
    const controller = createTransferController(rs, (change) => (state = change(state)), () => state, () => i18nFor(language));
    await controller.startExport();
    expect(state.feedback).toEqual({ tone: 'success', text: 'Конфигурация сохранена в файл: 21 правило.' });
    await controller.startImport();
    await controller.confirmImport('T');
    expect(state.feedback).toEqual({ tone: 'success', text: 'Конфигурация импортирована: 5 правил.' });
    rs.importConfig.mockResolvedValue({ ok: false, code: 'file-not-json' });
    await controller.startImport();
    expect(state.feedback).toEqual({ tone: 'danger', text: `Импорт не выполнен: ${RU.t.errors['file-not-json']}` });
    language = 'en';
    rs.exportConfig.mockResolvedValue({ ok: true, value: { rules: 1, path: '/tmp/x.json' } });
    await controller.startExport();
    expect(state.feedback).toEqual({ tone: 'success', text: 'Config saved to file: 1 rule.' });
    rs.importConfig.mockResolvedValue({ ok: true, value: { token: 'U', config: configWith(2) } });
    rs.applyImport.mockResolvedValue({ ok: false, code: 'busy' });
    await controller.startImport();
    await controller.confirmImport('U');
    expect(state.feedback).toEqual({ tone: 'danger', text: `Config not replaced: ${EN.t.errors.busy}` });
  });

  it('recovery: success and failure in English', async () => {
    let state: RecoveryUiState = INITIAL_RECOVERY_UI;
    const rs = { resetConfig: vi.fn().mockResolvedValueOnce({ ok: false, code: 'busy' }).mockResolvedValueOnce({ ok: true, value: undefined }) };
    const controller = createRecoveryController(rs, (change) => (state = change(state)), () => state, () => EN);
    controller.ask();
    await controller.confirm();
    expect(state.feedback).toEqual({ tone: 'danger', text: `Config not replaced: ${EN.t.errors.busy}` });
    await controller.confirm();
    expect(state.feedback).toEqual({ tone: 'success', text: EN.t.rules.resetDone });
  });
});

const connected = (state: EngineState = STATE): EngineStateView => ({
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.1.0' },
  state,
  error: null,
});
const ready: ConfigView = { phase: 'ready', config: CONFIG, revision: 3, error: null };
const panelProps = (i18n: I18n, extra: Partial<RulesPanelProps> = {}): RulesPanelProps => ({
  engine: connected(),
  config: ready,
  now: NOW,
  query: '',
  filter: 'all',
  busy: new Set(),
  confirmingDelete: null,
  feedback: null,
  onQueryChange: vi.fn(),
  onFilterChange: vi.fn(),
  onToggleRule: vi.fn(),
  onAskDelete: vi.fn(),
  onCancelDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onReloadConfig: vi.fn(),
  onAddRule: vi.fn(),
  onEditRule: vi.fn(),
  transfer: INITIAL_TRANSFER_UI,
  onImport: vi.fn(),
  onExport: vi.fn(),
  onConfirmImport: vi.fn(),
  onCancelImport: vi.fn(),
  recovery: INITIAL_RECOVERY_UI,
  onAskReset: vi.fn(),
  onCancelReset: vi.fn(),
  onConfirmReset: vi.fn(),
  i18n,
  ...extra,
});
/** Rendered inside a provider of the same language, as in the app (shared components read the context). */
const inLanguage = (locale: Locale, element: ReactElement) => renderMarkup(createElement(I18nProvider, { language: locale }, element));
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('RulesPanel in Russian and English', () => {
  it.each([
    ['ru', RU, ['Добавить правило', 'Статус', 'Адрес', 'Тип', 'Интерфейс', 'Заметка', 'Подсеть', 'Все', 'Импорт', 'Экспорт']],
    ['en', EN, ['Add rule', 'Status', 'Address', 'Type', 'Interface', 'Note', 'Subnet', 'All', 'Import', 'Export']],
  ] as const)('%s: header, toolbar and table; no Uzbek left', (locale, i18n, expected) => {
    const html = words(inLanguage(locale, createElement(RulesPanel, panelProps(i18n))));
    for (const word of expected) expect(html).toContain(word);
    for (const word of UZBEK_WORDS) expect(html).not.toContain(word);
  });

  it('the delete question and the import question are in the language', () => {
    const del = words(inLanguage('en', createElement(RulesPanel, panelProps(EN, { confirmingDelete: ID.host }))));
    expect(del).toContain('Delete the rule “172.16.12.40”? Its routes will be removed.');
    expect(del).toContain('Cancel');
    const imp = words(
      inLanguage('ru', createElement(RulesPanel, panelProps(RU, { transfer: { ...INITIAL_TRANSFER_UI, preview: { token: 'T', config: configWith(2) } } }))),
    );
    expect(imp).toContain('Импорт полностью заменит текущую конфигурацию: 2 правила (сейчас 6).');
    expect(imp).toContain('Заменить');
  });

  it('nothing found: the query and the filter, in Russian', () => {
    const html = words(inLanguage('ru', createElement(RulesPanel, panelProps(RU, { query: ' zzz ', filter: 'off' }))));
    expect(html).toContain('Ничего не найдено');
    expect(html).toContain('Нет подходящих правил по запросу «zzz» среди «Выключенные».');
  });

  it('the unreadable-config recovery and its question, in English', () => {
    const engine: EngineStateView = { helper: 'config-unreadable', connection: { kind: 'config-unreadable', helperVersion: '0.1.0' }, state: null, error: null };
    const raw = inLanguage('en', createElement(RulesPanel, panelProps(EN, { engine, config: { phase: 'idle', config: null, revision: null, error: null }, recovery: { ...INITIAL_RECOVERY_UI, confirming: true } })));
    const html = words(raw);
    expect(html).toContain('Start with an empty config');
    expect(html).toContain('Replace the stored (unreadable) config with an empty one?');
    expect(raw.replace(/&#x27;/g, "'")).toContain(`aria-label="Add rule — ${EN.t.rules.configUnreadableReason}"`);
  });
});

describe('RulesWindowFrame (sidebar) in English', () => {
  it('section names, the nav label and the helper status', () => {
    const html = inLanguage('en', createElement(RulesWindowFrame, { section: 'rules', engine: connected(), onSelect: vi.fn(), i18n: EN, children: null }));
    expect(html).toContain('aria-label="Sections"');
    for (const word of ['Rules', 'Log', 'Settings', EN.t.helperStatus.connected, 'root daemon · v0.1.0']) expect(words(html)).toContain(word);
    for (const word of UZBEK_WORDS) expect(words(html)).not.toContain(word);
  });
});
