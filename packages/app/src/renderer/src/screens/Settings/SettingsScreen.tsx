// "Sozlamalar": login item, Ethernet adapter override, Wi‑Fi as the default
// channel (a command shown for the user to run — the app never runs it,
// decision GAP-04) and removing the helper. The design has no settings screen
// (GAP-01): it follows the rules window — page header, bordered cards.

import type { Config } from '@routeswitch/shared';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Button, ROLE_LABELS, StatusDot, Toggle } from '../../components';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import type { RsApi, RsServiceOrder } from '../../rs';
import {
  copyServiceOrderCommand,
  errorText,
  ethernetChoices,
  saveEthernetOverride,
  setOpenAtLogin,
  uninstallHelper,
  type Feedback,
  type SettingsApi,
} from './actions';
import styles from './SettingsScreen.module.css';

export type SettingsSection = 'login' | 'ethernet' | 'wifi' | 'helper';

export interface ServiceOrderView {
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly order: RsServiceOrder | null;
  readonly feedback: Feedback | null;
}

export interface SettingsPanelProps {
  readonly engine: EngineStateView;
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

const HELPER_STATUS: Readonly<Record<EngineStateView['helper'], { readonly text: string; readonly tone: 'success' | 'warning' | 'danger' | 'neutral' }>> = {
  loading: { text: 'Tekshirilmoqda…', tone: 'neutral' },
  connected: { text: 'Helper ishlayapti', tone: 'success' },
  connecting: { text: 'Helper bilan ulanmoqda…', tone: 'warning' },
  'not-installed': { text: "Helper o'rnatilmagan", tone: 'neutral' },
  disconnected: { text: 'Helper ishlamayapti', tone: 'danger' },
  incompatible: { text: 'Helper versiyasi mos emas', tone: 'danger' },
  stopped: { text: "Ilova to'xtamoqda", tone: 'neutral' },
  unavailable: { text: "Holatni o'qib bo'lmadi", tone: 'danger' },
};

/** The settings for given data; `SettingsScreen` supplies the live data and the actions. */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { engine, serviceOrder, busy, feedback } = props;
  const state = engine.state;
  const connected = engine.helper === 'connected' && state !== null;
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
  const helperStatus = HELPER_STATUS[engine.helper];
  const order = serviceOrder.order;

