import type { Config, EngineState, TestResult } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, InterfaceOption, Segment } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import { IDLE_CONFIG, type ConfigView } from '../../hooks/useConfig';
import { LOADING_VIEW, type EngineStateView } from '../../hooks/useEngineState';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import {
  AddRulePanel,
  focusField,
  formStatus,
  handleDialogEscape,
  refreshText,
  visibleErrors,
  type AddRulePanelProps,
  type FormStatus,
} from './AddRuleScreen';
import { initialAddRuleUi, type AddRuleUiState } from './controller';
import { formOfRule, NEW_RULE_FORM, WILDCARD_TEXT, type RuleForm } from './model';
import { VALIDATION_TEXT as UZ_VALIDATION } from '../../text';

const NEW_ID = '77777777-7777-4777-8777-777777777777';
const connected = (state: EngineState = STATE): EngineStateView => ({
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.1.0' },
  state,
  error: null,
});
const ui = (form: Partial<RuleForm> = {}, extra: Partial<AddRuleUiState> = {}): AddRuleUiState => ({
  ...initialAddRuleUi({ ...NEW_RULE_FORM, ...form }),
  ...extra,
});
const READY: FormStatus = { kind: 'ready' };

const props = (extra: Partial<AddRulePanelProps> = {}): AddRulePanelProps => ({
  mode: 'add',
  ruleId: NEW_ID,
  status: READY,
  engine: connected(),
  config: CONFIG,
  ui: ui(),
  onKind: vi.fn(),
  onIface: vi.fn(),
  onField: vi.fn(),
  onBlur: vi.fn(),
  onSave: vi.fn(),
  onCancel: vi.fn(),
  onTest: vi.fn(),
  ...extra,
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const render = (extra: Partial<AddRulePanelProps> = {}) => renderMarkup(createElement(AddRulePanel, props(extra)));

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (value: unknown) => void;
  readonly onBlur?: () => void;
  readonly onSelect?: (value: unknown) => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly type?: string;
  readonly role?: string;
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
}
// Segment and the leaf components keep their props; the rest are hook-free and are expanded.
const LEAVES: readonly unknown[] = [Button, Segment, InterfaceOption];
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  const own: ReactElement<AnyProps>[] = [node, ...elementsOf(node.props.children)];
  if (typeof node.type === 'function' && !LEAVES.includes(node.type)) {
    own.push(...elementsOf((node.type as (p: AnyProps) => ReactNode)(node.props)));
  }
  return own;
}
const treeOf = (extra: Partial<AddRulePanelProps> = {}) => {
  const all = props(extra);
  return { all, elements: elementsOf(AddRulePanel(all)) };
};
const buttonsNamed = (elements: ReactElement<AnyProps>[], name: string) =>
  elements.filter((element) => element.type === Button && (element.props.children === name || (Array.isArray(element.props.children) && element.props.children.includes(name))));
const inputWithPlaceholder = (elements: ReactElement<AnyProps>[], placeholder: string) =>
  elements.find((element) => element.type === 'input' && element.props.placeholder === placeholder);
const changeEvent = (value: string | boolean) => ({ target: { value, checked: value } });

