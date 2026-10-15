// What the main process says, in English (shape: `shell.uz.ts`).

import { plural } from '../plural';
import type { Shape } from '../types';
import type { shellUz } from './shell.uz';

const n = (count: number, one: string, other: string): string => `${String(count)} ${plural('en', count, { one, other })}`;

export const shellEn: Shape<typeof shellUz> = {
  tray: {
    connecting: 'RouteSwitch — connecting…',
    notInstalled: 'RouteSwitch — helper not installed',
    disconnected: 'RouteSwitch — no connection to the helper',
    incompatible: 'RouteSwitch — helper version does not match',
    configUnreadable: 'RouteSwitch — helper config is damaged, rules are not applied',
    off: 'RouteSwitch — off',
    active: 'RouteSwitch — active',
    failing: (count) => `RouteSwitch — ${n(count, 'rule', 'rules')} failing`,
    rulesWaiting: (count) => `${n(count, 'rule is', 'rules are')} waiting for an interface`,
    sameSubnet: 'Ethernet and Wi‑Fi are on the same network',
    manageRules: 'Manage Rules',
    quit: 'Quit RouteSwitch',
  },

  dialogs: {
    importTitle: 'Import Config',
    exportTitle: 'Export Config',
  },

  journal: {
    connected: (helperVersion) => `Connected to the helper (v${helperVersion})`,
    notInstalled: 'The helper is not installed — rules are not applied',
    disconnected: (why) => `No connection to the helper: ${why}`,
    disconnectedWhy: {
      'not-running': 'the helper is not running (the socket exists, no answer)',
      'permission-denied': "no permission for the helper's socket",
      'connection-lost': 'the connection was lost',
      'protocol-error': 'the helper gave an answer that could not be understood',
      timeout: 'the helper did not answer',
      error: 'could not connect to the helper',
    },
    configUnreadable:
      'The helper could not read its saved config — no rule is applied. Restore it by importing a config or starting with an empty one',
    incompatible: (helperVersion, protocolVersion, expected) =>
      `The helper version does not match: v${helperVersion}, protocol ${String(protocolVersion)} (needed: ${String(expected)})`,
    flapping: 'The helper connection keeps changing — further changes are not written to the journal for up to 10 minutes',
  },
};
