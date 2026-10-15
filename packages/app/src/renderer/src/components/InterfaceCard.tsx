import type { IfaceRole, InterfaceState } from '@routeswitch/shared';
import type { ReactElement } from 'react';

import type { I18n } from '../../../i18n';
import { UZ } from '../text';
import { EthernetIcon, WifiIcon } from './icons';
import styles from './InterfaceCard.module.css';
import { StatusDot, type StatusTone } from './StatusBadge';

/** Display names of the roles, as the design writes them (non-breaking hyphen in Wi‑Fi): product names, the same in every language. */
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

/** How a role's interface reads in the menu bar window, in the language of `i18n`. */
export function describeInterface(iface: InterfaceState, i18n: I18n = UZ): InterfaceSummary {
  const words = i18n.t.components.iface;
  if (iface.device === null) {
    return { detail: words.adapterMissing, tone: 'neutral', stateLabel: words.notConnected };
  }
  if (!iface.up || iface.ip === null) {
    return { detail: words.deviceDown(iface.device), tone: 'neutral', stateLabel: words.notConnected };
  }
  if (iface.gateway === null) {
    return { detail: words.deviceNoGateway(iface.device, iface.ip), tone: 'warning', stateLabel: words.noGateway };
  }
  return { detail: `${iface.device} · ${iface.ip} → ${iface.gateway}`, tone: 'success', stateLabel: words.connected };
}

/** The shorter detail of an interface option: device and gateway (`en5 · 10.20.4.1`). */
export function describeInterfaceOption(iface: InterfaceState, i18n: I18n = UZ): string {
  const words = i18n.t.components.iface;
  if (iface.device === null) return words.notConnected;
  if (!iface.up) return words.deviceDown(iface.device);
  return iface.gateway === null ? words.optionNoGateway(iface.device) : `${iface.device} · ${iface.gateway}`;
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
  /** The UI language (`useI18n()` of the screen); Uzbek when not given. */
  readonly i18n?: I18n | undefined;
}

/** A role's interface with its address, gateway and connection dot (menu bar window). */
export function InterfaceCard({ role, iface, isDefault = false, i18n = UZ }: InterfaceCardProps): ReactElement {
  const summary = describeInterface(iface, i18n);
  const Icon = role === 'wifi' ? WifiIcon : EthernetIcon;
  return (
    <div className={styles['card']} data-role={role} data-tone={summary.tone}>
      <Icon size={20} className={styles['icon']} />
      <div className={styles['body']}>
        <div className={styles['title']}>
          <span className={styles['name']}>{ROLE_LABELS[role]}</span>
          {isDefault ? <span className={styles['defaultTag']}>{i18n.t.components.iface.defaultTag}</span> : null}
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
  /** The UI language (`useI18n()` of the screen); Uzbek when not given. */
  readonly i18n?: I18n | undefined;
}

/** A selectable interface card (the "Interfeys" choice of the add-rule form). */
export function InterfaceOption({
  role,
  iface,
  selected,
  onSelect,
  disabled = false,
  i18n = UZ,
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
        <span className={styles['detail']}>{describeInterfaceOption(iface, i18n)}</span>
      </span>
    </button>
  );
}
