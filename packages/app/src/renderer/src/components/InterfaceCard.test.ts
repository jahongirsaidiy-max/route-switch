import type { InterfaceState } from '@routeswitch/shared';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  IfaceTag,
  InterfaceCard,
  InterfaceOption,
  describeInterface,
  describeInterfaceOption,
} from './InterfaceCard';
import { i18nFor } from '../../../i18n';
import { renderMarkup, type ElementProps } from './test-utils';

const CONNECTED: InterfaceState = { device: 'en5', ip: '10.20.4.37', gateway: '10.20.4.1', up: true };
const NO_GATEWAY: InterfaceState = { device: 'en5', ip: '10.20.4.37', gateway: null, up: true };
const DOWN: InterfaceState = { device: 'en5', ip: null, gateway: null, up: false };
const ABSENT: InterfaceState = { device: null, ip: null, gateway: null, up: false };

describe('describeInterface', () => {
  it('shows device, address and gateway of a connected interface', () => {
    expect(describeInterface(CONNECTED)).toEqual({
      detail: 'en5 · 10.20.4.37 → 10.20.4.1',
      tone: 'success',
      stateLabel: 'Ulangan',
    });
  });

  it('warns about a missing gateway', () => {
    expect(describeInterface(NO_GATEWAY)).toEqual({
      detail: "en5 · 10.20.4.37 · gateway yo'q",
      tone: 'warning',
      stateLabel: "Gateway yo'q",
    });
  });

  it('tells a disconnected adapter from a missing one', () => {
    expect(describeInterface(DOWN)).toEqual({ detail: 'en5 · ulanmagan', tone: 'neutral', stateLabel: 'Ulanmagan' });
    expect(describeInterface(ABSENT)).toEqual({ detail: 'Adapter topilmadi', tone: 'neutral', stateLabel: 'Ulanmagan' });
  });
});

describe('describeInterfaceOption', () => {
  it('shows device and gateway', () => {
    expect(describeInterfaceOption(CONNECTED)).toBe('en5 · 10.20.4.1');
    expect(describeInterfaceOption(NO_GATEWAY)).toBe("en5 · gateway yo'q");
    expect(describeInterfaceOption(DOWN)).toBe('en5 · ulanmagan');
    expect(describeInterfaceOption(ABSENT)).toBe('Ulanmagan');
  });
});

describe('InterfaceCard', () => {
  it('renders the role, the detail line and a connection dot', () => {
    const html = renderMarkup(createElement(InterfaceCard, { role: 'ethernet', iface: CONNECTED }));
    expect(html).toContain('data-role="ethernet"');
    expect(html).toContain('>Ethernet<');
    expect(html).toContain('en5 · 10.20.4.37 → 10.20.4.1');
    expect(html).toContain('aria-label="Ulangan"');
    expect(html).toContain('data-tone="success"');
    expect(html).not.toContain('DEFAULT');
  });

  it('marks the default role and a down interface', () => {
    const html = renderMarkup(createElement(InterfaceCard, { role: 'wifi', iface: DOWN, isDefault: true }));
    expect(html).toContain('>Wi‑Fi<');
    expect(html).toContain('>DEFAULT<');
    expect(html).toContain('aria-label="Ulanmagan"');
    expect(html).toContain('data-tone="neutral"');
  });
});

describe('IfaceTag', () => {
  it('labels each role', () => {
    expect(renderMarkup(createElement(IfaceTag, { role: 'ethernet' }))).toContain('>ETH<');
    expect(renderMarkup(createElement(IfaceTag, { role: 'wifi' }))).toContain('>WIFI<');
  });
});

describe('InterfaceOption', () => {
  it('is a pressed button when selected', () => {
    const html = renderMarkup(
      createElement(InterfaceOption, { role: 'ethernet', iface: CONNECTED, selected: true, onSelect: vi.fn() }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('>ETH<');
    expect(html).toContain('en5 · 10.20.4.1');
    expect(
      renderMarkup(createElement(InterfaceOption, { role: 'wifi', iface: ABSENT, selected: false, onSelect: vi.fn() })),
    ).toContain('aria-pressed="false"');
  });

  it('reports its role when picked, unless disabled', () => {
    const onSelect = vi.fn();
    (InterfaceOption({ role: 'wifi', iface: CONNECTED, selected: false, onSelect }).props as ElementProps).onClick?.();
    expect(onSelect).toHaveBeenCalledWith('wifi');

    const blocked = vi.fn();
    const element = InterfaceOption({ role: 'wifi', iface: CONNECTED, selected: false, onSelect: blocked, disabled: true });
    (element.props as ElementProps).onClick?.();
    expect(blocked).not.toHaveBeenCalled();
  });
});

describe('interfaces in every language (TASK-DELTA-14)', () => {
  const ru = i18nFor('ru');
  const en = i18nFor('en');

  it('describeInterface and describeInterfaceOption', () => {
    expect(describeInterface(CONNECTED, ru)).toEqual({ detail: 'en5 · 10.20.4.37 → 10.20.4.1', tone: 'success', stateLabel: 'Подключён' });
    expect(describeInterface(NO_GATEWAY, ru)).toEqual({ detail: 'en5 · 10.20.4.37 · нет шлюза', tone: 'warning', stateLabel: 'Нет шлюза' });
    expect(describeInterface(DOWN, en)).toEqual({ detail: 'en5 · not connected', tone: 'neutral', stateLabel: 'Not connected' });
    expect(describeInterface(ABSENT, en)).toEqual({ detail: 'Adapter not found', tone: 'neutral', stateLabel: 'Not connected' });
    expect(describeInterfaceOption(NO_GATEWAY, en)).toBe('en5 · no gateway');
    expect(describeInterfaceOption(DOWN, ru)).toBe('en5 · не подключён');
    expect(describeInterfaceOption(ABSENT, ru)).toBe('Не подключён');
  });

  it('the card: the dot name and the default tag; role names stay product names', () => {
    const html = renderMarkup(createElement(InterfaceCard, { role: 'wifi', iface: DOWN, isDefault: true, i18n: ru }));
    expect(html).toContain('>Wi‑Fi<');
    expect(html).toContain('>ОСНОВНОЙ<');
    expect(html).toContain('aria-label="Не подключён"');
    expect(renderMarkup(createElement(InterfaceCard, { role: 'ethernet', iface: CONNECTED, i18n: en }))).toContain('aria-label="Connected"');
    expect(renderMarkup(createElement(InterfaceOption, { role: 'ethernet', iface: DOWN, selected: false, onSelect: vi.fn(), i18n: en }))).toContain(
      'en5 · not connected',
    );
  });
});
