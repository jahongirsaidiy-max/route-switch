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
  RsLogChannel,
  RsLogEntry,
  RsResult,
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

const api: RsApi = {
  getState: () => invoke('rs:getState'),
  getConfig: () => invoke('rs:getConfig'),
  saveRule: (rule) => invoke('rs:saveRule', rule),
  deleteRule: (id) => invoke('rs:deleteRule', id),
  toggleRule: (id, enabled) => invoke('rs:toggleRule', id, enabled),
  setEnabled: (on) => invoke('rs:setEnabled', on),
  apply: () => invoke('rs:apply'),
  test: (target) => invoke('rs:test', target),
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
  openRulesWindow: () => invoke('rs:openRulesWindow'),
  onLog: (listener) => {
    const forward = (_event: IpcRendererEvent, entry: RsLogEntry): void => {
      listener(entry);
    };
    ipcRenderer.on(LOG_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(LOG_CHANNEL, forward);
    };
  },
};

contextBridge.exposeInMainWorld('rs', api);