describe('AddRulePanel — layout', () => {
  it('a new rule: title, kind segment, address, interfaces, note, command preview, test, buttons', () => {
    const html = render({ ui: ui({ target: '10.50.0.0/16' }) });
    const words = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="add-rule-title"');
    for (const phrase of [
      'Yangi qoida',
      'Manzil va u qaysi kanal orqali borishini tanlang.',
      'Turi',
      'Subnet (CIDR)',
      'Butun ichki tarmoq uchun eng ishonchli variant.',
      'Interfeys',
      'Ethernet',
      'en5 · 10.20.4.1',
      'Wi‑Fi',
      'en0 · 192.168.0.1',
      'Izoh',
      "Helper qo'llaydigan buyruq — ko'rsatish uchun, ilova uni yuritmaydi",
      '$ route -n add -net 10.50.0.0/16 10.20.4.1',
      "Sinab ko'rish",
      'Bekor qilish',
      "Saqlash va qo'llash",
    ]) {
      expect(words).toContain(phrase);
    }
    expect(html).not.toContain('Ichki DNS server');
    expect(html).toContain('role="radiogroup" aria-label="Turi"');
  });

  it('edit mode is titled for editing', () => {
    expect(text(render({ mode: 'edit' }))).toContain('Qoidani tahrirlash');
  });

  it('the DNS block only for a domain: check box, server, refresh, resolver file', () => {
    const html = text(render({ ui: ui({ kind: 'domain', target: 'corp.local', useDns: true, dns: '10.20.0.10' }) }));
    expect(html).toContain('Ichki DNS server orqali resolve qilish');
    expect(html).toContain("IP'larni yangilash oralig'i (soniya)");
    expect(html).toContain("/etc/resolver/corp.local fayli yaratiladi. IP'lar har 10 daqiqada yangilanadi.");
    expect(html).toContain('$ route -n add -host <resolve(corp.local)> 10.20.4.1');
    expect(html).toContain('$ route -n add -host 10.20.0.10 10.20.4.1');
    const noDns = text(render({ ui: ui({ kind: 'domain', target: 'corp.local', useDns: false }) }));
    expect(noDns).not.toContain('/etc/resolver');
    expect(noDns).not.toContain('DNS server manzili');
  });

  it('the address hint says how a value will be stored', () => {
    expect(text(render({ ui: ui({ target: '10.1.2.3/8' }) }))).toContain('10.0.0.0/8 sifatida saqlanadi.');
    expect(text(render({ ui: ui({ kind: 'subnet', target: '172.16.12.40/32' }) }))).toContain('«172.16.12.40» qoidasida ham bor');
  });

  it('an IP wildcard: the CIDR under the input, the -net preview, the subnet test (TASK-DELTA-15)', () => {
    const html = text(render({ ui: ui({ kind: 'ip', target: '10.*.*.*', iface: 'wifi' }), config: null }));
    expect(html).toContain('→ 10.0.0.0/8 (subnet)');
    expect(html).toContain('$ route -n add -net 10.0.0.0/8 192.168.0.1');
    expect(html).not.toContain('-host 10.0.0.0/8');
    const { all, elements } = treeOf({ ui: ui({ kind: 'ip', target: '10.*.*.*' }), config: null });
    buttonsNamed(elements, "Sinab ko'rish")[0]?.props.onClick?.();
    expect(all.onTest).toHaveBeenCalledWith('10.0.0.1');
    // The hints of both IP kinds give a wildcard example.
    expect(text(render({ ui: ui({ kind: 'ip' }) }))).toContain('10.*.*.*');
    expect(text(render({ ui: ui({ kind: 'subnet' }) }))).toContain('10.*.*.*');
  });

  it('an invalid or forbidden wildcard is refused next to the field (ADR-001 words for 224.*.*.*)', () => {
    const touched = { submitted: true };
    expect(text(render({ ui: ui({ kind: 'ip', target: '10.*.1.*' }, touched) }))).toContain("faqat oxirgi oktetlarda");
    const forbidden = text(render({ ui: ui({ kind: 'ip', target: '224.*.*.*' }, touched) }));
    expect(forbidden).not.toContain('→ 224.0.0.0');
    expect(forbidden).toContain(UZ_VALIDATION.multicast);
  });

  it('a helper that is not connected: a banner, and no command', () => {
    const html = text(render({ engine: { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null } }));
    expect(html).toContain("Helper o'rnatilmagan — qoidani saqlab bo'lmaydi.");
    expect(html).toContain("Buyruq helper ulanganda ko'rinadi");
    expect(html).toContain("Helper bilan aloqa yo'q.");
    expect(text(render({ engine: LOADING_VIEW }))).toContain("qoidani saqlab bo'lmaydi");
  });

  it('loading, missing and unreadable edit forms show why, with only "Bekor qilish" (focused)', () => {
    for (const [status, phrase] of [
      [{ kind: 'loading' }, "Qoida o'qilmoqda…"],
      [{ kind: 'missing' }, "Bu qoida endi yo'q"],
      [{ kind: 'unavailable', text: "Helper bilan aloqa yo'q — qoidani o'qib bo'lmaydi." }, "qoidani o'qib bo'lmaydi"],
    ] as const) {
      const html = render({ mode: 'edit', status });
      expect(text(html)).toContain(phrase);
      expect(html).not.toContain('Saqlash');
      expect(html).not.toContain('<input');
      const { elements } = treeOf({ mode: 'edit', status });
      expect(buttonsNamed(elements, 'Bekor qilish')[0]?.props.autoFocus).toBe(true);
    }
  });
});

