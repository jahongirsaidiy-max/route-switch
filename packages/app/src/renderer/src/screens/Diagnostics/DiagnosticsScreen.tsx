// "Diagnostika" (TASK-DELTA-20): a section of the rules window that explains
// how traffic to one host, address or URL leaves the machine — the matching
// rule and why it wins, the kernel's route for each address against the
// rule's interface, the rule's DNS server and whether it answers. The design
// has no such screen: it follows the rules window's other sections — page
// header, a toolbar with the input, bordered cards and a table.
//
// The page sends one cleaned-up target (`parseDiagnosticTarget`) through
// `window.rs.diagnose`; it never resolves or reaches the network itself.

import { useMemo, useRef, useState, type ReactElement } from 'react';

import type { I18n } from '../../../../i18n';
import { Button } from '../../components';
import { useConfig } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import type { RsApi } from '../../rs';
import { UZ } from '../../text';
import {
  createDiagnosticsController,
  INITIAL_DIAGNOSTICS_UI,
  type DiagnosticsController,
  type DiagnosticsUiState,
} from './controller';
import styles from './DiagnosticsScreen.module.css';
import { diagnosisView, type DiagnosisView } from './model';

const INPUT_ID = 'diagnostics-target';
const MESSAGE_ID = 'diagnostics-target-message';

/** Why "Tekshirish" is off; null when it can be pressed. */
export function runBlockedReason(engine: Pick<EngineStateView, 'helper'>, i18n: I18n = UZ): string | null {
  return engine.helper === 'connected' ? null : i18n.t.diagnostics.needsHelper;
}

