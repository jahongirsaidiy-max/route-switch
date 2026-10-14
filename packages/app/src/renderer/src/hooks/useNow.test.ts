import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../components/test-utils';
import { NOW_TICK_MS, browserClockDeps, createNowStore, useNow, type ClockDeps, type ClockDocument, type ClockWindow } from './useNow';

function fakeClock(start = 1_000) {
  let time = start;
  const ticks = new Set<() => void>();
  const shows = new Set<() => void>();
  const every = vi.fn((_ms: number, tick: () => void) => {
    ticks.add(tick);
    return () => ticks.delete(tick);
  });
  const deps: ClockDeps = {
    now: () => time,
    every,
    onShow: (tick) => {
      shows.add(tick);
      return () => shows.delete(tick);
    },
  };
  return {
    deps,
    every,
    set: (value: number) => {
      time = value;
    },
    tick: () => {
      for (const tick of [...ticks]) tick();
    },
    show: () => {
      for (const show of [...shows]) show();
    },
    running: () => ticks.size + shows.size,
  };
}

describe('createNowStore', () => {
  it('moves on every tick while someone listens, every 30 s by default', () => {
    const clock = fakeClock();
    const store = createNowStore(clock.deps);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(clock.every).toHaveBeenCalledWith(NOW_TICK_MS, expect.any(Function));
    clock.set(31_000);
    clock.tick();
    expect(store.getSnapshot()).toBe(31_000);
    expect(listener).toHaveBeenCalledTimes(1);
    // The same time again is no change.
    clock.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('jumps to the present when the window is shown or focused again (popover reopened)', () => {
    const clock = fakeClock();
    const store = createNowStore(clock.deps);
    store.subscribe(() => undefined);
    clock.set(3_600_000);
    clock.show();
    expect(store.getSnapshot()).toBe(3_600_000);
  });

  it('stops with the last listener and starts at the present with the next one', () => {
    const clock = fakeClock();
    const store = createNowStore(clock.deps);
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);
    first();
    expect(clock.running()).toBe(2);
    second();
    second();
    expect(clock.running()).toBe(0);
    clock.set(99_000);
    store.subscribe(() => undefined);
    expect(store.getSnapshot()).toBe(99_000);
    expect(clock.running()).toBe(2);
  });
});

describe('useNow', () => {
  it('renders the store’s time', () => {
    const clock = fakeClock(42);
    const store = createNowStore(clock.deps);
    function Probe(): ReactElement {
      return createElement('p', null, useNow(store));
    }
    expect(renderMarkup(createElement(Probe))).toBe('<p>42</p>');
  });
});

describe('browserClockDeps (window / document wiring)', () => {
  function fakePage() {
    const listeners = { focus: new Set<() => void>(), visibilitychange: new Set<() => void>() };
    const win: ClockWindow & { cleared: number[] } = {
      cleared: [],
      setInterval: vi.fn(() => 7),
      clearInterval: vi.fn((id: number) => {
        win.cleared.push(id);
      }),
      addEventListener: vi.fn((_type: 'focus', listener: () => void) => {
        listeners.focus.add(listener);
      }),
      removeEventListener: vi.fn((_type: 'focus', listener: () => void) => {
        listeners.focus.delete(listener);
      }),
    };
    const doc: { -readonly [K in keyof ClockDocument]: ClockDocument[K] } = {
      visibilityState: 'visible',
      addEventListener: vi.fn((_type: 'visibilitychange', listener: () => void) => {
        listeners.visibilitychange.add(listener);
      }),
      removeEventListener: vi.fn((_type: 'visibilitychange', listener: () => void) => {
        listeners.visibilitychange.delete(listener);
      }),
    };
    return { win, doc, listeners };
  }

  it('the interval is set with the period and cleared with its own id', () => {
    const page = fakePage();
    const tick = vi.fn();
    const stop = browserClockDeps(page.win, page.doc).every(30_000, tick);
    expect(page.win.setInterval).toHaveBeenCalledWith(tick, 30_000);
    stop();
    expect(page.win.cleared).toEqual([7]);
  });

  it('focus ticks; the very same listeners are removed on stop', () => {
    const page = fakePage();
    const tick = vi.fn();
    const stop = browserClockDeps(page.win, page.doc).onShow(tick);
    expect(page.listeners.focus.size).toBe(1);
    expect(page.listeners.visibilitychange.size).toBe(1);
    for (const listener of page.listeners.focus) listener();
    expect(tick).toHaveBeenCalledTimes(1);
    const added = vi.mocked(page.win.addEventListener).mock.calls[0]?.[1];
    const addedVisibility = vi.mocked(page.doc.addEventListener).mock.calls[0]?.[1];
    stop();
    expect(page.win.removeEventListener).toHaveBeenCalledWith('focus', added);
    expect(page.doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', addedVisibility);
    expect(page.listeners.focus.size).toBe(0);
    expect(page.listeners.visibilitychange.size).toBe(0);
  });

  it('becoming visible ticks; becoming hidden does not', () => {
    const page = fakePage();
    const tick = vi.fn();
    browserClockDeps(page.win, page.doc).onShow(tick);
    const fire = () => {
      for (const listener of page.listeners.visibilitychange) listener();
    };
    page.doc.visibilityState = 'hidden';
    fire();
    expect(tick).not.toHaveBeenCalled();
    page.doc.visibilityState = 'visible';
    fire();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('now is the given clock', () => {
    const page = fakePage();
    expect(browserClockDeps(page.win, page.doc, () => 5).now()).toBe(5);
  });
});
