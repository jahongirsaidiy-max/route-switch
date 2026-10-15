// The menu bar window (360×600, opened under the tray icon): the global
// switch, both interfaces, the first enabled rules, the status of the last
// apply and two actions. Design: route-switch-docs/RouteSwitch UI.html,
// "Menu bar oynasi". Everything shown comes from `onState` (and the config,
// read again whenever its revision changes); the window keeps no truth of
// its own — a switch shows the state the helper reported, not the click.

import type { IfaceRole } from '@routeswitch/shared';
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
import type { I18n } from '../../../../i18n';
import { configStoreFor, useConfig, type ConfigView } from '../../hooks/useConfig';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import { useNow } from '../../hooks/useNow';
import { browserShowSignal, readOnShow, type ShowSignal, type ShownReader } from '../../hooks/windowShown';
import type { RsApi, RsServiceOrder } from '../../rs';
import { errorText, helperNotice, loadingNotice, networkWarnings, UZ, type Feedback } from '../../text';
import { installHelper } from '../Install';
import { dnsWarningViews } from '../AddRule/model';
import { backupKey, backupOffer, useBackup, type BackupApi } from '../Rules/recovery';
import { DnsWarningBanner } from '../Rules/RulesScreen';
import { openHelp, openRules, reapply, setRouting, suggestRule, type MenuBarApi } from './actions';
import styles from './MenuBarScreen.module.css';
import { defaultRole, interfacesKey, menuRules, statusLine, type MenuRule, type StatusLine } from './model';

/** Which DNS warning's offer to open in the rules window. */
export interface DnsOfferRequest {
  readonly server: string;
  readonly role: IfaceRole;
}

export type MenuBarAction = 'enabled' | 'apply' | 'rules' | 'reconnect' | 'install';

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
  /** The header's "?": the rules window at its Help section (TASK-DELTA-22). Absent: no button. */
  readonly onOpenHelp?: () => void;
  readonly onReloadConfig: () => void;
  /** "Qayta ulanish" of the helper notice. */
  readonly onReconnect: () => void;
  /** "Helper'ni (qayta) o'rnatish" of the helper notice (TASK-214). */
  readonly onInstall: () => void;
  /**
   * The rules backup's restore offer (TASK-DELTA-16): the helper holds no
   * rules, the app's backup does. Its button opens the rules window, where
   * the preview and the confirmation are.
   */
  readonly backupOffer?: { readonly count: number; readonly savedAt: string } | null;
  /**
   * A DNS warning's "qoidasini qo'shish" (TASK-DELTA-21): the rules window
   * opens with the add-rule form filled in. Absent: the warnings show without it.
   */
  readonly onSuggestRule?: (request: DnsOfferRequest) => void;
  /** The language of the window (`useI18n()`); Uzbek without it. */
  readonly i18n?: I18n;
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

function RuleRow({ rule, i18n }: { readonly rule: MenuRule; readonly i18n: I18n }): ReactElement {
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
      {notice?.kind === 'status' ? <StatusBadge status={notice.status} detail={notice.text} i18n={i18n} /> : null}
      {notice?.kind === 'warning' ? <StatusDot tone="warning" label={i18n.t.menuBar.warning(notice.text)} /> : null}
    </li>
  );
}

function RulesSection({
  config,
  engine,
  now,
  onReloadConfig,
  i18n,
}: Pick<MenuBarPanelProps, 'config' | 'now' | 'onReloadConfig'> & { readonly engine: EngineStateView; readonly i18n: I18n }): ReactElement {
  const words = i18n.t.menuBar;
  const state = engine.state;
  const rules = config.config === null || state === null ? null : menuRules(config.config, state, now, undefined, i18n);
  return (
    // With routing off no rule is applied: the list is dimmed (the status row says why).
    <section className={styles['rules']} aria-labelledby="menubar-rules" data-off={state?.enabled === false || undefined}>
      <div className={styles['rulesHead']}>
        <h2 id="menubar-rules" className={styles['label']}>
          {words.activeRules}
        </h2>
        {rules === null ? null : <span className={styles['count']}>{words.ruleCount(rules.total, rules.routes)}</span>}
      </div>
      {rules === null && config.phase === 'failed' ? (
        <div className={styles['empty']} role="alert">
          <p>
            {words.rulesUnreadable} {config.error === null ? '' : errorText(config.error.code, i18n)}
          </p>
          <Button variant="ghost" onClick={onReloadConfig}>
            {words.reload}
          </Button>
        </div>
      ) : null}
      {rules === null && config.phase !== 'failed' ? (
        <p className={styles['empty']} role="status">
          {words.rulesLoading}
        </p>
      ) : null}
      {rules !== null && rules.total === 0 ? (
        <p className={styles['empty']}>{words.noRules}</p>
      ) : null}
      {rules !== null && rules.total > 0 ? (
        <ul className={styles['list']}>
          {rules.shown.map((rule) => (
            <RuleRow key={rule.id} rule={rule} i18n={i18n} />
          ))}
        </ul>
      ) : null}
      {rules !== null && rules.hidden > 0 ? <p className={styles['more']}>{words.moreRules(rules.hidden)}</p> : null}
    </section>
  );
}