function Result({ view, i18n }: { readonly view: DiagnosisView; readonly i18n: I18n }): ReactElement {
  const words = i18n.t.diagnostics;
  return (
    <section className={styles['result']} aria-label={words.resultLabel(view.target)}>
      <div className={styles['verdict']} data-tone={view.verdict.tone} role="status">
        <p className={styles['verdictTitle']}>
          <span className={styles['mono']}>{view.target}</span> — {view.verdict.title}
        </p>
        {view.verdict.advice === null ? null : <p className={styles['verdictText']}>{view.verdict.advice}</p>}
      </div>

      <div className={styles['card']}>
        <h2 className={styles['cardTitle']}>{words.matchTitle}</h2>
        {view.match === null ? null : (
          <>
            <p className={styles['strong']}>{view.match.rule}</p>
            <p className={styles['muted']}>{view.match.why}</p>
          </>
        )}
        {view.noMatch === null ? null : <p className={styles['muted']}>{view.noMatch}</p>}
        {view.lookup.map((line) => (
          <p key={line} className={styles['muted']}>
            {line}
          </p>
        ))}
      </div>

      <div className={styles['table']}>
        <div className={styles['head']} aria-hidden="true">
          <span>{words.columns.address}</span>
          <span>{words.columns.actual}</span>
          <span>{words.columns.expected}</span>
          <span>{words.columns.status}</span>
        </div>
        {view.rows.length === 0 ? (
          <p className={styles['empty']}>{words.noAddressRows}</p>
        ) : (
          <ul className={styles['rows']} aria-label={words.addressesTitle}>
            {view.rows.map((row) => (
              <li key={row.address} className={styles['row']} data-status={row.status}>
                <span>
                  <span className={styles['mono']}>{row.address}</span>
                  <span className={styles['sub']}>{row.source}</span>
                  {row.rule === null ? null : <span className={styles['sub']}>{row.rule}</span>}
                </span>
                <span className={styles['mono']}>{row.failure ?? row.actual}</span>
                <span>{row.expected}</span>
                <span className={styles['status']} data-status={row.status}>
                  {row.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {view.dns === null && view.dnsNote === null ? null : (
        <div className={styles['card']}>
          <h2 className={styles['cardTitle']}>{words.dnsTitle}</h2>
          {view.dns === null ? null : (
            <>
              <p>
                <span className={styles['mono']}>{view.dns.server}</span>
                {view.dns.via === null ? null : <span className={styles['muted']}> · {view.dns.via}</span>}
                {' · '}
                <span className={styles['status']} data-tone={view.dns.tone}>
                  {view.dns.outcome}
                </span>
              </p>
              <p className={`${styles['muted'] ?? ''} ${styles['mono'] ?? ''}`}>{view.dns.resolverFile}</p>
            </>
          )}
          {view.dnsNote === null ? null : <p className={styles['muted']}>{view.dnsNote}</p>}
        </div>
      )}

      {view.notes.length === 0 ? null : (
        <div className={styles['card']}>
          <h2 className={styles['cardTitle']}>{words.notesTitle}</h2>
          <ul className={styles['notes']}>
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export interface DiagnosticsPanelProps {
  readonly ui: DiagnosticsUiState;
  /** Why "Tekshirish" is off (no helper); null when it can be pressed. */
  readonly blocked: string | null;
  /** The result in words; null before the first diagnosis. */
  readonly view: DiagnosisView | null;
  readonly onInput: (input: string) => void;
  readonly onRun: () => void;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n;
}

/** The section for given data; `DiagnosticsScreen` supplies the live one. */
export function DiagnosticsPanel({ ui, blocked, view, onInput, onRun, i18n = UZ }: DiagnosticsPanelProps): ReactElement {
  const words = i18n.t.diagnostics;
  const message = ui.fieldError ?? (blocked === null ? words.hint : words.runOff(blocked));
  return (
    <section className={styles['screen']} aria-labelledby="diagnostics-title">
      <header className={styles['header']}>
        <h1 id="diagnostics-title" className={styles['title']}>
          {words.title}
        </h1>
        <p className={styles['subtitle']}>{words.subtitle}</p>
      </header>

      <form
        className={styles['toolbar']}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onRun();
        }}
      >
        <label className={styles['label']} htmlFor={INPUT_ID}>
          {words.inputLabel}
        </label>
        <div className={styles['inputRow']}>
          <input
            id={INPUT_ID}
            type="text"
            className={styles['input']}
            value={ui.input}
            placeholder={words.placeholder}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={4096}
            aria-invalid={ui.fieldError === null ? undefined : true}
            aria-describedby={MESSAGE_ID}
            data-invalid={ui.fieldError === null ? undefined : true}
            onChange={(event) => {
              onInput(event.target.value);
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={ui.running}
            disabled={blocked !== null}
            label={blocked === null ? undefined : words.runOff(blocked)}
          >
            {words.run}
          </Button>
        </div>
        <p
          id={MESSAGE_ID}
          className={styles['hint']}
          data-tone={ui.fieldError === null ? undefined : 'danger'}
          role={ui.fieldError === null ? undefined : 'alert'}
        >
          {message}
        </p>
      </form>

      <div className={styles['body']}>
        {ui.running ? (
          <p className={styles['running']} role="status">
            {words.running}
          </p>
        ) : null}
        {ui.failure === null ? null : (
          <div className={styles['alert']} role="alert">
            {ui.failure}
          </div>
        )}
        {view === null ? (
          ui.running || ui.failure !== null ? null : (
            <div className={styles['notice']} role="status">
              <div className={styles['noticeTitle']}>{words.emptyTitle}</div>
              <div>{words.emptyText}</div>
            </div>
          )
        ) : (
          <Result view={view} i18n={i18n} />
        )}
      </div>
    </section>
  );
}

export interface DiagnosticsScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: Pick<RsApi, 'diagnose' | 'getState' | 'onState' | 'getConfig'>;
}

/** The Diagnostika section of the rules window. */
export function DiagnosticsScreen({ rs: given }: DiagnosticsScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const i18n = useI18n();
  const language = useRef(i18n);
  language.current = i18n;
  const engine = useEngineState(rs);
  // For the matching rule's target and interface; the diagnosis names the rule by id.
  const config = useConfig(rs);
  const [ui, setUi] = useState<DiagnosticsUiState>(INITIAL_DIAGNOSTICS_UI);
  const latest = useRef(ui);
  const controller: DiagnosticsController = useMemo(
    () =>
      createDiagnosticsController(
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
  const rules = config.config?.rules ?? null;
  const view = ui.diagnosis === null ? null : diagnosisView(ui.diagnosis, rules, i18n);
  return (
    <DiagnosticsPanel
      ui={ui}
      blocked={runBlockedReason(engine, i18n)}
      view={view}
      onInput={controller.setInput}
      onRun={() => {
        void controller.run();
      }}
      i18n={i18n}
    />
  );
}
