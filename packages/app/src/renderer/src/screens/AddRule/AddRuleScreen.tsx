// "Yangi qoida" / "Qoidani tahrirlash" — the add-rule form of the rules window,
// shown as a modal dialog over the rules table (520 wide, as the design's
// "Qoida qo'shish" page). Design: route-switch-docs/RouteSwitch UI.html.
// Kind, address, DNS block (domain only), interface, note; the command the
// helper would run; "Sinab ko'rish" (`test`); "Saqlash va qo'llash" (`saveRule`).
// The form is checked with the shared schema as it is typed; the main process
// and the helper check it again.

import type { Config, IfaceRole, InterfaceState, RuleKind } from '@routeswitch/shared';
import { useEffect, useMemo, useRef, useState, type ReactElement, type Ref } from 'react';

import { Button, InterfaceOption, Segment, StatusDot } from '../../components';
import type { I18n } from '../../../../i18n';
import { useConfig, type ConfigView } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import type { RsApi } from '../../rs';
import { errorText, helperStatusText, UZ } from '../../text';
import type { AddRuleApi } from './actions';
import styles from './AddRuleScreen.module.css';
import { createAddRuleController, initialAddRuleUi, type AddRuleController, type AddRuleUiState } from './controller';
import {
  acceptedValues,
  checkForm,
  commandPreview,
  describeTest,
  kindOptions,
  targetField,
  testAddressOf,
  type FieldErrors,
  type FormField,
} from './model';

/** What the rules window opens the form for. */
export type RuleEditorTarget = { readonly mode: 'add' } | { readonly mode: 'edit'; readonly id: string };

const ROLES: readonly IfaceRole[] = ['ethernet', 'wifi'];
const UNKNOWN_INTERFACE: InterfaceState = { device: null, ip: null, gateway: null, up: false };

/** Whether the form can be shown: the rule to edit is read, missing, or cannot be read. */
export type FormStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly text: string };

export interface AddRulePanelProps {
  readonly mode: 'add' | 'edit';
  readonly ruleId: string;
  readonly status: FormStatus;
  readonly engine: EngineStateView;
  /** The stored config, for the uniqueness check and the saved rule's state; null when not read. */
  readonly config: Config | null;
  readonly ui: AddRuleUiState;
  readonly onKind: (kind: RuleKind) => void;
  readonly onIface: (iface: IfaceRole) => void;
  readonly onField: AddRuleController['setField'];
  readonly onBlur: (field: FormField) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onTest: (address: string) => void;
  /** The input of a field, so the focus can move to the first refused one. */
  readonly fieldRef?: ((field: FormField) => Ref<HTMLInputElement>) | undefined;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n | undefined;
}

const MESSAGE_ID: Readonly<Record<FormField, string>> = {
  target: 'add-rule-target-message',
  dns: 'add-rule-dns-message',
  refreshSec: 'add-rule-refresh-message',
  note: 'add-rule-note-message',
};

/** The errors to show: a field's once it was left, every one after a save was asked for. */
export function visibleErrors(errors: FieldErrors, ui: Pick<AddRuleUiState, 'touched' | 'submitted'>): FieldErrors {
  if (ui.submitted) return errors;
  const shown: FieldErrors = {};
  for (const field of ui.touched) {
    const error = errors[field];
    if (error !== undefined) shown[field] = error;
  }
  return shown;
}

/** "IP'lar har 10 daqiqada yangilanadi." / "… har 90 soniyada …" — the refresh hint. */
export function refreshText(seconds: number, i18n: I18n = UZ): string {
  const words = i18n.t.addRule;
  return seconds % 60 === 0 ? words.refreshMinutes(seconds / 60) : words.refreshSeconds(seconds);
}

function Message({ field, error, hint }: { readonly field: FormField; readonly error: string | undefined; readonly hint: string | null }) {
  if (error === undefined && hint === null) return null;
  return (
    <span id={MESSAGE_ID[field]} className={styles['hint']} data-tone={error === undefined ? undefined : 'danger'}>
      {error ?? hint}
    </span>
  );
}

const inputProps = (field: FormField, error: string | undefined, props: AddRulePanelProps) => ({
  ref: props.fieldRef?.(field),
  'aria-invalid': error === undefined ? undefined : true,
  'data-invalid': error === undefined ? undefined : true,
  onBlur: () => {
    props.onBlur(field);
  },
});

