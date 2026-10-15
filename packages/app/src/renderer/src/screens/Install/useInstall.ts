// The install button's state for a screen that has no action runner of its
// own (the rules window sidebar): one install at a time, and its message.

import { useCallback, useState } from 'react';

import type { Feedback } from '../../text';
import { installHelper, type InstallApi } from './actions';

export interface InstallState {
  readonly installing: boolean;
  readonly feedback: Feedback | null;
  /** Starts an install; ignored while one runs (the main process would answer `busy`). */
  readonly install: () => void;
}

export function useInstall(rs: InstallApi): InstallState {
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const install = useCallback(() => {
    if (installing) return;
    setInstalling(true);
    setFeedback(null);
    void installHelper(rs).then((line) => {
      setFeedback(line);
      setInstalling(false);
    });
  }, [rs, installing]);
  return { installing, feedback, install };
}
