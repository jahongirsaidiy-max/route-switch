import type { ReactElement, ReactNode, Ref } from 'react';

import styles from './Button.module.css';

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  /**
   * `primary`   — accent fill ("Qoidalarni boshqarish", "Saqlash va qo'llash");
   * `secondary` — white with a border ("Qayta qo'llash", "Bekor qilish");
   * `ghost`     — no fill until hovered (row actions: edit, delete).
   */
  readonly variant?: 'primary' | 'secondary' | 'ghost';
  /** `md` 34px (menu bar, toolbar), `lg` 36px (rules header, dialog), `icon` 28×28 square. */
  readonly size?: 'md' | 'lg' | 'icon';
  /** Stretch to share the row equally with its siblings (menu bar footer). */
  readonly grow?: boolean;
  /** Required when the button shows only an icon. */
  readonly label?: string | undefined;
  readonly disabled?: boolean;
  /** The action is under way: the button is inert and announces it. */
  readonly busy?: boolean;
  readonly type?: 'button' | 'submit';
  /** Takes the focus when it appears (the safe choice of a confirmation that just opened). */
  readonly autoFocus?: boolean;
  /** The `<button>` element, for a caller that moves the focus back to it. */
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  grow = false,
  label,
  disabled = false,
  busy = false,
  type = 'button',
  autoFocus,
  ref,
}: ButtonProps): ReactElement {
  const inert = disabled || busy;
  return (
    <button
      ref={ref}
      type={type}
      autoFocus={autoFocus}
      className={styles['button']}
      data-variant={variant}
      data-size={size}
      data-grow={grow || undefined}
      data-busy={busy || undefined}
      aria-label={label}
      aria-busy={busy || undefined}
      // Busy keeps the button focusable: a focused button that becomes `disabled` drops
      // keyboard focus to <body>. It is announced as unavailable and ignores clicks instead.
      disabled={disabled}
      aria-disabled={busy && !disabled ? true : undefined}
      onClick={() => {
        if (!inert) onClick?.();
      }}
    >
      {children}
    </button>
  );
}
