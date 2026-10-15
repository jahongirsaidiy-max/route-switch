// "Tekshirish" of the Diagnostika section, as plain functions over the
// preload API and an update function — tested without a DOM, like the rules
// window's controllers. The input is checked here first (`parseDiagnosticTarget`);
// a refused one is a field error and nothing is sent. One diagnosis at a
// time: a second press while one runs does nothing (the main process would
// answer `busy` anyway).

import type { I18n } from '../../../../i18n';
import type { RsApi, RsDiagnosis, RsErrorCode } from '../../rs';
import { errorText, isValidationCode, UZ } from '../../text';
import { parseDiagnosticTarget } from './target';

export type DiagnosticsApi = Pick<RsApi, 'diagnose'>;

export interface DiagnosticsUiState {
  readonly input: string;
  /** Why the input was refused (in the language of the moment it was checked). */
  readonly fieldError: string | null;
  readonly running: boolean;
  /** The last diagnosis, kept while a new one runs. */
  readonly diagnosis: RsDiagnosis | null;
  /** Why the last diagnosis could not be made. */
  readonly failure: string | null;
}

export const INITIAL_DIAGNOSTICS_UI: DiagnosticsUiState = { input: '', fieldError: null, running: false, diagnosis: null, failure: null };

export type DiagnosticsUiUpdate = (change: (state: DiagnosticsUiState) => DiagnosticsUiState) => void;

export interface DiagnosticsController {
  readonly setInput: (input: string) => void;
  /** "Tekshirish": checks the input, then asks the main process. Ignored while one runs. */
  readonly run: () => Promise<void>;
}

/**
 * Why a diagnosis could not be made, in words. The helper's limits have codes
 * of their own (TASK-DELTA-21): `rate-limited` — the connection's per-minute
 * budget is used up; `busy` — another diagnosis runs (the helper's, or the
 * main process's one at a time). Any other code keeps the generic words.
 */
export function failureText(code: RsErrorCode, i18n: I18n = UZ): string {
  const words = i18n.t.diagnostics;
  if (code === 'rate-limited') return words.rateLimited;
  if (code === 'busy') return words.helperBusy;
  return words.failed(errorText(code, i18n));
}

/** The words of a refused input. */
export function inputErrorText(input: string, i18n: I18n = UZ): string | null {
  const parsed = parseDiagnosticTarget(input);
  if (parsed.ok) return null;
  return isValidationCode(parsed.code) ? i18n.t.validation[parsed.code] : i18n.t.diagnostics.inputErrors[parsed.code];
}

/** `i18n` is read when an outcome is written, so a message is in the language of that moment. */
export function createDiagnosticsController(
  rs: DiagnosticsApi,
  update: DiagnosticsUiUpdate,
  current: () => DiagnosticsUiState,
  i18n: () => I18n = () => UZ,
): DiagnosticsController {
  return {
    setInput: (input) => {
      update((state) => ({ ...state, input, fieldError: null }));
    },
    run: async () => {
      if (current().running) return;
      const parsed = parseDiagnosticTarget(current().input);
      if (!parsed.ok) {
        update((state) => ({ ...state, fieldError: inputErrorText(state.input, i18n()) }));
        return;
      }
      update((state) => ({ ...state, fieldError: null, running: true, failure: null }));
      let failure: string | null = null;
      let diagnosis: RsDiagnosis | null = null;
      try {
        const result = await rs.diagnose(parsed.target);
        if (result.ok) diagnosis = result.value;
        else failure = failureText(result.code, i18n());
      } catch {
        // The preload never rejects; a page without a main process answers this way.
        failure = i18n().t.diagnostics.failed(errorText('unspecified', i18n()));
      }
      update((state) => ({
        ...state,
        running: false,
        failure,
        diagnosis: diagnosis ?? (failure === null ? state.diagnosis : null),
      }));
    },
  };
}
