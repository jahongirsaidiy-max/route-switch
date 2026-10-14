import type { ReactElement } from 'react';

import type { RsApi } from '../rs';
import { errorText, INSTALL_UNAVAILABLE, type Feedback, type HelperRecovery as Recovery } from '../text';
import { Button } from './Button';
import styles from './HelperRecovery.module.css';

export interface HelperRecoveryProps {
  /** What the helper's status calls for (`helperNotice(…).recovery`). */
  readonly recovery: Recovery | null;
  /** "Qayta ulanish" / "Qayta tekshirish": asks the main process to try the connection now. */
  readonly onReconnect: () => void;
  /** The reconnect request is on its way. */
  readonly reconnecting: boolean;
  /** `sm` for the rules window sidebar. */
  readonly size?: 'md' | 'sm';
}

/**
 * The way out of a helper status: try the connection again, and install the
 * helper — which the app cannot do yet (TASK-214), so that button is shown
 * disabled with the reason in its name. Nothing for `repair-config` (the rules
 * screen offers import and an empty config) or for statuses with nothing to do.
 */
export function HelperRecovery({ recovery, onReconnect, reconnecting, size = 'md' }: HelperRecoveryProps): ReactElement | null {
  if (recovery === null || recovery === 'repair-config') return null;
  const install = recovery === 'reinstall' ? "Helper'ni qayta o'rnatish" : "Helper'ni o'rnatish";
  return (
    <div className={styles['actions']} data-size={size}>
      <Button onClick={onReconnect} busy={reconnecting}>
        {recovery === 'reconnect' ? 'Qayta ulanish' : 'Qayta tekshirish'}
      </Button>
      {recovery === 'reconnect' ? null : (
        // A disabled button is not focusable: the reason is in its name, the wrapper's title shows it on hover.
        <span title={INSTALL_UNAVAILABLE}>
          <Button disabled label={`${install} — ${INSTALL_UNAVAILABLE}`}>
            {install}
          </Button>
        </span>
      )}
    </div>
  );
}

/** "Qayta ulanish": the result arrives as a new connection in `onState`; only a refused call says something. */
export async function requestReconnect(rs: Pick<RsApi, 'reconnectHelper'>): Promise<Feedback | null> {
  const result = await rs.reconnectHelper();
  return result.ok ? null : { tone: 'danger', text: errorText(result.code) };
}
