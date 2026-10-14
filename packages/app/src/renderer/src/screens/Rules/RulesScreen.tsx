// "Qoidalar" — the main screen of the rules window: search, filter, the rules
// table (switch, address, kind, interface, note, actions) and the status
// footer. Design: route-switch-docs/RouteSwitch UI.html, "Qoidalar oynasi".
// The table joins the stored config with the engine state by rule id; a
// switch shows what the config holds, never the click (it changes once the
// helper has stored it and the new revision has been read).

import { useEffect, useMemo, useRef, useState, type ReactElement, type Ref } from 'react';

import {
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
import { configStoreFor, useConfig, type ConfigView } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useNow } from '../../hooks/useNow';
import type { RsApi } from '../../rs';
import { errorText, type Feedback } from '../../text';
import { helperNotice, statusLine } from '../MenuBar';
import type { RulesApi } from './actions';
import { createRulesController, focusTrashButton, INITIAL_RULES_UI, rulesHandlers, type RulesUiState } from './controller';
import {
  activeCount,
  notesById,
  overlapWarnings,
  ROW_FILTER_LABELS,
  ruleRows,
  visibleRows,
  type RowFilter,
  type RuleRow,
} from './model';
import styles from './RulesScreen.module.css';
import {
  createTransferController,
  importQuestion,
  importSummary,
  INITIAL_TRANSFER_UI,
  returnImportFocus,
  transferPanelProps,
  type TransferApi,
  type TransferUiState,
} from './transfer';

/** Why "Qoida qo'shish" / "Tahrirlash" are off until the add-rule form exists. */
export const ADD_RULE_UNAVAILABLE = "Qoida qo'shish oynasi hali tayyor emas";

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
  /** Opens the add-rule form; absent until that form exists (the button is then disabled, with the reason). */
  readonly onAddRule?: (() => void) | undefined;
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
}

const COLUMNS = ['Holat', 'Manzil', 'Turi', 'Interfeys', 'Izoh', ''] as const;

function ReasonLine({ row }: { readonly row: RuleRow }): ReactElement | null {
  const status = row.status;
  if (status.kind === 'ok' || status.kind === 'none') return null;
  return (
    <span className={styles['reason']} data-tone={status.kind}>
      {status.kind === 'warning' ? <StatusDot tone="warning" size="sm" label="Ogohlantirish" /> : null}
      {status.text}
    </span>
  );
}

function Row({
  row,
  busy,
  onToggleRule,
  onAskDelete,
  onEditRule,
  trashRef,
}: { readonly row: RuleRow; readonly busy: boolean } & Pick<RulesPanelProps, 'onToggleRule' | 'onAskDelete' | 'onEditRule' | 'trashRef'>): ReactElement {
  const status = row.status;
  return (
    <div className={styles['row']} role="row" data-enabled={row.enabled} data-status={status.kind}>
      <span role="cell" className={styles['cell']}>
        <Toggle
          size="sm"
          checked={row.enabled}
          label={`${row.target} qoidasi`}
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
          {status.kind === 'warning' ? <StatusBadge status="active" /> : null}
          {status.kind === 'pending' || status.kind === 'error' ? <StatusBadge status={status.kind} /> : null}
        </span>
        <ReasonLine row={row} />
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
        <span title={onEditRule === undefined ? ADD_RULE_UNAVAILABLE : undefined}>
          <Button
            variant="ghost"
            size="icon"
            label={onEditRule === undefined ? `Tahrirlash — ${ADD_RULE_UNAVAILABLE}` : `${row.target} qoidasini tahrirlash`}
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
          label={`${row.target} qoidasini o'chirish`}
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

function TableBody(props: RulesPanelProps & { readonly rows: readonly RuleRow[]; readonly visible: readonly RuleRow[] }): ReactElement {
  const { rows, visible } = props;
  if (rows.length === 0) {
    return (
      <div className={styles['empty']} role="status">
        <p className={styles['emptyTitle']}>Hali qoida yo'q</p>
        <p>Qoida qo'shilgach, manzil shu yerda ko'rinadi va tanlangan interfeys orqali yo'naltiriladi.</p>
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div className={styles['empty']} role="status">
        <p className={styles['emptyTitle']}>Hech narsa topilmadi</p>
        <p>
          {props.query.trim() === '' ? '' : `«${props.query.trim()}» bo'yicha `}
          {props.filter === 'all' ? '' : `«${ROW_FILTER_LABELS[props.filter]}» orasida `}
          mos qoida yo'q.
        </p>
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
        />
      ))}
    </div>
  );
}

