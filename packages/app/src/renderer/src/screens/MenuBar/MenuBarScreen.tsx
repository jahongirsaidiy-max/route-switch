// The menu bar window (360×600, opened under the tray icon): the global
// switch, both interfaces, the first enabled rules, the status of the last
// apply and two actions. Design: route-switch-docs/RouteSwitch UI.html,
// "Menu bar oynasi". Everything shown comes from `onState` (and the config,
// read again whenever its revision changes); the window keeps no truth of
// its own — a switch shows the state the helper reported, not the click.

import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  Banner,
  Button,
  CheckIcon,
  HelperRecovery,
  IfaceTag,
  InterfaceCard,
  RouteIcon,
  StatusBadge,
  StatusDot,
  Toggle,
  requestReconnect,
} from '../../components';
import { configStoreFor, useConfig, type ConfigView } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useNow } from '../../hooks/useNow';
import type { RsApi, RsServiceOrder } from '../../rs';
import { errorText, helperNotice, LOADING_NOTICE, networkWarnings, type Feedback } from '../../text';
import { openRules, reapply, setRouting, type MenuBarApi } from './actions';
import styles from './MenuBarScreen.module.css';
import { defaultRole, interfacesKey, menuRules, statusLine, type MenuRule, type StatusLine } from './model';

export type MenuBarAction = 'enabled' | 'apply' | 'rules' | 'reconnect';

export interface MenuBarPanelProps {
  readonly engine: EngineStateView;
  readonly config: ConfigView;
  /** The network service order, for the DEFAULT tag; null when unknown. */
  readonly serviceOrder: RsServiceOrder | null;
  /** Milliseconds since the epoch; times are shown relative to it. */
  readonly now: number;
  readonly busy: ReadonlySet<MenuBarAction>;
  readonly feedback: Feedback | null;
  readonly onToggle: (next: boolean) => void;
  readonly onApply: () => void;
  readonly onOpenRules: () => void;
  readonly onReloadConfig: () => void;
  /** "Qayta ulanish" of the helper notice. */
  readonly onReconnect: () => void;
}

