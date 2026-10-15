// "Sozlamalar": the UI language (TASK-DELTA-11), login item, Ethernet adapter override, Wi‑Fi as the default
// channel (a command shown for the user to run — the app never runs it,
// decision GAP-04), the rules backup (TASK-DELTA-16) and removing the helper. The design has no settings screen
// (GAP-01): it follows the rules window — page header, bordered cards. The
// words are in the UI language (`t.settings`, TASK-DELTA-14); the command
// itself is shown as `networksetup` takes it.

import type { Config } from '@routeswitch/shared';
import { useCallback, useEffect, useRef, useState, type ReactElement, type Ref } from 'react';

import { LANGUAGE_NAMES, LANGUAGE_PICKER_TITLE, LOCALES, isLocale, type I18n, type Locale } from '../../../../i18n';
import { Button, StatusDot, Toggle } from '../../components';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import { browserShowSignal, readOnShow, type ShowSignal, type ShownReader } from '../../hooks/windowShown';
import type { RsApi, RsServiceOrder } from '../../rs';
import {
  copyServiceOrderCommand,
  ethernetChoices,
  saveEthernetOverride,
  setOpenAtLogin,
  uninstallHelper,
  type Feedback,
  type SettingsApi,
} from './actions';
import { errorText, helperStatusText, UZ } from '../../text';
import {
  backupKey,
  INITIAL_BACKUP_VIEW,
  removeBackup,
  useBackup,
  type BackupApi,
  type BackupView,
} from '../Rules/recovery';
import {
  cancelPreview,
  confirmPreview,
  INITIAL_TRANSFER_UI,
  previewQuestion,
  startRestore,
  type TransferUiState,
} from '../Rules/transfer';
import styles from './SettingsScreen.module.css';

export type SettingsSection = 'language' | 'login' | 'ethernet' | 'wifi' | 'backup' | 'helper';

export interface ServiceOrderView {
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly order: RsServiceOrder | null;
  readonly feedback: Feedback | null;
}

export interface SettingsPanelProps {
  readonly engine: EngineStateView;
  /** The UI language in force (`useI18n().locale`). */
  readonly language: Locale;
  /** The language card's hint, in the language in force (`t.settingsLanguage.hint`). */
  readonly languageHint: string;
  readonly onSelectLanguage: (language: Locale) => void;
  /** Null while it is being read or when it could not be read. */
  readonly openAtLogin: boolean | null;
  /** The stored overrides; undefined when the config has not been read (no helper). */
  readonly overrides: Config['ifaceOverrides'] | null | undefined;
  readonly serviceOrder: ServiceOrderView;
  readonly busy: ReadonlySet<SettingsSection>;
  readonly confirmingUninstall: boolean;
  readonly feedback: Readonly<Partial<Record<SettingsSection, Feedback>>>;
  readonly onToggleLogin: (next: boolean) => void;
  readonly onSelectEthernet: (device: string | null) => void;
  readonly onCopyCommand: () => void;
  readonly onRefreshOrder: () => void;
  readonly onAskUninstall: () => void;
  readonly onCancelUninstall: () => void;
  readonly onConfirmUninstall: () => void;
  /** The "Helper'ni o'chirish" button, so the focus can return to it after the question closes. */
  readonly uninstallRef?: Ref<HTMLButtonElement> | undefined;
  /** The rules backup (TASK-DELTA-16); `loading` when not given. */
  readonly backup?: BackupView | undefined;
  /** The helper's config now, for the restore preview's counts; null when not read. */
  readonly config?: Config | null | undefined;
  /** Milliseconds since the epoch, for the backup's time. */
  readonly now?: number | undefined;
  /** The restore's preview and its outcome (the import flow of the rules window). */
  readonly restore?: TransferUiState | undefined;
  readonly confirmingBackupRemoval?: boolean | undefined;
  readonly onRestoreBackup?: (() => void) | undefined;
  readonly onConfirmRestore?: ((token: string) => void) | undefined;
  readonly onCancelRestore?: (() => void) | undefined;
  readonly onAskRemoveBackup?: (() => void) | undefined;
  readonly onCancelRemoveBackup?: (() => void) | undefined;
  readonly onConfirmRemoveBackup?: (() => void) | undefined;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n | undefined;
}

