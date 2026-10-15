import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Toggle, type ToggleProps } from './Toggle';
import { renderMarkup, type ElementProps } from './test-utils';

const render = (props: ToggleProps) => renderMarkup(createElement(Toggle, props));

describe('Toggle', () => {
  it('renders a labelled switch that reflects `checked`', () => {
    const html = render({ checked: true, onChange: () => undefined, label: 'Routingni o‘chirish' });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Routingni o‘chirish"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-size="md"');
    expect(html).not.toContain('disabled');

    expect(render({ checked: false, onChange: () => undefined, label: 'x' })).toContain('aria-checked="false"');
  });

  it('has the small size of the rules table', () => {
    expect(render({ checked: true, onChange: () => undefined, label: 'x', size: 'sm' })).toContain('data-size="sm"');
  });

  it('requests the opposite value and leaves the state to the caller', () => {
    const onChange = vi.fn();
    const props = Toggle({ checked: false, onChange, label: 'x' }).props as ElementProps;
    props.onClick?.();
    expect(onChange).toHaveBeenCalledWith(true);

    const onChange2 = vi.fn();
    (Toggle({ checked: true, onChange: onChange2, label: 'x' }).props as ElementProps).onClick?.();
    expect(onChange2).toHaveBeenCalledWith(false);
  });

  it('is inert while disabled, and while busy without losing focus', () => {
    const onChange = vi.fn();
    for (const extra of [{ disabled: true }, { busy: true }]) {
      (Toggle({ checked: false, onChange, label: 'x', ...extra }).props as ElementProps).onClick?.();
    }
    expect(onChange).not.toHaveBeenCalled();

    const disabled = render({ checked: false, onChange, label: 'x', disabled: true });
    expect(disabled).toContain('disabled=""');
    expect(disabled).not.toContain('aria-disabled');

    // A focused button that turns `disabled` drops keyboard focus; busy must stay focusable.
    const busy = render({ checked: false, onChange, label: 'x', busy: true });
    expect(busy).not.toContain('disabled=""');
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('data-busy="true"');
  });

});
