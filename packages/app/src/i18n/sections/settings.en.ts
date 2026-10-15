// The settings screen (TASK-DELTA-14), in English.

import type { Messages } from '../types';

export const settingsEn: Messages['settings'] = {
  title: 'Settings',
  subtitle: 'Settings of the app and the helper. Rules are stored in the helper.',
  login: {
    title: 'Open at login',
    hint: 'When you log in, RouteSwitch opens in the menu bar. Routes keep working without the app — the helper holds them.',
    on: 'RouteSwitch will open at login.',
    off: 'Open at login is turned off.',
    refused: 'macOS did not accept the setting (System Settings → Login Items).',
  },
  ethernet: {
    title: 'Ethernet adapter',
    hint: (detected) =>
      `Normally the first adapter with an IP address that is not Wi‑Fi is used${detected === null ? '' : ` (now: ${detected})`}. If there are several, choose the right one.`,
    fieldLabel: 'Adapter for the Ethernet role',
    auto: 'Automatic',
    noIp: 'No IP',
    notConnected: (device) => `${device} · not connected`,
    needsHelper: 'You can choose once the helper is connected.',
    savedAuto: 'The Ethernet adapter is detected automatically.',
    saved: (device) => `The Ethernet role is now on ${device}.`,
  },
  wifi: {
    title: 'Make Wi‑Fi the default',
    hint: 'Traffic that matches no rule leaves through the first connected network in the service order. Changing that order needs administrator rights, so RouteSwitch only shows the command — you run it yourself in Terminal.',
    loading: 'Reading the service order…',
    failed: 'Could not read the service order.',
    notFound: 'No Wi‑Fi service found.',
    alreadyFirst: (service) => `${service} is already first — Wi‑Fi is the default channel.`,
    currentFirst: (service) => `First now: ${service}.`,
    commandLabel: 'The command that puts Wi‑Fi first',
    copy: 'Copy',
    refresh: 'Refresh',
    copied: 'Command copied — paste it into Terminal.',
  },
  helper: {
    title: 'Helper',
    hint: "Removing asks for the administrator password: every route and resolver file the helper added is removed, the root daemon stops, and its files — the config (your rules) and the log — are deleted too. A copy of your rules stays in the app's backup, and after a reinstall the app offers to restore it; export to move them to another Mac.",
    uninstall: 'Remove the helper',
    question: "Remove the helper? Your rules stay in the app's backup — you can restore them after reinstalling.",
    confirm: 'Yes, remove',
    cancel: 'Cancel',
  },
};
