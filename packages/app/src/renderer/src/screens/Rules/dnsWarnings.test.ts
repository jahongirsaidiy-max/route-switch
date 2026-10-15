// TASK-DELTA-21: the DNS warning banner in the rules window and the menu bar,
// its button, and the menu bar's way into the rules window's add-rule form.

import type { Config, DnsWarning, EngineState } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor } from '../../../../i18n';
import { Banner, Button } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import { type ConfigView } from '../../hooks/useConfig';
import { type EngineStateView } from '../../hooks/useEngineState';
import { dnsRuleForm, dnsWarningViews, type RuleForm } from '../AddRule';
import { CONFIG, NOW, ORDER_WIFI_FIRST, STATE } from '../MenuBar/fixtures';
import { suggestRule } from '../MenuBar/actions';
import { MenuBarPanel, type MenuBarPanelProps } from '../MenuBar/MenuBarScreen';
import { INITIAL_RECOVERY_UI } from './recovery';
import { DnsWarningBanner, RulesPanel, type RulesPanelProps } from './RulesScreen';
import type { RsRulesIntent } from '../../rs';
import { DNS_OFFER_WAIT_MS, dnsOfferStep, followRulesIntents, type PendingDnsOffer } from './RulesWindow';
import { INITIAL_TRANSFER_UI } from './transfer';

const WARNING: DnsWarning = { server: '192.168.0.53', source: 'interface', role: 'ethernet', via: 'wifi', code: 'other-interface-subnet' };
/** The Wi‑Fi gateway as the Ethernet DNS server: no rule can be offered. */
const GATEWAY_WARNING: DnsWarning = { ...WARNING, server: '192.168.0.1' };
const WARNED: EngineState = { ...STATE, dnsWarnings: [WARNING, GATEWAY_WARNING] };

const connected = (state: EngineState = WARNED): EngineStateView => ({
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.2.0' },
  state,
  error: null,
});
const ready = (config: Config | null = CONFIG): ConfigView => ({ phase: 'ready', config, revision: 3, error: null });

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ');

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly busy?: boolean;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  const own: ReactElement<AnyProps>[] = [node, ...elementsOf(node.props.children)];
  if (node.type === Banner) own.push(...elementsOf(Banner(node.props as Parameters<typeof Banner>[0])));
  return own;
}

const rulesProps = (extra: Partial<RulesPanelProps> = {}): RulesPanelProps => ({
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
  recovery: INITIAL_RECOVERY_UI,
  onAskReset: vi.fn(),
  onCancelReset: vi.fn(),
  onConfirmReset: vi.fn(),
  onAddRule: vi.fn(),
  ...extra,
});

describe('the rules window: DNS warning banners', () => {
  it('one banner per server with its button, or the reason in place of the button', () => {
    const words = text(renderMarkup(createElement(RulesPanel, rulesProps())));
    expect(words).toContain('Ethernet DNS serveri (192.168.0.53) Wi‑Fi orqali ketmoqda');
    expect(words).toContain("192.168.0.53 → Ethernet qoidasini qo'shish");
    expect(words).toContain("Qoida taklif qilinmaydi: 192.168.0.1 — Wi‑Fi gateway'i");
    expect(words).not.toContain("192.168.0.1 → Ethernet qoidasini qo'shish");
  });

  it('no banner without warnings', () => {
    const words = text(renderMarkup(createElement(RulesPanel, rulesProps({ engine: connected(STATE) }))));
    expect(words).not.toContain('DNS serveri');
  });

  it('while the form cannot open, the banner says why instead of a button', () => {
    const words = text(renderMarkup(createElement(RulesPanel, rulesProps({ onAddRule: undefined }))));
    expect(words).toContain("Qoida qo'shib bo'lmaydi: ");
    expect(words).not.toContain("192.168.0.53 → Ethernet qoidasini qo'shish");
  });

  it('in Russian and English', () => {
    for (const [locale, label] of [
      ['ru', 'Добавить правило 192.168.0.53 → Ethernet'],
      ['en', 'Add rule 192.168.0.53 → Ethernet'],
    ] as const) {
      const words = text(renderMarkup(createElement(RulesPanel, rulesProps({ i18n: i18nFor(locale) }))));
      expect(words).toContain(label);
      expect(words).not.toContain('qoidasini');
    }
  });

  it("the button opens the form filled in — it saves nothing", () => {
    const [view] = dnsWarningViews(WARNED, CONFIG);
    if (view === undefined) throw new Error('no view');
    const onOffer = vi.fn();
    const elements = elementsOf(DnsWarningBanner({ warning: view, addRuleOff: null, onOffer, i18n: i18nFor('uz') }));
    const button = elements.find((element) => element.type === Button);
    button?.props.onClick?.();
    expect(onOffer).toHaveBeenCalledTimes(1);
    expect(onOffer).toHaveBeenCalledWith(dnsRuleForm('192.168.0.53', 'ethernet'), view);
    // The rules panel passes the form to the window's onAddRule.
    const onAddRule = vi.fn<(prefill?: RuleForm) => void>();
    const panel = RulesPanel(rulesProps({ onAddRule }));
    const banner = elementsOf(panel).find((element) => element.type === DnsWarningBanner);
    (banner?.props as unknown as { onOffer: (form: RuleForm) => void }).onOffer(dnsRuleForm('192.168.0.53', 'ethernet'));
    expect(onAddRule).toHaveBeenCalledWith(dnsRuleForm('192.168.0.53', 'ethernet'));
  });
});

