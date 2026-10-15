// "Bo'sh config bilan boshlash": the way out when the helper runs but cannot
// load the config it stored (`config-unreadable`). The other way out is the
// toolbar's "Import". Plain functions over the preload API and an update
// function, like `controller.ts`: every transition is tested without a DOM.

import type { RsApi } from '../../rs';
import { errorText, type Feedback } from '../../text';

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

export const RESET_DONE = "Bo'sh config saqlandi — helper yana ishlayapti. Endi qoida qo'shishingiz yoki import qilishingiz mumkin.";

export function createRecoveryController(rs: RecoveryApi, update: RecoveryUiUpdate, current: () => RecoveryUiState): RecoveryController {
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
      update((next) => ({
        ...next,
        busy: false,
        confirming: !result.ok,
        feedback: result.ok ? { tone: 'success', text: RESET_DONE } : { tone: 'danger', text: `Config almashtirilmadi: ${errorText(result.code)}` },
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
