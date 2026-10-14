import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RsApi } from '../rs';
import { INSTALL_TEXT } from '../text';
import { Banner } from './Banner';
import { Button } from './Button';
import { HelperRecovery, requestReconnect, type HelperRecoveryProps } from './HelperRecovery';
import { renderMarkup } from './test-utils';

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly label?: string;
}
const buttonsOf = (node: ReactNode): ReactElement<AnyProps>[] => {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(buttonsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  return node.type === Button ? [node] : buttonsOf(node.props.children);
};
const props = (extra: Partial<HelperRecoveryProps> = {}): HelperRecoveryProps => ({
  recovery: 'reconnect',
  onReconnect: vi.fn(),
  reconnecting: false,
  onInstall: vi.fn(),
  installing: false,
  ...extra,
});

describe('HelperRecovery', () => {
  it('reconnect: one button that asks for a reconnect', () => {
    const all = props();
    const buttons = buttonsOf(HelperRecovery(all));
    expect(buttons.map((button) => button.props.children)).toEqual(['Qayta ulanish']);
    buttons[0]?.props.onClick?.();
    expect(all.onReconnect).toHaveBeenCalledTimes(1);
  });

  it('busy while the request is on its way — focusable, not disabled', () => {
    const html = renderMarkup(createElement(HelperRecovery, props({ reconnecting: true })));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
  });

  it.each([
    ['install', "Helper'ni o'rnatish"],
    ['reinstall', "Helper'ni qayta o'rnatish"],
  ] as const)('%s: "Qayta tekshirish" and the install button that asks for an install (TASK-214)', (recovery, install) => {
    const all = props({ recovery });
    const buttons = buttonsOf(HelperRecovery(all));
    expect(buttons.map((button) => button.props.children)).toEqual(['Qayta tekshirish', install]);
    expect(buttons[1]?.props.disabled).toBeUndefined();
    buttons[0]?.props.onClick?.();
    expect(all.onReconnect).toHaveBeenCalledTimes(1);
    expect(all.onInstall).not.toHaveBeenCalled();
    buttons[1]?.props.onClick?.();
    expect(all.onInstall).toHaveBeenCalledTimes(1);
    expect(renderMarkup(createElement(HelperRecovery, all))).not.toContain(INSTALL_TEXT.waiting.slice(0, 20));
  });

  it('installing: the install button is busy (focusable, aria-disabled) and a status line says what happens', () => {
    const html = renderMarkup(createElement(HelperRecovery, props({ recovery: 'install', installing: true })));
    expect(html).toMatch(/aria-busy="true"[^>]*>|aria-disabled="true"/);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('role="status"');
    expect(html).toContain('Administrator paroli so&#x27;raladi');
    const buttons = buttonsOf(HelperRecovery(props({ recovery: 'install', installing: true })));
    expect(buttons[1]?.props.busy).toBe(true);
  });

  it('nothing for a broken config (the rules screen repairs it) or with nothing to do', () => {
    expect(HelperRecovery(props({ recovery: 'repair-config' }))).toBeNull();
    expect(HelperRecovery(props({ recovery: null }))).toBeNull();
  });

  it('the sidebar size stacks the buttons', () => {
    expect(renderMarkup(createElement(HelperRecovery, props({ size: 'sm' })))).toContain('data-size="sm"');
  });
});

describe('requestReconnect', () => {
  it('null on success (the outcome arrives with onState); the words of the code on a refusal', async () => {
    const ok: Pick<RsApi, 'reconnectHelper'> = { reconnectHelper: vi.fn(() => Promise.resolve({ ok: true as const, value: null })) };
    expect(await requestReconnect(ok)).toBeNull();
    const refused: Pick<RsApi, 'reconnectHelper'> = {
      reconnectHelper: () => Promise.resolve({ ok: false as const, code: 'forbidden' as const, error: 'x' }),
    };
    expect(await requestReconnect(refused)).toEqual({ tone: 'danger', text: "Bu oynadan ruxsat yo'q." });
  });
});

describe('Banner', () => {
  it('a note with its title as name, the text, and the tone', () => {
    const html = renderMarkup(createElement(Banner, { tone: 'warning', title: 'Ethernet ulanmagan', text: '2 ta qoida kutilmoqda.' }));
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="Ethernet ulanmagan"');
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('2 ta qoida kutilmoqda.');
    expect(html).toContain('data-size="md"');
  });

  it('no empty text paragraph; actions under the text; the compact size', () => {
    const html = renderMarkup(createElement(Banner, { tone: 'danger', title: 'x', text: '', size: 'compact' }, createElement('button', null, 'y')));
    expect(html.match(/<p/g)).toHaveLength(1);
    expect(html).toContain('<button>y</button>');
    expect(html).toContain('data-size="compact"');
    expect(html).toContain('data-tone="danger"');
  });
});
