// How the helper's connection reads: a short status line (rules window
// sidebar, settings screen) and the notice a screen shows in place of its
// content while there is no live state, with the way out of it.

import type { I18n } from '../../../i18n';
import type { EngineStateView } from '../hooks/useEngineState';
import { errorText, UZ } from './errors';

export interface HelperStatusText {
  readonly text: string;
  readonly tone: 'success' | 'warning' | 'danger' | 'neutral';
}

const HELPER_STATUS_TONE: Readonly<Record<EngineStateView['helper'], HelperStatusText['tone']>> = {
  loading: 'neutral',
  connected: 'success',
  connecting: 'warning',
  'not-installed': 'neutral',
  disconnected: 'danger',
  'config-unreadable': 'danger',
  incompatible: 'danger',
  stopped: 'neutral',
  unavailable: 'danger',
};

/** The short status line of a helper status, in the language of `i18n`. */
export function helperStatusText(status: EngineStateView['helper'], i18n: I18n = UZ): HelperStatusText {
  return { text: i18n.t.helperStatus[status], tone: HELPER_STATUS_TONE[status] };
}

/** Every status line in Uzbek (screens that do not pass their language yet). */
export const HELPER_STATUS_TEXT: Readonly<Record<EngineStateView['helper'], HelperStatusText>> = Object.fromEntries(
  Object.keys(HELPER_STATUS_TONE).map((status) => [status, helperStatusText(status as EngineStateView['helper'])]),
) as Record<EngineStateView['helper'], HelperStatusText>;

/**
 * What the user can do about a helper status:
 * - `reconnect`     — try the connection again now ("Qayta ulanish");
 * - `install`       — install the helper (administrator password, `installHelper`);
 * - `reinstall`     — install the matching helper version (the same);
 * - `repair-config` — replace the unreadable stored config: import a file, or start with an empty one.
 */
export type HelperRecovery = 'reconnect' | 'install' | 'reinstall' | 'repair-config';

/** The words of installing the helper from the app (TASK-214), in Uzbek; `i18n.t.install` in a screen's language. */
export const INSTALL_TEXT: I18n['t']['install'] = UZ.t.install;

export interface HelperNotice {
  readonly title: string;
  readonly text: string;
  readonly tone: 'neutral' | 'warning' | 'danger';
  /** The way out; null when there is nothing to do but wait. */
  readonly recovery: HelperRecovery | null;
}

/** The notice while the first snapshot is on its way. */
export const loadingNotice = (i18n: I18n = UZ): HelperNotice => ({ title: i18n.t.notice.loadingTitle, text: '', tone: 'neutral', recovery: null });

export const LOADING_NOTICE: HelperNotice = loadingNotice();

/** The notice for every helper status but `connected`; where it matters it says that applied routes stay with the helper. */
export function helperNotice(engine: EngineStateView, i18n: I18n = UZ): HelperNotice | null {
  const connection = engine.connection;
  const words = i18n.t.notice;
  switch (engine.helper) {
    case 'connected':
      return null;
    case 'loading':
      return loadingNotice(i18n);
    case 'connecting':
      return { title: words.connectingTitle, text: '', tone: 'neutral', recovery: null };
    case 'not-installed':
      return { title: words.notInstalledTitle, text: words.notInstalledText, tone: 'warning', recovery: 'install' };
    case 'disconnected':
      return {
        title: words.disconnectedTitle,
        text: connection?.kind === 'disconnected' ? `${words.disconnected[connection.reason]} ${words.routesStay}` : words.routesStay,
        tone: 'danger',
        recovery: 'reconnect',
      };
    case 'config-unreadable':
      return { title: words.configUnreadableTitle, text: words.configUnreadableText, tone: 'danger', recovery: 'repair-config' };
    case 'incompatible':
      return {
        title: words.incompatibleTitle,
        text:
          connection?.kind === 'incompatible'
            ? words.incompatibleText(connection.helperVersion, connection.protocolVersion, connection.expectedProtocolVersion)
            : words.reinstall,
        tone: 'danger',
        recovery: 'reinstall',
      };
    case 'stopped':
      return { title: words.stoppedTitle, text: '', tone: 'neutral', recovery: null };
    case 'unavailable':
      return {
        title: words.unavailableTitle,
        text: engine.error === null ? '' : errorText(engine.error.code, i18n),
        tone: 'danger',
        recovery: null,
      };
  }
}
