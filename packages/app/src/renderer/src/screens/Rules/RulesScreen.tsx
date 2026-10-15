// "Qoidalar" — the main screen of the rules window: search, filter, the rules
// table (switch, address, kind, interface, note, actions) and the status
// footer. Design: route-switch-docs/RouteSwitch UI.html, "Qoidalar oynasi".
// The table joins the stored config with the engine state by rule id; a
// switch shows what the config holds, never the click (it changes once the
// helper has stored it and the new revision has been read).

import { PATHS } from '@routeswitch/shared';
import { useEffect, useMemo, useRef, useState, type ReactElement, type Ref } from 'react';

import {
  Banner,
  Button,
  EditIcon,
  IfaceTag,
  PlusIcon,
  SearchIcon,
  StatusBadge,
  StatusDot,
  Toggle,
  TrashIcon,
} from '../../components';
import type { I18n } from '../../../../i18n';
import { configStoreFor, useConfig, type ConfigView } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import { useNow } from '../../hooks/useNow';
import type { RsApi } from '../../rs';
import { errorText, helperNotice, networkWarnings, UZ, type Feedback } from '../../text';
import { dnsWarningViews, type DnsWarningView, type RuleForm } from '../AddRule/model';
import { statusLine } from '../MenuBar';
import type { RulesApi } from './actions';
import { createRulesController, focusTrashButton, INITIAL_RULES_UI, rulesHandlers, type RulesUiState } from './controller';
import {
  activeCount,
  notesById,
  overlapWarnings,
  ROW_FILTERS,
  ruleRows,
  visibleRows,
  type RowFilter,
  type RuleRow,
} from './model';
import {
  backupKey,
  backupOffer,
  createRecoveryController,
  dismissBackupOffer,
  focusResetButton,
  INITIAL_RECOVERY_UI,
  recoveryHandlers,
  useBackup,
  type BackupApi,
  type RecoveryApi,
  type RecoveryUiState,
} from './recovery';
import styles from './RulesScreen.module.css';
import {
  createTransferController,
  INITIAL_TRANSFER_UI,
  previewQuestion,
  returnImportFocus,
  startRestore,
  transferPanelProps,
  type TransferApi,
  type TransferUiState,
} from './transfer';

/** Why "Qoida qo'shish" and "Export" are off while the helper cannot load its stored config (TASK-300). Uzbek; the panel uses its language's. */
export const CONFIG_UNREADABLE_REASON = UZ.t.rules.configUnreadableReason;

/** Why "Qoida qo'shish" / "Tahrirlash" are off until the add-rule form exists. Uzbek; the panel uses its language's. */
export const ADD_RULE_UNAVAILABLE = UZ.t.rules.addRuleUnavailable;