const menuProps = (extra: Partial<MenuBarPanelProps> = {}): MenuBarPanelProps => ({
  engine: connected(),
  config: ready(),
  serviceOrder: ORDER_WIFI_FIRST,
  now: NOW,
  busy: new Set(),
  feedback: null,
  onToggle: vi.fn(),
  onApply: vi.fn(),
  onOpenRules: vi.fn(),
  onReloadConfig: vi.fn(),
  onReconnect: vi.fn(),
  onInstall: vi.fn(),
  onSuggestRule: vi.fn(),
  ...extra,
});

describe('the menu bar: DNS warning banners', () => {
  it('shows the banner with its button, compact', () => {
    const html = renderMarkup(createElement(MenuBarPanel, menuProps()));
    expect(text(html)).toContain("192.168.0.53 → Ethernet qoidasini qo'shish");
    expect(text(html)).toContain('Ethernet DNS serveri (192.168.0.53) Wi‑Fi orqali ketmoqda');
    expect(html).toContain('data-size="compact"');
  });

  it('its button asks for the server and the role (not a rule); busy while the rules window opens', () => {
    const [view] = dnsWarningViews(WARNED, CONFIG);
    if (view === undefined) throw new Error('no view');
    const onSuggestRule = vi.fn();
    // What the menu bar's Warnings passes the banner.
    const onOffer = (_form: RuleForm, { server, role }: { server: string; role: 'ethernet' | 'wifi' }) => {
      onSuggestRule({ server, role });
    };
    const elements = elementsOf(DnsWarningBanner({ warning: view, addRuleOff: null, onOffer, busy: true, i18n: i18nFor('uz'), size: 'compact' }));
    const button = elements.find((element) => element.type === Button);
    expect(button?.props.busy).toBe(true);
    button?.props.onClick?.();
    expect(onSuggestRule).toHaveBeenCalledWith({ server: '192.168.0.53', role: 'ethernet' });
  });

  it('suggestRule opens the rules window with the DNS offer intent (server and role, no rule), and saves nothing', async () => {
    const rs = { setEnabled: vi.fn(), apply: vi.fn(), openRulesWindow: vi.fn(() => Promise.resolve({ ok: true as const, value: null })), saveRule: vi.fn() };
    expect(await suggestRule(rs, { server: '192.168.0.53', role: 'ethernet' })).toBeNull();
    expect(rs.openRulesWindow).toHaveBeenCalledTimes(1);
    expect(rs.openRulesWindow).toHaveBeenCalledWith({ kind: 'dns-offer', server: '192.168.0.53', role: 'ethernet' });
    expect(rs.saveRule).not.toHaveBeenCalled();
    const refused = { ...rs, openRulesWindow: vi.fn(() => Promise.resolve({ ok: false as const, code: 'invalid-input' as const, error: 'x' })) };
    expect(await suggestRule(refused, { server: '192.168.0.53', role: 'ethernet' })).toMatchObject({ tone: 'danger' });
  });
});

