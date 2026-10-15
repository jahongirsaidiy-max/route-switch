// One renderer, two windows. The main process opens every window on the same
// page and names the screen in the `view` query parameter
// (`src/main/windows.ts`: `viewUrl`, `WindowView`); this picks the screen.

import './styles/global.css';

import type { ComponentType, ReactElement } from 'react';

import type { Locale } from '../../i18n';
import styles from './App.module.css';
import { I18nProvider, useI18n, type LanguageApi } from './hooks/useI18n';
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
  /** The preload API for the UI language; `window.rs` in the app. */
  readonly rs?: LanguageApi;
  /** A fixed UI language instead of the stored one (tests). */
  readonly language?: Locale;
}

/** The page: the screen of its window, in the UI language (TASK-DELTA-11) — every window follows a change at once. */
export function App({ search = window.location.search, screens = SCREENS, rs, language }: AppProps): ReactElement {
  return (
    <I18nProvider rs={rs} language={language}>
      <AppView search={search} screens={screens} />
    </I18nProvider>
  );
}

function AppView({ search, screens }: { readonly search: string; readonly screens: Readonly<Record<View, ComponentType>> }): ReactElement {
  const { t } = useI18n();
  const view = parseView(search);
  if (view === null) {
    return (
      <main className={styles['root']} data-view="unknown">
        <div className={styles['placeholder']} role="alert">
          <h1 className={styles['title']}>RouteSwitch</h1>
          <p className={styles['subtitle']}>{t.unknownWindow}</p>
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
