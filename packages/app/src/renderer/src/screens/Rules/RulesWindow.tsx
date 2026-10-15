// The rules window (`?view=rules`, 1040×680): a sidebar with the window's
// sections — Qoidalar, Jurnal, Diagnostika, Sozlamalar — and the helper's status, and the
// chosen section beside it. The macOS title bar is the real one, so the
// design's drawn traffic lights are not repeated. The design's "Interfeyslar"
// and "DNS resolverlar" items have no screen in the MVP and are left out.
// "Qoida qo'shish" and a row's "Tahrirlash" open the add-rule form as a modal
// dialog over the window; the window behind it is `inert` until it closes, and
// the focus then returns to the button that opened it.

import { useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import { HelperRecovery, requestReconnect, RouteIcon, StatusDot } from '../../components';
import type { I18n } from '../../../../i18n';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { useI18n } from '../../hooks/useI18n';
import type { RsApi } from '../../rs';
import { helperNotice, helperStatusText, UZ, type Feedback } from '../../text';
import { AddRuleDialog, type RuleEditorTarget } from '../AddRule';
import { DiagnosticsScreen } from '../Diagnostics';
import { useInstall } from '../Install';
import { LogScreen } from '../Log';
import { SettingsScreen } from '../Settings';
import { RulesScreen } from './RulesScreen';
import styles from './RulesWindow.module.css';

export type RulesSection = 'rules' | 'log' | 'diagnostics' | 'settings';

function Svg({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** "Jurnal" icon of the design. */
function LogIcon(): ReactElement {
  return (
    <Svg>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </Svg>
  );
}

/** "Diagnostika" (not in the design): a magnifier, in the stroke of the design's icons. */
function DiagnosticsIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5M8.5 11h5" />
    </Svg>
  );
}

/** "Sozlamalar" icon of the design. */
function SettingsIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </Svg>
  );
}

/** The sidebar's sections, in order; their names are `t.rules.sections`. */
export const SECTIONS: readonly { readonly id: RulesSection; readonly icon: () => ReactElement }[] = [
  { id: 'rules', icon: () => <RouteIcon size={16} /> },
  { id: 'log', icon: LogIcon },
  { id: 'diagnostics', icon: DiagnosticsIcon },
  { id: 'settings', icon: SettingsIcon },
];

/** What a section's screen gets from the window: the way into the add-rule form. */
export interface SectionScreenProps {
  readonly onAddRule: () => void;
  readonly onEditRule: (id: string) => void;
}

/** The screen of each section. */
export const SECTION_SCREENS: Readonly<Record<RulesSection, ComponentType<SectionScreenProps>>> = {
  rules: ({ onAddRule, onEditRule }) => <RulesScreen onAddRule={onAddRule} onEditRule={onEditRule} />,
  log: () => <LogScreen />,
  diagnostics: () => <DiagnosticsScreen />,
  settings: () => <SettingsScreen />,
};

export interface RulesWindowFrameProps {
  readonly section: RulesSection;
  readonly engine: EngineStateView;
  readonly onSelect: (section: RulesSection) => void;
  /** A dialog is open over the window: nothing behind it can be focused or clicked. */
  readonly inert?: boolean;
  /** "Qayta ulanish" of the helper box, shown in every section while the helper is away. */
  readonly onReconnect?: () => void;
  readonly reconnecting?: boolean;
  /** A refused reconnect request. */
  readonly reconnectFeedback?: Feedback | null;
  /** "Helper'ni (qayta) o'rnatish" of the helper box (TASK-214). */
  readonly onInstall?: () => void;
  readonly installing?: boolean;
  /** How the last install ended. */
  readonly installFeedback?: Feedback | null;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n;
  readonly children: ReactNode;
}

