// The rules window (`?view=rules`, 1040×680): a sidebar with the window's
// sections — Qoidalar, Jurnal, Sozlamalar — and the helper's status, and the
// chosen section beside it. The macOS title bar is the real one, so the
// design's drawn traffic lights are not repeated. The design's "Interfeyslar"
// and "DNS resolverlar" items have no screen in the MVP and are left out.
// "Qoida qo'shish" and a row's "Tahrirlash" open the add-rule form as a modal
// dialog over the window; the window behind it is `inert` until it closes, and
// the focus then returns to the button that opened it.

import { useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import { HelperRecovery, requestReconnect, RouteIcon, StatusDot } from '../../components';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import type { RsApi } from '../../rs';
import { HELPER_STATUS_TEXT, helperNotice, type Feedback } from '../../text';
import { AddRuleDialog, type RuleEditorTarget } from '../AddRule';
import { LogScreen } from '../Log';
import { SettingsScreen } from '../Settings';
import { RulesScreen } from './RulesScreen';
import styles from './RulesWindow.module.css';

export type RulesSection = 'rules' | 'log' | 'settings';

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

/** "Sozlamalar" icon of the design. */
function SettingsIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </Svg>
  );
}

export const SECTIONS: readonly { readonly id: RulesSection; readonly label: string; readonly icon: () => ReactElement }[] = [
  { id: 'rules', label: 'Qoidalar', icon: () => <RouteIcon size={16} /> },
  { id: 'log', label: 'Jurnal', icon: LogIcon },
  { id: 'settings', label: 'Sozlamalar', icon: SettingsIcon },
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
  children,
}: RulesWindowFrameProps): ReactElement {
  const helper = HELPER_STATUS_TEXT[engine.helper];
  const connection = engine.connection;
  // The same words as the screens' notices, so every section says why and what to do.
  const notice = helperNotice(engine);
  return (
    <div className={styles['window']} inert={inert || undefined}>
      <aside className={styles['sidebar']}>
        <nav aria-label="Bo'limlar" className={styles['nav']}>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
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
              {label}
            </button>
          ))}
        </nav>
        <div className={styles['helper']} role="status">
          <div className={styles['helperTitle']}>
            <StatusDot tone={helper.tone} label={helper.text} size="sm" />
            <span>{helper.text}</span>
          </div>
          {connection?.kind === 'connected' ? <div>root daemon · v{connection.helperVersion}</div> : null}
          {notice === null || notice.text === '' ? null : <p className={styles['helperText']}>{notice.text}</p>}
          {onReconnect === undefined ? null : (
            <HelperRecovery recovery={notice?.recovery ?? null} onReconnect={onReconnect} reconnecting={reconnecting} size="sm" />
          )}
          {reconnectFeedback === null ? null : (
            <p className={styles['helperText']} data-tone={reconnectFeedback.tone} role="alert">
              {reconnectFeedback.text}
            </p>
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
  readonly rs?: Pick<RsApi, 'getState' | 'onState' | 'reconnectHelper'>;
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
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectFeedback, setReconnectFeedback] = useState<Feedback | null>(null);
  const reconnect = () => {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectFeedback(null);
    void requestReconnect(rs).then((line) => {
      setReconnectFeedback(line);
      setReconnecting(false);
    });
  };
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
