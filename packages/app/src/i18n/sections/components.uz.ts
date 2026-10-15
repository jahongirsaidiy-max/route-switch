// The shared components and the helper install flow (TASK-DELTA-14), in
// Uzbek: the source of the `components` keys. Role names (Ethernet, Wi‑Fi)
// and their tags (ETH, WIFI) are product names, the same in every language.

import type { RuleStatus } from '@routeswitch/shared';

export const componentsUz = {
  /** A rule's status tag (`StatusBadge`). */
  ruleStatus: {
    active: 'Faol',
    pending: 'Kutilmoqda',
    error: 'Xato',
    disabled: "O'chirilgan",
  } satisfies Readonly<Record<RuleStatus, string>>,
  /** How a role's interface reads (`InterfaceCard`, `InterfaceOption`). */
  iface: {
    adapterMissing: 'Adapter topilmadi',
    notConnected: 'Ulanmagan',
    noGateway: "Gateway yo'q",
    connected: 'Ulangan',
    deviceDown: (device: string): string => `${device} · ulanmagan`,
    deviceNoGateway: (device: string, ip: string): string => `${device} · ${ip} · gateway yo'q`,
    optionNoGateway: (device: string): string => `${device} · gateway yo'q`,
    /** The tag of the role that carries the default route. */
    defaultTag: 'DEFAULT',
  },
  /** The way out of a helper status (`HelperRecovery`) and the install flow (TASK-214). */
  recovery: {
    reconnect: 'Qayta ulanish',
    recheck: 'Qayta tekshirish',
    /** "Helper'ni o'chirish" without the app's `uninstall.sh`: the helper's own uninstall over the socket. */
    removedOverSocket: "Helper o'chirildi: uning route'lari va resolver fayllari olib tashlandi. Routing to'xtadi.",
  },
};
