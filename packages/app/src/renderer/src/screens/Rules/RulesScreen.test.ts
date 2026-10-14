import type { Config, EngineState } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Toggle } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import { IDLE_CONFIG, type ConfigView } from '../../hooks/useConfig';
import { LOADING_VIEW, type EngineStateView } from '../../hooks/useEngineState';
import type { RsApi } from '../../rs';
import { RULE_REASON_TEXT } from '../../text';
import { CONFIG, ID, NOW, STATE, ruleState } from '../MenuBar/fixtures';
import { ADD_RULE_UNAVAILABLE, RulesPanel, RulesScreen, type RulesPanelProps } from './RulesScreen';
import { INITIAL_TRANSFER_UI } from './transfer';

const connected = (state: EngineState = STATE): EngineStateView => ({
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.1.0' },
  state,
  error: null,
});
const ready = (config: Config = CONFIG): ConfigView => ({ phase: 'ready', config, revision: 3, error: null });

const props = (extra: Partial<RulesPanelProps> = {}): RulesPanelProps => ({
  engine: connected(),
  config: ready(),
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
  transfer: INITIAL_TRANSFER_UI,
  onImport: vi.fn(),
  onExport: vi.fn(),
  onConfirmImport: vi.fn(),
  onCancelImport: vi.fn(),
  ...extra,
});
const render = (extra: Partial<RulesPanelProps> = {}) => renderMarkup(createElement(RulesPanel, props(extra)));
/** The visible words of rendered markup, entities decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

// Every component here is hook-free, so calling them returns the element tree: handlers are reached without a DOM.
interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (value: unknown) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly checked?: boolean;
  readonly autoFocus?: boolean;
  readonly ref?: unknown;
  readonly role?: string;
  readonly onKeyDown?: (event: { key: string }) => void;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  const own: ReactElement<AnyProps>[] = [node, ...elementsOf(node.props.children)];
  if (typeof node.type === 'function' && node.type !== Button && node.type !== Toggle) {
    own.push(...elementsOf((node.type as (p: AnyProps) => ReactNode)(node.props)));
  }
  return own;
}
const treeOf = (extra: Partial<RulesPanelProps> = {}) => {
  const all = props(extra);
  return { all, elements: elementsOf(RulesPanel(all)) };
};
const buttonsLabelled = (elements: ReactElement<AnyProps>[], label: string) =>
  elements.filter((element) => element.type === Button && (element.props.label === label || element.props.children === label));
const toggles = (elements: ReactElement<AnyProps>[]) => elements.filter((element) => element.type === Toggle);

describe('RulesPanel — table', () => {
  it('shows the header, toolbar, every rule with kind, interface and note, and the footer', () => {
    const html = render();
    const words = text(html);
    expect(words).toContain('Qoidalar');
    expect(words).toContain("Qoida qo'shish");
    expect(words).toContain('Import');
    expect(words).toContain('Export');
    for (const column of ['Holat', 'Manzil', 'Turi', 'Interfeys', 'Izoh']) expect(words).toContain(column);
    expect(html.match(/role="row"/g)).toHaveLength(7);
    expect(words).toContain('10.0.0.0/8 Subnet ETH en5 Ichki tarmoq');
    expect(words).toContain('corp.local Domen + DNS ETH en5 DNS: 10.20.0.10');
    expect(words).toContain('github.com Domen WIFI en0 3 IP · har 10 daq');
    expect(words).toContain("Oxirgi qo'llash: 10:58 · tarmoq o'zgarganda");
    expect(words).toContain("5 ta qoida faol · tarmoq o'zgarganda avtomatik qo'llanadi");
  });

  it('each rule has its own switch showing the config, and a switched-off rule reads as off', () => {
    const { all, elements } = treeOf();
    const switches = toggles(elements);
    expect(switches.map((element) => element.props.checked)).toEqual([true, false, true, true, true, true]);
    expect(switches[0]?.props.label).toBe('10.0.0.0/8 qoidasi');
    switches[1]?.props.onChange?.(true);
    expect(all.onToggleRule).toHaveBeenCalledWith(ID.off, true);
    expect(render()).toContain('data-enabled="false"');
  });

  it('a rule on its way to the helper is busy, not disabled', () => {
    const { elements } = treeOf({ busy: new Set([ID.subnet]) });
    expect(toggles(elements)[0]?.props.busy).toBe(true);
    expect(buttonsLabelled(elements, "10.0.0.0/8 qoidasini o'chirish")[0]?.props.busy).toBe(true);
  });

  it('pending and error rows show the status and the translated reason', () => {
    const state = {
      ...STATE,
      rules: [ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' }), ruleState(ID.host, { status: 'pending', reasonCode: 'interface-down' })],
    };
    const html = render({ engine: connected(state) });
    expect(html).toContain('data-status="error"');
    expect(html).toContain('data-status="pending"');
    const words = text(html);
    expect(words).toContain("Route qo'shilmadi");
    expect(words).toContain('Interfeys ulanmagan');
    expect(words).toContain('1 ta qoidada xato');
  });

  it.each(['addresses-truncated', 'overridden-by-rule', 'dns-server-excluded'] as const)(
    'active + %s reads "Faol" with a warning mark and the reason, and is not an error',
    (code) => {
      const state = { ...STATE, rules: [ruleState(ID.domain, { reasonCode: code })] };
      const html = render({ engine: connected(state) });
      expect(html).toContain('data-status="active"');
      expect(text(html)).toContain('Faol');
      expect(html).toContain('aria-label="Ogohlantirish"');
      expect(html).toContain('data-tone="warning"');
      expect(html).not.toContain('data-status="error"');
      // The reason is read once (the line), not again inside the tag.
      expect(html.split(RULE_REASON_TEXT[code].replace(/'/g, '&#x27;')).length - 1).toBe(1);
      expect(text(html)).not.toContain('xato');
    },
  );

  it('warns about overlapping subnets (findOverlaps)', () => {
    const config: Config = {
      ...CONFIG,
      rules: [...CONFIG.rules, { id: '77777777-7777-4777-8777-777777777777', kind: 'subnet', target: '10.1.0.0/16', iface: 'wifi', enabled: true, refreshSec: 600 }],
    };
    const html = render({ config: ready(config) });
    expect(html).toContain('role="note"');
    expect(text(html)).toContain('10.1.0.0/16 (WIFI) → 10.0.0.0/8 (ETH) ichida · boshqa interfeys');
    expect(render()).not.toContain('role="note"');
  });

  it('with routing off the footer says how to turn it on', () => {
    const words = text(render({ engine: connected({ ...STATE, enabled: false }) }));
    expect(words).toContain("Routing o'chirilgan");
    expect(words).toContain('umumiy tugma bilan yoqiladi');
  });
});

describe('RulesPanel — search and filter', () => {
  it('passes what is typed and chosen', () => {
    const { all, elements } = treeOf();
    const input = elements.find((element) => element.type === 'input');
    input?.props.onChange?.({ target: { value: 'git' } });
    expect(all.onQueryChange).toHaveBeenCalledWith('git');
    const select = elements.find((element) => element.type === 'select');
    select?.props.onChange?.({ target: { value: 'problems' } });
    expect(all.onFilterChange).toHaveBeenCalledWith('problems');
  });

  it('shows only matching rows', () => {
    const html = render({ query: 'firebird' });
    expect(html.match(/role="row"/g)).toHaveLength(2);
    expect(text(html)).toContain('172.16.12.40');
  });

  it('nothing found says what was looked for', () => {
    const words = text(render({ query: 'nope', filter: 'off' }));
    expect(words).toContain('Hech narsa topilmadi');
    expect(words).toContain("«nope» bo'yicha «O'chirilgan» orasida mos qoida yo'q.");
  });

  it('an empty config says there is no rule yet', () => {
    const words = text(render({ config: ready({ ...CONFIG, rules: [] }) }));
    expect(words).toContain("Hali qoida yo'q");
    expect(words).not.toContain('topilmadi');
  });
});

describe('RulesPanel — delete with confirmation', () => {
  it('the trash button only asks; nothing is removed before the confirmation', () => {
    const { all, elements } = treeOf();
    buttonsLabelled(elements, "github.com qoidasini o'chirish")[0]?.props.onClick?.();
    expect(all.onAskDelete).toHaveBeenCalledWith(ID.domain);
    expect(all.onConfirmDelete).not.toHaveBeenCalled();
  });

  it('the confirmation names the rule and confirms or cancels', () => {
    const { all, elements } = treeOf({ confirmingDelete: ID.domain });
    expect(text(renderMarkup(RulesPanel(all)))).toContain("«github.com» qoidasi o'chirilsinmi?");
    expect(renderMarkup(RulesPanel(all))).toContain('role="alertdialog"');
    buttonsLabelled(elements, "O'chirish")[0]?.props.onClick?.();
    expect(all.onConfirmDelete).toHaveBeenCalledWith(ID.domain);
    buttonsLabelled(elements, 'Bekor qilish')[0]?.props.onClick?.();
    expect(all.onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it('the safe choice "Bekor qilish" takes the focus when the question opens; Escape cancels', () => {
    const { all, elements } = treeOf({ confirmingDelete: ID.domain });
    const cancel = buttonsLabelled(elements, 'Bekor qilish')[0];
    expect(cancel?.props.autoFocus).toBe(true);
    expect(buttonsLabelled(elements, "O'chirish")[0]?.props.autoFocus).toBeUndefined();
    const dialog = elements.find((element) => element.props.role === 'alertdialog');
    // Keyed by rule: asking about another rule mounts a new dialog, which takes the focus again.
    expect(dialog?.key).toBe(ID.domain);
    dialog?.props.onKeyDown?.({ key: 'Enter' });
    expect(all.onCancelDelete).not.toHaveBeenCalled();
    dialog?.props.onKeyDown?.({ key: 'Escape' });
    expect(all.onCancelDelete).toHaveBeenCalledTimes(1);
    expect(all.onConfirmDelete).not.toHaveBeenCalled();
  });

  it('each trash button gets its rule\'s ref, so the focus can come back to it after a cancel', () => {
    const refs = new Map<string, () => void>();
    const trashRef = vi.fn((id: string) => {
      const ref = () => undefined;
      refs.set(id, ref);
      return ref;
    });
    const { elements } = treeOf({ trashRef });
    expect(buttonsLabelled(elements, "github.com qoidasini o'chirish")[0]?.props.ref).toBe(refs.get(ID.domain));
    expect(trashRef).toHaveBeenCalledTimes(6);
  });

  it('a confirmation for a rule that is gone is not shown', () => {
    expect(render({ confirmingDelete: '99999999-9999-4999-8999-999999999999' })).not.toContain('alertdialog');
  });

  it('a failure is an alert', () => {
    expect(render({ feedback: { tone: 'danger', text: "Qoida o'chirib tashlanmadi: x" } })).toMatch(/role="alert"[^>]*>Qoida o/);
  });
});

describe('RulesPanel — what is not built yet (TASK-213, TASK-215)', () => {
  it('"Qoida qo\'shish" and edit are disabled with the reason until the add-rule form exists', () => {
    const { elements } = treeOf();
    const add = elements.find((element) => element.type === Button && elementsOf(element.props.children).length > 0);
    expect(add?.props.disabled).toBe(true);
    // The reason is in the accessible name, not only in a tooltip of the wrapper (a disabled button takes no focus).
    expect(add?.props.label).toBe(`Qoida qo'shish — ${ADD_RULE_UNAVAILABLE}`);
    expect(render()).toContain(`aria-label="Qoida qo&#x27;shish — ${ADD_RULE_UNAVAILABLE.replace(/'/g, '&#x27;')}"`);
    const html = render();
    expect(html).toContain(`title="${ADD_RULE_UNAVAILABLE.replace(/'/g, '&#x27;')}"`);
    expect(buttonsLabelled(elements, `Tahrirlash — ${ADD_RULE_UNAVAILABLE}`)).toHaveLength(6);
    expect(buttonsLabelled(elements, `Tahrirlash — ${ADD_RULE_UNAVAILABLE}`).every((element) => element.props.disabled === true)).toBe(true);
  });

  it('with handlers given (TASK-213) they work', () => {
    const onAddRule = vi.fn();
    const onEditRule = vi.fn();
    const { elements } = treeOf({ onAddRule, onEditRule });
    buttonsLabelled(elements, '10.0.0.0/8 qoidasini tahrirlash')[0]?.props.onClick?.();
    expect(onEditRule).toHaveBeenCalledWith(ID.subnet);
    const add = elements.find((element) => element.type === Button && element.props.disabled === false && element.props.label === undefined);
    add?.props.onClick?.();
    expect(onAddRule).toHaveBeenCalledTimes(1);
  });
});

describe('RulesPanel — not ready', () => {
  it('no helper: the notice instead of the table', () => {
    const engine: EngineStateView = { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null };
    const html = render({ engine, config: IDLE_CONFIG });
    expect(text(html)).toContain("Helper o'rnatilmagan");
    expect(html).not.toContain('role="table"');
    expect(render({ engine: LOADING_VIEW, config: IDLE_CONFIG })).toContain('role="status"');
  });

  it('config loading, and a failed read with a way to retry', () => {
    expect(text(render({ config: { ...IDLE_CONFIG, phase: 'loading', revision: 3 } }))).toContain("Qoidalar o'qilmoqda…");
    const failed: ConfigView = { phase: 'failed', config: null, revision: 3, error: { code: 'timeout', message: 'x' } };
    const { all, elements } = treeOf({ config: failed });
    expect(text(renderMarkup(RulesPanel(all)))).toContain("Qoidalarni o'qib bo'lmadi");
    buttonsLabelled(elements, "Qayta o'qish")[0]?.props.onClick?.();
    expect(all.onReloadConfig).toHaveBeenCalledTimes(1);
  });
});

describe('RulesScreen', () => {
  it('renders from window.rs-like data only, asking nothing during static rendering', () => {
    const rs = {
      getState: vi.fn(() => new Promise<never>(() => undefined)),
      onState: vi.fn<RsApi['onState']>(() => () => undefined),
      getConfig: vi.fn(),
      toggleRule: vi.fn(),
      deleteRule: vi.fn(),
      importConfig: vi.fn(),
      applyImport: vi.fn(),
      exportConfig: vi.fn(),
    };
    const html = renderMarkup(createElement(RulesScreen, { rs }));
    expect(text(html)).toContain("Holat o'qilmoqda…");
    expect(rs.getConfig).not.toHaveBeenCalled();
  });
});
