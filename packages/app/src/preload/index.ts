// Runs in every window before the page, under `sandbox: true` — so it is built
// as a single CommonJS file with its dependencies bundled in.
//
// Exposes `window.rs` (types: `src/renderer/src/rs.d.ts`) and nothing else.
// Each method is a bare `ipcRenderer.invoke` on its channel; the main process
// (`src/main/ipc.ts`) checks every call. No logic lives here: whatever this
// file decided, a compromised page could bypass by calling the channel itself.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  RsApi,
  RsInvokeChannel,
  RsInvokeChannels,
  RsLanguage,
  RsLanguageChannel,
  RsLogChannel,
  RsLogEntry,
  RsResult,
  RsRulesIntentChannel,
  RsSnapshot,
  RsStateChannel,
} from '../renderer/src/rs';

const invoke = <C extends RsInvokeChannel>(
  channel: C,
  ...args: RsInvokeChannels[C]['args']
): Promise<RsResult<RsInvokeChannels[C]['value']>> =>
  // The main process answers every call on these channels with an `RsResult`.
  ipcRenderer.invoke(channel, ...args) as Promise<RsResult<RsInvokeChannels[C]['value']>>;

const STATE_CHANNEL: RsStateChannel = 'rs:state';
const LOG_CHANNEL: RsLogChannel = 'rs:log';
const LANGUAGE_CHANNEL: RsLanguageChannel = 'rs:language';
const RULES_INTENT_CHANNEL: RsRulesIntentChannel = 'rs:rulesIntent';

const api: RsApi = {
  getState: () => invoke('rs:getState'),
  getConfig: () => invoke('rs:getConfig'),
  saveRule: (rule) => invoke('rs:saveRule', rule),
  deleteRule: (id) => invoke('rs:deleteRule', id),
  toggleRule: (id, enabled) => invoke('rs:toggleRule', id, enabled),
  setEnabled: (on) => invoke('rs:setEnabled', on),
  apply: () => invoke('rs:apply'),
  test: (target) => invoke('rs:test', target),
  diagnose: (target) => invoke('rs:diagnose', target),
  importConfig: () => invoke('rs:import'),
  applyImport: (token) => invoke('rs:applyImport', token),
  exportConfig: () => invoke('rs:export'),
  onState: (listener) => {
    // The page never sees the Electron event object, only the snapshot.
    const forward = (_event: IpcRendererEvent, snapshot: RsSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(STATE_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(STATE_CHANNEL, forward);
    };
  },
  getLog: () => invoke('rs:getLog'),
  getSettings: () => invoke('rs:getSettings'),
  setOpenAtLogin: (on) => invoke('rs:setOpenAtLogin', on),
  setIfaceOverrides: (overrides) => invoke('rs:setIfaceOverrides', overrides),
  getServiceOrder: () => invoke('rs:getServiceOrder'),
  copyServiceOrderCommand: () => invoke('rs:copyServiceOrderCommand'),
  uninstallHelper: () => invoke('rs:uninstall'),
  // Without an intent no argument is sent: the main process counts them.
  openRulesWindow: (intent) => (intent === undefined ? invoke('rs:openRulesWindow') : invoke('rs:openRulesWindow', intent)),
  takeRulesIntent: () => invoke('rs:takeRulesIntent'),
  onRulesIntent: (listener) => {
    const forward = (): void => {
      listener();
    };
    ipcRenderer.on(RULES_INTENT_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(RULES_INTENT_CHANNEL, forward);
    };
  },
  reconnectHelper: () => invoke('rs:reconnect'),
  resetConfig: () => invoke('rs:resetConfig'),
  installHelper: () => invoke('rs:installHelper'),
  removeHelper: () => invoke('rs:removeHelper'),
  onLog: (listener) => {
    const forward = (_event: IpcRendererEvent, entry: RsLogEntry): void => {
      listener(entry);
    };
    ipcRenderer.on(LOG_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(LOG_CHANNEL, forward);
    };
  },
  getLanguage: () => invoke('rs:getLanguage'),
  setLanguage: (language) => invoke('rs:setLanguage', language),
  getBackup: () => invoke('rs:getBackup'),
  restoreBackup: () => invoke('rs:restoreBackup'),
  deleteBackup: () => invoke('rs:deleteBackup'),
  dismissBackup: () => invoke('rs:dismissBackup'),
  onLanguage: (listener) => {
    const forward = (_event: IpcRendererEvent, language: RsLanguage): void => {
      listener(language);
    };
    ipcRenderer.on(LANGUAGE_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(LANGUAGE_CHANNEL, forward);
    };
  },
};

contextBridge.exposeInMainWorld('rs', api);
