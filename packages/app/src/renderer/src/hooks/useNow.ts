// The current time for relative and "today" texts ("2 daq oldin", "10:58").
// It ticks while a component listens, and jumps to the present whenever the
// window is shown or focused again: the menu bar window is hidden, not
// closed, so without that a reopened popover would show the time of its
// last render.

import { useSyncExternalStore } from 'react';

/** How often the clock moves while the window stays open. */
export const NOW_TICK_MS = 30_000;

/** What the clock needs from its surroundings; the browser by default, fakes in tests. */
export interface ClockDeps {
  readonly now: () => number;
  /** Calls `tick` every `ms`; returns the function that stops it. */
  readonly every: (ms: number, tick: () => void) => () => void;
  /** Calls `tick` whenever the window is shown or focused; returns the function that stops it. */
  readonly onShow: (tick: () => void) => () => void;
}

export interface NowStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

/** A clock for `useSyncExternalStore`: running only while it has listeners. */
export function createNowStore(deps: ClockDeps, tickMs = NOW_TICK_MS): NowStore {
  let value = deps.now();
  const listeners = new Set<() => void>();
  let stops: (() => void)[] = [];

  const tick = () => {
    const next = deps.now();
    if (next === value) return;
    value = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // A clock that slept while nobody listened is brought to the present first.
        value = deps.now();
        stops = [deps.every(tickMs, tick), deps.onShow(tick)];
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
      };
    },
    getSnapshot: () => value,
  };
}

/** The parts of `window` the clock uses. */
export interface ClockWindow {
  readonly setInterval: (handler: () => void, ms: number) => number;
  readonly clearInterval: (id: number) => void;
  readonly addEventListener: (type: 'focus', listener: () => void) => void;
  readonly removeEventListener: (type: 'focus', listener: () => void) => void;
}

/** The parts of `document` the clock uses. */
export interface ClockDocument {
  readonly visibilityState: DocumentVisibilityState;
  readonly addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  readonly removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
}

/** The clock's wiring to a page: an interval, the window's focus and the document becoming visible. */
export function browserClockDeps(win: ClockWindow, doc: ClockDocument, now: () => number = Date.now): ClockDeps {
  return {
    now,
    every: (ms, tick) => {
      const id = win.setInterval(tick, ms);
      return () => {
        win.clearInterval(id);
      };
    },
    onShow: (tick) => {
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
    },
  };
}

/** Without a page (static rendering in tests) the clock reads the time and never runs. */
const STATIC_DEPS: ClockDeps = { now: () => Date.now(), every: () => () => undefined, onShow: () => () => undefined };

let shared: NowStore | null = null;

/** Milliseconds since the epoch, kept current (every 30 s, and on show / focus). */
export function useNow(store?: NowStore): number {
  const clock =
    store ??
    (shared ??= createNowStore(typeof window === 'undefined' ? STATIC_DEPS : browserClockDeps(window, document)));
  // The third argument serves static rendering (component tests); the app never renders on a server.
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