export interface RulesPanelProps {
  readonly engine: EngineStateView;
  readonly config: ConfigView;
  /** Milliseconds since the epoch, for the footer's clock. */
  readonly now: number;
  readonly query: string;
  readonly filter: RowFilter;
  /** Rules whose switch or removal is on its way to the helper. */
  readonly busy: ReadonlySet<string>;
  /** The rule waiting for "O'chirish" to be confirmed. */
  readonly confirmingDelete: string | null;
  readonly feedback: Feedback | null;
  readonly onQueryChange: (query: string) => void;
  readonly onFilterChange: (filter: RowFilter) => void;
  readonly onToggleRule: (id: string, enabled: boolean) => void;
  readonly onAskDelete: (id: string) => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: (id: string) => void;
  readonly onReloadConfig: () => void;
  /**
   * Opens the add-rule form; absent until that form exists (the button is then disabled, with the reason).
   * With `prefill`, the form opens filled in (a DNS warning's offer, TASK-DELTA-21); it is not saved.
   */
  readonly onAddRule?: ((prefill?: RuleForm) => void) | undefined;
  /** Opens a rule in the add-rule form; absent like `onAddRule`. */
  readonly onEditRule?: ((id: string) => void) | undefined;
  /** The ref for a rule's trash button, so the focus can return to it after a cancelled removal. */
  readonly trashRef?: ((id: string) => Ref<HTMLButtonElement>) | undefined;
  /** Config import / export (TASK-215). */
  readonly transfer: TransferUiState;
  readonly onImport: () => void;
  readonly onExport: () => void;
  readonly onConfirmImport: (token: string) => void;
  readonly onCancelImport: () => void;
  /** The "Import" button, so the focus can return to it after the confirmation closes. */
  readonly importRef?: Ref<HTMLButtonElement> | undefined;
  /** The way out of an unreadable stored config: "Bo'sh config bilan boshlash" and its question. */
  readonly recovery: RecoveryUiState;
  readonly onAskReset: () => void;
  readonly onCancelReset: () => void;
  readonly onConfirmReset: () => void;
  /** The "Bo'sh config bilan boshlash" button, so the focus can return to it after a cancelled question. */
  readonly resetRef?: Ref<HTMLButtonElement> | undefined;
  /** The rules backup's restore offer (TASK-DELTA-16): shown while the helper holds no rules and the backup has some. */
  readonly backupOffer?: { readonly count: number; readonly savedAt: string } | null | undefined;
  /** "Ko'rib chiqish": the backup into the import preview. */
  readonly onReviewBackup?: (() => void) | undefined;
  /** "Kerak emas": this backup is not offered again. */
  readonly onDismissBackup?: (() => void) | undefined;
  /** A failed dismissal. */
  readonly backupFeedback?: Feedback | null | undefined;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n | undefined;
}

const columns = (i18n: I18n): readonly string[] => {
  const words = i18n.t.rules.columns;
  return [words.status, words.target, words.kind, words.iface, words.note, ''];
};

function ReasonLine({ row, i18n }: { readonly row: RuleRow; readonly i18n: I18n }): ReactElement | null {
  const status = row.status;
  if (status.kind === 'ok' || status.kind === 'none') return null;
  return (
    <>
      <span className={styles['reason']} data-tone={status.kind}>
        {status.kind === 'warning' ? <StatusDot tone="warning" size="sm" label={i18n.t.rules.warningMark} /> : null}
        {status.text}
      </span>
      {row.lastKnown === null ? null : <span className={styles['lastKnown']}>{row.lastKnown}</span>}
    </>
  );
}

/**
 * The helper runs but cannot load its stored config: what happened, and the
 * two ways out — the toolbar's "Import" (here too), or an empty config after
 * a confirmation.
 */
