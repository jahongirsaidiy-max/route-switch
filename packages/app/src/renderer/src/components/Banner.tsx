import type { ReactElement, ReactNode } from 'react';

import styles from './Banner.module.css';

export interface BannerProps {
  /** `warning` — something works less well than asked (a rule waits, one subnet); `danger` — something does not work. */
  readonly tone: 'warning' | 'danger';
  readonly title: string;
  readonly text?: string;
  /** Buttons, under the text. */
  readonly children?: ReactNode;
  /** `compact` for the menu bar window (360px wide). */
  readonly size?: 'md' | 'compact';
}

/**
 * A warning above a screen's content (not in the design — derived from its
 * status tones): a coloured bar, a title and one line of text. A `note`, not
 * an alert: it describes a lasting condition that the state shows anyway, and
 * it would be read again on every re-render of a live region.
 */
export function Banner({ tone, title, text, children, size = 'md' }: BannerProps): ReactElement {
  return (
    <div className={styles['banner']} data-tone={tone} data-size={size} role="note" aria-label={title}>
      <p className={styles['title']}>{title}</p>
      {text === undefined || text === '' ? null : <p className={styles['text']}>{text}</p>}
      {children === undefined ? null : <div className={styles['actions']}>{children}</div>}
    </div>
  );
}