  return (
    <section className={styles['screen']} aria-labelledby="settings-title">
      <header className={styles['header']}>
        <h1 id="settings-title" className={styles['title']}>
          Sozlamalar
        </h1>
        <p className={styles['subtitle']}>Ilova va helper sozlamalari. Qoidalar helper'da saqlanadi.</p>
      </header>

      <div className={styles['sections']}>
        <section className={styles['card']} aria-labelledby="settings-login">
          <div className={styles['row']}>
            <div className={styles['text']}>
              <h2 id="settings-login" className={styles['cardTitle']}>
                Login'da ishga tushirish
              </h2>
              <p className={styles['hint']}>
                Kompyuterga kirganda RouteSwitch menu bar'da ochiladi. Route'lar ilovasiz ham ishlayveradi — ularni helper ushlab
                turadi.
              </p>
            </div>
            <Toggle
              checked={props.openAtLogin === true}
              onChange={props.onToggleLogin}
              label="Login'da ishga tushirish"
              disabled={props.openAtLogin === null && !busy.has('login')}
              busy={busy.has('login')}
            />
          </div>
          <FeedbackLine feedback={feedback.login} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-ethernet">
          <h2 id="settings-ethernet" className={styles['cardTitle']}>
            {ROLE_LABELS.ethernet} adapteri
          </h2>
          <p className={styles['hint']}>
            Odatda birinchi IP manzili bor, Wi‑Fi bo'lmagan adapter olinadi
            {detected === null ? '' : ` (hozir: ${detected})`}. Bir nechta adapter bo'lsa, keraklisini tanlang.
          </p>
          <label className={styles['field']}>
            <span className={styles['label']}>Ethernet roli uchun adapter</span>
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
              <option value={AUTO}>Avtomatik</option>
              {choices.map((adapter) => (
                <option key={adapter.device} value={adapter.device}>
                  {[adapter.device, adapter.port, adapter.ip ?? "IP yo'q"].join(' · ')}
                </option>
              ))}
              {missingOverride ? <option value={override}>{override} · ulanmagan</option> : null}
            </select>
          </label>
          {connected ? null : <p className={styles['hint']}>Helper ulanganda tanlash mumkin.</p>}
          <FeedbackLine feedback={feedback.ethernet} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-wifi">
          <h2 id="settings-wifi" className={styles['cardTitle']}>
            Wi‑Fi'ni default qilish
          </h2>
          <p className={styles['hint']}>
            Qoidaga tushmagan trafik xizmatlar tartibidagi birinchi ulangan tarmoqdan ketadi. Bu tartibni o'zgartirish administrator
            huquqini talab qiladi, shuning uchun RouteSwitch buyruqni faqat ko'rsatadi — uni Terminal'da o'zingiz bajarasiz.
          </p>
          {serviceOrder.phase === 'loading' ? (
            <p className={styles['hint']} role="status">
              Xizmatlar tartibi o'qilmoqda…
            </p>
          ) : null}
          {serviceOrder.phase === 'failed' ? (
            <p className={styles['feedback']} data-tone="danger" role="alert">
              Xizmatlar tartibini o'qib bo'lmadi.
            </p>
          ) : null}
          {order !== null && order.command === null ? (
            <p className={styles['hint']}>Wi‑Fi xizmati topilmadi.</p>
          ) : null}
          {order !== null && order.command !== null ? (
            <>
              <p className={styles['status']} data-ok={order.wifiFirst}>
                {order.wifiFirst
                  ? `${order.wifiService ?? 'Wi‑Fi'} allaqachon birinchi — default kanal Wi‑Fi.`
                  : `Hozir birinchi: ${order.services.find((service) => service.enabled)?.name ?? '—'}.`}
              </p>
              <pre className={styles['command']} aria-label="Wi‑Fi'ni birinchi qiladigan buyruq">
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
              Nusxalash
            </Button>
            <Button onClick={props.onRefreshOrder} busy={serviceOrder.phase === 'loading'}>
              Yangilash
            </Button>
          </div>
          <FeedbackLine feedback={serviceOrder.feedback} />
        </section>

        <section className={styles['card']} aria-labelledby="settings-helper">
          <h2 id="settings-helper" className={styles['cardTitle']}>
            Helper
          </h2>
          <div className={styles['helperStatus']}>
            <StatusDot tone={helperStatus.tone} label={helperStatus.text} size="sm" />
            <span>
              {helperStatus.text}
              {engine.connection?.kind === 'connected' ? ` · v${engine.connection.helperVersion}` : ''}
            </span>
          </div>
          <p className={styles['hint']}>
            O'chirish helper qo'shgan barcha route'lar va resolver fayllarini olib tashlaydi va root daemon'ni to'xtatadi. Qoidalar
            routing'ga ta'sir qilmay qoladi.
          </p>
          {props.confirmingUninstall ? (
            <div className={styles['confirm']} role="alertdialog" aria-labelledby="settings-uninstall-question">
              <p id="settings-uninstall-question" className={styles['confirmText']}>
                Helper rostdan ham o'chirilsinmi?
              </p>
              <div className={styles['actions']}>
                <Button variant="primary" onClick={props.onConfirmUninstall} busy={busy.has('helper')}>
                  Ha, o'chirish
                </Button>
                <Button onClick={props.onCancelUninstall} disabled={busy.has('helper')}>
                  Bekor qilish
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles['actions']}>
              <Button onClick={props.onAskUninstall} disabled={!connected}>
                Helper'ni o'chirish
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
  readonly rs?: SettingsApi & Pick<RsApi, 'getState' | 'onState'>;
}

/** The settings screen of the rules window. */
export function SettingsScreen({ rs: given }: SettingsScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const engine = useEngineState(rs);
  const [openAtLogin, setOpenAtLoginValue] = useState<boolean | null>(null);
  const [overrides, setOverrides] = useState<Config['ifaceOverrides'] | null | undefined>(undefined);
  const [serviceOrder, setServiceOrder] = useState<ServiceOrderView>({ phase: 'loading', order: null, feedback: null });
  const [busy, setBusy] = useState<ReadonlySet<SettingsSection>>(new Set());
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
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
      else say('login', { tone: 'danger', text: errorText(result.code) });
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
      return undefined;
    }
    let live = true;
    void rs.getConfig().then((result) => {
      if (!live) return;
      setOverrides(result.ok ? (result.value.ifaceOverrides ?? null) : undefined);
    });
    return () => {
      live = false;
    };
  }, [rs, configRevision]);

  const refreshOrder = useCallback(() => {
    setServiceOrder((current) => ({ ...current, phase: 'loading' }));
    void rs.getServiceOrder().then((result) => {
      setServiceOrder(
        result.ok
          ? { phase: 'ready', order: result.value, feedback: null }
          : { phase: 'failed', order: null, feedback: { tone: 'danger', text: errorText(result.code) } },
      );
    });
  }, [rs]);
  useEffect(refreshOrder, [refreshOrder]);

  return (
    <SettingsPanel
      engine={engine}
      openAtLogin={openAtLogin}
      overrides={overrides}
      serviceOrder={serviceOrder}
      busy={busy}
      confirmingUninstall={confirmingUninstall}
      feedback={feedback}
      onToggleLogin={(next) => {
        mark('login', true);
        void setOpenAtLogin(rs, next).then(({ openAtLogin: value, feedback: line }) => {
          if (value !== null) setOpenAtLoginValue(value);
          say('login', line);
          mark('login', false);
        });
      }}
      onSelectEthernet={(device) => {
        mark('ethernet', true);
        void saveEthernetOverride(rs, device).then((line) => {
          say('ethernet', line);
          mark('ethernet', false);
        });
      }}
      onCopyCommand={() => {
        mark('wifi', true);
        void copyServiceOrderCommand(rs).then(({ order, feedback: line }) => {
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
      }}
      onConfirmUninstall={() => {
        mark('helper', true);
        void uninstallHelper(rs).then((line) => {
          say('helper', line);
          setConfirmingUninstall(false);
          mark('helper', false);
        });
      }}
    />
  );
}