describe('AddRulePanel — errors next to the field', () => {
  it('hidden while typing, shown once the field was left, all shown after a save attempt', () => {
    const typing = render({ ui: ui({ target: '10.0.0.0/33' }) });
    expect(typing).not.toContain('aria-invalid');
    const left = render({ ui: ui({ target: '10.0.0.0/33' }, { touched: new Set(['target']) }) });
    expect(left).toContain('aria-invalid="true"');
    expect(text(left)).toContain("Prefiks 8 dan 32 gacha bo'lishi kerak.");
    expect(left).toMatch(/id="add-rule-target-message"[^>]*data-tone="danger"/);
    const submitted = render({ ui: ui({ kind: 'domain', target: '*.corp.local', useDns: true, dns: 'x', refreshSec: '10' }, { submitted: true }) });
    expect(text(submitted)).toContain(WILDCARD_TEXT);
    expect(submitted.match(/aria-invalid="true"/g)).toHaveLength(3);
    expect(text(submitted)).toContain('60 dan 86400 gacha butun son');
    expect(text(submitted)).not.toContain('yangilanadi');
  });

  it('a conflicting target is refused next to the field and shows no misleading hint', () => {
    const html = text(render({ ui: ui({ kind: 'ip', target: '172.16.12.40', iface: 'wifi' }, { submitted: true }) }));
    expect(html).toContain("«172.16.12.40» qoidasida Ethernet orqali yo'naltirilgan");
  });

  it('the save feedback is an alert', () => {
    expect(render({ ui: ui({}, { feedback: { tone: 'danger', text: 'Qoida saqlanmadi: x' } }) })).toMatch(/role="alert"[^>]*>Qoida saqlanmadi: x/);
  });

  it('visibleErrors and refreshText', () => {
    const errors = { target: 'a', dns: 'b' };
    expect(visibleErrors(errors, { touched: new Set(), submitted: false })).toEqual({});
    expect(visibleErrors(errors, { touched: new Set(['dns', 'note']), submitted: false })).toEqual({ dns: 'b' });
    expect(visibleErrors(errors, { touched: new Set(), submitted: true })).toBe(errors);
    expect(refreshText(600)).toBe("IP'lar har 10 daqiqada yangilanadi.");
    expect(refreshText(90)).toBe("IP'lar har 90 soniyada yangilanadi.");
  });
});