const AUTO = '';

function FeedbackLine({ feedback }: { readonly feedback: Feedback | null | undefined }): ReactElement | null {
  if (feedback === null || feedback === undefined) return null;
  return (
    <p className={styles['feedback']} data-tone={feedback.tone} role={feedback.tone === 'danger' ? 'alert' : 'status'}>
      {feedback.text}
    </p>
  );
}

/**
 * "Qoidalar zaxirasi": what the app's backup holds, "Zaxiradan tiklash" (the
 * import preview, then "Almashtirish") and "Zaxirani o'chirish" (after a question).
 */
function BackupCard(props: SettingsPanelProps & { readonly i18n: I18n; readonly connected: boolean }): ReactElement {
  const { i18n, busy } = props;
  const words = i18n.t.backup.settings;
  const backup = props.backup ?? INITIAL_BACKUP_VIEW;
  const restore = props.restore ?? INITIAL_TRANSFER_UI;
  const info = backup.info;
  const now = props.now ?? Date.now();
  const preview = restore.preview;
  const removing = busy.has('backup');
  return (
    <section className={styles['card']} aria-labelledby="settings-backup">
      <h2 id="settings-backup" className={styles['cardTitle']}>
        {words.title}
      </h2>
      <p className={styles['hint']}>{words.hint}</p>
      <p className={styles['status']} role="status">
        {backup.phase === 'loading' ? words.loading : info === null ? words.none : words.summary(info.ruleCount, i18n.formatTime(info.savedAt, now))}
      </p>
      {info !== null && !props.connected ? <p className={styles['hint']}>{words.needsHelper}</p> : null}
      {preview !== null ? (
        <div
          key={preview.token}
          className={styles['confirm']}
          role="alertdialog"
          aria-labelledby="settings-restore-question"
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onCancelRestore?.();
          }}
        >
          <p id="settings-restore-question" className={styles['confirmText']}>
            {previewQuestion(preview, props.config ?? null, now, i18n)}
          </p>
          <div className={styles['actions']}>
            <Button
              variant="primary"
              busy={restore.phase === 'applying'}
              onClick={() => {
                props.onConfirmRestore?.(preview.token);
              }}
            >
              {i18n.t.rules.replace}
            </Button>
            {/* The safe choice takes the focus (WAI-ARIA alertdialog). */}
            <Button autoFocus onClick={() => {
              props.onCancelRestore?.();
            }} busy={restore.phase === 'applying'}>
              {words.cancel}
            </Button>
          </div>
        </div>
      ) : props.confirmingBackupRemoval === true ? (
        <div
          className={styles['confirm']}
          role="alertdialog"
          aria-labelledby="settings-backup-question"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !removing) props.onCancelRemoveBackup?.();
          }}
        >
          <p id="settings-backup-question" className={styles['confirmText']}>
            {words.removeQuestion}
          </p>
          <div className={styles['actions']}>
            <Button variant="primary" onClick={() => {
              props.onConfirmRemoveBackup?.();
            }} busy={removing}>
              {words.removeConfirm}
            </Button>
            <Button autoFocus onClick={() => {
              props.onCancelRemoveBackup?.();
            }} busy={removing}>
              {words.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles['actions']}>
          <Button
            variant="primary"
            onClick={() => {
              props.onRestoreBackup?.();
            }}
            disabled={info === null || info.ruleCount === 0 || !props.connected}
            busy={restore.phase !== 'idle'}
          >
            {words.restore}
          </Button>
          <Button onClick={() => {
              props.onAskRemoveBackup?.();
            }} disabled={info === null}>
            {words.remove}
          </Button>
        </div>
      )}
      <FeedbackLine feedback={restore.feedback} />
      <FeedbackLine feedback={props.feedback.backup} />
    </section>
  );
}

