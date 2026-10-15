// Config import / export of the rules window (TASK-215), as plain functions
// over the preload API and an update function — tested without a DOM, like
// `controller.ts`.
//
// Import: the main process shows the system file dialog, reads and checks the
// file with the shared `Config` schema and returns it with a one-use token;
// nothing reaches the helper yet. The page shows what the replacement changes
// and asks; only "Almashtirish" sends `applyImport(token)`. An import REPLACES
// the stored config as a whole: the file is a complete config, and merging
// would need rules for duplicate ids, one target on two interfaces and the
// global switch that the user could not see in advance. The confirmation
// states every rule that is added, removed or changed.
//
// Export: the main process reads the stored config and writes it to the path
// the user chooses in the system save dialog.

import type { Config } from '@routeswitch/shared';
import type { Ref } from 'react';

import type { I18n } from '../../../../i18n';
import type { RsApi, RsResult } from '../../rs';
import { configIssueText, errorText, UZ, type Feedback } from '../../text';
import type { RulesController } from './controller';

export type TransferApi = Pick<RsApi, 'importConfig' | 'applyImport' | 'exportConfig'>;

export interface ImportPreview {
  readonly token: string;
  readonly config: Config;
  /** Where the config comes from: a file the user chose, or the app's rules backup (TASK-DELTA-16, with its time). */
  readonly source?: { readonly kind: 'backup'; readonly savedAt: string };
}

export interface TransferUiState {
  /** What is on its way: a file dialog and read, the replacement, or an export. */
  readonly phase: 'idle' | 'importing' | 'applying' | 'exporting';
  /** A read file waiting for "Almashtirish". */
  readonly preview: ImportPreview | null;
  readonly feedback: Feedback | null;
  /** The confirmation closed: the focus goes back to "Import". */
  readonly focusImport: boolean;
}

export const INITIAL_TRANSFER_UI: TransferUiState = { phase: 'idle', preview: null, feedback: null, focusImport: false };

export type TransferUiUpdate = (change: (state: TransferUiState) => TransferUiState) => void;

/** The words for a refused import. */
export function importFailureText(result: Extract<RsResult<unknown>, { ok: false }>, i18n: I18n = UZ): string {
  const why = result.code === 'invalid-config' ? configIssueText(result.issue, i18n) : errorText(result.code, i18n);
  return i18n.t.rules.importFailed(why);
}

export interface TransferController {
  /** "Import": opens the file dialog (main process); a valid file waits for confirmation. Ignored while busy. */
  readonly startImport: () => Promise<void>;
  /** "Bekor qilish" / Escape: forgets the read file; nothing is sent. */
  readonly cancelImport: () => void;
  /** Closes the confirmation without moving the focus (another panel takes it). */
  readonly dismiss: () => void;
  /** "Almashtirish": replaces the stored config with the file's, once. */
  readonly confirmImport: (token: string) => Promise<void>;
  /** "Export": the save dialog and the file write (main process). Ignored while busy. */
  readonly startExport: () => Promise<void>;
  readonly focusDone: () => void;
}

/** `i18n` is read when an outcome is written, so a message is in the language of that moment. */
export function createTransferController(
  rs: TransferApi,
  update: TransferUiUpdate,
  current: () => TransferUiState,
  i18n: () => I18n = () => UZ,
): TransferController {
  return {
    startImport: async () => {
      if (current().phase !== 'idle') return;
      update((state) => ({ ...state, phase: 'importing', preview: null, feedback: null }));
      const result = await rs.importConfig();
      const words = i18n();
      update((state) => {
        if (!result.ok) return { ...state, phase: 'idle', feedback: { tone: 'danger', text: importFailureText(result, words) } };
        // Cancelled dialog: nothing changes.
        if (result.value === null) return { ...state, phase: 'idle' };
        return { ...state, phase: 'idle', preview: { token: result.value.token, config: result.value.config } };
      });
    },
    cancelImport: () => {
      cancelPreview(update);
    },
    dismiss: () => {
      update((state) => (state.preview === null || state.phase === 'applying' ? state : { ...state, preview: null }));
    },
    confirmImport: (token) => confirmPreview(rs, token, update, current, i18n),
    startExport: async () => {
      if (current().phase !== 'idle') return;
      update((state) => ({ ...state, phase: 'exporting', feedback: null }));
      const result = await rs.exportConfig();
      const words = i18n();
      update((state) => ({
        ...state,
        phase: 'idle',
        feedback: !result.ok
          ? { tone: 'danger', text: words.t.rules.exportFailed(errorText(result.code, words)) }
          : result.value === null
            ? null
            : { tone: 'success', text: words.t.rules.exported(result.value.rules) },
      }));
    },
    focusDone: () => {
      update((state) => (state.focusImport ? { ...state, focusImport: false } : state));
    },
  };
}

