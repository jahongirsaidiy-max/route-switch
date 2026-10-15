// The form's transitions as plain functions over the preload API and an update
// function (the shape of `screens/Rules/controller.ts`): every step — editing a
// field, a refused save, a save on its way, a test — is tested without a DOM.
// `AddRuleDialog` keeps the state in `useState` and passes its setter.

import type { Config, IfaceRole, RuleKind, TestResult } from '@routeswitch/shared';

import type { Feedback } from '../../text';
import { saveRule, testRoute, type AddRuleApi } from './actions';
import { checkForm, firstErrorField, formOfRule, NEW_RULE_FORM, type FormField, type RuleForm } from './model';

export type TestView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly address: string }
  | { readonly phase: 'done'; readonly address: string; readonly result: TestResult }
  | { readonly phase: 'failed'; readonly address: string; readonly text: string };

export interface AddRuleUiState {
  readonly form: RuleForm;
  /** Edit mode: the form has been filled from the stored rule (once; later config revisions do not overwrite typing). */
  readonly loaded: boolean;
  /** Fields the user has left once: their errors show from then on. */
  readonly touched: ReadonlySet<FormField>;
  /** A save was asked for: every error shows. */
  readonly submitted: boolean;
  readonly saving: boolean;
  readonly feedback: Feedback | null;
  readonly test: TestView;
  /** After a refused save, the field that gets the focus. */
  readonly focusField: FormField | null;
}

export const initialAddRuleUi = (form: RuleForm = NEW_RULE_FORM, loaded = false): AddRuleUiState => ({
  form,
  loaded,
  touched: new Set(),
  submitted: false,
  saving: false,
  feedback: null,
  test: { phase: 'idle' },
  focusField: null,
});

export type AddRuleUiUpdate = (change: (state: AddRuleUiState) => AddRuleUiState) => void;

export interface AddRuleController {
  readonly setKind: (kind: RuleKind) => void;
  readonly setIface: (iface: IfaceRole) => void;
  /** Any text field or the DNS check box. */
  readonly setField: <K extends 'target' | 'dns' | 'refreshSec' | 'note' | 'useDns'>(field: K, value: RuleForm[K]) => void;
  /** The user left a field: its error may show now. */
  readonly blur: (field: FormField) => void;
  /** Edit mode: fills the form from the stored rule, once. */
  readonly load: (rule: Parameters<typeof formOfRule>[0]) => void;
  /**
   * "Saqlash va qo'llash": checks the form with the shared schema against
   * `config`; a refused form shows every error and moves the focus to the
   * first; a valid one is sent once (a second click while it is on its way is
   * ignored). Success calls `onSaved`; a refusal keeps the form open with the
   * reason.
   */
  readonly save: (config: Config | null) => Promise<void>;
  /** "Sinab ko'rish" for one address; only the answer for the latest request is kept. */
  readonly runTest: (address: string) => Promise<void>;
  /** The focus has been moved; forget the request. */
  readonly focusDone: () => void;
}

export function createAddRuleController(
  rs: AddRuleApi,
  id: string,
  update: AddRuleUiUpdate,
  current: () => AddRuleUiState,
  onSaved: () => void,
): AddRuleController {
  // Bumped by every test: an answer that arrives after a newer request is dropped.
  let testGeneration = 0;
  const editForm = (change: (form: RuleForm) => RuleForm) => {
    update((state) => ({ ...state, form: change(state.form), feedback: null }));
  };

  return {
    setKind: (kind) => {
      // The id stays: changing the kind edits the same rule.
      editForm((form) => (form.kind === kind ? form : { ...form, kind }));
    },
    setIface: (iface) => {
      editForm((form) => (form.iface === iface ? form : { ...form, iface }));
    },
    setField: (field, value) => {
      editForm((form) => ({ ...form, [field]: value }));
    },
    blur: (field) => {
      update((state) => (state.touched.has(field) ? state : { ...state, touched: new Set([...state.touched, field]) }));
    },
    load: (rule) => {
      update((state) => (state.loaded ? state : { ...state, form: formOfRule(rule), loaded: true }));
    },
    save: async (config) => {
      const state = current();
      if (state.saving) return;
      const check = checkForm(state.form, id, config);
      if (check.rule === null) {
        update((next) => ({ ...next, submitted: true, focusField: firstErrorField(check.errors), feedback: check.formError === null ? null : { tone: 'danger', text: check.formError } }));
        return;
      }
      update((next) => ({ ...next, submitted: true, saving: true, feedback: null }));
      const feedback = await saveRule(rs, check.rule);
      update((next) => ({ ...next, saving: false, feedback }));
      if (feedback === null) onSaved();
    },
    runTest: async (address) => {
      testGeneration += 1;
      const generation = testGeneration;
      update((state) => ({ ...state, test: { phase: 'running', address } }));
      const outcome = await testRoute(rs, address);
      if (generation !== testGeneration) return;
      update((state) => ({
        ...state,
        test: outcome.ok ? { phase: 'done', address, result: outcome.result } : { phase: 'failed', address, text: outcome.text },
      }));
    },
    focusDone: () => {
      update((state) => (state.focusField === null ? state : { ...state, focusField: null }));
    },
  };
}
