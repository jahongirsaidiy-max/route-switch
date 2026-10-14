// The rules window (`?view=rules`, 1040×680): a sidebar with the window's
// sections — Qoidalar, Jurnal, Sozlamalar — and the helper's status, and the
// chosen section beside it. The macOS title bar is the real one, so the
// design's drawn traffic lights are not repeated. The design's "Interfeyslar"
// and "DNS resolverlar" items have no screen in the MVP and are left out.

import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import { RouteIcon, StatusDot } from '../../components';
import { useEngineState, type EngineStateView } from '../../hooks/useEngineState';
import { HELPER_STATUS_TEXT } from '../../text';
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

/** The screen of each section. */
export const SECTION_SCREENS: Readonly<Record<RulesSection, ComponentType>> = {
  rules: () => <RulesScreen />,
  log: () => <LogScreen />,
  settings: () => <SettingsScreen />,
};

export interface RulesWindowFrameProps {
  readonly section: RulesSection;
  readonly engine: EngineStateView;
  readonly onSelect: (section: RulesSection) => void;
  readonly children: ReactNode;
}

/** The sidebar and the section's screen, for given data. */
export function RulesWindowFrame({ section, engine, onSelect, children }: RulesWindowFrameProps): ReactElement {
  const helper = HELPER_STATUS_TEXT[engine.helper];
  const connection = engine.connection;
  return (
    <div className={styles['window']}>
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
        </div>
      </aside>
      <div className={styles['main']}>{children}</div>
    </div>
  );
}

export interface RulesWindowProps {
  /** The section shown first; "Qoidalar" by default. */
  readonly initialSection?: RulesSection;
  readonly screens?: Readonly<Record<RulesSection, ComponentType>>;
}

/** The screen of the rules window (`?view=rules`). */
export function RulesWindow({ initialSection = 'rules', screens = SECTION_SCREENS }: RulesWindowProps): ReactElement {
  const engine = useEngineState();
  const [section, setSection] = useState<RulesSection>(initialSection);
  const Screen = screens[section];
  return (
    <RulesWindowFrame section={section} engine={engine} onSelect={setSection}>
      <Screen />
    </RulesWindowFrame>
  );
}