function ConfigRecovery(props: RulesPanelProps & { readonly i18n: I18n }): ReactElement {
  const { recovery } = props;
  const t = props.i18n.t.rules;
  return (
    <>
      <div className={styles['recoveryActions']}>
        <Button variant="primary" busy={props.transfer.phase !== 'idle'} onClick={props.onImport}>
          {t.importConfig}
        </Button>
        <Button ref={props.resetRef} busy={recovery.busy || recovery.confirming} onClick={props.onAskReset}>
          {t.startEmpty}
        </Button>
      </div>
      {recovery.confirming ? (
        <div
          className={styles['confirm']}
          role="alertdialog"
          aria-labelledby="rules-reset-question"
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onCancelReset();
          }}
        >
          <p id="rules-reset-question" className={styles['confirmText']}>
            {t.resetQuestion(PATHS.config)}
          </p>
          <Button variant="primary" busy={recovery.busy} onClick={props.onConfirmReset}>
            {t.replace}
          </Button>
          {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
          <Button autoFocus busy={recovery.busy} onClick={props.onCancelReset}>
            {t.cancel}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Row({
  row,
  busy,
  onToggleRule,
  onAskDelete,
  onEditRule,
  trashRef,
  i18n,
}: { readonly row: RuleRow; readonly busy: boolean; readonly i18n: I18n } & Pick<
  RulesPanelProps,
  'onToggleRule' | 'onAskDelete' | 'onEditRule' | 'trashRef'
>): ReactElement {
  const status = row.status;
  const t = i18n.t.rules;
  return (
    <div className={styles['row']} role="row" data-enabled={row.enabled} data-status={status.kind}>
      <span role="cell" className={styles['cell']}>
        <Toggle
          size="sm"
          checked={row.enabled}
          label={t.toggleLabel(row.target)}
          busy={busy}
          onChange={(next) => {
            onToggleRule(row.id, next);
          }}
        />
      </span>
      <span role="cell" className={styles['addressCell']}>
        <span className={styles['addressLine']}>
          <span className={styles['target']} title={row.target}>
            {row.target}
          </span>
          {/* The reason is read once, from the line below; the tag carries only the status. */}
          {status.kind === 'warning' ? <StatusBadge status="active" i18n={i18n} /> : null}
          {status.kind === 'pending' || status.kind === 'error' ? <StatusBadge status={status.kind} i18n={i18n} /> : null}
        </span>
        <ReasonLine row={row} i18n={i18n} />
      </span>
      <span role="cell" className={styles['kind']}>
        {row.kindLabel}
      </span>
      <span role="cell" className={styles['iface']}>
        <IfaceTag role={row.iface} />
        <span className={styles['device']}>{row.device ?? '—'}</span>
      </span>
      <span role="cell" className={styles['note']} title={row.detail}>
        {row.detail}
      </span>
      <span role="cell" className={styles['actions']}>
        <span title={onEditRule === undefined ? t.addRuleUnavailable : undefined}>
          <Button
            variant="ghost"
            size="icon"
            label={onEditRule === undefined ? t.editOff(t.addRuleUnavailable) : t.editLabel(row.target)}
            disabled={onEditRule === undefined}
            onClick={() => {
              onEditRule?.(row.id);
            }}
          >
            <EditIcon size={14} />
          </Button>
        </span>
        <Button
          variant="ghost"
          size="icon"
          label={t.deleteLabel(row.target)}
          busy={busy}
          ref={trashRef?.(row.id)}
          onClick={() => {
            onAskDelete(row.id);
          }}
        >
          <TrashIcon size={14} />
        </Button>
      </span>
    </div>
  );
}

function TableBody(
  props: RulesPanelProps & { readonly rows: readonly RuleRow[]; readonly visible: readonly RuleRow[]; readonly i18n: I18n },
): ReactElement {
  const { rows, visible, i18n } = props;
  const t = i18n.t.rules;
  if (rows.length === 0) {
    return (
      <div className={styles['empty']} role="status">
        <p className={styles['emptyTitle']}>{t.emptyTitle}</p>
        <p>{t.emptyText}</p>
      </div>
    );
  }
  if (visible.length === 0) {
    const query = props.query.trim();
    return (
      <div className={styles['empty']} role="status">
        <p className={styles['emptyTitle']}>{t.noMatchTitle}</p>
        <p>{t.noMatchText(query === '' ? null : query, props.filter === 'all' ? null : t.filters[props.filter])}</p>
      </div>
    );
  }
  return (
    <div role="rowgroup">
      {visible.map((row) => (
        <Row
          key={row.id}
          row={row}
          busy={props.busy.has(row.id)}
          onToggleRule={props.onToggleRule}
          onAskDelete={props.onAskDelete}
          onEditRule={props.onEditRule}
          trashRef={props.trashRef}
          i18n={i18n}
        />
      ))}
    </div>
  );
}

/**
 * A DNS server reached through the wrong interface (TASK-DELTA-21), with its
 * offer: the button opens the add-rule form filled in (nothing is saved), or,
 * when no rule can be offered, the reason in its place. While the form cannot
 * open (`addRuleOff`) the button says why, like "Qoida qo'shish".
 */
export function DnsWarningBanner({
  warning,
  addRuleOff,
  onOffer,
  busy = false,
  i18n,
  size = 'md',
}: {
  readonly warning: DnsWarningView;
  /** Why the form cannot open now; null when it can. */
  readonly addRuleOff: string | null;
  /** The offer's button: the form it fills in, and the warning (the menu bar passes its server and role on). */
  readonly onOffer: ((form: RuleForm, warning: DnsWarningView) => void) | undefined;
  readonly busy?: boolean;
  readonly i18n: I18n;
  readonly size?: 'md' | 'compact';
}): ReactElement {
  const offer = warning.offer;
  return (
    <Banner tone="warning" size={size} title={warning.title} text={warning.text}>
      {offer.kind === 'blocked' ? (
        <p className={styles['dnsBlocked']}>{offer.text}</p>
      ) : addRuleOff !== null ? (
        <p className={styles['dnsBlocked']}>{i18n.t.dnsWarnings.blockedUnavailable(addRuleOff)}</p>
      ) : (
        <Button
          variant="primary"
          busy={busy}
          onClick={() => {
            onOffer?.(offer.form, warning);
          }}
        >
          {offer.label}
        </Button>
      )}
    </Banner>
  );
}

/** The screen for given data; `RulesScreen` supplies the live data and the actions. */
export function RulesPanel(props: RulesPanelProps): ReactElement {
  const { engine, config } = props;
  const i18n = props.i18n ?? UZ;
  const t = i18n.t.rules;
  const state = engine.helper === 'connected' ? engine.state : null;
  const loaded = state !== null && config.config !== null ? { state, config: config.config } : null;
  const rows = loaded === null ? [] : ruleRows(loaded.config, loaded.state, props.now, i18n);
  const warnings = state === null ? [] : networkWarnings(state, config.config, i18n);
  const dnsWarnings = state === null ? [] : dnsWarningViews(state, config.config, i18n);
  const visible = loaded === null ? [] : visibleRows(rows, notesById(loaded.config), props.query, props.filter);
  const overlaps = loaded === null ? [] : overlapWarnings(loaded.config);
  const confirming = rows.find((row) => row.id === props.confirmingDelete) ?? null;
  const importing = props.transfer.preview;
  const offer = props.backupOffer ?? null;
  const notice = state === null ? helperNotice(engine, i18n) : null;
  const configBroken = engine.helper === 'config-unreadable';
  const addRuleOff = props.onAddRule === undefined ? t.addRuleUnavailable : configBroken ? t.configUnreadableReason : null;
  const line = loaded === null ? null : statusLine(loaded.state, props.now, i18n);

  return (
    <section className={styles['screen']} aria-labelledby="rules-title">
      <header className={styles['header']}>
        <div>
          <h1 id="rules-title" className={styles['title']}>
            {t.title}
          </h1>
          <p className={styles['subtitle']}>{t.subtitle}</p>
        </div>
        <span className={styles['addRule']} title={addRuleOff ?? undefined}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              props.onAddRule?.();
            }}
            disabled={addRuleOff !== null}
            label={addRuleOff === null ? undefined : t.addRuleOff(addRuleOff)}
          >
            <PlusIcon size={14} />
            {t.addRule}
          </Button>
        </span>
      </header>

      <div className={styles['toolbar']}>
        <label className={styles['search']}>
          <SearchIcon size={14} className={styles['searchIcon']} />
          <span className={styles['visuallyHidden']}>{t.search}</span>
          <input
            type="search"
            className={styles['searchInput']}
            placeholder={t.searchPlaceholder}
            value={props.query}
            onChange={(event) => {
              props.onQueryChange(event.target.value);
            }}
          />
        </label>
        <label className={styles['filter']}>
          <span className={styles['visuallyHidden']}>{t.filterLabel}</span>
          <select
            className={styles['filterSelect']}
            value={props.filter}
            onChange={(event) => {
              props.onFilterChange(event.target.value as RowFilter);
            }}
          >
            {ROW_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {t.filters[filter]}
              </option>
            ))}
          </select>
        </label>
        {/* The design's single "Import / Export" button, as two: each opens its own system file dialog. */}
        <Button
          ref={props.importRef}
          busy={props.transfer.phase !== 'idle'}
          label={t.importLabel}
          onClick={props.onImport}
        >
          {t.import}
        </Button>
        {/* Nothing to export while the stored config cannot be read; the reason is in the name (a disabled button is not focusable). */}
        <span title={configBroken ? t.configUnreadableReason : undefined}>
          <Button
            busy={props.transfer.phase !== 'idle'}
            disabled={configBroken}
            label={configBroken ? t.exportOff(t.configUnreadableReason) : t.exportLabel}
            onClick={props.onExport}
          >
            {t.export}
          </Button>
        </span>
      </div>

      {props.feedback === null ? null : (
        <p className={styles['feedback']} data-tone={props.feedback.tone} role="alert">
          {props.feedback.text}
        </p>
      )}

      {props.recovery.feedback === null ? null : (
        <p className={styles['feedback']} data-tone={props.recovery.feedback.tone} role={props.recovery.feedback.tone === 'danger' ? 'alert' : 'status'}>
          {props.recovery.feedback.text}
        </p>
      )}

      {props.transfer.feedback === null ? null : (
        <p className={styles['feedback']} data-tone={props.transfer.feedback.tone} role={props.transfer.feedback.tone === 'danger' ? 'alert' : 'status'}>
          {props.transfer.feedback.text}
        </p>
      )}

      {importing === null ? null : (
        // Keyed by file: another import opens a new question, which takes the focus again.
        <div
          key={importing.token}
          className={styles['confirm']}
          role="alertdialog"
          aria-labelledby="rules-import-question"
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onCancelImport();
          }}
        >
          <p id="rules-import-question" className={styles['confirmText']}>
            {previewQuestion(importing, config.config, props.now, i18n)}
          </p>
          <Button
            variant="primary"
            busy={props.transfer.phase === 'applying'}
            onClick={() => {
              props.onConfirmImport(importing.token);
            }}
          >
            {t.replace}
          </Button>
          {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
          <Button autoFocus onClick={props.onCancelImport}>
            {t.cancel}
          </Button>
        </div>
      )}

      {props.backupFeedback === null || props.backupFeedback === undefined ? null : (
        <p className={styles['feedback']} data-tone={props.backupFeedback.tone} role="alert">
          {props.backupFeedback.text}
        </p>
      )}

      {offer === null || importing !== null ? null : (
        <div className={styles['warnings']}>
          <Banner tone="warning" title={i18n.t.backup.offerTitle(offer.count)} text={i18n.t.backup.offerText(i18n.formatTime(offer.savedAt, props.now))}>
            <Button
              variant="primary"
              busy={props.transfer.phase !== 'idle'}
              onClick={() => {
                props.onReviewBackup?.();
              }}
            >
              {i18n.t.backup.review}
            </Button>
            <Button
              onClick={() => {
                props.onDismissBackup?.();
              }}
            >
              {i18n.t.backup.dismiss}
            </Button>
          </Banner>
        </div>
      )}

      {confirming === null || importing !== null ? null : (
        // Keyed by rule: asking about another rule opens a new dialog, which takes the focus again.
        <div
          key={confirming.id}
          className={styles['confirm']}
          role="alertdialog"
          aria-labelledby="rules-delete-question"
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onCancelDelete();
          }}
        >
          <p id="rules-delete-question" className={styles['confirmText']}>
            {t.deleteQuestion(confirming.target)}
          </p>
          <Button
            variant="primary"
            busy={props.busy.has(confirming.id)}
            onClick={() => {
              props.onConfirmDelete(confirming.id);
            }}
          >
            {t.remove}
          </Button>
          {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
          <Button autoFocus onClick={props.onCancelDelete}>
            {t.cancel}
          </Button>
        </div>
      )}

      {warnings.length === 0 && dnsWarnings.length === 0 ? null : (
        <div className={styles['warnings']}>
          {warnings.map((warning) => (
            <Banner key={warning.id} tone="warning" title={warning.title} text={warning.text} />
          ))}
          {dnsWarnings.map((warning) => (
            <DnsWarningBanner
              key={warning.id}
              warning={warning}
              addRuleOff={addRuleOff}
              onOffer={(form) => {
                props.onAddRule?.(form);
              }}
              i18n={i18n}
            />
          ))}
        </div>
      )}

      {overlaps.length === 0 ? null : (
        <div className={styles['overlaps']} role="note" aria-label={t.overlapsLabel}>
          <p className={styles['overlapsTitle']}>{t.overlapsTitle}</p>
          <ul className={styles['overlapList']}>
            {overlaps.slice(0, 3).map((overlap) => (
              <li key={`${overlap.wider}|${overlap.narrower}`}>
                {t.overlapInside(overlap.narrower, overlap.wider)}
                {overlap.crossInterface ? t.overlapOtherIface : ''}
              </li>
            ))}
            {overlaps.length > 3 ? <li>{t.overlapMore(overlaps.length - 3)}</li> : null}
          </ul>
        </div>
      )}

      {loaded === null ? (
        <div className={styles['notice']} role={notice?.tone === 'danger' || config.phase === 'failed' ? 'alert' : 'status'}>
          {notice !== null ? (
            <>
              <p className={styles['emptyTitle']}>{notice.title}</p>
              {notice.text === '' ? null : <p>{notice.text}</p>}
              {notice.recovery === 'repair-config' ? <ConfigRecovery {...props} i18n={i18n} /> : null}
            </>
          ) : config.phase === 'failed' ? (
            <>
              <p className={styles['emptyTitle']}>{t.readFailedTitle}</p>
              <p>{config.error === null ? '' : errorText(config.error.code, i18n)}</p>
              <Button variant="ghost" onClick={props.onReloadConfig}>
                {t.reload}
              </Button>
            </>
          ) : (
            <p>{t.reading}</p>
          )}
        </div>
      ) : (
        <div className={styles['table']} role="table" aria-label={t.title} aria-rowcount={visible.length + 1}>
          <div role="rowgroup" className={styles['head']}>
            <div className={styles['headRow']} role="row">
              {columns(i18n).map((column, index) => (
                <span key={index} role="columnheader">
                  {column}
                </span>
              ))}
            </div>
          </div>
          <TableBody {...props} rows={rows} visible={visible} i18n={i18n} />
        </div>
      )}

      <div className={styles['spacer']} />

      <footer className={styles['footer']}>
        {loaded === null || line === null ? (
          <span />
        ) : (
          <>
            <span className={styles['footerMono']}>{line.text}</span>
            <span role="status">
              {loaded.state.enabled ? t.activeRules(activeCount(loaded.state)) : t.routingOff}
              {line.errors === null ? null : <span className={styles['errors']}> · {line.errors}</span>}
            </span>
          </>
        )}
      </footer>
    </section>
  );
}

