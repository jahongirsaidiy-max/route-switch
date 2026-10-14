// The journal's memory: the last `LOG_BUFFER_CAPACITY` entries — `log` events
// of the helper and the app's own events about the helper connection — kept in the main process for the whole life of the app, so a window
// opened later still shows what happened before it (the helper replays
// nothing). Each entry gets a sequence number; a renderer that reads the
// history and listens for new entries at the same time uses it to drop the
// overlap.

import type { LogEvent } from '@routeswitch/shared';

import type { RsLogEntry } from '../renderer/src/rs';

/** How many entries the journal keeps (RouteSwitch.md §Electron ilova — Jurnal). */
export const LOG_BUFFER_CAPACITY = 500;

/** One journal line, as the renderer receives it (`window.rs.getLog` / `onLog`). */
export type LogEntry = RsLogEntry;

export type LogListener = (entry: LogEntry) => void;

export interface LogBuffer {
  /**
   * Stores the event as the newest entry, dropping the oldest beyond the
   * capacity, and tells the listeners. `source: 'app'` marks the app's own
   * entries; nothing else of the event is kept.
   */
  readonly push: (event: Pick<LogEvent, 'level' | 'msg' | 'at'> & { readonly source?: 'app' }) => LogEntry;
  /** The kept entries, oldest first. A new array each call. */
  readonly entries: () => readonly LogEntry[];
  /** Called with every entry pushed after subscribing. Returns the unsubscribe function. */
  readonly subscribe: (listener: LogListener) => () => void;
}

export interface LogBufferOptions {
  readonly capacity?: number;
  /** Called when a listener throws (to log it); the other listeners and the buffer carry on. */
  readonly onListenerError: (error: unknown) => void;
}

export function createLogBuffer(options: LogBufferOptions): LogBuffer {
  const capacity = options.capacity ?? LOG_BUFFER_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('The log buffer capacity must be a positive integer');

  // A ring: `start` is the index of the oldest entry once the ring is full.
  const ring: LogEntry[] = [];
  let start = 0;
  let seq = 0;
  const listeners = new Set<LogListener>();

  return {
    push(event) {
      seq += 1;
      const entry: LogEntry =
        event.source === 'app'
          ? { seq, level: event.level, msg: event.msg, at: event.at, source: 'app' }
          : { seq, level: event.level, msg: event.msg, at: event.at };
      if (ring.length < capacity) {
        ring.push(entry);
      } else {
        ring[start] = entry;
        start = (start + 1) % capacity;
      }
      for (const listener of [...listeners]) {
        try {
          listener(entry);
        } catch (error) {
          options.onListenerError(error);
        }
      }
      return entry;
    },
    entries: () => [...ring.slice(start), ...ring.slice(0, start)],
    subscribe(listener) {
      // Wrapped, so the same function subscribed twice is two subscriptions.
      const own: LogListener = (entry) => {
        listener(entry);
      };
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
  };
}