/**
 * "Almashtirish" of a preview (an import or a restore): replaces the stored
 * config with the previewed one, once — only the preview being asked about.
 * The token is used up either way: the confirmation closes.
 */
export async function confirmPreview(
  rs: Pick<RsApi, 'applyImport'>,
  token: string,
  update: TransferUiUpdate,
  current: () => TransferUiState,
  i18n: () => I18n = () => UZ,
): Promise<void> {
  const state = current();
  if (state.phase !== 'idle' || state.preview?.token !== token) return;
  const rules = state.preview.config.rules.length;
  const fromBackup = state.preview.source?.kind === 'backup';
  update((next) => ({ ...next, phase: 'applying', feedback: null }));
  const result = await rs.applyImport(token);
  const words = i18n();
  const t = words.t.rules;
  update((next) => ({
    ...next,
    phase: 'idle',
    preview: null,
    focusImport: true,
    feedback: result.ok
      ? { tone: 'success', text: fromBackup ? words.t.backup.restored(rules) : t.imported(rules) }
      : {
          tone: 'danger',
          text: (result.code === 'import-expired' ? t.importFailed : t.replaceFailed)(errorText(result.code, words)),
        },
  }));
}

/** "Bekor qilish" / Escape of a preview: forgets it; nothing is sent. */
export function cancelPreview(update: TransferUiUpdate): void {
  update((state) => (state.preview === null || state.phase === 'applying' ? state : { ...state, preview: null, focusImport: true }));
}

/**
 * "Ko'rib chiqish" of the backup offer / "Zaxiradan tiklash": the main process
 * reads the app's rules backup and hands it over like an imported file — the
 * same preview, the same one-use token, the same "Almashtirish"
 * (`confirmImport`). Nothing reaches the helper here. Ignored while busy.
 */
export async function startRestore(
  rs: Pick<RsApi, 'restoreBackup'>,
  savedAt: string,
  update: TransferUiUpdate,
  current: () => TransferUiState,
  i18n: () => I18n = () => UZ,
): Promise<void> {
  if (current().phase !== 'idle') return;
  update((state) => ({ ...state, phase: 'importing', preview: null, feedback: null }));
  const result = await rs.restoreBackup();
  const words = i18n();
  update((state) =>
    result.ok
      ? { ...state, phase: 'idle', preview: { token: result.value.token, config: result.value.config, source: { kind: 'backup', savedAt } } }
      : {
          ...state,
          phase: 'idle',
          feedback: {
            tone: 'danger',
            text: words.t.backup.restoreFailed(result.code === 'invalid-config' ? configIssueText(result.issue, words) : errorText(result.code, words)),
          },
        },
  );
}

/** The question of the confirmation for `preview`: a restore says which backup first. */
export function previewQuestion(preview: ImportPreview, current: Config | null, now: number, i18n: I18n = UZ): string {
  const question = importQuestion(importSummary(current, preview.config), i18n);
  return preview.source?.kind === 'backup' ? `${i18n.t.backup.previewFrom(i18n.formatTime(preview.source.savedAt, now))} ${question}` : question;
}

// ---------------------------------------------------------------------------
// The screen's wiring (what `RulesScreen` passes to `RulesPanel`)
// ---------------------------------------------------------------------------

