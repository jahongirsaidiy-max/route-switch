// The window being shown or focused again. The app's windows are hidden, not
// closed (the menu bar window always), so what a screen read when it opened
// can be stale by the time it is seen again: the clock (`useNow`) and the
// network service order (the DEFAULT tag) are brought up to date on this
// signal. The order changes without any interface changing — someone runs
// `networksetup -ordernetworkservices` — so nothing else would tell.

/** Calls `tick` whenever the window is shown or focused; returns the function that stops it. */
export type ShowSignal = (tick: () => void) => () => void;

/** The parts of `window` the signal uses. */
export interface ShowWindow {
  readonly addEventListener: (type: 'focus', listener: () => void) => void;
  readonly removeEventListener: (type: 'focus', listener: () => void) => void;
}

/** The parts of `document` the signal uses. */
export interface ShowDocument {
  readonly visibilityState: DocumentVisibilityState;
  readonly addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  readonly removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
}

/** The signal of a page: the window's focus and the document becoming visible. */
export function browserShowSignal(win: ShowWindow, doc: ShowDocument): ShowSignal {
  return (tick) => {
    // Hidden → visible ticks; becoming hidden does not.
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') tick();
    };
    win.addEventListener('focus', tick);
    doc.addEventListener('visibilitychange', onVisibility);
    return () => {
      win.removeEventListener('focus', tick);
      doc.removeEventListener('visibilitychange', onVisibility);
    };
  };
}

/** Why a read runs: the first one, a "Yangilash" button, the window shown again. */
export type ReadCause = 'start' | 'refresh' | 'show';

export interface ShownReader {
  /** Reads again now (a "Yangilash" button). */
  readonly refresh: () => void;
  /** Stops listening; the answer of a read in flight is dropped. */
  readonly stop: () => void;
}

/**
 * Reads now and again whenever the window is shown. Reads may overlap (a show
 * while one is in flight, a refresh): only the answer to the latest is
 * delivered, so a slow stale answer never overwrites a newer one. `read` is
 * told why it runs, so a screen can keep a background (show) read quiet.
 */
export function readOnShow<T>(
  read: (cause: ReadCause) => Promise<T>,
  deliver: (value: T) => void,
  onShow: ShowSignal,
): ShownReader {
  let generation = 0;
  const readFor = (cause: ReadCause) => {
    const mine = ++generation;
    void read(cause).then((value) => {
      if (mine === generation) deliver(value);
    });
  };
  readFor('start');
  const unlisten = onShow(() => {
    readFor('show');
  });
  return {
    refresh: () => {
      readFor('refresh');
    },
    stop: () => {
      generation += 1;
      unlisten();
    },
  };
}
