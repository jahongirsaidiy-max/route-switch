import type { EngineState } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import type { EngineStateView } from '../../hooks/useEngineState';
import type { RsServiceOrder } from '../../rs';
import { focusUninstallButton, SettingsPanel, SettingsScreen, type SettingsPanelProps } from './SettingsScreen';

const STATE: EngineState = {
  helperVersion: '0.1.0',
  seq: 1,
  configRevision: 1,
  enabled: true,
  interfaces: {
    ethernet: { device: 'en5', ip: '10.0.0.5', gateway: '10.0.0.1', up: true },
    wifi: { device: 'en0', ip: '192.168.0.10', gateway: '192.168.0.1', up: true },
  },
  adapters: [
    { device: 'en0', port: 'Wi-Fi', ip: '192.168.0.10' },
    { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.0.0.5' },
    { device: 'en7', port: 'Thunderbolt Ethernet', ip: null },
  ],
  rules: [],
  lastApplyAt: null,
  lastReconcileReason: null,
};
const CONNECTED: EngineStateView = {
  helper: 'connected',
  connection: { kind: 'connected', helperVersion: '0.1.0' },
  state: STATE,
  error: null,
};
const NOT_INSTALLED: EngineStateView = { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null };
const ORDER: RsServiceOrder = {
  services: [
    { name: 'USB 10/100/1000 LAN', hardwarePort: 'USB 10/100/1000 LAN', device: 'en5', enabled: true },
    { name: 'Wi-Fi', hardwarePort: 'Wi-Fi', device: 'en0', enabled: true },
  ],
  wifiService: 'Wi-Fi',
  wifiFirst: false,
  command: "sudo networksetup -ordernetworkservices 'Wi-Fi' 'USB 10/100/1000 LAN'",
};

const props = (extra: Partial<SettingsPanelProps> = {}): SettingsPanelProps => ({
  engine: CONNECTED,
  openAtLogin: false,
  overrides: null,
  serviceOrder: { phase: 'ready', order: ORDER, feedback: null },
  busy: new Set(),
  confirmingUninstall: false,
  feedback: {},
  onToggleLogin: vi.fn(),
  onSelectEthernet: vi.fn(),
  onCopyCommand: vi.fn(),
  onRefreshOrder: vi.fn(),
  onAskUninstall: vi.fn(),
  onCancelUninstall: vi.fn(),
  onConfirmUninstall: vi.fn(),
  ...extra,
});
const render = (extra: Partial<SettingsPanelProps> = {}) => renderMarkup(createElement(SettingsPanel, props(extra)));
// The panel has no hooks, so calling it returns its element tree: handlers are reached without a DOM.
interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly autoFocus?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly role?: string;
  readonly ref?: unknown;
  readonly onKeyDown?: (event: { key: string }) => void;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elementsOf(node.props.children)];
}
const treeOf = (extra: Partial<SettingsPanelProps> = {}) => {
  const all = props(extra);
  return { all, elements: elementsOf(SettingsPanel(all)) };
};
const buttonsNamed = (elements: ReactElement<AnyProps>[], text: string) =>
  elements.filter((element) => element.type === Button && element.props.children === text);

const selectOf = (html: string) => /<select[^>]*>.*?<\/select>/.exec(html)?.[0] ?? '';

describe('SettingsPanel: login item', () => {
  it('is a switch showing the setting', () => {
    expect(render({ openAtLogin: true })).toContain('aria-checked="true"');
    expect(render({ openAtLogin: false })).toContain('aria-label="Login&#x27;da ishga tushirish"');
  });

  it('is disabled until the setting is known and busy while it changes', () => {
    expect(render({ openAtLogin: null })).toMatch(/role="switch"[^>]*disabled=""/);
    const busy = render({ busy: new Set(['login']) });
    expect(busy).toContain('aria-busy="true"');
  });
});