/** The settings for given data; `SettingsScreen` supplies the live data and the actions. */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { engine, serviceOrder, busy, feedback } = props;
  const i18n = props.i18n ?? UZ;
  const words = i18n.t.settings;
  const state = engine.state;
  const connected = engine.helper === 'connected' && state !== null;
  // The helper also removes itself when its stored config is unreadable (it answers every method but two).
  const canUninstall = connected || engine.helper === 'config-unreadable';
  const wifiDevice = state?.interfaces.wifi.device ?? null;
  const choices = ethernetChoices(state?.adapters ?? [], wifiDevice);
  const override = props.overrides?.ethernet ?? null;
  const detected = state?.interfaces.ethernet.device ?? null;
  // Saving keeps the select enabled (a control that turns `disabled` drops keyboard focus — TASK-210 rule):
  // it is announced busy and ignores changes instead.
  const ethernetDisabled = !connected || props.overrides === undefined;
  const ethernetBusy = busy.has('ethernet');
  // An override naming an adapter that is not plugged in stays selectable, so the select shows the truth.
  const missingOverride = override !== null && !choices.some((adapter) => adapter.device === override);
  const helperStatus = helperStatusText(engine.helper, i18n);
  const order = serviceOrder.order;

  return (
    <section className={styles['screen']} aria-labelledby="settings-title">
      <header className={styles['header']}>
        <h1 id="settings-title" className={styles['title']}>
          {words.title}
        </h1>
        <p className={styles['subtitle']}>{words.subtitle}</p>
      </header>

      <div className={styles['sections']}>
        <section className={styles['card']} aria-labelledby="settings-language">
          {/* The title reads the same in every language, and each option is in its own: findable whatever language is on. */}
          <h2 id="settings-language" className={styles['cardTitle']}>
            {LANGUAGE_PICKER_TITLE}
          </h2>
          <p className={styles['hint']}>{props.languageHint}</p>
          <div className={styles['field']}>
            <select
              name="language"
              aria-labelledby="settings-language"
              className={`${styles['select'] ?? ''} ${styles['selectText'] ?? ''}`}
              value={props.language}
              aria-disabled={busy.has('language') ? true : undefined}
              aria-busy={busy.has('language') || undefined}
              onChange={(event) => {
                if (busy.has('language') || !isLocale(event.target.value)) return;
                props.onSelectLanguage(event.target.value);
              }}
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale} lang={locale}>
                  {LANGUAGE_NAMES[locale]}
                </option>
              ))}
            </select>
          </div>
          <FeedbackLine feedback={feedback.language} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-login">
          <div className={styles['row']}>
            <div className={styles['text']}>
              <h2 id="settings-login" className={styles['cardTitle']}>
                {words.login.title}
              </h2>
              <p className={styles['hint']}>{words.login.hint}</p>
            </div>
            <Toggle
              checked={props.openAtLogin === true}
              onChange={props.onToggleLogin}
              label={words.login.title}
              disabled={props.openAtLogin === null && !busy.has('login')}
              busy={busy.has('login')}
            />
          </div>
          <FeedbackLine feedback={feedback.login} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-ethernet">
          <h2 id="settings-ethernet" className={styles['cardTitle']}>
            {words.ethernet.title}
          </h2>
          <p className={styles['hint']}>{words.ethernet.hint(detected)}</p>
          <label className={styles['field']}>
            <span className={styles['label']}>{words.ethernet.fieldLabel}</span>
            <select
              className={styles['select']}
              value={override ?? AUTO}
              disabled={ethernetDisabled}
              aria-disabled={ethernetBusy && !ethernetDisabled ? true : undefined}
              aria-busy={ethernetBusy || undefined}
              onChange={(event) => {
                if (ethernetDisabled || ethernetBusy) return;
                props.onSelectEthernet(event.target.value === AUTO ? null : event.target.value);
              }}
            >
              <option value={AUTO}>{words.ethernet.auto}</option>
              {choices.map((adapter) => (
                <option key={adapter.device} value={adapter.device}>
                  {[adapter.device, adapter.port, adapter.ip ?? words.ethernet.noIp].join(' · ')}
                </option>
              ))}
              {missingOverride ? <option value={override}>{words.ethernet.notConnected(override)}</option> : null}
            </select>
          </label>
          {connected ? null : <p className={styles['hint']}>{words.ethernet.needsHelper}</p>}
          <FeedbackLine feedback={feedback.ethernet} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-wifi">
          <h2 id="settings-wifi" className={styles['cardTitle']}>
            {words.wifi.title}
          </h2>
          <p className={styles['hint']}>{words.wifi.hint}</p>
          {serviceOrder.phase === 'loading' ? (
            <p className={styles['hint']} role="status">
              {words.wifi.loading}
            </p>
          ) : null}
          {serviceOrder.phase === 'failed' ? (
            <p className={styles['feedback']} data-tone="danger" role="alert">
              {words.wifi.failed}
            </p>
          ) : null}
          {order !== null && order.command === null ? (
            <p className={styles['hint']}>{words.wifi.notFound}</p>
          ) : null}
          {order !== null && order.command !== null ? (
            <>
              <p className={styles['status']} data-ok={order.wifiFirst}>
                {order.wifiFirst
                  ? words.wifi.alreadyFirst(order.wifiService ?? 'Wi‑Fi')
                  : words.wifi.currentFirst(order.services.find((service) => service.enabled)?.name ?? '—')}
              </p>
              <pre className={styles['command']} aria-label={words.wifi.commandLabel}>
                <code>{order.command}</code>
              </pre>
            </>
          ) : null}
          <div className={styles['actions']}>
            <Button
              variant="primary"
              onClick={props.onCopyCommand}
              disabled={order?.command === null || order === null}
              busy={busy.has('wifi')}
            >
              {words.wifi.copy}
            </Button>
            <Button onClick={props.onRefreshOrder} busy={serviceOrder.phase === 'loading'}>
              {words.wifi.refresh}
            </Button>
          </div>
          <FeedbackLine feedback={serviceOrder.feedback} />
        </section>

        <BackupCard {...props} i18n={i18n} connected={connected} />

        <section className={styles['card']} aria-labelledby="settings-helper">
          <h2 id="settings-helper" className={styles['cardTitle']}>
            {words.helper.title}
          </h2>
          <div className={styles['helperStatus']}>
            <StatusDot tone={helperStatus.tone} label={helperStatus.text} size="sm" />
            <span>
              {helperStatus.text}
              {engine.connection?.kind === 'connected' ? ` · v${engine.connection.helperVersion}` : ''}
            </span>
          </div>
          <p className={styles['hint']}>{words.helper.hint}</p>
          {props.confirmingUninstall ? (
            <div
              className={styles['confirm']}
              role="alertdialog"
              aria-labelledby="settings-uninstall-question"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy.has('helper')) props.onCancelUninstall();
              }}
            >
              <p id="settings-uninstall-question" className={styles['confirmText']}>
                {words.helper.question}
              </p>
              <div className={styles['actions']}>
                <Button variant="primary" onClick={props.onConfirmUninstall} busy={busy.has('helper')}>
                  {words.helper.confirm}
                </Button>
                {/* The safe choice takes the focus (WAI-ARIA alertdialog); busy, not disabled, so it keeps it. */}
                <Button autoFocus onClick={props.onCancelUninstall} busy={busy.has('helper')}>
                  {words.helper.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles['actions']}>
              <Button ref={props.uninstallRef} onClick={props.onAskUninstall} disabled={!canUninstall}>
                {words.helper.uninstall}
              </Button>
            </div>
          )}
          <FeedbackLine feedback={feedback.helper} />
        </section>
      </div>
    </section>
  );
}