describe('the rules window: an intent from the menu bar', () => {
  const pending = (receivedAt = NOW, server = '192.168.0.53'): PendingDnsOffer => ({ server, role: 'ethernet', receivedAt });

  it("opens the form with the window's own offer", () => {
    expect(dnsOfferStep(pending(), connected(), ready(), false, NOW)).toEqual({ kind: 'open', form: dnsRuleForm('192.168.0.53', 'ethernet') });
  });

  it('waits for the state and the config', () => {
    const loading: EngineStateView = { helper: 'connecting', connection: null, state: null, error: null };
    expect(dnsOfferStep(pending(), loading, ready(), false, NOW)).toEqual({ kind: 'wait' });
    expect(dnsOfferStep(pending(), connected(), { phase: 'loading', config: null, revision: null, error: null }, false, NOW)).toEqual({ kind: 'wait' });
    expect(dnsOfferStep(pending(), connected(), { phase: 'idle', config: null, revision: null, error: null }, false, NOW)).toEqual({ kind: 'wait' });
    // A config that could not be read: the offer is checked without it.
    const failed: ConfigView = { phase: 'failed', config: null, revision: 3, error: { code: 'timeout', message: 'x' } };
    expect(dnsOfferStep(pending(), connected(), failed, false, NOW).kind).toBe('open');
  });

  it('drops it after waiting too long, when a form is open, with an unreadable config, or when the warning offers no rule (any more)', () => {
    expect(dnsOfferStep(pending(NOW - DNS_OFFER_WAIT_MS), connected(), ready(), false, NOW).kind).toBe('open');
    expect(dnsOfferStep(pending(NOW - DNS_OFFER_WAIT_MS - 1), connected(), ready(), false, NOW)).toEqual({ kind: 'drop' });
    expect(dnsOfferStep(pending(), connected(), ready(), true, NOW)).toEqual({ kind: 'drop' });
    const unreadable: EngineStateView = { helper: 'config-unreadable', connection: null, state: null, error: null };
    expect(dnsOfferStep(pending(), unreadable, ready(), false, NOW)).toEqual({ kind: 'drop' });
    expect(dnsOfferStep(pending(), connected(STATE), ready(), false, NOW)).toEqual({ kind: 'drop' });
    expect(dnsOfferStep(pending(NOW, '192.168.0.1'), connected(), ready(), false, NOW)).toEqual({ kind: 'drop' });
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('followRulesIntents: takes one waiting at start, then one per signal; null and failures are no intent; stops cleanly', async () => {
    const queue: (RsRulesIntent | null | 'fail')[] = [{ kind: 'dns-offer', server: '192.168.0.53', role: 'ethernet' }, null, { kind: 'section', section: 'log' }, 'fail'];
    let signal: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const rs = {
      takeRulesIntent: vi.fn(() => {
        const next = queue.shift() ?? null;
        return Promise.resolve(next === 'fail' ? { ok: false as const, code: 'forbidden' as const, error: 'x' } : { ok: true as const, value: next });
      }),
      onRulesIntent: vi.fn((listener: () => void) => {
        signal = listener;
        return unsubscribe;
      }),
    };
    const deliver = vi.fn();
    const stop = followRulesIntents(rs, deliver);
    await flush();
    expect(deliver.mock.calls).toEqual([[{ kind: 'dns-offer', server: '192.168.0.53', role: 'ethernet' }]]);
    const fire = () => {
      (signal as unknown as () => void)();
    };
    fire();
    await flush();
    fire();
    await flush();
    expect(deliver.mock.calls.slice(1)).toEqual([[{ kind: 'section', section: 'log' }]]);
    fire();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    // An answer that arrives after stop is dropped.
    queue.push({ kind: 'section', section: 'rules' });
    fire();
    stop();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