function AlertIcon({ size = 14 }: { readonly size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

function RuleRow({ rule }: { readonly rule: MenuRule }): ReactElement {
  const notice = rule.notice;
  return (
    <li className={styles['row']} data-notice={notice?.kind ?? undefined}>
      <IfaceTag role={rule.iface} />
      <span className={styles['target']} title={rule.target}>
        {rule.target}
      </span>
      {rule.detail === '' ? null : (
        <span className={styles['detail']} title={rule.detail}>
          {rule.detail}
        </span>
      )}
      {notice?.kind === 'status' ? <StatusBadge status={notice.status} detail={notice.text} /> : null}
      {notice?.kind === 'warning' ? <StatusDot tone="warning" label={`Ogohlantirish: ${notice.text}`} /> : null}
    </li>
  );
}

function RulesSection({ config, engine, now, onReloadConfig }: Pick<MenuBarPanelProps, 'config' | 'now' | 'onReloadConfig'> & { readonly engine: EngineStateView }): ReactElement {
  const state = engine.state;
  const rules = config.config === null || state === null ? null : menuRules(config.config, state, now);
  return (
    // With routing off no rule is applied: the list is dimmed (the status row says why).
    <section className={styles['rules']} aria-labelledby="menubar-rules" data-off={state?.enabled === false || undefined}>
      <div className={styles['rulesHead']}>
        <h2 id="menubar-rules" className={styles['label']}>
          Faol qoidalar
        </h2>
        {rules === null ? null : (
          <span className={styles['count']}>
            {rules.total} ta · {rules.routes} route
          </span>
        )}
      </div>
      {rules === null && config.phase === 'failed' ? (
        <div className={styles['empty']} role="alert">
          <p>Qoidalarni o'qib bo'lmadi. {config.error === null ? '' : errorText(config.error.code)}</p>
          <Button variant="ghost" onClick={onReloadConfig}>
            Qayta o'qish
          </Button>
        </div>
      ) : null}
      {rules === null && config.phase !== 'failed' ? (
        <p className={styles['empty']} role="status">
          Qoidalar o'qilmoqda…
        </p>
      ) : null}
      {rules !== null && rules.total === 0 ? (
        <p className={styles['empty']}>Yoqilgan qoida yo'q. «Qoidalarni boshqarish» orqali qo'shing.</p>
      ) : null}
      {rules !== null && rules.total > 0 ? (
        <ul className={styles['list']}>
          {rules.shown.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </ul>
      ) : null}
      {rules !== null && rules.hidden > 0 ? <p className={styles['more']}>Yana {rules.hidden} ta qoida</p> : null}
    </section>
  );
}

/** Rules waiting for an interface, both interfaces on one subnet (`networkWarnings`). */
function Warnings({ engine, config }: { readonly engine: EngineStateView; readonly config: ConfigView }): ReactElement | null {
  const state = engine.state;
  const warnings = state === null ? [] : networkWarnings(state, config.config);
  if (warnings.length === 0) return null;
  return (
    <div className={styles['warnings']}>
      {warnings.map((warning) => (
        <Banner key={warning.id} tone="warning" size="compact" title={warning.title} text={warning.text} />
      ))}
    </div>
  );
}

function StatusRow({ line }: { readonly line: StatusLine }): ReactElement {
  return (
    <div className={styles['status']} data-tone={line.tone} role="status">
      {line.tone === 'success' ? <CheckIcon size={14} className={styles['statusIcon']} /> : null}
      {line.tone === 'danger' ? (
        <span className={styles['statusIcon']}>
          <AlertIcon />
        </span>
      ) : null}
      <span className={styles['statusText']}>{line.text}</span>
      {line.errors === null ? null : <span className={styles['errors']}>{line.errors}</span>}
    </div>
  );
}

/** The window for given data; `MenuBarScreen` supplies the live data and the actions. */
export function MenuBarPanel(props: MenuBarPanelProps): ReactElement {
  const { engine, busy } = props;
  const state = engine.helper === 'connected' ? engine.state : null;
  // A connected snapshot always carries a state; should one ever not, it reads as still loading.
  const notice = state === null ? (helperNotice(engine) ?? LOADING_NOTICE) : null;
  const enabled = state?.enabled ?? false;
  const preferred = state === null ? null : defaultRole(props.serviceOrder, state.interfaces);

  return (
    <section className={styles['screen']} aria-labelledby="menubar-title">
      <div className={styles['panel']}>
        <header className={styles['header']}>
          <div className={styles['brand']}>
            <RouteIcon size={22} />
            <h1 id="menubar-title" className={styles['brandName']}>
              RouteSwitch
            </h1>
          </div>
          <div className={styles['switch']}>
            <span aria-hidden="true">{state === null ? '' : enabled ? 'Faol' : "O'chiq"}</span>
            <Toggle
              checked={enabled}
              onChange={props.onToggle}
              label="Routing (barcha qoidalar)"
              disabled={state === null}
              busy={busy.has('enabled')}
            />
          </div>
        </header>

        {state === null || notice !== null ? (
          <div className={styles['notice']} data-tone={notice?.tone} role={notice?.tone === 'danger' ? 'alert' : 'status'}>
            <p className={styles['noticeTitle']}>{notice?.title}</p>
            {notice === null || notice.text === '' ? null : <p className={styles['noticeText']}>{notice.text}</p>}
            <HelperRecovery recovery={notice?.recovery ?? null} onReconnect={props.onReconnect} reconnecting={busy.has('reconnect')} />
          </div>
        ) : (
          <>
            <section className={styles['interfaces']} aria-labelledby="menubar-interfaces">
              <h2 id="menubar-interfaces" className={styles['label']}>
                Interfeyslar
              </h2>
              <InterfaceCard role="wifi" iface={state.interfaces.wifi} isDefault={preferred === 'wifi'} />
              <InterfaceCard role="ethernet" iface={state.interfaces.ethernet} isDefault={preferred === 'ethernet'} />
            </section>
            <Warnings engine={engine} config={props.config} />
            <RulesSection config={props.config} engine={engine} now={props.now} onReloadConfig={props.onReloadConfig} />
            <StatusRow line={statusLine(state, props.now)} />
          </>
        )}

        {props.feedback === null ? null : (
          <p className={styles['feedback']} data-tone={props.feedback.tone} role="alert">
            {props.feedback.text}
          </p>
        )}

        <div className={styles['actions']}>
          <Button grow onClick={props.onApply} disabled={state === null || !enabled} busy={busy.has('apply')}>
            Qayta qo'llash
          </Button>
          <Button variant="primary" grow onClick={props.onOpenRules} busy={busy.has('rules')}>
            Qoidalarni boshqarish
          </Button>
        </div>
      </div>
    </section>
  );
}

export interface MenuBarScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: MenuBarApi & Pick<RsApi, 'getState' | 'onState' | 'getConfig' | 'getServiceOrder' | 'reconnectHelper'>;
}

/** The screen of the menu bar window (`?view=popover`). */
export function MenuBarScreen({ rs: given }: MenuBarScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const engine = useEngineState(rs);
  const config = useConfig(rs);
  // Ticks, and refreshes when the popover is shown again (it is hidden, not closed).
  const now = useNow();
  const [serviceOrder, setServiceOrder] = useState<RsServiceOrder | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<MenuBarAction>>(new Set());
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const run = useCallback((action: MenuBarAction, task: () => Promise<Feedback | null>) => {
    setBusy((current) => new Set(current).add(action));
    setFeedback(null);
    void task().then((line) => {
      setFeedback(line);
      setBusy((current) => {
        const next = new Set(current);
        next.delete(action);
        return next;
      });
    });
  }, []);

  // The service order decides the DEFAULT tag; it is read again when the interfaces change.
  const interfaces = engine.helper === 'connected' ? (engine.state?.interfaces ?? null) : null;
  const key = interfaces === null ? null : interfacesKey(interfaces);
  useEffect(() => {
    if (key === null) {
      setServiceOrder(null);
      return undefined;
    }
    let live = true;
    void rs.getServiceOrder().then((result) => {
      // Unknown order: no DEFAULT tag, nothing else depends on it.
      if (live) setServiceOrder(result.ok ? result.value : null);
    });
    return () => {
      live = false;
    };
  }, [rs, key]);

  // The popover hides when it loses focus; a message from before should not greet the next opening.
  useEffect(() => {
    const clear = () => {
      setFeedback(null);
    };
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('blur', clear);
    };
  }, []);

  return (
    <MenuBarPanel
      engine={engine}
      config={config}
      serviceOrder={serviceOrder}
      now={now}
      busy={busy}
      feedback={feedback}
      onToggle={(next) => {
        run('enabled', () => setRouting(rs, next));
      }}
      onApply={() => {
        run('apply', () => reapply(rs));
      }}
      onOpenRules={() => {
        run('rules', () => openRules(rs));
      }}
      onReloadConfig={() => {
        configStoreFor(rs).reload();
      }}
      onReconnect={() => {
        run('reconnect', () => requestReconnect(rs));
      }}
    />
  );
}