export interface SettingsScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: SettingsApi & BackupApi & Pick<RsApi, 'getState' | 'onState' | 'setLanguage' | 'restoreBackup' | 'applyImport' | 'deleteBackup'>;
}

/**
 * Sets the UI language. Every window then switches through `onLanguage`, this
 * one included, so a success needs no words; a refusal does, in the language
 * still in force.
 */
export async function chooseLanguage(rs: Pick<RsApi, 'setLanguage'>, language: Locale, i18n: I18n): Promise<Feedback | null> {
  const result = await rs.setLanguage(language);
  return result.ok ? null : { tone: 'danger', text: errorText(result.code, i18n) };
}

/** The settings screen of the rules window. */
export function SettingsScreen({ rs: given }: SettingsScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const i18n = useI18n();
  // Effects read the language through a ref: a language change must not read the settings again.
  const i18nRef = useRef(i18n);
  useEffect(() => {
    i18nRef.current = i18n;
  }, [i18n]);
  const engine = useEngineState(rs);
  const [openAtLogin, setOpenAtLoginValue] = useState<boolean | null>(null);
  const [overrides, setOverrides] = useState<Config['ifaceOverrides'] | null | undefined>(undefined);
  const [currentConfig, setCurrentConfig] = useState<Config | null>(null);
  const [serviceOrder, setServiceOrder] = useState<ServiceOrderView>({ phase: 'loading', order: null, feedback: null });
  const [busy, setBusy] = useState<ReadonlySet<SettingsSection>>(new Set());
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  // After the question closes, the focus goes back to "Helper'ni o'chirish" (when it can take it).
  const uninstallButton = useRef<HTMLButtonElement | null>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => {
    if (!returnFocus) return;
    focusUninstallButton(uninstallButton.current);
    setReturnFocus(false);
  }, [returnFocus]);
  const [feedback, setFeedback] = useState<Partial<Record<SettingsSection, Feedback>>>({});

  const mark = useCallback((section: SettingsSection, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(section);
      else next.delete(section);
      return next;
    });
  }, []);
  const say = useCallback((section: SettingsSection, value: Feedback) => {
    setFeedback((current) => ({ ...current, [section]: value }));
  }, []);

  // The login item, once.
  useEffect(() => {
    let live = true;
    void rs.getSettings().then((result) => {
      if (!live) return;
      if (result.ok) setOpenAtLoginValue(result.value.openAtLogin);
      else say('login', { tone: 'danger', text: errorText(result.code, i18nRef.current) });
    });
    return () => {
      live = false;
    };
  }, [rs, say]);

  // The stored overrides: on (re)connect and whenever the helper's config changes.
  const configRevision = engine.helper === 'connected' ? (engine.state?.configRevision ?? null) : null;
  useEffect(() => {
    if (configRevision === null) {
      setOverrides(undefined);
      setCurrentConfig(null);
      return undefined;
    }
    let live = true;
    void rs.getConfig().then((result) => {
      if (!live) return;
      setOverrides(result.ok ? (result.value.ifaceOverrides ?? null) : undefined);
      setCurrentConfig(result.ok ? result.value : null);
    });
    return () => {
      live = false;
    };
  }, [rs, configRevision]);

  // The service order: on open, on "Yangilash" and whenever the window is shown again (the command was run in Terminal).
  const orderReader = useRef<ShownReader | null>(null);
  useEffect(() => {
    const reader = followServiceOrderView(rs, setServiceOrder, browserShowSignal(window, document), () => i18nRef.current);
    orderReader.current = reader;
    return () => {
      reader.stop();
      orderReader.current = null;
    };
  }, [rs]);
  const refreshOrder = useCallback(() => {
    orderReader.current?.refresh();
  }, []);

  // The rules backup (TASK-DELTA-16): read on every connection and config revision, and when the window is shown.
  const backup = useBackup(rs, backupKey(engine));
  const [confirmingBackupRemoval, setConfirmingBackupRemoval] = useState(false);
  const [restore, setRestore] = useState<TransferUiState>(INITIAL_TRANSFER_UI);
  const latestRestore = useRef(restore);
  latestRestore.current = restore;
  const updateRestore = useCallback((change: (state: TransferUiState) => TransferUiState) => {
    latestRestore.current = change(latestRestore.current);
    setRestore(latestRestore.current);
  }, []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [backup.view]);

  return (
    <SettingsPanel
      engine={engine}
      backup={backup.view}
      config={currentConfig}
      now={now}
      restore={restore}
      confirmingBackupRemoval={confirmingBackupRemoval}
      onRestoreBackup={() => {
        const info = backup.view.info;
        if (info === null) return;
        setConfirmingBackupRemoval(false);
        void startRestore(rs, info.savedAt, updateRestore, () => latestRestore.current, () => i18nRef.current);
      }}
      onConfirmRestore={(token) => {
        void confirmPreview(rs, token, updateRestore, () => latestRestore.current, () => i18nRef.current);
      }}
      onCancelRestore={() => {
        cancelPreview(updateRestore);
      }}
      onAskRemoveBackup={() => {
        updateRestore((state) => (state.preview === null || state.phase === 'applying' ? state : { ...state, preview: null }));
        setConfirmingBackupRemoval(true);
      }}
      onCancelRemoveBackup={() => {
        setConfirmingBackupRemoval(false);
      }}
      onConfirmRemoveBackup={() => {
        mark('backup', true);
        void removeBackup(rs, i18n).then((line) => {
          say('backup', line);
          setConfirmingBackupRemoval(false);
          mark('backup', false);
          backup.reload();
        });
      }}
      i18n={i18n}
      language={i18n.locale}
      languageHint={i18n.t.settingsLanguage.hint}
      onSelectLanguage={(language) => {
        mark('language', true);
        void chooseLanguage(rs, language, i18n).then((line) => {
          setFeedback((current) => {
            const next = { ...current };
            if (line === null) delete next.language;
            else next.language = line;
            return next;
          });
          mark('language', false);
        });
      }}
      openAtLogin={openAtLogin}
      overrides={overrides}
      serviceOrder={serviceOrder}
      busy={busy}
      confirmingUninstall={confirmingUninstall}
      feedback={feedback}
      onToggleLogin={(next) => {
        mark('login', true);
        void setOpenAtLogin(rs, next, i18n).then(({ openAtLogin: value, feedback: line }) => {
          if (value !== null) setOpenAtLoginValue(value);
          say('login', line);
          mark('login', false);
        });
      }}
      onSelectEthernet={(device) => {
        mark('ethernet', true);
        void saveEthernetOverride(rs, device, i18n).then((line) => {
          say('ethernet', line);
          mark('ethernet', false);
        });
      }}
      onCopyCommand={() => {
        mark('wifi', true);
        void copyServiceOrderCommand(rs, i18n).then(({ order, feedback: line }) => {
          setServiceOrder((current) => ({
            phase: order === null ? current.phase : 'ready',
            order: order ?? current.order,
            feedback: line,
          }));
          mark('wifi', false);
        });
      }}
      onRefreshOrder={refreshOrder}
      onAskUninstall={() => {
        setConfirmingUninstall(true);
      }}
      onCancelUninstall={() => {
        setConfirmingUninstall(false);
        setReturnFocus(true);
      }}
      uninstallRef={uninstallButton}
      onConfirmUninstall={() => {
        mark('helper', true);
        void uninstallHelper(rs, i18n).then((line) => {
          say('helper', line);
          setConfirmingUninstall(false);
          mark('helper', false);
          setReturnFocus(true);
        });
      }}
    />
  );
}

