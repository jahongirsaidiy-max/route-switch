// Test doubles for the Electron objects the main process touches. Not part of
// the app: imported by tests only.

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { vi } from 'vitest';

export interface FakeWindow {
  readonly options: BrowserWindowConstructorOptions;
  readonly loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  readonly show: ReturnType<typeof vi.fn<() => void>>;
  readonly focus: ReturnType<typeof vi.fn<() => void>>;
  readonly restore: ReturnType<typeof vi.fn<() => void>>;
  readonly destroy: ReturnType<typeof vi.fn<() => void>>;
  minimized: boolean;
  emit(event: string): void;
  /** Emits a `webContents` event, e.g. `emitContents('did-navigate', {}, url)`. */
  emitContents(event: string, ...args: unknown[]): void;
}

export interface FakeBrowserWindowClass {
  readonly ctor: new (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly windows: FakeWindow[];
}

/** A recording stand-in for the `BrowserWindow` class. `load` decides how `loadURL` settles. */
export function fakeBrowserWindowClass(
  load: (url: string) => Promise<void> = () => Promise.resolve(),
  onConstruct: () => void = () => undefined,
): FakeBrowserWindowClass {
  const windows: FakeWindow[] = [];

  class Recorder implements FakeWindow {
    readonly options: BrowserWindowConstructorOptions;
    readonly loadURL = vi.fn(load);
    readonly show = vi.fn<() => void>();
    readonly focus = vi.fn<() => void>();
    readonly restore = vi.fn<() => void>();
    readonly destroy = vi.fn<() => void>();
    minimized = false;
    private readonly listeners = new Map<string, () => void>();
    private readonly contentsListeners = new Map<string, (...args: unknown[]) => void>();
    readonly webContents = {
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        this.contentsListeners.set(event, listener);
      },
    };

    constructor(options: BrowserWindowConstructorOptions) {
      this.options = options;
      windows.push(this);
      onConstruct();
    }

    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener);
      return this;
    }

    isMinimized(): boolean {
      return this.minimized;
    }

    emit(event: string): void {
      this.listeners.get(event)?.();
    }

    emitContents(event: string, ...args: unknown[]): void {
      const listener = this.contentsListeners.get(event);
      if (listener === undefined) throw new Error(`no webContents listener for ${event}`);
      listener(...args);
    }
  }

  return { ctor: Recorder as unknown as FakeBrowserWindowClass['ctor'], windows };
}
