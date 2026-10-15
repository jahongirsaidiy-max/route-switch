import type { EngineState } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Toggle } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import { IDLE_CONFIG, type ConfigView } from '../../hooks/useConfig';
import { LOADING_VIEW, type EngineStateView } from '../../hooks/useEngineState';
import type { RsApi, RsServiceOrder, RsSnapshot } from '../../rs';
import { CONFIG, ID, NOW, ORDER_WIFI_FIRST, STATE, ruleState } from './fixtures';
import { helperNotice, INSTALL_TEXT } from '../../text';
import { followServiceOrder, MenuBarPanel, MenuBarScreen, type MenuBarPanelProps } from './MenuBarScreen';

const connected = (state: EngineState = STATE): EngineStateView => ({
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.1.0' },
  state,
  error: null,
});
const READY: ConfigView = { phase: 'ready', config: CONFIG, revision: 3, error: null };

const props = (extra: Partial<MenuBarPanelProps> = {}): MenuBarPanelProps => ({
  engine: connected(),
  config: READY,
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
  ...extra,
});
const render = (extra: Partial<MenuBarPanelProps> = {}) => renderMarkup(createElement(MenuBarPanel, props(extra)));
/** The visible words of rendered markup, entities decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

// Every component of the window is hook-free, so calling them returns the element tree: handlers are reached without a DOM.
interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly label?: string;
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
const treeOf = (extra: Partial<MenuBarPanelProps> = {}) => {
  const all = props(extra);
  return { all, elements: elementsOf(MenuBarPanel(all)) };
};
const button = (elements: ReactElement<AnyProps>[], label: string) => {
  const found = elements.find((element) => element.type === Button && element.props.children === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};
const toggle = (elements: ReactElement<AnyProps>[]) => {
  const found = elements.find((element) => element.type === Toggle);
  if (found === undefined) throw new Error('no toggle');
  return found as ReactElement<AnyProps & { checked: boolean; disabled?: boolean; busy?: boolean; label: string }>;
};

describe('MenuBarPanel — connected', () => {
  it('shows the design: header with the switch, both interfaces, the first four rules, the status row and two buttons', () => {
    const html = render();
    const words = text(html);
    expect(words).toContain('RouteSwitch');
    expect(words).toContain('Faol');
    expect(words).toContain('Interfeyslar');
    expect(words).toContain('Wi‑Fi');
    expect(words).toContain('en0 · 192.168.0.104 → 192.168.0.1');
    expect(words).toContain('en5 · 10.20.4.37 → 10.20.4.1');
    expect(words).toContain('Faol qoidalar');
    expect(words).toContain('5 ta · 8 route');
    for (const target of ['10.0.0.0/8', 'corp.local', '172.16.12.40', 'github.com']) expect(words).toContain(target);
    expect(words).not.toContain('192.168.50.0/24');
    expect(words).toContain('Yana 1 ta qoida');
    expect(words).toContain('Ichki tarmoq');
    expect(words).toContain('DNS: 10.20.0.10');
    expect(words).toContain('3 IP · 2 daq oldin');
    expect(words).toContain("Oxirgi qo'llash: 10:58 · tarmoq o'zgarganda");
    expect(words).toContain("Qayta qo'llash");
    expect(words).toContain('Qoidalarni boshqarish');
    // Wi‑Fi is first in the service order: it carries the default route.
    expect(html.match(/DEFAULT/g)).toHaveLength(1);
    expect(html.indexOf('DEFAULT')).toBeLessThan(html.indexOf('Ethernet'));
  });

  it('lists the rules with their interface tags, in config order', () => {
    const html = render();
    const tags = [...html.matchAll(/data-role="(ethernet|wifi)">(ETH|WIFI)</g)].map((match) => match[2]);
    expect(tags).toEqual(['ETH', 'ETH', 'ETH', 'WIFI']);
    expect(html.match(/<li /g)).toHaveLength(4);
  });

  it('marks Ethernet DEFAULT when it is first, and no role without a known order', () => {
    const reversed = { ...ORDER_WIFI_FIRST, services: [...ORDER_WIFI_FIRST.services].reverse() };
    const html = render({ serviceOrder: reversed });
    expect(html.indexOf('DEFAULT')).toBeGreaterThan(html.indexOf('Ethernet'));
    expect(render({ serviceOrder: null })).not.toContain('DEFAULT');
  });

  it('the switch shows the state the helper reported and asks for the opposite', () => {
    const { all, elements } = treeOf();
    const control = toggle(elements);
    expect(control.props.checked).toBe(true);
    expect(control.props.label).toBe('Routing (barcha qoidalar)');
    control.props.onChange?.(false);
    expect(all.onToggle).toHaveBeenCalledWith(false);

    const off = treeOf({ engine: connected({ ...STATE, enabled: false }) });
    expect(toggle(off.elements).props.checked).toBe(false);
    expect(text(renderMarkup(MenuBarPanel(off.all)))).toContain("O'chiq");
  });

  it('the two buttons call their actions', () => {
    const { all, elements } = treeOf();
    button(elements, "Qayta qo'llash").props.onClick?.();
    button(elements, 'Qoidalarni boshqarish').props.onClick?.();
    expect(all.onApply).toHaveBeenCalledTimes(1);
    expect(all.onOpenRules).toHaveBeenCalledTimes(1);
  });

  it('a running action is busy (announced, focus kept), not disabled', () => {
    const html = render({ busy: new Set(['enabled', 'apply']) });
    expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    const { elements } = treeOf({ busy: new Set(['rules']) });
    expect(button(elements, 'Qoidalarni boshqarish').props).toMatchObject({ busy: true });
  });

  it('re-applying is off while routing is off', () => {
    const { elements } = treeOf({ engine: connected({ ...STATE, enabled: false }) });
    expect(button(elements, "Qayta qo'llash").props).toMatchObject({ disabled: true });
    const html = render({ engine: connected({ ...STATE, enabled: false }) });
    expect(text(html)).toContain("Routing o'chirilgan");
    expect(html).toContain('data-off="true"');
    expect(render()).not.toContain('data-off');
  });

  it('counts only error rules in the status row; an active rule with a warning code is not an error', () => {
    const state: EngineState = {
      ...STATE,
      rules: [
        ruleState(ID.subnet, { status: 'error', reasonCode: 'route-failed' }),
        ruleState(ID.dnsDomain, { reasonCode: 'dns-server-excluded' }),
        ruleState(ID.host, { status: 'pending', reasonCode: 'interface-down' }),
        ruleState(ID.domain, { reasonCode: 'overridden-by-rule' }),
      ],
    };
    const html = render({ engine: connected(state) });
    const words = text(html);
    expect(words).toContain('1 ta qoidada xato');
    // Error and pending get a status tag with the translated reason; the warnings get a warning mark.
    expect(html).toContain('data-status="error"');
    expect(words).toContain("Route qo'shilmadi");
    expect(html).toContain('data-status="pending"');
    expect(words).toContain('Interfeys ulanmagan');
    expect(html.match(/aria-label="Ogohlantirish: [^"]+"/g)).toEqual([
      'aria-label="Ogohlantirish: Ba&#x27;zi manzillar DNS server — ular yo&#x27;naltirilmaydi"',
      'aria-label="Ogohlantirish: Ba&#x27;zi manzillar boshqa qoida orqali boshqa interfeysga yo&#x27;naltirilgan"',
    ]);
    expect(html.match(/data-status="error"/g)).toHaveLength(1);
  });

  it('only warnings: the status row stays green with no error count', () => {
    const state: EngineState = { ...STATE, rules: [ruleState(ID.domain, { reasonCode: 'overridden-by-rule' })] };
    const html = render({ engine: connected(state) });
    expect(html).toContain('data-tone="success"');
    expect(text(html)).not.toContain('xato');
  });

  it('shows a failed action as an alert', () => {
    const html = render({ feedback: { tone: 'danger', text: "Helper bilan aloqa yo'q — hech narsa yuborilmadi." } });
    expect(html).toMatch(/role="alert"[^>]*>Helper bilan aloqa yo&#x27;q/);
  });
});

describe('MenuBarPanel — network warnings and failed domains (TASK-300)', () => {
  const ethernetDown: EngineState = {
    ...STATE,
    interfaces: { ...STATE.interfaces, ethernet: { device: 'en5', ip: null, gateway: null, up: false } },
    rules: STATE.rules.map((rule) =>
      new Set<string>([ID.subnet, ID.dnsDomain, ID.host]).has(rule.ruleId)
        ? ruleState(rule.ruleId, { status: 'pending', reasonCode: 'interface-down' })
        : rule,
    ),
  };

  it('an interface that is down: its rules are pending, and a warning says how many wait', () => {
    const html = render({ engine: connected(ethernetDown) });
    const words = text(html);
    expect(words).toContain('Ethernet ulanmagan');
    expect(words).toContain("3 ta qoida kutilmoqda — interfeys ulanganda avtomatik qo'llanadi.");
    expect(html.match(/data-status="pending"/g)).toHaveLength(3);
    expect(html).toMatch(/role="note" aria-label="Ethernet ulanmagan"/);
    // Waiting is not an error.
    expect(words).not.toContain('xato');
  });

  it('both interfaces behind one gateway: a one-subnet warning', () => {
    const state: EngineState = {
      ...STATE,
      interfaces: {
        ethernet: { device: 'en5', ip: '192.168.1.20', gateway: '192.168.1.1', up: true },
        wifi: { device: 'en0', ip: '192.168.1.30', gateway: '192.168.1.1', up: true },
      },
    };
    const words = text(render({ engine: connected(state) }));
    expect(words).toContain('Ethernet va Wi‑Fi bitta tarmoqda');
    expect(words).toContain("gateway orqali route ishonchsiz");
    expect(text(render())).not.toContain('bitta tarmoqda');
  });

  it('a domain rule that failed to resolve shows the reason and its last known address', () => {
    const state: EngineState = {
      ...STATE,
      rules: STATE.rules.map((rule) =>
        rule.ruleId === ID.domain ? { ...rule, status: 'error', reasonCode: 'resolve-failed', reason: 'DNS query failed' } : rule,
      ),
    };
    const html = render({ engine: connected(state) });
    const words = text(html);
    // The row has room for the first address; the status tag's name (tooltip, screen reader) has them all.
    expect(words).toContain('140.82.112.3 +2');
    expect(words).toContain("DNS so'rovi bajarilmadi. Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): 140.82.112.3, 140.82.112.4, 140.82.113.3 · 2 daq oldin");
    expect(html).toMatch(/title="DNS so&#x27;rovi bajarilmadi\. Oxirgi ma&#x27;lum IP&#x27;lar/);
    expect(html).toContain('data-status="error"');
  });
});

describe('MenuBarPanel — rules not ready', () => {
  it('while the config is read', () => {
    const words = text(render({ config: { ...IDLE_CONFIG, phase: 'loading', revision: 3 } }));
    expect(words).toContain("Qoidalar o'qilmoqda…");
    expect(words).not.toContain('ta · ');
  });

  it('when the config could not be read, with a way to read it again', () => {
    const failed: ConfigView = { phase: 'failed', config: null, revision: 3, error: { code: 'timeout', message: 'x' } };
    const { all, elements } = treeOf({ config: failed });
    expect(text(renderMarkup(MenuBarPanel(all)))).toContain("Qoidalarni o'qib bo'lmadi.");
    button(elements, "Qayta o'qish").props.onClick?.();
    expect(all.onReloadConfig).toHaveBeenCalledTimes(1);
  });

  it('a failed re-read keeps showing the previous config', () => {
    const words = text(render({ config: { ...READY, phase: 'failed', error: { code: 'busy', message: 'x' } } }));
    expect(words).toContain('10.0.0.0/8');
  });

  it('no enabled rule', () => {
    const words = text(render({ config: { ...READY, config: { ...CONFIG, rules: [] } } }));
    expect(words).toContain("Yoqilgan qoida yo'q");
    expect(words).toContain('0 ta · 8 route');
  });
});

describe('MenuBarPanel — no live state', () => {
  const views: [string, EngineStateView, string][] = [
    ['loading', LOADING_VIEW, "Holat o'qilmoqda…"],
    ['connecting', { helper: 'connecting', connection: { kind: 'connecting' }, state: null, error: null }, 'Helper bilan ulanmoqda…'],
    ['not-installed', { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null }, "Helper o'rnatilmagan"],
    [
      'disconnected',
      { helper: 'disconnected', connection: { kind: 'disconnected', reason: 'not-running' }, state: null, error: null },
      "Helper bilan aloqa yo'q",
    ],
    [
      'incompatible',
      {
        helper: 'incompatible',
        connection: { kind: 'incompatible', helperVersion: '0.0.9', protocolVersion: 1, expectedProtocolVersion: 2 },
        state: null,
        error: null,
      },
      'Helper versiyasi mos emas',
    ],
    ['stopped', { helper: 'stopped', connection: { kind: 'stopped' }, state: null, error: null }, "Ilova to'xtamoqda"],
    [
      'config-unreadable',
      { helper: 'config-unreadable', connection: { kind: 'config-unreadable', helperVersion: '0.1.0' }, state: null, error: null },
      "Helper config'i buzilgan",
    ],
    ['unavailable', { helper: 'unavailable', connection: null, state: null, error: { code: 'forbidden', message: 'x' } }, "Holatni o'qib bo'lmadi"],
  ];

  it.each(views)('%s: a notice instead of interfaces and rules; the switch is off and disabled', (_name, engine, title) => {
    const { all, elements } = treeOf({ engine, config: IDLE_CONFIG });
    const html = renderMarkup(MenuBarPanel(all));
    expect(text(html)).toContain(title);
    expect(html).not.toContain('Interfeyslar');
    expect(html).not.toContain('Faol qoidalar');
    expect(html).not.toContain("Oxirgi qo'llash");
    expect(toggle(elements).props).toMatchObject({ checked: false, disabled: true });
    expect(button(elements, "Qayta qo'llash").props).toMatchObject({ disabled: true });
    // The rules window opens without a helper (it offers the install).
    expect(button(elements, 'Qoidalarni boshqarish').props.disabled).toBeUndefined();
  });

  it('says why the helper is unreachable and that routes stay applied', () => {
    expect(helperNotice(views[3]?.[1] ?? LOADING_VIEW)?.text).toBe(
      "Helper ishlamayapti. U launchd orqali qayta ishga tushadi; bo'lmasa qayta o'rnating. Qo'llangan route'lar helper'da qoladi.",
    );
    expect(helperNotice(views[4]?.[1] ?? LOADING_VIEW)?.text).toContain('v0.0.9');
    expect(helperNotice(views[7]?.[1] ?? LOADING_VIEW)?.text).toBe("Bu oynadan ruxsat yo'q.");
    expect(helperNotice(connected())).toBeNull();
  });

  it('helper away: "Qayta ulanish" asks for a reconnect, and is busy (not disabled) while asked', () => {
    const away = views.find(([name]) => name === 'disconnected')?.[1] ?? LOADING_VIEW;
    const { all, elements } = treeOf({ engine: away });
    button(elements, 'Qayta ulanish').props.onClick?.();
    expect(all.onReconnect).toHaveBeenCalledTimes(1);
    expect(() => button(elements, "Helper'ni o'rnatish")).toThrow();
    const busy = treeOf({ engine: away, busy: new Set(['reconnect']) });
    expect(button(busy.elements, 'Qayta ulanish').props).toMatchObject({ busy: true });
    expect(button(busy.elements, 'Qayta ulanish').props.disabled).toBeUndefined();
  });

  it('no helper, or another version: "Qayta tekshirish", and the install button that installs (TASK-214)', () => {
    for (const name of ['not-installed', 'incompatible']) {
      const engine = views.find(([view]) => view === name)?.[1] ?? LOADING_VIEW;
      const { all, elements } = treeOf({ engine });
      button(elements, 'Qayta tekshirish').props.onClick?.();
      expect(all.onReconnect).toHaveBeenCalledTimes(1);
      const install = button(elements, name === 'incompatible' ? INSTALL_TEXT.reinstall : INSTALL_TEXT.install);
      expect(install.props.disabled).toBeUndefined();
      install.props.onClick?.();
      expect(all.onInstall).toHaveBeenCalledTimes(1);
      const busy = treeOf({ engine, busy: new Set(['install']) });
      expect(button(busy.elements, name === 'incompatible' ? INSTALL_TEXT.reinstall : INSTALL_TEXT.install).props).toMatchObject({ busy: true });
      expect(text(render({ engine, busy: new Set(['install']) }))).toContain("Administrator paroli so'raladi");
    }
  });

  it('nothing to press while loading, connecting, stopping, unreadable from the main process, or with a broken config', () => {
    for (const name of ['loading', 'connecting', 'stopped', 'unavailable', 'config-unreadable']) {
      const engine = views.find(([view]) => view === name)?.[1] ?? LOADING_VIEW;
      const words = text(render({ engine }));
      expect(words).not.toContain('Qayta ulanish');
      expect(words).not.toContain('Qayta tekshirish');
    }
    // The broken config is repaired in the rules window, which the footer button opens.
    const broken = views.find(([view]) => view === 'config-unreadable')?.[1] ?? LOADING_VIEW;
    expect(text(render({ engine: broken }))).toContain("«Qoidalar» bo'limida config'ni import qiling");
  });

  it('a stray state outside connected is never shown', () => {
    const html = render({ engine: { helper: 'disconnected', connection: { kind: 'disconnected', reason: 'timeout' }, state: STATE, error: null } });
    expect(html).not.toContain('Interfeyslar');
    expect(text(html)).toContain('Helper javob bermadi');
  });

  it('errors are alerts, waiting is a status', () => {
    expect(render({ engine: views[3]?.[1] ?? LOADING_VIEW })).toContain('role="alert"');
    expect(render({ engine: LOADING_VIEW })).toContain('role="status"');
  });
});

describe('MenuBarScreen', () => {
  it('renders from window.rs-like data only: loading until the first snapshot arrives', () => {
    const rs: Parameters<typeof MenuBarScreen>[0]['rs'] = {
      getState: vi.fn(() => new Promise<never>(() => undefined)),
      onState: vi.fn<(listener: (snapshot: RsSnapshot) => void) => () => void>(() => () => undefined),
      getConfig: vi.fn(),
      getServiceOrder: vi.fn(),
      setEnabled: vi.fn(),
      apply: vi.fn(),
      openRulesWindow: vi.fn(),
      reconnectHelper: vi.fn(),
      installHelper: vi.fn(),
    } satisfies Partial<RsApi>;
    const html = renderMarkup(createElement(MenuBarScreen, { rs }));
    expect(text(html)).toContain("Holat o'qilmoqda…");
    // Static rendering runs no effects: nothing was asked of the helper or the main process.
    expect(rs.getConfig).not.toHaveBeenCalled();
    expect(rs.getServiceOrder).not.toHaveBeenCalled();
  });
});

describe('followServiceOrder (TASK-DELTA-08)', () => {
  type OrderResult = Awaited<ReturnType<RsApi['getServiceOrder']>>;
  const ETHERNET_FIRST: RsServiceOrder = { ...ORDER_WIFI_FIRST, services: [...ORDER_WIFI_FIRST.services].reverse(), wifiFirst: false };
  function page(answers: OrderResult[]) {
    const shows = new Set<() => void>();
    const resolvers: ((result: OrderResult) => void)[] = [];
    const rs = {
      getServiceOrder: vi.fn(
        () =>
          new Promise<OrderResult>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    };
    let order: RsServiceOrder | null = null;
    const reader = followServiceOrder(
      rs,
      (next) => {
        order = next;
      },
      (tick) => {
        shows.add(tick);
        return () => shows.delete(tick);
      },
    );
    return {
      rs,
      reader,
      shows,
      order: () => order,
      show: () => {
        for (const tick of [...shows]) tick();
      },
      answer: async (index: number) => {
        const result = answers[index];
        if (result !== undefined) resolvers[index]?.(result);
        await Promise.resolve();
      },
    };
  }
  const defaultCard = (order: RsServiceOrder | null) => {
    const html = render({ serviceOrder: order });
    if (!html.includes('DEFAULT')) return null;
    return html.indexOf('DEFAULT') < html.indexOf('Ethernet') ? 'wifi' : 'ethernet';
  };

  it('the order changed, the interfaces did not: the next show moves DEFAULT to the other card', async () => {
    const view = page([
      { ok: true, value: ORDER_WIFI_FIRST },
      { ok: true, value: ETHERNET_FIRST },
      { ok: true, value: ORDER_WIFI_FIRST },
    ]);
    await view.answer(0);
    expect(defaultCard(view.order())).toBe('wifi');
    view.show();
    await view.answer(1);
    expect(defaultCard(view.order())).toBe('ethernet');
    view.show();
    await view.answer(2);
    expect(defaultCard(view.order())).toBe('wifi');
    expect(view.rs.getServiceOrder).toHaveBeenCalledTimes(3);
  });

  it('a read that fails leaves no DEFAULT tag', async () => {
    const view = page([
      { ok: true, value: ORDER_WIFI_FIRST },
      { ok: false, code: 'timeout', error: 'timed out' },
    ]);
    await view.answer(0);
    view.show();
    await view.answer(1);
    expect(view.order()).toBeNull();
    expect(defaultCard(view.order())).toBeNull();
  });

  it('two reads racing: the stale answer arriving last does not bring the old DEFAULT back', async () => {
    const view = page([
      { ok: true, value: ORDER_WIFI_FIRST },
      { ok: true, value: ETHERNET_FIRST },
    ]);
    view.show();
    await view.answer(1);
    await view.answer(0);
    expect(defaultCard(view.order())).toBe('ethernet');
  });

  it('stop (disconnected, interfaces changed, unmounted) stops listening for shows', () => {
    const view = page([]);
    expect(view.shows.size).toBe(1);
    view.reader.stop();
    expect(view.shows.size).toBe(0);
  });
});
