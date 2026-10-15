import type { ReactElement } from 'react';

import styles from './Toggle.module.css';

export interface ToggleProps {
  readonly checked: boolean;
  /** Called with the requested value. The toggle shows `checked` only: the caller decides what holds. */
  readonly onChange: (next: boolean) => void;
  /** Accessible name; the design shows no visible label on the switch itself. */
  readonly label: string;
  /**
   * `md` (38×22, accent when on) is the global switch of the menu bar window;
   * `sm` (32×18, green when on) is the per-rule switch of the rules table.
   */
  readonly size?: 'md' | 'sm';
  readonly disabled?: boolean;
  /** A change is on its way to the helper: the switch is inert and announces it. */
  readonly busy?: boolean;
}

export function Toggle({
  checked,
  onChange,
  label,
  size = 'md',
  disabled = false,
  busy = false,
}: ToggleProps): ReactElement {
  const inert = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      // Busy keeps the button focusable: a focused button that becomes `disabled` drops
      // keyboard focus to <body>. It is announced as unavailable and ignores clicks instead.
      disabled={disabled}
      aria-disabled={busy && !disabled ? true : undefined}
      className={styles['toggle']}
      data-size={size}
      data-checked={checked}
      data-busy={busy || undefined}
      onClick={() => {
        if (!inert) onChange(!checked);
      }}
    >
      <span className={styles['knob']} aria-hidden="true" />
    </button>
  );
}
