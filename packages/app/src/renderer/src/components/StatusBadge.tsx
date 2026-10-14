import type { RuleStatus } from '@routeswitch/shared';
import type { ReactElement } from 'react';

import styles from './StatusBadge.module.css';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

/** The visible words for a rule status (`EngineState.rules[].status`). */
export const RULE_STATUS_LABELS: Readonly<Record<RuleStatus, string>> = {
  active: 'Faol',
  pending: 'Kutilmoqda',
  error: 'Xato',
  disabled: "O'chirilgan",
};

export const RULE_STATUS_TONES: Readonly<Record<RuleStatus, StatusTone>> = {
  active: 'success',
  pending: 'warning',
  error: 'danger',
  disabled: 'neutral',
};

export interface StatusBadgeProps {
  readonly status: RuleStatus;
  /** Why the rule is in this status (already translated); shown as a tooltip and read by screen readers. */
  readonly detail?: string;
}

/** A rule's status as a small tag, in the style of the design's DEFAULT tag. */
export function StatusBadge({ status, detail }: StatusBadgeProps): ReactElement {
  const label = RULE_STATUS_LABELS[status];
  return (
    <span className={styles['badge']} data-tone={RULE_STATUS_TONES[status]} data-status={status} title={detail}>
      <span className={styles['badgeDot']} aria-hidden="true" />
      {label}
      {detail === undefined ? null : <span className={styles['visuallyHidden']}>: {detail}</span>}
    </span>
  );
}

export interface StatusDotProps {
  readonly tone: StatusTone;
  /** What the dot means ("Ulangan"); the dot is an image with this name. */
  readonly label: string;
  /** `md` 8px (interface card), `sm` 7px (helper box of the sidebar). */
  readonly size?: 'md' | 'sm';
}

/** The coloured dot of the design (interface connected, helper running). */
export function StatusDot({ tone, label, size = 'md' }: StatusDotProps): ReactElement {
  return <span className={styles['dot']} data-tone={tone} data-size={size} role="img" aria-label={label} title={label} />;
}