export interface RulesScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: RulesApi & TransferApi & RecoveryApi & BackupApi & Pick<RsApi, 'getState' | 'onState' | 'getConfig' | 'restoreBackup' | 'dismissBackup'>;
  /** Opens the add-rule form (TASK-213), filled in by a DNS warning's offer when `prefill` is given (TASK-DELTA-21). */
  readonly onAddRule?: (prefill?: RuleForm) => void;
  readonly onEditRule?: (id: string) => void;
}

/** The rules screen of the rules window. */
export function RulesScreen({ rs: given, onAddRule, onEditRule }: RulesScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const i18n = useI18n();
  // The controllers write their messages in the language of the moment the outcome arrives.
  const language = useRef(i18n);
  language.current = i18n;
  const engine = useEngineState(rs);
  const config = useConfig(rs);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [ui, setUi] = useState<RulesUiState>(INITIAL_RULES_UI);
  // The controller reads the latest state through this ref (a click may land before React re-renders).
  const latest = useRef(ui);
  latest.current = ui;
  const controller = useMemo(
    () =>
      createRulesController(
        rs,
        (change) => {
          latest.current = change(latest.current);
          setUi(latest.current);
        },
        () => latest.current,
        () => language.current,
      ),
    [rs],
  );

  // The trash buttons on the page, by rule; the focus returns to one after a cancelled removal.
  const trashButtons = useRef(new Map<string, HTMLButtonElement>());
  const trashRef = useMemo(() => {
    const refs = new Map<string, (element: HTMLButtonElement | null) => void>();
    return (id: string) => {
      let ref = refs.get(id);
      if (ref === undefined) {
        ref = (element) => {
          if (element === null) trashButtons.current.delete(id);
          else trashButtons.current.set(id, element);
        };
        refs.set(id, ref);
      }
      return ref;
    };
  }, []);
  useEffect(() => {
    if (ui.focusTrash === null) return;
    focusTrashButton(trashButtons.current, ui.focusTrash);
    controller.focusDone();
  }, [ui.focusTrash, controller]);

  const [transfer, setTransfer] = useState<TransferUiState>(INITIAL_TRANSFER_UI);
  const latestTransfer = useRef(transfer);
  latestTransfer.current = transfer;
  const transferController = useMemo(
    () =>
      createTransferController(
        rs,
        (change) => {
          latestTransfer.current = change(latestTransfer.current);
          setTransfer(latestTransfer.current);
        },
        () => latestTransfer.current,
        () => language.current,
      ),
    [rs],
  );
  const importButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    returnImportFocus(transfer, importButton.current, transferController);
  }, [transfer, transferController]);
  const handlers = rulesHandlers(controller);

  const [recovery, setRecovery] = useState<RecoveryUiState>(INITIAL_RECOVERY_UI);
  const latestRecovery = useRef(recovery);
  latestRecovery.current = recovery;
  const recoveryController = useMemo(
    () =>
      createRecoveryController(
        rs,
        (change) => {
          latestRecovery.current = change(latestRecovery.current);
          setRecovery(latestRecovery.current);
        },
        () => latestRecovery.current,
        () => language.current,
      ),
    [rs],
  );
  const resetButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recovery.focusReset) return;
    focusResetButton(resetButton.current);
    recoveryController.focusDone();
  }, [recovery.focusReset, recoveryController]);

  // The rules backup (TASK-DELTA-16): read on every connection and config revision, and when the window is shown.
  const backup = useBackup(rs, backupKey(engine));
  const offer = backupOffer(engine, config.config, backup.view);
  const [backupFeedback, setBackupFeedback] = useState<Feedback | null>(null);

  return (
    <RulesPanel
      engine={engine}
      backupOffer={offer}
      backupFeedback={backupFeedback}
      onReviewBackup={() => {
        if (offer === null) return;
        controller.dismissDelete();
        setBackupFeedback(null);
        void startRestore(
          rs,
          offer.savedAt,
          (change) => {
            latestTransfer.current = change(latestTransfer.current);
            setTransfer(latestTransfer.current);
          },
          () => latestTransfer.current,
          () => language.current,
        );
      }}
      onDismissBackup={() => {
        setBackupFeedback(null);
        void dismissBackupOffer(rs, language.current).then((line) => {
          setBackupFeedback(line);
          backup.reload();
        });
      }}
      config={config}
      now={now}
      query={query}
      filter={filter}
      busy={ui.busy}
      confirmingDelete={ui.confirmingDelete}
      feedback={ui.feedback}
      onQueryChange={setQuery}
      onFilterChange={setFilter}
      {...handlers}
      {...transferPanelProps(controller, transferController, transfer, importButton)}
      onReloadConfig={() => {
        configStoreFor(rs).reload();
      }}
      onAddRule={onAddRule}
      onEditRule={onEditRule}
      trashRef={trashRef}
      recovery={recovery}
      {...recoveryHandlers(recoveryController)}
      resetRef={resetButton}
      i18n={i18n}
    />
  );
}
