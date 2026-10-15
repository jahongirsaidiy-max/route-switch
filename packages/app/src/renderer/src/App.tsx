// One renderer, two windows. The main process opens every window on the same
// page and names the screen in the `view` query parameter
// (`src/main/windows.ts`: `viewUrl`, `WindowView`); this picks the screen.

import './styles/global.css';

import type { ComponentType, ReactElement } from 'react';

import styles from './App.module.css';
import { MenuBarScreen } from './screens/MenuBar';
import { RulesWindow } from './screens/Rules';

/** The screens a window can show; the same values as `WindowView` in the main process. */
export const VIEWS = ['popover', 'rules'] as const;
export type View = (typeof VIEWS)[number];

const VIEW_PARAM = 'view';

/**
 * The view a page URL's query names, or null when it names none, an unknown
 * one, or more than one (`?view=a&view=b` is not something the main process
 * produces, so it is not guessed at).
 */
export function parseView(search: string): View | null {
  const values = new URLSearchParams(search).getAll(VIEW_PARAM);
  if (values.length !== 1) return null;
  const [value] = values;
  return VIEWS.find((view) => view === value) ?? null;
}

/** Window titles, as the design names the screens. */
export const VIEW_TITLES: Readonly<Record<View, string>> = {
  popover: 'Menu bar oynasi',
  rules: 'Qoidalar oynasi',
};

/** The screen component of each view. */
export const SCREENS: Readonly<Record<View, ComponentType>> = {
  popover: MenuBarScreen,
  rules: RulesWindow,
};

export interface AppProps {
  /** The page URL's query; `window.location.search` in the app. */
  readonly search?: string;
  readonly screens?: Readonly<Record<View, ComponentType>>;
}

export function App({ search = window.location.search, screens = SCREENS }: AppProps): ReactElement {
  const view = parseView(search);
  if (view === null) {
    return (
      <main className={styles['root']} data-view="unknown">
        <div className={styles['placeholder']} role="alert">
          <h1 className={styles['title']}>RouteSwitch</h1>
          <p className={styles['subtitle']}>Noma'lum oyna. Ilovani menu bar ikonkasidan qayta oching.</p>
        </div>
      </main>
    );
  }
  const Screen = screens[view];
  return (
    <main className={styles['root']} data-view={view}>
      <Screen />
    </main>
  );
}
