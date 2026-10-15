// "Bo'sh config bilan boshlash": the way out when the helper runs but cannot
// load the config it stored (`config-unreadable`). The other way out is the
// toolbar's "Import". Below it, the rules backup's restore offer (TASK-DELTA-16). Plain functions over the preload API and an update
// function, like `controller.ts`: every transition is tested without a DOM.

import type { Config } from '@routeswitch/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { I18n } from '../../../../i18n';
import type { EngineStateView } from '../../hooks/useEngineState';
import { browserShowSignal, readOnShow, type ShowSignal, type ShownReader } from '../../hooks/windowShown';
import type { RsApi, RsBackupInfo } from '../../rs';
import { errorText, UZ, type Feedback } from '../../text';

export type RecoveryApi = Pick<RsApi, 'resetConfig'>;

export interface RecoveryUiState {
  /** The question "replace the stored config with an empty one?" is open. */
  readonly confirming: boolean;
  /** The reset is on its way to the helper. */
  readonly busy: boolean;
  readonly feedback: Feedback | null;
  /** After a cancelled question, the "Bo'sh config bilan boshlash" button gets the focus back. */
  readonly focusReset: boolean;
}

export const INITIAL_RECOVERY_UI: RecoveryUiState = { confirming: false, busy: false, feedback: null, focusReset: false };

export type RecoveryUiUpdate = (change: (state: RecoveryUiState) => RecoveryUiState) => void;

export interface RecoveryController {
  /** The button: only asks; nothing is sent. */
  readonly ask: () => void;
  /** "Bekor qilish" (or Escape): closes the question unless the reset is on its way; nothing is sent. */
  readonly cancel: () => void;
  /** "Almashtirish": sends `resetConfig` once. Success closes the question; a failure keeps it open with the reason. */
  readonly confirm: () => Promise<void>;
  /** The focus has been moved back; forget the request. */
  readonly focusDone: () => void;
}

/** The success message in Uzbek (the screen shows `t.rules.resetDone` of its language). */
export const RESET_DONE = UZ.t.rules.resetDone;

/** `i18n` is read when the outcome is written. */
export function createRecoveryController(
  rs: RecoveryApi,
  update: RecoveryUiUpdate,
  current: () => RecoveryUiState,
  i18n: () => I18n = () => UZ,
): RecoveryController {
  return {
    ask: () => {
      update((state) => (state.busy ? state : { ...state, confirming: true, feedback: null, focusReset: false }));
    },
    cancel: () => {
      update((state) => (!state.confirming || state.busy ? state : { ...state, confirming: false, focusReset: true }));
    },
    confirm: async () => {
      const state = current();
      if (!state.confirming || state.busy) return;
      update((next) => ({ ...next, busy: true, feedback: null }));
      const result = await rs.resetConfig();
      const words = i18n();
      update((next) => ({
        ...next,
        busy: false,
        confirming: !result.ok,
        feedback: result.ok
          ? { tone: 'success', text: words.t.rules.resetDone }
          : { tone: 'danger', text: words.t.rules.replaceFailed(errorText(result.code, words)) },
      }));
    },
    focusDone: () => {
      update((state) => (state.focusReset ? { ...state, focusReset: false } : state));
    },
  };
}

/** The panel's handlers for the controller. */
export function recoveryHandlers(controller: RecoveryController) {
  return {
    onAskReset: () => {
      controller.ask();
    },
    onCancelReset: () => {
      controller.cancel();
    },
    onConfirmReset: () => {
      void controller.confirm();
    },
  };
}

/** Gives the focus back to the "Bo'sh config bilan boshlash" button when it is still on the page. */
export function focusResetButton(button: Pick<HTMLElement, 'isConnected' | 'focus'> | null): boolean {
  if (button === null || !button.isConnected) return false;
  button.focus();
  return true;
}

// ---------------------------------------------------------------------------
// The rules backup's restore offer (TASK-DELTA-16)
// ---------------------------------------------------------------------------
//
// The main process keeps the last config it saw (`userData/rules-backup.json`).
// When the helper runs with no rules and the backup has some, the menu bar and
// the rules window offer them back. "Ko'rib chiqish" opens the import preview
// (`startRestore` in `transfer.ts`); only its "Almashtirish" sends anything to
// the helper. "Kerak emas" turns down this backup (a newer one is offered again).

export type BackupApi = Pick<RsApi, 'getBackup'>;

export interface BackupView {
  /** `loading` until the first answer; `failed` when it could not be read (no offer then). */
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly info: RsBackupInfo | null;
}

export const INITIAL_BACKUP_VIEW: BackupView = { phase: 'loading', info: null };

/** The offer, when there is one: the helper is connected with an empty config and the backup has rules the user did not turn down. */
export function backupOffer(
  engine: Pick<EngineStateView, 'helper'>,
  config: Config | null,
  backup: BackupView,
): { readonly count: number; readonly savedAt: string } | null {
  if (engine.helper !== 'connected' || config === null || config.rules.length > 0) return null;
  const info = backup.info;
  if (info === null || info.dismissed || info.ruleCount < 1) return null;
  return { count: info.ruleCount, savedAt: info.savedAt };
}

/**
 * Reads what the backup holds now, again whenever `key` changes (a new
 * connection, a new config revision) and whenever the window is shown again.
 */
export function followBackup(rs: BackupApi, deliver: (view: BackupView) => void, onShow: ShowSignal): ShownReader {
  return readOnShow(
    () => rs.getBackup(),
    (result) => {
      deliver(result.ok ? { phase: 'ready', info: result.value } : { phase: 'failed', info: null });
    },
    onShow,
  );
}

/** The backup as a screen shows it; `reload` reads it again (after a removal or a dismissal). */
export function useBackup(rs: BackupApi, key: string): { readonly view: BackupView; readonly reload: () => void } {
  const [view, setView] = useState<BackupView>(INITIAL_BACKUP_VIEW);
  const reader = useRef<ShownReader | null>(null);
  useEffect(() => {
    const current = followBackup(rs, setView, browserShowSignal(window, document));
    reader.current = current;
    return () => {
      current.stop();
      reader.current = null;
    };
  }, [rs, key]);
  const reload = useCallback(() => {
    reader.current?.refresh();
  }, []);
  return { view, reload };
}

/** "Kerak emas": turns down this backup's offer. A failure is a message; success needs none (the offer goes). */
export async function dismissBackupOffer(rs: Pick<RsApi, 'dismissBackup'>, i18n: I18n = UZ): Promise<Feedback | null> {
  const result = await rs.dismissBackup();
  return result.ok ? null : { tone: 'danger', text: i18n.t.backup.dismissFailed(errorText(result.code, i18n)) };
}

/** The key that makes `useBackup` read again: the connection and the config revision. */
export function backupKey(engine: Pick<EngineStateView, 'helper' | 'state'>): string {
  return `${engine.helper}:${engine.helper === 'connected' ? String(engine.state?.configRevision ?? '') : ''}`;
}

/** "Zaxirani o'chirish" (after its question): removes the backup; the message says how it went. */
export async function removeBackup(rs: Pick<RsApi, 'deleteBackup'>, i18n: I18n = UZ): Promise<Feedback> {
  const words = i18n.t.backup.settings;
  const result = await rs.deleteBackup();
  return result.ok ? { tone: 'success', text: words.removed } : { tone: 'danger', text: words.removeFailed(errorText(result.code, i18n)) };
}
