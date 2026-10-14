import { createElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../../components/test-utils';
import { LOADING_VIEW, type EngineStateView } from '../../hooks/useEngineState';
import { LogScreen } from '../Log';
import { SettingsScreen } from '../Settings';
import { RulesScreen } from './RulesScreen';
import { focusedElement, restoreFocus, RulesWindowFrame, SECTIONS, SECTION_SCREENS, type RulesSection } from './RulesWindow';

const CONNECTED: EngineStateView = { helper: 'connected', connection: { kind: 'connected', helperVersion: '0.1.0' }, state: null, error: null };

const frame = (section: RulesSection, engine: EngineStateView = CONNECTED, onSelect = vi.fn()) =>
  RulesWindowFrame({ section, engine, onSelect, children: createElement('p', { 'data-screen': section }) });

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elementsOf(node.props.children)];
}

describe('RulesWindowFrame', () => {
  it('a sidebar with Qoidalar, Jurnal and Sozlamalar; the current one is marked', () => {
    const html = renderMarkup(frame('log'));
    expect(SECTIONS.map((section) => section.label)).toEqual(['Qoidalar', 'Jurnal', 'Sozlamalar']);
    for (const label of ['Qoidalar', 'Jurnal', 'Sozlamalar']) expect(html).toContain(label);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>.*Jurnal/);
    expect(html).toContain('data-screen="log"');
    expect(html).toContain('<nav aria-label="Bo&#x27;limlar"');
  });

  it('choosing an item selects its section', () => {
    const onSelect = vi.fn();
    const buttons = elementsOf(frame('rules', CONNECTED, onSelect)).filter((element) => element.type === 'button');
    expect(buttons).toHaveLength(3);
    buttons[2]?.props.onClick?.();
    expect(onSelect).toHaveBeenCalledWith('settings');
  });

  it('the helper box: running with its version, or why not', () => {
    const html = renderMarkup(frame('rules'));
    expect(html).toContain('Helper ishlayapti');
    expect(html).toContain('root daemon · v0.1.0');
    const absent = renderMarkup(frame('rules', { helper: 'not-installed', connection: { kind: 'not-installed' }, state: null, error: null }));
    expect(absent).toContain('Helper o&#x27;rnatilmagan');
    expect(absent).not.toContain('root daemon');
    expect(renderMarkup(frame('rules', LOADING_VIEW))).toContain('Tekshirilmoqda…');
  });
});

describe('SECTION_SCREENS', () => {
  const onAddRule = vi.fn();
  const onEditRule = vi.fn();
  const screenOf = (section: RulesSection) =>
    (SECTION_SCREENS[section] as (props: { onAddRule: () => void; onEditRule: (id: string) => void }) => ReactElement)({ onAddRule, onEditRule });

  it('wires the rules, journal and settings screens', () => {
    expect(screenOf('rules').type as ComponentType).toBe(RulesScreen);
    expect(screenOf('log').type as ComponentType).toBe(LogScreen);
    expect(screenOf('settings').type as ComponentType).toBe(SettingsScreen);
  });

  it('the rules screen gets the way into the add-rule form (its buttons are then enabled)', () => {
    const props = screenOf('rules').props as { onAddRule: () => void; onEditRule: (id: string) => void };
    expect(props.onAddRule).toBe(onAddRule);
    expect(props.onEditRule).toBe(onEditRule);
  });
});

describe('the window behind the add-rule dialog', () => {
  it('is inert while the dialog is open, and only then', () => {
    expect(renderMarkup(RulesWindowFrame({ section: 'rules', engine: CONNECTED, onSelect: vi.fn(), inert: true, children: null }))).toMatch(/^<div[^>]*inert=""/);
    expect(renderMarkup(frame('rules'))).not.toContain('inert');
  });

  it('the focus returns to the button that opened the dialog, when it is still there', () => {
    const button = { isConnected: true, focus: vi.fn() };
    const body = {} as HTMLElement;
    expect(focusedElement({ activeElement: button as unknown as Element, body })).toBe(button);
    expect(focusedElement({ activeElement: body, body })).toBeNull();
    expect(focusedElement({ activeElement: null, body })).toBeNull();
    expect(focusedElement(undefined)).toBeNull();
    expect(restoreFocus(button)).toBe(true);
    expect(button.focus).toHaveBeenCalledTimes(1);
    const gone = { isConnected: false, focus: vi.fn() };
    expect(restoreFocus(gone)).toBe(false);
    expect(gone.focus).not.toHaveBeenCalled();
    expect(restoreFocus(null)).toBe(false);
  });
});