/** The screen for given data; `RulesScreen` supplies the live data and the actions. */
export function RulesPanel(props: RulesPanelProps): ReactElement {
  const { engine, config } = props;
  const state = engine.helper === 'connected' ? engine.state : null;
  const loaded = state !== null && config.config !== null ? { state, config: config.config } : null;
  const rows = loaded === null ? [] : ruleRows(loaded.config, loaded.state);
  const visible = loaded === null ? [] : visibleRows(rows, notesById(loaded.config), props.query, props.filter);
  const overlaps = loaded === null ? [] : overlapWarnings(loaded.config);
  const confirming = rows.find((row) => row.id === props.confirmingDelete) ?? null;
  const importing = props.transfer.preview;
  const notice = state === null ? helperNotice(engine) : null;
  const line = loaded === null ? null : statusLine(loaded.state, props.now);

  return (
    <section className={styles['screen']} aria-labelledby="rules-title">
      <header className={styles['header']}>
        <div>
          <h1 id="rules-title" className={styles['title']}>
            Qoidalar
          </h1>
          <p className={styles['subtitle']}>
            Qaysi manzil qaysi interfeys orqali borishini belgilang. Qolgan trafik default kanal orqali ketadi.
          </p>
        </div>
        <span className={styles['addRule']} title={props.onAddRule === undefined ? ADD_RULE_UNAVAILABLE : undefined}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              props.onAddRule?.();
            }}
            disabled={props.onAddRule === undefined}
            label={props.onAddRule === undefined ? `Qoida qo'shish — ${ADD_RULE_UNAVAILABLE}` : undefined}
          >
            <PlusIcon size={14} />
            Qoida qo'shish
          </Button>
        </span>
      </header>

      <div className={styles['toolbar']}>
        <label className={styles['search']}>
          <SearchIcon size={14} className={styles['searchIcon']} />
          <span className={styles['visuallyHidden']}>Qidirish</span>
          <input
            type="search"
            className={styles['searchInput']}
            placeholder="IP, subnet, domen yoki izoh bo'yicha qidirish"
            value={props.query}
            onChange={(event) => {
              props.onQueryChange(event.target.value);
            }}
          />
        </label>
        <label className={styles['filter']}>
          <span className={styles['visuallyHidden']}>Ko'rsatish</span>
          <select
            className={styles['filterSelect']}
            value={props.filter}
            onChange={(event) => {
              props.onFilterChange(event.target.value as RowFilter);
            }}
          >
            {(Object.keys(ROW_FILTER_LABELS) as RowFilter[]).map((filter) => (
              <option key={filter} value={filter}>
                {ROW_FILTER_LABELS[filter]}
              </option>
            ))}
          </select>
        </label>
        {/* The design's single "Import / Export" button, as two: each opens its own system file dialog. */}
        <Button
          ref={props.importRef}
          busy={props.transfer.phase !== 'idle'}
          label="Config import (JSON fayldan)"
          onClick={props.onImport}
        >
          Import
        </Button>
        <Button busy={props.transfer.phase !== 'idle'} label="Config export (JSON faylga)" onClick={props.onExport}>
          Export
        </Button>
      </div>

      {props.feedback === null ? null : (
        <p className={styles['feedback']} data-tone={props.feedback.tone} role="alert">
          {props.feedback.text}
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
            {importQuestion(importSummary(config.config, importing.config))}
          </p>
          <Button
            variant="primary"
            busy={props.transfer.phase === 'applying'}
            onClick={() => {
              props.onConfirmImport(importing.token);
            }}
          >
            Almashtirish
          </Button>
          {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
          <Button autoFocus onClick={props.onCancelImport}>
            Bekor qilish
          </Button>
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
            «{confirming.target}» qoidasi o'chirilsinmi? Uning route'lari olib tashlanadi.
          </p>
          <Button
            variant="primary"
            busy={props.busy.has(confirming.id)}
            onClick={() => {
              props.onConfirmDelete(confirming.id);
            }}
          >
            O'chirish
          </Button>
          {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
          <Button autoFocus onClick={props.onCancelDelete}>
            Bekor qilish
          </Button>
        </div>
      )}

      {overlaps.length === 0 ? null : (
        <div className={styles['overlaps']} role="note" aria-label="Ustma-ust manzillar">
          <p className={styles['overlapsTitle']}>Ustma-ust manzillar — aniqrog'i (uzunroq prefiks) ustun keladi:</p>
          <ul className={styles['overlapList']}>
            {overlaps.slice(0, 3).map((overlap) => (
              <li key={`${overlap.wider}|${overlap.narrower}`}>
                {overlap.narrower} → {overlap.wider} ichida
                {overlap.crossInterface ? ' · boshqa interfeys' : ''}
              </li>
            ))}
            {overlaps.length > 3 ? <li>yana {overlaps.length - 3} ta</li> : null}
          </ul>
        </div>
      )}

      {loaded === null ? (
        <div className={styles['notice']} role={notice?.tone === 'danger' || config.phase === 'failed' ? 'alert' : 'status'}>
          {notice !== null ? (
            <>
              <p className={styles['emptyTitle']}>{notice.title}</p>
              {notice.text === '' ? null : <p>{notice.text}</p>}
            </>
          ) : config.phase === 'failed' ? (
            <>
              <p className={styles['emptyTitle']}>Qoidalarni o'qib bo'lmadi</p>
              <p>{config.error === null ? '' : errorText(config.error.code)}</p>
              <Button variant="ghost" onClick={props.onReloadConfig}>
                Qayta o'qish
              </Button>
            </>
          ) : (
            <p>Qoidalar o'qilmoqda…</p>
          )}
        </div>
      ) : (
        <div className={styles['table']} role="table" aria-label="Qoidalar" aria-rowcount={visible.length + 1}>
          <div role="rowgroup" className={styles['head']}>
            <div className={styles['headRow']} role="row">
              {COLUMNS.map((column, index) => (
                <span key={index} role="columnheader">
                  {column}
                </span>
              ))}
            </div>
          </div>
          <TableBody {...props} rows={rows} visible={visible} />
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
              {loaded.state.enabled
                ? `${String(activeCount(loaded.state))} ta qoida faol · tarmoq o'zgarganda avtomatik qo'llanadi`
                : 'Routing menu bar oynasidagi umumiy tugma bilan yoqiladi'}
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
  readonly rs?: RulesApi & TransferApi & Pick<RsApi, 'getState' | 'onState' | 'getConfig'>;
  /** Opens the add-rule form (TASK-213). */
  readonly onAddRule?: () => void;
  readonly onEditRule?: (id: string) => void;
}

/** The rules screen of the rules window. */
export function RulesScreen({ rs: given, onAddRule, onEditRule }: RulesScreenProps): ReactElement {
  const rs = given ?? window.rs;
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
      ),
    [rs],
  );
  const importButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    returnImportFocus(transfer, importButton.current, transferController);
  }, [transfer, transferController]);
  const handlers = rulesHandlers(controller);

  return (
    <RulesPanel
      engine={engine}
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
    />
  );
}