describe('SettingsPanel: Ethernet adapter', () => {
  it('offers automatic and every non-Wi-Fi adapter', () => {
    const select = selectOf(render());
    expect(select).toContain('<option value="" selected="">Avtomatik</option>');
    expect(select).toContain('en5 · USB 10/100/1000 LAN · 10.0.0.5');
    expect(select).toContain('en7 · Thunderbolt Ethernet · IP yo&#x27;q');
    expect(select).not.toContain('value="en0"');
    expect(select).not.toContain('disabled');
  });

  it('shows the stored override, also when that adapter is not plugged in', () => {
    expect(selectOf(render({ overrides: { ethernet: 'en7' } }))).toContain('<option value="en7" selected="">');
    expect(selectOf(render({ overrides: { ethernet: 'en9' } }))).toContain('en9 · ulanmagan');
  });

  it('is disabled without a helper and before the config is read', () => {
    expect(selectOf(render({ engine: NOT_INSTALLED, overrides: undefined }))).toContain('disabled=""');
    expect(selectOf(render({ overrides: undefined }))).toContain('disabled=""');
  });

  it('stays focusable while saving: busy and aria-disabled, not disabled', () => {
    const select = selectOf(render({ busy: new Set(['ethernet']) }));
    expect(select).not.toContain('disabled=""');
    expect(select).toContain('aria-disabled="true"');
    expect(select).toContain('aria-busy="true"');
  });

  it('reports a choice, but ignores changes while saving or disabled', () => {
    const pick = (extra: Partial<SettingsPanelProps>, value: string) => {
      const { all, elements } = treeOf(extra);
      const select = elements.find((element) => element.type === 'select');
      select?.props.onChange?.({ target: { value } });
      return all.onSelectEthernet;
    };
    expect(pick({}, 'en7')).toHaveBeenCalledWith('en7');
    expect(pick({}, '')).toHaveBeenCalledWith(null);
    expect(pick({ busy: new Set(['ethernet']) }, 'en7')).not.toHaveBeenCalled();
    expect(pick({ engine: NOT_INSTALLED, overrides: undefined }, 'en7')).not.toHaveBeenCalled();
  });
});