/**
 * Rules waiting for an interface, both interfaces on one subnet
 * (`networkWarnings`), and DNS servers reached through the wrong interface,
 * each with its add-rule offer (`dnsWarningViews`, TASK-DELTA-21).
 */
function Warnings({
  engine,
  config,
  onSuggestRule,
  suggesting,
  i18n,
}: {
  readonly engine: EngineStateView;
  readonly config: ConfigView;
  readonly onSuggestRule: ((request: DnsOfferRequest) => void) | undefined;
  readonly suggesting: boolean;
  readonly i18n: I18n;
}): ReactElement | null {
  const state = engine.state;
  const warnings = state === null ? [] : networkWarnings(state, config.config, i18n);
  const dnsWarnings = state === null ? [] : dnsWarningViews(state, config.config, i18n);
  if (warnings.length === 0 && dnsWarnings.length === 0) return null;
  return (
    <div className={styles['warnings']}>
      {warnings.map((warning) => (
        <Banner key={warning.id} tone="warning" size="compact" title={warning.title} text={warning.text} />
      ))}
      {dnsWarnings.map((warning) => (
        <DnsWarningBanner
          key={warning.id}
          warning={warning}
          size="compact"
          addRuleOff={null}
          busy={suggesting}
          onOffer={
            onSuggestRule === undefined
              ? undefined
              : (_form, { server, role }) => {
                  onSuggestRule({ server, role });
                }
          }
          i18n={i18n}
        />
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
  const i18n = props.i18n ?? UZ;
  const words = i18n.t.menuBar;
  const state = engine.helper === 'connected' ? engine.state : null;
  // A connected snapshot always carries a state; should one ever not, it reads as still loading.
  const notice = state === null ? (helperNotice(engine, i18n) ?? loadingNotice(i18n)) : null;
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
            {props.onOpenHelp === undefined ? null : (
              <button
                type="button"
                className={styles['helpButton']}
                aria-label={i18n.t.rules.sections.help}
                title={i18n.t.rules.sections.help}
                onClick={props.onOpenHelp}
              >
                ?
              </button>
            )}
            <span aria-hidden="true">{state === null ? '' : enabled ? words.on : words.off}</span>
            <Toggle
              checked={enabled}
              onChange={props.onToggle}
              label={words.toggleLabel}
              disabled={state === null}
              busy={busy.has('enabled')}
            />
          </div>
        </header>

        {state === null || notice !== null ? (
          <div className={styles['notice']} data-tone={notice?.tone} role={notice?.tone === 'danger' ? 'alert' : 'status'}>
            <p className={styles['noticeTitle']}>{notice?.title}</p>
            {notice === null || notice.text === '' ? null : <p className={styles['noticeText']}>{notice.text}</p>}
            <HelperRecovery
              i18n={i18n}
              recovery={notice?.recovery ?? null}
              onReconnect={props.onReconnect}
              reconnecting={busy.has('reconnect')}
              onInstall={props.onInstall}
              installing={busy.has('install')}
            />
          </div>
        ) : (
          <>
            <section className={styles['interfaces']} aria-labelledby="menubar-interfaces">
              <h2 id="menubar-interfaces" className={styles['label']}>
                {words.interfaces}
              </h2>
              <InterfaceCard role="wifi" iface={state.interfaces.wifi} isDefault={preferred === 'wifi'} i18n={i18n} />
              <InterfaceCard role="ethernet" iface={state.interfaces.ethernet} isDefault={preferred === 'ethernet'} i18n={i18n} />
            </section>
            {props.backupOffer === null || props.backupOffer === undefined ? null : (
              <div className={styles['warnings']}>
                <Banner
                  tone="warning"
                  size="compact"
                  title={i18n.t.backup.offerTitle(props.backupOffer.count)}
                  text={i18n.t.backup.offerText(i18n.formatTime(props.backupOffer.savedAt, props.now))}
                >
                  <Button variant="primary" onClick={props.onOpenRules} busy={busy.has('rules')}>
                    {i18n.t.backup.openRules}
                  </Button>
                </Banner>
              </div>
            )}
            <Warnings
              engine={engine}
              config={props.config}
              onSuggestRule={props.onSuggestRule}
              suggesting={busy.has('rules')}
              i18n={i18n}
            />
            <RulesSection config={props.config} engine={engine} now={props.now} onReloadConfig={props.onReloadConfig} i18n={i18n} />
            <StatusRow line={statusLine(state, props.now, i18n)} />
          </>
        )}

        {props.feedback === null ? null : (
          <p className={styles['feedback']} data-tone={props.feedback.tone} role="alert">
            {props.feedback.text}
          </p>
        )}

        <div className={styles['actions']}>
          <Button grow onClick={props.onApply} disabled={state === null || !enabled} busy={busy.has('apply')}>
            {words.reapply}
          </Button>
          <Button variant="primary" grow onClick={props.onOpenRules} busy={busy.has('rules')}>
            {words.manageRules}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Reads the service order now and on every show of the window; an order that cannot be read is `null` (no DEFAULT tag). */
export function followServiceOrder(
  rs: Pick<RsApi, 'getServiceOrder'>,
  deliver: (order: RsServiceOrder | null) => void,
  onShow: ShowSignal,
): ShownReader {
  return readOnShow(
    () => rs.getServiceOrder(),
    (result) => {
      // Unknown order: no DEFAULT tag, nothing else depends on it.
      deliver(result.ok ? result.value : null);
    },
    onShow,
  );
}

export interface MenuBarScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: MenuBarApi & BackupApi & Pick<RsApi, 'getState' | 'onState' | 'getConfig' | 'getServiceOrder' | 'reconnectHelper' | 'installHelper'>;
}

/** The screen of the menu bar window (`?view=popover`). */
export function MenuBarScreen({ rs: given }: MenuBarScreenProps): ReactElement {
  const rs = given ?? window.rs;
  const i18n = useI18n();
  const engine = useEngineState(rs);
  const config = useConfig(rs);
  // The rules backup (TASK-DELTA-16): read on every connection and config revision, and when the popover is shown.
  const backup = useBackup(rs, backupKey(engine));
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

  // The service order decides the DEFAULT tag; it is read again when the interfaces change and
  // whenever the popover is shown again (a new order changes no interface).
  const interfaces = engine.helper === 'connected' ? (engine.state?.interfaces ?? null) : null;
  const key = interfaces === null ? null : interfacesKey(interfaces);
  useEffect(() => {
    if (key === null) {
      setServiceOrder(null);
      return undefined;
    }
    return followServiceOrder(rs, setServiceOrder, browserShowSignal(window, document)).stop;
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
      i18n={i18n}
      backupOffer={backupOffer(engine, config.config, backup.view)}
      onToggle={(next) => {
        run('enabled', () => setRouting(rs, next, i18n));
      }}
      onApply={() => {
        run('apply', () => reapply(rs, i18n));
      }}
      onOpenRules={() => {
        run('rules', () => openRules(rs, i18n));
      }}
      onOpenHelp={() => {
        run('rules', () => openHelp(rs, i18n));
      }}
      onSuggestRule={(request) => {
        run('rules', () => suggestRule(rs, request, i18n));
      }}
      onReloadConfig={() => {
        configStoreFor(rs).reload();
      }}
      onReconnect={() => {
        run('reconnect', () => requestReconnect(rs, i18n));
      }}
      onInstall={() => {
        // One install at a time; the main process would answer a second one `busy`.
        if (!busy.has('install')) run('install', () => installHelper(rs, i18n));
      }}
    />
  );
}
