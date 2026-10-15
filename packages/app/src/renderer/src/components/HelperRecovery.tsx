import type { ReactElement } from 'react';

import type { I18n } from '../../../i18n';
import type { RsApi } from '../rs';
import { errorText, UZ, type Feedback, type HelperRecovery as Recovery } from '../text';
import { Button } from './Button';
import styles from './HelperRecovery.module.css';

export interface HelperRecoveryProps {
  /** What the helper's status calls for (`helperNotice(…).recovery`). */
  readonly recovery: Recovery | null;
  /** "Qayta ulanish" / "Qayta tekshirish": asks the main process to try the connection now. */
  readonly onReconnect: () => void;
  /** The reconnect request is on its way. */
  readonly reconnecting: boolean;
  /** "Helper'ni o'rnatish" / "Helper'ni qayta o'rnatish": the administrator password, then the app's install script (TASK-214). */
  readonly onInstall: () => void;
  /** The install runs (password dialog, script); the button is busy, not disabled, and a hint says what is happening. */
  readonly installing: boolean;
  /** `sm` for the rules window sidebar. */
  readonly size?: 'md' | 'sm';
  /**
   * The UI language (`useI18n()` of the screen); Uzbek when not given. A prop,
   * not the context: screen tests render components by calling them, outside React.
   */
  readonly i18n?: I18n | undefined;
}

/**
 * The way out of a helper status: try the connection again, and install (or
 * reinstall) the helper. Nothing for `repair-config` (the rules screen offers
 * import and an empty config) or for statuses with nothing to do.
 */
export function HelperRecovery({
  recovery,
  onReconnect,
  reconnecting,
  onInstall,
  installing,
  size = 'md',
  i18n = UZ,
}: HelperRecoveryProps): ReactElement | null {
  if (recovery === null || recovery === 'repair-config') return null;
  const { install, components } = i18n.t;
  return (
    <div className={styles['actions']} data-size={size}>
      <Button onClick={onReconnect} busy={reconnecting}>
        {recovery === 'reconnect' ? components.recovery.reconnect : components.recovery.recheck}
      </Button>
      {recovery === 'reconnect' ? null : (
        <Button variant="primary" onClick={onInstall} busy={installing}>
          {recovery === 'reinstall' ? install.reinstall : install.install}
        </Button>
      )}
      {installing ? (
        <p className={styles['hint']} role="status">
          {install.waiting}
        </p>
      ) : null}
    </div>
  );
}

/** "Qayta ulanish": the result arrives as a new connection in `onState`; only a refused call says something. */
export async function requestReconnect(rs: Pick<RsApi, 'reconnectHelper'>, i18n: I18n = UZ): Promise<Feedback | null> {
  const result = await rs.reconnectHelper();
  return result.ok ? null : { tone: 'danger', text: errorText(result.code, i18n) };
}