describe('AddRulePanel — wiring', () => {
  it('submitting the form saves (Enter or the primary button); not while the form is not ready', () => {
    const { all, elements } = treeOf();
    const form = elements.find((element) => element.type === 'form');
    const preventDefault = vi.fn();
    form?.props.onSubmit?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(all.onSave).toHaveBeenCalledTimes(1);
    const save = buttonsNamed(elements, "Saqlash va qo'llash")[0];
    expect(save?.props.type).toBe('submit');
    expect(save?.props.busy).toBe(false);
    const loading = treeOf({ status: { kind: 'loading' } });
    loading.elements.find((element) => element.type === 'form')?.props.onSubmit?.({ preventDefault: vi.fn() });
    expect(loading.all.onSave).not.toHaveBeenCalled();
  });

  it('while saving the primary button is busy (focusable, aria-disabled), not disabled', () => {
    const { elements } = treeOf({ ui: ui({ target: '10.0.0.0/8' }, { saving: true }) });
    const save = buttonsNamed(elements, "Saqlash va qo'llash")[0];
    expect(save?.props.busy).toBe(true);
    expect(save?.props.disabled).toBeUndefined();
    expect(render({ ui: ui({ target: '10.0.0.0/8' }, { saving: true }) })).toMatch(/aria-busy="true"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-busy="true"/);
  });

  it('"Bekor qilish" and Escape cancel; other keys do nothing', () => {
    const { all, elements } = treeOf();
    buttonsNamed(elements, 'Bekor qilish')[0]?.props.onClick?.();
    expect(all.onCancel).toHaveBeenCalledTimes(1);
    const form = elements.find((element) => element.type === 'form');
    form?.props.onKeyDown?.({ key: 'Enter', preventDefault: vi.fn() });
    expect(all.onCancel).toHaveBeenCalledTimes(1);
    form?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() });
    expect(all.onCancel).toHaveBeenCalledTimes(2);
    expect(all.onSave).not.toHaveBeenCalled();
  });

  it('while saving, "Bekor qilish" is busy and Escape does not close: a late refusal is not lost (TASK-300)', () => {
    const { all, elements } = treeOf({ ui: ui({ target: '10.0.0.0/8' }, { saving: true }) });
    const cancel = buttonsNamed(elements, 'Bekor qilish')[0];
    expect(cancel?.props.busy).toBe(true);
    expect(cancel?.props.disabled).toBeUndefined();
    const form = elements.find((element) => element.type === 'form');
    form?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() });
    expect(all.onCancel).not.toHaveBeenCalled();
  });

  it('the kind segment, interface options and inputs report to their callbacks', () => {
    const { all, elements } = treeOf({ ui: ui({ kind: 'domain', target: 'corp.local', useDns: true }) });
    const segment = elements.find((element) => element.type === Segment);
    segment?.props.onChange?.('ip');
    expect(all.onKind).toHaveBeenCalledWith('ip');
    const options = elements.filter((element) => element.type === InterfaceOption);
    expect(options).toHaveLength(2);
    options[1]?.props.onSelect?.('wifi');
    expect(all.onIface).toHaveBeenCalledWith('wifi');

    const target = inputWithPlaceholder(elements, 'corp.local');
    expect(target?.props.autoFocus).toBe(true);
    target?.props.onChange?.(changeEvent('a.local'));
    expect(all.onField).toHaveBeenCalledWith('target', 'a.local');
    target?.props.onBlur?.();
    expect(all.onBlur).toHaveBeenCalledWith('target');

    inputWithPlaceholder(elements, '10.20.0.10')?.props.onChange?.(changeEvent('10.1.1.1'));
    expect(all.onField).toHaveBeenCalledWith('dns', '10.1.1.1');
    inputWithPlaceholder(elements, 'Masalan: buxgalteriya tizimi')?.props.onChange?.(changeEvent('n'));
    expect(all.onField).toHaveBeenCalledWith('note', 'n');
    const checkbox = elements.find((element) => element.type === 'input' && (element.props as { type?: string }).type === 'checkbox');
    checkbox?.props.onChange?.(changeEvent(false));
    expect(all.onField).toHaveBeenCalledWith('useDns', false);
    const refresh = elements.find((element) => element.type === 'input' && (element.props as { inputMode?: string }).inputMode === 'numeric');
    refresh?.props.onChange?.(changeEvent('900'));
    expect(all.onField).toHaveBeenCalledWith('refreshSec', '900');
  });

  it('"Sinab ko\'rish" tests the address the rule routes; disabled with the reason when there is none', () => {
    const { all, elements } = treeOf({ ui: ui({ target: '10.0.0.0/8' }) });
    const test = buttonsNamed(elements, "Sinab ko'rish")[0];
    expect(test?.props.label).toBe("10.0.0.1 manzilini sinab ko'rish");
    test?.props.onClick?.();
    expect(all.onTest).toHaveBeenCalledWith('10.0.0.1');

    const invalid = treeOf({ ui: ui({ target: '10.0.0.0/33' }) });
    const off = buttonsNamed(invalid.elements, "Sinab ko'rish")[0];
    expect(off?.props.disabled).toBe(true);
    expect(off?.props.label).toBe("Sinab ko'rish — Avval to'g'ri manzil kiriting.");
    off?.props.onClick?.();
    expect(invalid.all.onTest).not.toHaveBeenCalled();
  });

  it('a saved domain rule is tested with its first resolved address', () => {
    const rule = CONFIG.rules.find((candidate) => candidate.id === ID.dnsDomain);
    if (rule === undefined) throw new Error('fixture');
    const { all, elements } = treeOf({ mode: 'edit', ruleId: ID.dnsDomain, ui: ui(formOfRule(rule), { loaded: true }) });
    buttonsNamed(elements, "Sinab ko'rish")[0]?.props.onClick?.();
    expect(all.onTest).toHaveBeenCalledWith('10.20.1.5');
    expect(text(render({ ui: ui({ kind: 'domain', target: 'new.local' }) }))).toContain('avval saqlang');
  });

  it('shows the test answer only for the address being tested', () => {
    const result: TestResult = { target: '10.0.0.1', destination: 'default', gateway: '192.168.0.1', device: 'en0', role: 'wifi', ruleId: null };
    const done = text(render({ ui: ui({ target: '10.0.0.0/8' }, { test: { phase: 'done', address: '10.0.0.1', result } }) }));
    expect(done).toContain('10.0.0.1 → en0 (Wi‑Fi) · gateway 192.168.0.1');
    expect(done).toContain("Hozir Wi‑Fi orqali ketadi — saqlangandan keyin Ethernet orqali bo'ladi.");
    const stale = text(render({ ui: ui({ target: '192.168.50.0/24', iface: 'wifi' }, { test: { phase: 'done', address: '10.0.0.1', result } }) }));
    expect(stale).not.toContain('→ en0');
    expect(stale).toContain('192.168.50.1 hozir qaysi interfeys orqali ketishini tekshiradi');
    const failed = text(render({ ui: ui({ target: '10.0.0.0/8' }, { test: { phase: 'failed', address: '10.0.0.1', text: 'Bu manzil uchun route topilmadi.' } }) }));
    expect(failed).toContain('Bu manzil uchun route topilmadi.');
    const running = treeOf({ ui: ui({ target: '10.0.0.0/8' }, { test: { phase: 'running', address: '10.0.0.1' } }) });
    expect(buttonsNamed(running.elements, "Sinab ko'rish")[0]?.props.busy).toBe(true);
  });

  it('a saved rule tested through its own interface reads as matching', () => {
    const rule = CONFIG.rules.find((candidate) => candidate.id === ID.subnet);
    if (rule === undefined) throw new Error('fixture');
    const result: TestResult = { target: '10.0.0.1', destination: '10.0.0.0', gateway: '10.20.4.1', device: 'en5', role: 'ethernet', ruleId: ID.subnet };
    const html = text(
      render({ mode: 'edit', ruleId: ID.subnet, ui: ui(formOfRule(rule), { loaded: true, test: { phase: 'done', address: '10.0.0.1', result } }) }),
    );
    expect(html).toContain("Shu qoida bo'yicha Ethernet orqali ketadi.");
  });
});