/**
 * The panel's import / export props for the two controllers. One question at
 * a time: asking about a removal closes the import confirmation, and
 * "Import" closes the removal question; neither moves the focus (the new
 * question takes it).
 */
export function transferPanelProps(
  rules: Pick<RulesController, 'askDelete' | 'dismissDelete'>,
  transfer: TransferController,
  state: TransferUiState,
  importRef: Ref<HTMLButtonElement>,
) {
  return {
    transfer: state,
    importRef,
    onAskDelete: (id: string) => {
      transfer.dismiss();
      rules.askDelete(id);
    },
    onImport: () => {
      rules.dismissDelete();
      void transfer.startImport();
    },
    onExport: () => {
      void transfer.startExport();
    },
    onConfirmImport: (token: string) => {
      void transfer.confirmImport(token);
    },
    onCancelImport: () => {
      transfer.cancelImport();
    },
  };
}

/**
 * After the confirmation closed (`focusImport`), moves the focus back to the
 * "Import" button and forgets the request. False when nothing was asked or
 * the button is not on the page.
 */
export function returnImportFocus(state: Pick<TransferUiState, 'focusImport'>, button: { focus: () => void } | null, transfer: Pick<TransferController, 'focusDone'>): boolean {
  if (!state.focusImport) return false;
  transfer.focusDone();
  if (button === null) return false;
  button.focus();
  return true;
}

// ---------------------------------------------------------------------------
// What the replacement changes
// ---------------------------------------------------------------------------

export interface ImportSummary {
  readonly rules: number;
  /** Rules stored now; null when the config is not read. */
  readonly current: number | null;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly unchanged: number;
  /** The global switch flips. */
  readonly enabledChange: 'on' | 'off' | null;
  readonly overridesChanged: boolean;
}

type ConfigRule = Config['rules'][number];
const ruleKey = (rule: ConfigRule): string =>
  JSON.stringify([rule.kind, rule.target, rule.iface, rule.enabled, rule.dns ?? null, rule.refreshSec, rule.note ?? null]);
const overridesKey = (config: Config): string => JSON.stringify([config.ifaceOverrides?.ethernet ?? null, config.ifaceOverrides?.wifi ?? null]);

/** Rules matched by id (ids are kept by edits, `TASK-213`): added, removed, changed, the same. */
export function importSummary(current: Config | null, next: Config): ImportSummary {
  if (current === null) {
    return { rules: next.rules.length, current: null, added: next.rules.length, removed: 0, changed: 0, unchanged: 0, enabledChange: null, overridesChanged: false };
  }
  const now = new Map(current.rules.map((rule) => [rule.id.toLowerCase(), rule]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const rule of next.rules) {
    const stored = now.get(rule.id.toLowerCase());
    if (stored === undefined) added += 1;
    else if (ruleKey(stored) === ruleKey(rule)) unchanged += 1;
    else changed += 1;
  }
  const kept = new Set(next.rules.map((rule) => rule.id.toLowerCase()));
  const removed = current.rules.filter((rule) => !kept.has(rule.id.toLowerCase())).length;
  return {
    rules: next.rules.length,
    current: current.rules.length,
    added,
    removed,
    changed,
    unchanged,
    enabledChange: current.enabled === next.enabled ? null : next.enabled ? 'on' : 'off',
    overridesChanged: overridesKey(current) !== overridesKey(next),
  };
}

/** The question of the confirmation. */
export function importQuestion(summary: ImportSummary, i18n: I18n = UZ): string {
  const t = i18n.t.rules;
  const parts = [
    t.importReplaces(summary.rules, summary.current),
    summary.current === null ? '' : t.importCounts(summary.added, summary.removed, summary.changed, summary.unchanged),
    summary.enabledChange === 'off' ? t.importRoutingOff : summary.enabledChange === 'on' ? t.importRoutingOn : '',
    summary.overridesChanged ? t.importOverrides : '',
  ];
  return parts.filter((part) => part !== '').join(' ');
}
