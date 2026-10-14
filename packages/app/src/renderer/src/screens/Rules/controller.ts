// What happens when the user toggles or deletes a rule, as plain functions
// over the preload API and an update function — no React, so every
// transition is tested without a DOM. `RulesScreen` keeps the state in
// `useState` and passes its setter.

import type { Feedback } from '../../text';
import { removeRule, setRuleEnabled, type RulesApi } from './actions';

export interface RulesUiState {
  /** Rules whose switch or removal is on its way to the helper. */
  readonly busy: ReadonlySet<string>;
  /** The rule whose removal waits for "O'chirish" to be confirmed. */
  readonly confirmingDelete: string | null;
  readonly feedback: Feedback | null;
  /** After a cancelled removal, the rule whose trash button gets the focus back. */
  readonly focusTrash: string | null;
}

export const INITIAL_RULES_UI: RulesUiState = { busy: new Set(), confirmingDelete: null, feedback: null, focusTrash: null };

export type RulesUiUpdate = (change: (state: RulesUiState) => RulesUiState) => void;

const withBusy = (busy: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(busy);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

export interface RulesController {
  /** The rule's switch: sends exactly the requested value. Ignored while that rule is busy. */
  readonly toggle: (id: string, enabled: boolean) => Promise<void>;
  /** The trash button: only asks; nothing is sent. */
  readonly askDelete: (id: string) => void;
  /** "Bekor qilish" (or Escape): closes the question; nothing is sent; the focus goes back to the trash button. */
  readonly cancelDelete: () => void;
  /**
   * "O'chirish": removes the rule being asked about. On success the question
   * closes; on failure it stays open with the reason, for another try.
   */
  readonly confirmDelete: (id: string) => Promise<void>;
  /** The focus has been moved back; forget the request. */
  readonly focusDone: () => void;
}

export function createRulesController(rs: RulesApi, update: RulesUiUpdate, current: () => RulesUiState): RulesController {
  const begin = (id: string) => {
    update((state) => ({ ...state, busy: withBusy(state.busy, id, true), feedback: null }));
  };

  return {
    toggle: async (id, enabled) => {
      if (current().busy.has(id)) return;
      begin(id);
      const feedback = await setRuleEnabled(rs, id, enabled);
      update((state) => ({ ...state, busy: withBusy(state.busy, id, false), feedback }));
    },
    askDelete: (id) => {
      update((state) => ({ ...state, confirmingDelete: id, feedback: null, focusTrash: null }));
    },
    cancelDelete: () => {
      update((state) =>
        state.confirmingDelete === null ? state : { ...state, confirmingDelete: null, focusTrash: state.confirmingDelete },
      );
    },
    confirmDelete: async (id) => {
      const state = current();
      // Only the rule being asked about, and only once.
      if (state.confirmingDelete !== id || state.busy.has(id)) return;
      begin(id);
      const feedback = await removeRule(rs, id);
      update((next) => ({
        ...next,
        busy: withBusy(next.busy, id, false),
        feedback,
        confirmingDelete: feedback === null && next.confirmingDelete === id ? null : next.confirmingDelete,
      }));
    },
    focusDone: () => {
      update((state) => (state.focusTrash === null ? state : { ...state, focusTrash: null }));
    },
  };
}

/** The panel's handlers for the controller (what `RulesScreen` passes to `RulesPanel`). */
export function rulesHandlers(controller: RulesController) {
  return {
    onToggleRule: (id: string, enabled: boolean) => {
      void controller.toggle(id, enabled);
    },
    onAskDelete: (id: string) => {
      controller.askDelete(id);
    },
    onCancelDelete: () => {
      controller.cancelDelete();
    },
    onConfirmDelete: (id: string) => {
      void controller.confirmDelete(id);
    },
  };
}

/** Moves the focus to the trash button of `id` when it is on the page. */
export function focusTrashButton(buttons: ReadonlyMap<string, { focus: () => void }>, id: string | null): boolean {
  if (id === null) return false;
  const button = buttons.get(id);
  if (button === undefined) return false;
  button.focus();
  return true;
}