describe('formStatus', () => {
  const ready = (config: Config | null): ConfigView => ({ phase: 'ready', config, revision: 3, error: null });
  it('add is always ready; edit waits for the rule, then stays ready', () => {
    expect(formStatus({ mode: 'add' }, IDLE_CONFIG, false)).toEqual({ kind: 'ready' });
    expect(formStatus({ mode: 'edit', id: ID.host }, ready(CONFIG), false)).toEqual({ kind: 'loading' });
    expect(formStatus({ mode: 'edit', id: ID.host }, ready(CONFIG), true)).toEqual({ kind: 'ready' });
    expect(formStatus({ mode: 'edit', id: ID.host }, { ...IDLE_CONFIG, phase: 'loading' }, false)).toEqual({ kind: 'loading' });
  });
  it('a rule that is gone, a failed read, no helper', () => {
    expect(formStatus({ mode: 'edit', id: NEW_ID }, ready(CONFIG), false)).toEqual({ kind: 'missing' });
    expect(formStatus({ mode: 'edit', id: NEW_ID }, { phase: 'failed', config: null, revision: 3, error: { code: 'timeout', message: 'x' } }, false)).toMatchObject({
      kind: 'unavailable',
      text: expect.stringContaining("Qoidani o'qib bo'lmadi: Javob kelmadi") as string,
    });
    expect(formStatus({ mode: 'edit', id: NEW_ID }, IDLE_CONFIG, false)).toEqual({ kind: 'unavailable', text: "Helper bilan aloqa yo'q — qoidani o'qib bo'lmaydi." });
  });
});

it('focusField moves the focus to a field on the page', () => {
  const focus = vi.fn();
  const inputs = new Map([['dns', { focus }]] as const);
  expect(focusField(inputs, 'dns')).toBe(true);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(focusField(inputs, 'target')).toBe(false);
  expect(focusField(inputs, null)).toBe(false);
});

describe('handleDialogEscape (TASK-300)', () => {
  const event = (key: string, defaultPrevented = false) => ({ key, defaultPrevented, preventDefault: vi.fn() });

  it('Escape closes and is marked handled; other keys do nothing', () => {
    const onCancel = vi.fn();
    const escape = event('Escape');
    expect(handleDialogEscape(escape, false, onCancel)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    const enter = event('Enter');
    expect(handleDialogEscape(enter, false, onCancel)).toBe(false);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("an Escape the form's own listener handled is not handled again at the document", () => {
    const onCancel = vi.fn();
    expect(handleDialogEscape(event('Escape', true), false, onCancel)).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('while a save is on its way Escape is swallowed, not a close', () => {
    const onCancel = vi.fn();
    const escape = event('Escape');
    expect(handleDialogEscape(escape, true, onCancel)).toBe(false);
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
