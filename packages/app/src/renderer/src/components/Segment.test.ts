import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Segment,
  handleSegmentKey,
  nextSegmentValue,
  segmentTabStop,
  type SegmentOption,
  type SegmentProps,
} from './Segment';
import { renderMarkup } from './test-utils';

type Kind = 'ip' | 'subnet' | 'domain';

const KINDS: readonly SegmentOption<Kind>[] = [
  { value: 'ip', label: 'IP' },
  { value: 'subnet', label: 'Subnet' },
  { value: 'domain', label: 'Domen' },
];

const render = (props: Partial<SegmentProps<Kind>> = {}) =>
  renderMarkup(
    createElement(Segment<Kind>, { options: KINDS, value: 'subnet', onChange: vi.fn(), label: 'Turi', ...props }),
  );

const radios = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];

describe('Segment', () => {
  it('renders a labelled radio group with the value checked and the only tab stop', () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Turi"');
    const buttons = radios(html);
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toContain('aria-checked="false"');
    expect(buttons[0]).toContain('tabindex="-1"');
    expect(buttons[1]).toContain('aria-checked="true"');
    expect(buttons[1]).toContain('tabindex="0"');
    expect(buttons[1]).toContain('data-selected="true"');
    expect(buttons[1]).toContain('>Subnet<');
    expect(buttons[2]).toContain('tabindex="-1"');
  });

  it('keeps the first option reachable when the value matches none', () => {
    const buttons = radios(render({ value: 'other' as Kind }));
    expect(buttons[0]).toContain('tabindex="0"');
    expect(buttons.filter((button) => button.includes('aria-checked="true"'))).toHaveLength(0);
  });

  it('puts the tab stop on the first enabled option when the selected one is disabled', () => {
    const options = KINDS.map((option) => (option.value === 'subnet' ? { ...option, disabled: true } : option));
    const buttons = radios(render({ options }));
    expect(buttons[0]).toContain('tabindex="0"');
    expect(buttons[1]).toContain('tabindex="-1"');
    expect(buttons[1]).toContain('aria-checked="true"');
    expect(buttons.filter((button) => button.includes('tabindex="0"'))).toHaveLength(1);
  });

  it('skips a disabled first option when nothing is selected', () => {
    const options = KINDS.map((option) => (option.value === 'ip' ? { ...option, disabled: true } : option));
    const buttons = radios(render({ options, value: 'other' as Kind }));
    expect(buttons[0]).toContain('tabindex="-1"');
    expect(buttons[1]).toContain('tabindex="0"');
    expect(buttons.filter((button) => button.includes('tabindex="0"'))).toHaveLength(1);
  });

  it('disables the whole group or single options', () => {
    expect(radios(render({ disabled: true })).every((button) => button.includes('disabled=""'))).toBe(true);
    expect(render({ disabled: true })).toContain('aria-disabled="true"');
    const options = KINDS.map((option) => (option.value === 'domain' ? { ...option, disabled: true } : option));
    const buttons = radios(render({ options }));
    expect(buttons[2]).toContain('disabled=""');
    expect(buttons[0]).not.toContain('disabled');
  });
});

describe('nextSegmentValue', () => {
  it('moves with the arrow keys and wraps around', () => {
    expect(nextSegmentValue(KINDS, 'subnet', 'ArrowRight')).toBe('domain');
    expect(nextSegmentValue(KINDS, 'subnet', 'ArrowDown')).toBe('domain');
    expect(nextSegmentValue(KINDS, 'subnet', 'ArrowLeft')).toBe('ip');
    expect(nextSegmentValue(KINDS, 'subnet', 'ArrowUp')).toBe('ip');
    expect(nextSegmentValue(KINDS, 'domain', 'ArrowRight')).toBe('ip');
    expect(nextSegmentValue(KINDS, 'ip', 'ArrowLeft')).toBe('domain');
  });

  it('jumps with Home and End', () => {
    expect(nextSegmentValue(KINDS, 'subnet', 'Home')).toBe('ip');
    expect(nextSegmentValue(KINDS, 'subnet', 'End')).toBe('domain');
  });

  it('ignores other keys and a move onto the current value', () => {
    expect(nextSegmentValue(KINDS, 'ip', 'Home')).toBeNull();
    expect(nextSegmentValue(KINDS, 'subnet', 'Enter')).toBeNull();
    expect(nextSegmentValue(KINDS, 'subnet', 'a')).toBeNull();
    expect(nextSegmentValue(KINDS.slice(0, 1), 'ip', 'ArrowRight')).toBeNull();
    expect(nextSegmentValue<Kind>([], 'ip', 'Home')).toBeNull();
  });

  it('skips disabled options', () => {
    const options = KINDS.map((option) => (option.value === 'domain' ? { ...option, disabled: true } : option));
    expect(nextSegmentValue(options, 'subnet', 'ArrowRight')).toBe('ip');
    expect(nextSegmentValue(options, 'subnet', 'End')).toBeNull();
    expect(nextSegmentValue(options, 'ip', 'End')).toBe('subnet');
  });

  it('starts from the ends when the value matches no option', () => {
    expect(nextSegmentValue(KINDS, 'other' as Kind, 'ArrowRight')).toBe('ip');
    expect(nextSegmentValue(KINDS, 'other' as Kind, 'ArrowLeft')).toBe('domain');
  });
});

describe('segmentTabStop', () => {
  const disable = (value: Kind) => KINDS.map((option) => (option.value === value ? { ...option, disabled: true } : option));

  it('is the selected option when it is enabled', () => {
    expect(segmentTabStop(KINDS, 'domain')).toBe('domain');
  });

  it('falls back to the first enabled option', () => {
    expect(segmentTabStop(disable('subnet'), 'subnet')).toBe('ip');
    expect(segmentTabStop(KINDS, 'other' as Kind)).toBe('ip');
    expect(segmentTabStop(disable('ip'), 'other' as Kind)).toBe('subnet');
  });

  it('is null when every option is disabled', () => {
    expect(segmentTabStop(KINDS.map((option) => ({ ...option, disabled: true })), 'ip')).toBeNull();
  });
});

describe('handleSegmentKey', () => {
  const setup = (disabled = false) => {
    const onChange = vi.fn();
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const press = (key: string) => {
      handleSegmentKey({ options: KINDS, value: 'subnet', disabled, onChange, focus }, { key, preventDefault });
    };
    return { onChange, focus, preventDefault, press };
  };

  it('selects and focuses the next option and keeps the page from scrolling', () => {
    const { onChange, focus, preventDefault, press } = setup();
    press('ArrowRight');
    expect(onChange).toHaveBeenCalledWith('domain');
    expect(focus).toHaveBeenCalledWith('domain');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    press('ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('ip');
    expect(focus).toHaveBeenLastCalledWith('ip');
  });

  it('does nothing in a disabled group', () => {
    const { onChange, focus, preventDefault, press } = setup(true);
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) press(key);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('leaves unrelated keys alone', () => {
    const { onChange, focus, preventDefault, press } = setup();
    for (const key of ['Enter', ' ', 'a', 'Tab']) press(key);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
