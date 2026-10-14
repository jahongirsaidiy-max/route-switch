import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, type ButtonProps } from './Button';
import { renderMarkup, type ElementProps } from './test-utils';

const render = (props: ButtonProps) => renderMarkup(createElement(Button, props));

describe('Button', () => {
  it('renders a non-submitting secondary button by default', () => {
    const html = render({ children: "Qayta qo'llash" });
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="secondary"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain('Qayta qo&#x27;llash');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('aria-busy');
  });

  it('renders each variant and size', () => {
    for (const variant of ['primary', 'secondary', 'ghost'] as const) {
      expect(render({ children: 'x', variant })).toContain(`data-variant="${variant}"`);
    }
    for (const size of ['md', 'lg', 'icon'] as const) {
      expect(render({ children: 'x', size })).toContain(`data-size="${size}"`);
    }
    expect(render({ children: 'x', grow: true })).toContain('data-grow="true"');
    expect(render({ children: 'x', type: 'submit' })).toContain('type="submit"');
  });

  it('names an icon-only button', () => {
    expect(render({ children: 'x', size: 'icon', variant: 'ghost', label: 'Tahrirlash' })).toContain(
      'aria-label="Tahrirlash"',
    );
  });

  it('calls onClick when enabled', () => {
    const onClick = vi.fn();
    (Button({ children: 'x', onClick }).props as ElementProps).onClick?.();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is inert while disabled, and while busy without losing focus', () => {
    const onClick = vi.fn();
    for (const extra of [{ disabled: true }, { busy: true }]) {
      (Button({ children: 'x', onClick, ...extra }).props as ElementProps).onClick?.();
    }
    expect(onClick).not.toHaveBeenCalled();

    const disabled = render({ children: 'x', disabled: true });
    expect(disabled).toContain('disabled=""');
    expect(disabled).not.toContain('aria-disabled');

    // A focused button that turns `disabled` drops keyboard focus; busy must stay focusable.
    const busy = render({ children: 'x', busy: true });
    expect(busy).not.toContain('disabled=""');
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('data-busy="true"');
  });

});
