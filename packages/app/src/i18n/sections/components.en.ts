// The shared components and the helper install flow (TASK-DELTA-14), in English.

import type { Messages } from '../types';

export const componentsEn: Messages['components'] = {
  ruleStatus: {
    active: 'Active',
    pending: 'Pending',
    error: 'Error',
    disabled: 'Off',
  },
  iface: {
    adapterMissing: 'Adapter not found',
    notConnected: 'Not connected',
    noGateway: 'No gateway',
    connected: 'Connected',
    deviceDown: (device) => `${device} · not connected`,
    deviceNoGateway: (device, ip) => `${device} · ${ip} · no gateway`,
    optionNoGateway: (device) => `${device} · no gateway`,
    defaultTag: 'DEFAULT',
  },
  recovery: {
    reconnect: 'Reconnect',
    recheck: 'Check again',
    removedOverSocket: 'Helper removed: its routes and resolver files are gone. Routing has stopped.',
  },
};