/**
 * Reads the service order now and on every show of the window. The first read
 * and "Yangilash" show `loading`; a read on show is quiet — the card keeps what
 * it shows (no status line pushing the buttons down under a click) until the answer.
 */
export function followServiceOrderView(
  rs: Pick<RsApi, 'getServiceOrder'>,
  update: (next: (current: ServiceOrderView) => ServiceOrderView) => void,
  onShow: ShowSignal,
  /** The UI language at the time of the answer; Uzbek when not given. */
  language: () => I18n = () => UZ,
): ShownReader {
  return readOnShow(
    (cause) => {
      if (cause !== 'show') update((current) => ({ ...current, phase: 'loading' }));
      return rs.getServiceOrder();
    },
    (result) => {
      update(() =>
        result.ok
          ? { phase: 'ready', order: result.value, feedback: null }
          : { phase: 'failed', order: null, feedback: { tone: 'danger', text: errorText(result.code, language()) } },
      );
    },
    onShow,
  );
}

/** Gives the focus back to "Helper'ni o'chirish" when it is on the page and enabled (after an uninstall it is not). */
export function focusUninstallButton(button: Pick<HTMLButtonElement, 'isConnected' | 'disabled' | 'focus'> | null): boolean {
  if (button === null || !button.isConnected || button.disabled) return false;
  button.focus();
  return true;
}
