import type { IfaceRole, InterfaceState } from '@routeswitch/shared';
import type { ReactElement } from 'react';

import { EthernetIcon, WifiIcon } from './icons';
import styles from './InterfaceCard.module.css';
import { StatusDot, type StatusTone } from './StatusBadge';

/** Display names of the roles, as the design writes them (non-breaking hyphen in Wi‑Fi). */
export const ROLE_LABELS: Readonly<Record<IfaceRole, string>> = {
  ethernet: 'Ethernet',
  wifi: 'Wi‑Fi',
};

/** The short coloured tag of a role (rules table, active rules, interface options). */
export const ROLE_TAGS: Readonly<Record<IfaceRole, string>> = {
  ethernet: 'ETH',
  wifi: 'WIFI',
};

export interface InterfaceSummary {
  /** Mono detail line, e.g. `en5 · 10.20.4.37 → 10.20.4.1`. */
  readonly detail: string;
  readonly tone: StatusTone;
  /** What the status dot says. */
  readonly stateLabel: string;
}

/** How a role's interface reads in the menu bar window. */
export function describeInterface(iface: InterfaceState): InterfaceSummary {
  if (iface.device === null) {
    return { detail: 'Adapter topilmadi', tone: 'neutral', stateLabel: 'Ulanmagan' };
  }
  if (!iface.up || iface.ip === null) {
    return { detail: `${iface.device} · ulanmagan`, tone: 'neutral', stateLabel: 'Ulanmagan' };
  }
  if (iface.gateway === null) {
    return { detail: `${iface.device} · ${iface.ip} · gateway yo'q`, tone: 'warning', stateLabel: "Gateway yo'q" };
  }
  return { detail: `${iface.device} · ${iface.ip} → ${iface.gateway}`, tone: 'success', stateLabel: 'Ulangan' };
}

/** The shorter detail of an interface option: device and gateway (`en5 · 10.20.4.1`). */
export function describeInterfaceOption(iface: InterfaceState): string {
  if (iface.device === null) return 'Ulanmagan';
  if (!iface.up) return `${iface.device} · ulanmagan`;
  return `${iface.device} · ${iface.gateway ?? "gateway yo'q"}`;
}

export function IfaceTag({ role }: { readonly role: IfaceRole }): ReactElement {
  return (
    <span className={styles['tag']} data-role={role}>
      {ROLE_TAGS[role]}
    </span>
  );
}

export interface InterfaceCardProps {
  readonly role: IfaceRole;
  readonly iface: InterfaceState;
  /** Show the DEFAULT tag (the role carries the default route). */
  readonly isDefault?: boolean;
}

/** A role's interface with its address, gateway and connection dot (menu bar window). */
export function InterfaceCard({ role, iface, isDefault = false }: InterfaceCardProps): ReactElement {
  const summary = describeInterface(iface);
  const Icon = role === 'wifi' ? WifiIcon : EthernetIcon;
  return (
    <div className={styles['card']} data-role={role} data-tone={summary.tone}>
      <Icon size={20} className={styles['icon']} />
      <div className={styles['body']}>
        <div className={styles['title']}>
          <span className={styles['name']}>{ROLE_LABELS[role]}</span>
          {isDefault ? <span className={styles['defaultTag']}>DEFAULT</span> : null}
        </div>
        <div className={styles['detail']}>{summary.detail}</div>
      </div>
      <StatusDot tone={summary.tone} label={summary.stateLabel} />
    </div>
  );
}

export interface InterfaceOptionProps {
  readonly role: IfaceRole;
  readonly iface: InterfaceState;
  readonly selected: boolean;
  readonly onSelect: (role: IfaceRole) => void;
  readonly disabled?: boolean;
}

/** A selectable interface card (the "Interfeys" choice of the add-rule form). */
export function InterfaceOption({
  role,
  iface,
  selected,
  onSelect,
  disabled = false,
}: InterfaceOptionProps): ReactElement {
  return (
    <button
      type="button"
      className={styles['option']}
      data-selected={selected}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect(role);
      }}
    >
      <IfaceTag role={role} />
      <span className={styles['body']}>
        <span className={styles['name']}>{ROLE_LABELS[role]}</span>
        <span className={styles['detail']}>{describeInterfaceOption(iface)}</span>
      </span>
    </button>
  );
}