/** The sidebar and the section's screen, for given data. */
export function RulesWindowFrame({
  section,
  engine,
  onSelect,
  inert = false,
  onReconnect,
  reconnecting = false,
  reconnectFeedback = null,
  onInstall = () => undefined,
  installing = false,
  installFeedback = null,
  i18n = UZ,
  children,
}: RulesWindowFrameProps): ReactElement {
  const t = i18n.t.rules;
  const helper = helperStatusText(engine.helper, i18n);
  const connection = engine.connection;
  // The same words as the screens' notices, so every section says why and what to do.
  const notice = helperNotice(engine, i18n);
  return (
    <div className={styles['window']} inert={inert || undefined}>
      <aside className={styles['sidebar']}>
        <nav aria-label={t.sectionsNav} className={styles['nav']}>
          {SECTIONS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={styles['item']}
              aria-current={id === section ? 'page' : undefined}
              onClick={() => {
                onSelect(id);
              }}
            >
              <Icon />
              {t.sections[id]}
            </button>
          ))}
        </nav>
        <div className={styles['helper']} role="status">
          <div className={styles['helperTitle']}>
            <StatusDot tone={helper.tone} label={helper.text} size="sm" />
            <span>{helper.text}</span>
          </div>
          {connection?.kind === 'connected' ? <div>{t.helperDaemon(connection.helperVersion)}</div> : null}
          {notice === null || notice.text === '' ? null : <p className={styles['helperText']}>{notice.text}</p>}
          {onReconnect === undefined ? null : (
            <HelperRecovery
              recovery={notice?.recovery ?? null}
              onReconnect={onReconnect}
              reconnecting={reconnecting}
              onInstall={onInstall}
              installing={installing}
              size="sm"
              i18n={i18n}
            />
          )}
          {[reconnectFeedback, installFeedback].map((line, index) =>
            line === null ? null : (
              <p key={index} className={styles['helperText']} data-tone={line.tone} role="alert">
                {line.text}
              </p>
            ),
          )}
        </div>
      </aside>
      <div className={styles['main']}>{children}</div>
    </div>
  );
}

/** The element that had the focus, so it can get it back; null when there is none to return to. */
export function focusedElement(doc: Pick<Document, 'activeElement' | 'body'> | undefined): HTMLElement | null {
  const element = doc?.activeElement ?? null;
  return element === null || element === doc?.body ? null : (element as HTMLElement);
}

/** Gives the focus back to `element` when it is still on the page. */
export function restoreFocus(element: Pick<HTMLElement, 'isConnected' | 'focus'> | null): boolean {
  if (element === null || !element.isConnected) return false;
  element.focus();
  return true;
}

export interface RulesWindowProps {
  /** The section shown first; "Qoidalar" by default. */
  readonly initialSection?: RulesSection;
  readonly screens?: Readonly<Record<RulesSection, ComponentType<SectionScreenProps>>>;
  readonly editorScreen?: ComponentType<{ readonly editor: RuleEditorTarget; readonly onClose: () => void }>;
  /** The preload API; `window.rs` in the app. */
  readonly rs?: Pick<RsApi, 'getState' | 'onState' | 'reconnectHelper' | 'installHelper'>;
}

/** The screen of the rules window (`?view=rules`). */
export function RulesWindow({
  initialSection = 'rules',
  screens = SECTION_SCREENS,
  editorScreen: Editor = AddRuleDialog,
  rs: given,
}: RulesWindowProps): ReactElement {
  const rs = given ?? window.rs;
  const engine = useEngineState(rs);
  const i18n = useI18n();
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectFeedback, setReconnectFeedback] = useState<Feedback | null>(null);
  const reconnect = () => {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectFeedback(null);
    void requestReconnect(rs, i18n).then((line) => {
      setReconnectFeedback(line);
      setReconnecting(false);
    });
  };
  const installing = useInstall(rs);
  const [section, setSection] = useState<RulesSection>(initialSection);
  const [editor, setEditor] = useState<RuleEditorTarget | null>(null);
  // The button that opened the form; it gets the focus back once the window is no longer inert.
  const opener = useRef<HTMLElement | null>(null);
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (!returning) return;
    restoreFocus(opener.current);
    opener.current = null;
    setReturning(false);
  }, [returning]);

  const open = (target: RuleEditorTarget) => {
    opener.current = focusedElement(globalThis.document);
    setEditor(target);
  };
  const close = () => {
    setEditor(null);
    setReturning(true);
  };
  const Screen = screens[section];
  return (
    <>
      <RulesWindowFrame
        section={section}
        engine={engine}
        onSelect={setSection}
        inert={editor !== null}
        onReconnect={reconnect}
        reconnecting={reconnecting}
        reconnectFeedback={reconnectFeedback}
        onInstall={installing.install}
        installing={installing.installing}
        installFeedback={installing.feedback}
        i18n={i18n}
      >
        <Screen
          onAddRule={() => {
            open({ mode: 'add' });
          }}
          onEditRule={(id) => {
            open({ mode: 'edit', id });
          }}
        />
      </RulesWindowFrame>
      {/* Keyed by what it edits: another rule opens a fresh form. */}
      {editor === null ? null : <Editor key={editor.mode === 'edit' ? editor.id : 'add'} editor={editor} onClose={close} />}
    </>
  );
}
