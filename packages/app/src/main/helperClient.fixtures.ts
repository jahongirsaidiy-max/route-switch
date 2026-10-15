// Test fixtures for the helper client: protocol messages a real helper would
// send, a fake socket and a fake scheduler. Imported by tests only.

import { PROTOCOL_VERSION, type Config, type EngineState } from '@routeswitch/shared';

import type { HelperSocket } from './helperClient';
import { createLogger, type LogEntry, type Logger } from './logger';

export const RULE_ID = '0b7c1c6e-7d2f-4b53-9c44-0d7f7b6f3a10';

const DOWN = { device: null, ip: null, gateway: null, up: false } as const;

export const engineState = (seq: number, configRevision = 1, extra: Partial<EngineState> = {}): EngineState => ({
  helperVersion: '1.2.3',
  seq,
  configRevision,
  enabled: true,
  interfaces: { ethernet: { device: 'en5', ip: '10.0.0.5', gateway: '10.0.0.1', up: true }, wifi: DOWN },
  adapters: [{ device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.0.0.5' }],
  rules: [],
  lastApplyAt: '2026-01-02T03:04:05.000Z',
  lastReconcileReason: 'startup',
  ...extra,
});

export const emptyConfig = (): Config => ({ version: 1, enabled: true, rules: [] });

export const oneRuleConfig = (): Config => ({
  version: 1,
  enabled: true,
  rules: [{ id: RULE_ID, enabled: true, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', refreshSec: 600 }],
});

export const statusResult = (state: EngineState, protocolVersion: number = PROTOCOL_VERSION) => ({
  protocolVersion,
  helperVersion: state.helperVersion,
  state,
});

export const ok = (id: number, result: Record<string, unknown>) => ({ id, ok: true, result });
export const refused = (id: number | null, error: string, code?: string) =>
  code === undefined ? { id, ok: false, error } : { id, ok: false, error, code };

type Listener = (...args: never[]) => void;

export class FakeSocket implements HelperSocket {
  readonly written: string[] = [];
  writableLength = 0;
  destroyed = false;
  /** When set, `write` throws it — a socket that was destroyed under the client. */
  writeError: Error | null = null;
  /** Lines written after `destroy()` — always a bug in the client. */
  writesAfterDestroy = 0;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  write(data: string): boolean {
    if (this.writeError !== null) throw this.writeError;
    if (this.destroyed) this.writesAfterDestroy += 1;
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  emit(event: 'connect' | 'close'): void;
  emit(event: 'error', error: Error): void;
  emit(event: 'data', chunk: string | Uint8Array): void;
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  }

  /** Delivers one message as the helper would: one JSON line. */
  receive(message: unknown): void {
    this.emit('data', `${JSON.stringify(message)}\n`);
  }

  /** Every request written so far, parsed. */
  requests(): { id: number; method: string; [key: string]: unknown }[] {
    return this.written.map((line) => JSON.parse(line) as { id: number; method: string });
  }

  lastRequest(): { id: number; method: string; [key: string]: unknown } {
    const last = this.requests().at(-1);
    if (last === undefined) throw new Error('nothing was written to the socket');
    return last;
  }
}

export const socketError = (code: string): Error => Object.assign(new Error(code), { code });

export interface FakeScheduler {
  now: number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Moves the clock forward, running every timer that falls due, in order. */
  readonly advance: (ms: number) => void;
  /** Delays, from now, of the timers still scheduled. */
  readonly pending: () => number[];
}

export function fakeScheduler(): FakeScheduler {
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: FakeScheduler = {
    now: 0,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: scheduler.now + delayMs, callback });
      return handle;
    },
    clearTimer: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
    advance: (ms) => {
      const end = scheduler.now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        scheduler.now = due[1].at;
        due[1].callback();
      }
      scheduler.now = end;
    },
    pending: () => [...timers.values()].map((timer) => timer.at - scheduler.now).sort((a, b) => a - b),
  };
  return scheduler;
}

/** Lets promise continuations (the handshake's awaits) run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function memoryLogger(now: () => number = () => 0): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: createLogger({ sink: (entry) => entries.push(entry), now, minLevel: 'debug' }), entries };
}