/** `kind` / `target` as the rule is saved (an IP wildcard is the subnet it stands for, see `acceptedValues`). */
function TestRow(props: AddRulePanelProps & { readonly kind: RuleKind; readonly target: string | null; readonly i18n: I18n }): ReactElement {
  const { ui, config, engine, ruleId, i18n } = props;
  const t = i18n.t.addRule;
  const stored = config?.rules.find((rule) => rule.id === ruleId) ?? null;
  const ruleState = engine.state?.rules.find((state) => state.ruleId === ruleId) ?? null;
  const saved = stored === null ? null : { target: stored.target, kind: stored.kind, dns: stored.dns ?? null, state: ruleState };
  const connected = engine.helper === 'connected';
  const subject = connected ? testAddressOf(props.kind, props.target, saved, i18n) : { reason: t.testNoHelper };
  const address = 'address' in subject ? subject.address : null;
  const test = ui.test;
  const current = address !== null && test.phase !== 'idle' && test.address === address ? test : null;
  const savedAsTyped = saved !== null && saved.target === props.target && stored?.iface === ui.form.iface;

  return (
    <div className={styles['testRow']}>
      <Button
        variant="secondary"
        busy={current?.phase === 'running'}
        disabled={address === null}
        label={address === null ? t.testOff('reason' in subject ? subject.reason : '') : t.testAddress(address)}
        onClick={() => {
          if (address !== null) props.onTest(address);
        }}
      >
        {t.test}
      </Button>
      <div className={styles['testResult']} role="status">
        {address === null ? (
          <span className={styles['muted']}>{'reason' in subject ? subject.reason : ''}</span>
        ) : current === null ? (
          <span className={styles['muted']}>{t.testIdle(address)}</span>
        ) : current.phase === 'running' ? (
          <span className={styles['muted']}>{t.testRunning(address)}</span>
        ) : current.phase === 'failed' ? (
          <span data-tone="danger">{current.text}</span>
        ) : (
          (() => {
            const summary = describeTest(current.result, ui.form.iface, ruleId, savedAsTyped, i18n);
            return (
              <>
                <span className={styles['testRoute']}>{summary.route}</span>
                <span className={styles['testVerdict']} data-tone={summary.tone}>
                  <StatusDot tone={summary.tone} size="sm" label={summary.tone === 'success' ? t.testMatch : t.testMismatch} />
                  {summary.verdict}
                </span>
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}

function FormBody(props: AddRulePanelProps & { readonly i18n: I18n }): ReactElement {
  const { ui, config, engine, i18n } = props;
  const t = i18n.t.addRule;
  const form = ui.form;
  const check = checkForm(form, props.ruleId, config, i18n);
  const errors = visibleErrors(check.errors, ui);
  const field = targetField(form.kind, i18n);
  const interfaces = engine.helper === 'connected' ? (engine.state?.interfaces ?? null) : null;
  // The preview and the test use the target only once the shared normaliser accepts it.
  // An IP wildcard is previewed as the subnet it is saved as (`-net 10.0.0.0/8`).
  const { kind, target, dns } = acceptedValues(form);
  const preview = commandPreview(kind, target, dns, form.iface, interfaces, i18n);
  const refresh = Number(form.refreshSec.trim());
  const targetHint =
    check.wildcardCidr !== null
      ? t.wildcardResult(check.wildcardCidr)
      : check.normalisedTarget !== null
        ? t.normalised(check.normalisedTarget)
        : check.sameAs !== null
          ? t.sameAs(check.sameAs)
          : field.hint;

  return (
    <>
      <div className={styles['body']}>
        <div className={styles['field']}>
          <span id="add-rule-kind" className={styles['label']}>
            {t.kindLabel}
          </span>
          <Segment label={t.kindLabel} options={kindOptions(i18n)} value={form.kind} onChange={props.onKind} />
        </div>

        <label className={styles['field']}>
          <span className={styles['label']}>{field.label}</span>
          <input
            type="text"
            className={styles['input']}
            data-mono
            value={form.target}
            placeholder={field.placeholder}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoFocus
            aria-describedby={MESSAGE_ID.target}
            {...inputProps('target', errors.target, props)}
            onChange={(event) => {
              props.onField('target', event.target.value);
            }}
          />
          <Message field="target" error={errors.target} hint={targetHint} />
        </label>

        {form.kind === 'domain' ? (
          <div className={styles['dnsBox']}>
            <label className={styles['check']}>
              <input
                type="checkbox"
                checked={form.useDns}
                onChange={(event) => {
                  props.onField('useDns', event.target.checked);
                }}
              />
              <span>{t.useDns}</span>
            </label>
            {form.useDns ? (
              <label className={styles['dnsField']}>
                <span className={styles['visuallyHidden']}>{t.dnsAddress}</span>
                <input
                  type="text"
                  className={styles['input']}
                  data-size="sm"
                  data-mono
                  value={form.dns}
                  placeholder="10.20.0.10"
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby={errors.dns === undefined ? undefined : MESSAGE_ID.dns}
                  {...inputProps('dns', errors.dns, props)}
                  onChange={(event) => {
                    props.onField('dns', event.target.value);
                  }}
                />
                <Message field="dns" error={errors.dns} hint={null} />
              </label>
            ) : null}
            <label className={styles['refreshField']}>
              <span>{t.refreshLabel}</span>
              <input
                type="text"
                inputMode="numeric"
                className={styles['input']}
                data-size="sm"
                data-mono
                data-width="short"
                value={form.refreshSec}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={errors.refreshSec === undefined ? undefined : MESSAGE_ID.refreshSec}
                {...inputProps('refreshSec', errors.refreshSec, props)}
                onChange={(event) => {
                  props.onField('refreshSec', event.target.value);
                }}
              />
            </label>
            <Message field="refreshSec" error={errors.refreshSec} hint={null} />
            <div className={styles['hint']}>
              {form.useDns && target !== null ? t.resolverFile(target) : ''}
              {errors.refreshSec === undefined && check.errors.refreshSec === undefined ? refreshText(refresh, i18n) : ''}
            </div>
          </div>
        ) : null}

        <div className={styles['field']} role="group" aria-labelledby="add-rule-iface">
          <span id="add-rule-iface" className={styles['label']}>
            {t.ifaceLabel}
          </span>
          <div className={styles['ifaces']}>
            {ROLES.map((role) => (
              <InterfaceOption
                key={role}
                role={role}
                iface={interfaces?.[role] ?? UNKNOWN_INTERFACE}
                selected={form.iface === role}
                onSelect={props.onIface}
                i18n={i18n}
              />
            ))}
          </div>
        </div>

        <label className={styles['field']}>
          <span className={styles['label']}>{t.noteLabel}</span>
          <input
            type="text"
            className={styles['input']}
            data-size="md"
            value={form.note}
            placeholder={t.notePlaceholder}
            aria-describedby={errors.note === undefined ? undefined : MESSAGE_ID.note}
            {...inputProps('note', errors.note, props)}
            onChange={(event) => {
              props.onField('note', event.target.value);
            }}
          />
          <Message field="note" error={errors.note} hint={null} />
        </label>
      </div>

      <div className={styles['preview']} role="group" aria-labelledby="add-rule-preview">
        <span id="add-rule-preview" className={styles['previewLabel']}>
          {t.previewLabel}
        </span>
        {preview.lines.map((line) => (
          <code key={line} className={styles['command']}>
            {line}
          </code>
        ))}
        {preview.note === null ? null : <span className={styles['previewNote']}>{preview.note}</span>}
        <TestRow {...props} kind={kind} target={target} i18n={i18n} />
      </div>
    </>
  );
}

/** The dialog for given data; `AddRuleDialog` supplies the live data and the actions. */
export function AddRulePanel(props: AddRulePanelProps): ReactElement {
  const { status, ui, engine } = props;
  const i18n = props.i18n ?? UZ;
  const t = i18n.t.addRule;
  const helper = engine.helper === 'connected' ? null : helperStatusText(engine.helper, i18n);
  const ready = status.kind === 'ready';

  return (
    <div className={styles['backdrop']}>
      <form
        className={styles['dialog']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-rule-title"
        aria-describedby="add-rule-subtitle"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) props.onSave();
        }}
        onKeyDown={(event) => {
          handleDialogEscape(event, ui.saving, props.onCancel);
        }}
      >
        <header className={styles['header']}>
          <h1 id="add-rule-title" className={styles['title']}>
            {t.titles[props.mode]}
          </h1>
          <p id="add-rule-subtitle" className={styles['subtitle']}>
            {t.subtitle}
          </p>
        </header>

        {helper === null ? null : (
          <p className={styles['banner']} role="status">
            <StatusDot tone={helper.tone} size="sm" label={helper.text} />
            {t.helperDown(helper.text)}
          </p>
        )}

        {ready ? (
          <FormBody {...props} i18n={i18n} />
        ) : (
          <div className={styles['body']} role={status.kind === 'loading' ? 'status' : 'alert'}>
            <p className={styles['statusText']}>
              {status.kind === 'loading' ? t.loadingRule : status.kind === 'missing' ? t.missingRule : status.text}
            </p>
          </div>
        )}

        {ui.feedback === null ? null : (
          <p className={styles['feedback']} data-tone={ui.feedback.tone} role="alert">
            {ui.feedback.text}
          </p>
        )}

        <footer className={styles['footer']}>
          {/* While a save is on its way the form stays: its outcome (a refusal, say) is shown here. */}
          <Button size="lg" autoFocus={!ready} busy={ui.saving} onClick={props.onCancel}>
            {t.cancel}
          </Button>
          {ready ? (
            <Button variant="primary" size="lg" type="submit" busy={ui.saving}>
              {t.save}
            </Button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}

/** The part of a keyboard event the dialog's Escape reads. */
export interface DialogKeyEvent {
  readonly key: string;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * Escape closes the dialog — unless a save is on its way (the dialog stays
 * until its outcome is known: a late refusal must not be lost), or the event
 * was handled already (the form's own listener and the document's both see
 * an Escape typed inside the form). True when it closed.
 */
export function handleDialogEscape(event: DialogKeyEvent, saving: boolean, onCancel: () => void): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  event.preventDefault();
  if (saving) return false;
  onCancel();
  return true;
}

/** Why the form cannot be shown yet, from the live config. */
export function formStatus(editor: RuleEditorTarget, config: ConfigView, loaded: boolean, i18n: I18n = UZ): FormStatus {
  const t = i18n.t.addRule;
  if (editor.mode === 'add' || loaded) return { kind: 'ready' };
  if (config.config?.rules.some((rule) => rule.id === editor.id) === true) return { kind: 'loading' };
  if (config.phase === 'ready') return { kind: 'missing' };
  if (config.phase === 'failed') return { kind: 'unavailable', text: t.readFailed(config.error === null ? '' : errorText(config.error.code, i18n)) };
  if (config.phase === 'idle') return { kind: 'unavailable', text: t.readNoHelper };
  return { kind: 'loading' };
}

/** Moves the focus to a field's input when it is on the page. */
export function focusField(inputs: ReadonlyMap<FormField, { focus: () => void }>, field: FormField | null): boolean {
  if (field === null) return false;
  const input = inputs.get(field);
  if (input === undefined) return false;
  input.focus();
  return true;
}

export interface AddRuleDialogProps {
  readonly editor: RuleEditorTarget;
  /** Closes the form: after "Bekor qilish", Escape, or a successful save. */
  readonly onClose: () => void;
  /** The preload API; `window.rs` in the app. */
  readonly rs?: AddRuleApi & Pick<RsApi, 'getState' | 'onState' | 'getConfig'>;
  /** The id of a new rule; `crypto.randomUUID()` in the app. */
  readonly newId?: () => string;
}

/** The add / edit rule dialog of the rules window. */
export function AddRuleDialog({ editor, onClose, rs: given, newId }: AddRuleDialogProps): ReactElement {
  const rs = given ?? window.rs;
  const engine = useEngineState(rs);
  const config = useConfig(rs);
  const i18n = useI18n();
  // The controller writes its messages in the language of the moment the outcome arrives.
  const language = useRef(i18n);
  language.current = i18n;
  // One id for the life of the dialog: changing the kind edits the same rule.
  const [ruleId] = useState(() => (editor.mode === 'edit' ? editor.id : (newId ?? (() => globalThis.crypto.randomUUID()))()));
  const [ui, setUi] = useState<AddRuleUiState>(() => initialAddRuleUi());
  const latest = useRef(ui);
  latest.current = ui;
  const close = useRef(onClose);
  close.current = onClose;
  const controller = useMemo(
    () =>
      createAddRuleController(
        rs,
        ruleId,
        (change) => {
          latest.current = change(latest.current);
          setUi(latest.current);
        },
        () => latest.current,
        () => {
          close.current();
        },
        () => language.current,
      ),
    [rs, ruleId],
  );

  const stored = editor.mode === 'edit' ? (config.config?.rules.find((rule) => rule.id === ruleId) ?? null) : null;
  useEffect(() => {
    if (stored !== null && !ui.loaded) controller.load(stored);
  }, [stored, ui.loaded, controller]);

  const inputs = useRef(new Map<FormField, HTMLInputElement>());
  const fieldRef = useMemo(() => {
    const refs = new Map<FormField, (element: HTMLInputElement | null) => void>();
    return (field: FormField) => {
      let ref = refs.get(field);
      if (ref === undefined) {
        ref = (element) => {
          if (element === null) inputs.current.delete(field);
          else inputs.current.set(field, element);
        };
        refs.set(field, ref);
      }
      return ref;
    };
  }, []);
  useEffect(() => {
    if (ui.focusField === null) return;
    focusField(inputs.current, ui.focusField);
    controller.focusDone();
  }, [ui.focusField, controller]);

  // Escape also when the focus fell to <body> (a click on the dialog's padding):
  // the form's own listener does not hear it then.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      handleDialogEscape(event, latest.current.saving, () => {
        close.current();
      });
    };
    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <AddRulePanel
      mode={editor.mode}
      ruleId={ruleId}
      status={formStatus(editor, config, ui.loaded, i18n)}
      engine={engine}
      config={config.config}
      ui={ui}
      onKind={controller.setKind}
      onIface={controller.setIface}
      onField={controller.setField}
      onBlur={controller.blur}
      onSave={() => {
        void controller.save(config.config);
      }}
      onCancel={() => {
        // Not while a save is on its way: the dialog waits for its outcome.
        if (!latest.current.saving) onClose();
      }}
      onTest={(address) => {
        void controller.runTest(address);
      }}
      fieldRef={fieldRef}
      i18n={i18n}
    />
  );
}