describe('SettingsPanel: Wi-Fi as the default', () => {
  it('shows the command to run and a copy button, never a run button', () => {
    const html = render();
    expect(html).toContain('sudo networksetup -ordernetworkservices &#x27;Wi-Fi&#x27; &#x27;USB 10/100/1000 LAN&#x27;');
    expect(html).toContain('Hozir birinchi: USB 10/100/1000 LAN.');
    expect(html).toContain('>Nusxalash<');
    expect(html).not.toMatch(/Bajarish|Yuritish|Qo&#x27;llash</);
  });

  it('says when Wi-Fi is already first', () => {
    expect(render({ serviceOrder: { phase: 'ready', order: { ...ORDER, wifiFirst: true }, feedback: null } })).toContain(
      'allaqachon birinchi',
    );
  });

  it('has loading, failed and no-Wi-Fi states with copy disabled', () => {
    const loading = render({ serviceOrder: { phase: 'loading', order: null, feedback: null } });
    expect(loading).toContain('o&#x27;qilmoqda');
    const failed = render({ serviceOrder: { phase: 'failed', order: null, feedback: { tone: 'danger', text: 'Amal bajarilmadi.' } } });
    expect(failed).toContain('Xizmatlar tartibini o&#x27;qib bo&#x27;lmadi.');
    expect(failed).toContain('Amal bajarilmadi.');
    const noWifi = render({ serviceOrder: { phase: 'ready', order: { ...ORDER, wifiService: null, command: null }, feedback: null } });
    expect(noWifi).toContain('Wi‑Fi xizmati topilmadi.');
    for (const html of [loading, failed, noWifi]) {
      expect(html).toMatch(/disabled=""[^>]*>Nusxalash</);
    }
  });
});

describe('SettingsPanel: helper', () => {
  it('shows the helper and asks before uninstalling', () => {
    const html = render();
    expect(html).toContain('Helper ishlayapti · v0.1.0');
    expect(html).toContain('>Helper&#x27;ni o&#x27;chirish<');
    expect(html).not.toContain('role="alertdialog"');
  });

  it('cannot uninstall without a connected helper', () => {
    expect(render({ engine: NOT_INSTALLED })).toMatch(/disabled=""[^>]*>Helper&#x27;ni o&#x27;chirish</);
  });

  it('the first click only asks; uninstall is wired only to the confirm button', () => {
    const asking = treeOf();
    const [start] = buttonsNamed(asking.elements, "Helper'ni o'chirish");
    expect(buttonsNamed(asking.elements, "Ha, o'chirish")).toHaveLength(0);
    start?.props.onClick?.();
    expect(asking.all.onAskUninstall).toHaveBeenCalledTimes(1);
    expect(asking.all.onConfirmUninstall).not.toHaveBeenCalled();
    expect(asking.elements.some((element) => element.props.onClick === asking.all.onConfirmUninstall)).toBe(false);

    const confirming = treeOf({ confirmingUninstall: true });
    expect(buttonsNamed(confirming.elements, "Helper'ni o'chirish")).toHaveLength(0);
    const [cancel] = buttonsNamed(confirming.elements, 'Bekor qilish');
    cancel?.props.onClick?.();
    expect(confirming.all.onCancelUninstall).toHaveBeenCalledTimes(1);
    expect(confirming.all.onConfirmUninstall).not.toHaveBeenCalled();
    const [confirm] = buttonsNamed(confirming.elements, "Ha, o'chirish");
    confirm?.props.onClick?.();
    expect(confirming.all.onConfirmUninstall).toHaveBeenCalledTimes(1);
  });

  it('the question takes the focus on its safe choice; busy (not disabled) while uninstalling; Escape cancels unless busy (TASK-300)', () => {
    const confirming = treeOf({ confirmingUninstall: true });
    const [cancel] = buttonsNamed(confirming.elements, 'Bekor qilish');
    expect(cancel?.props.autoFocus).toBe(true);
    const dialog = confirming.elements.find((element) => element.props.role === 'alertdialog');
    dialog?.props.onKeyDown?.({ key: 'Enter' });
    expect(confirming.all.onCancelUninstall).not.toHaveBeenCalled();
    dialog?.props.onKeyDown?.({ key: 'Escape' });
    expect(confirming.all.onCancelUninstall).toHaveBeenCalledTimes(1);

    const busy = treeOf({ confirmingUninstall: true, busy: new Set(['helper']) });
    const [busyCancel] = buttonsNamed(busy.elements, 'Bekor qilish');
    expect(busyCancel?.props.busy).toBe(true);
    expect(busyCancel?.props.disabled).toBeUndefined();
    busy.elements.find((element) => element.props.role === 'alertdialog')?.props.onKeyDown?.({ key: 'Escape' });
    expect(busy.all.onCancelUninstall).not.toHaveBeenCalled();
  });

  it('the uninstall button carries the ref the focus returns to', () => {
    const ref = { current: null };
    const [start] = buttonsNamed(treeOf({ uninstallRef: ref }).elements, "Helper'ni o'chirish");
    expect(start?.props.ref).toBe(ref);
  });

  it('a helper whose stored config is unreadable can still be uninstalled (TASK-300)', () => {
    const engine: EngineStateView = { helper: 'config-unreadable', connection: { kind: 'config-unreadable', helperVersion: '0.1.0' }, state: null, error: null };
    const [start] = buttonsNamed(treeOf({ engine }).elements, "Helper'ni o'chirish");
    expect(start?.props.disabled).toBe(false);
    expect(render({ engine })).toContain('Helper config&#x27;i buzilgan');
  });

  it('confirms, then shows the result', () => {
    const confirming = render({ confirmingUninstall: true });
    expect(confirming).toContain('role="alertdialog"');
    expect(confirming).toContain('Ha, o&#x27;chirish');
    expect(confirming).toContain('Bekor qilish');
    const failed = render({ feedback: { helper: { tone: 'danger', text: 'O‘rnatilgan helper bu amalni hali bajara olmaydi.' } } });
    expect(failed).toContain('role="alert"');
  });
});

describe('SettingsScreen', () => {
  it('starts with everything loading and nothing changed', () => {
    const rs = {
      getState: vi.fn(() => new Promise<never>(() => undefined)),
      onState: vi.fn(() => () => undefined),
      getSettings: vi.fn(),
      setOpenAtLogin: vi.fn(),
      getConfig: vi.fn(),
      setIfaceOverrides: vi.fn(),
      getServiceOrder: vi.fn(),
      copyServiceOrderCommand: vi.fn(),
      uninstallHelper: vi.fn(),
      removeHelper: vi.fn(),
    };
    const html = renderMarkup(createElement(SettingsScreen, { rs }));
    expect(html).toContain('Sozlamalar');
    expect(html).toContain('o&#x27;qilmoqda');
    expect(html).toContain('Tekshirilmoqda');
    expect(rs.setOpenAtLogin).not.toHaveBeenCalled();
    expect(rs.setIfaceOverrides).not.toHaveBeenCalled();
    expect(rs.copyServiceOrderCommand).not.toHaveBeenCalled();
    expect(rs.uninstallHelper).not.toHaveBeenCalled();
    expect(rs.removeHelper).not.toHaveBeenCalled();
  });
});

describe('focusUninstallButton (TASK-300)', () => {
  it('only an enabled button still on the page gets the focus (after an uninstall it is disabled)', () => {
    const focus = vi.fn();
    expect(focusUninstallButton({ isConnected: true, disabled: false, focus })).toBe(true);
    expect(focusUninstallButton({ isConnected: true, disabled: true, focus })).toBe(false);
    expect(focusUninstallButton({ isConnected: false, disabled: false, focus })).toBe(false);
    expect(focusUninstallButton(null)).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
