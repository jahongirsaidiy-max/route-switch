import { createConnection, type Socket } from 'node:net';

import { createJsonLinesDecoder, encodeJsonLine, parseServerMessage, type Event, type Response } from '@routeswitch/shared';

/**
 * Test-only client of the helper socket: speaks the protocol line by line and
 * parses every line with `parseServerMessage`, as the app does. Not exported
 * from `index.ts`.
 */
export interface TestClient {
  readonly socket: Socket;
  /** Sends one request object (or raw text, written as is) and waits for the response with its id. */
  request(message: Record<string, unknown>): Promise<Response>;
  /** Writes raw text; responses to it land in `responses`. */
  raw(text: string): void;
  /** Every event received so far. */
  readonly events: Event[];
  /** Every response received so far, in order. */
  readonly responses: Response[];
  /** Lines that did not parse as a server message. */
  readonly invalid: unknown[];
  /** Resolves when the server has closed the connection. */
  readonly closed: Promise<void>;
  /** Waits until `predicate` holds for the received messages, or rejects after `ms`. */
  waitFor(predicate: () => boolean, ms?: number): Promise<void>;
  close(): void;
}

export const connectTestClient = (path: string): Promise<TestClient> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const decoder = createJsonLinesDecoder();
    const events: Event[] = [];
    const responses: Response[] = [];
    const invalid: unknown[] = [];
    const waiters = new Map<number, (response: Response) => void>();
    const checks = new Set<() => void>();
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((done) => {
      markClosed = done;
    });

    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        if (!line.ok) {
          invalid.push(line.error);
          continue;
        }
        const message = parseServerMessage(line.value);
        if (!message.ok) {
          invalid.push(line.value);
          continue;
        }
        if (message.value.kind === 'event') events.push(message.value.event);
        else {
          const { response } = message.value;
          responses.push(response);
          if (response.id !== null) {
            const waiter = waiters.get(response.id);
            waiters.delete(response.id);
            waiter?.(response);
          }
        }
      }
      for (const check of [...checks]) check();
    });
    socket.on('close', () => {
      markClosed();
      for (const check of [...checks]) check();
    });
    socket.on('error', (error) => {
      reject(error);
    });
    socket.once('connect', () => {
      resolve({
        socket,
        events,
        responses,
        invalid,
        closed,
        request: (message) =>
          new Promise<Response>((done) => {
            const id = message['id'];
            if (typeof id === 'number') waiters.set(id, done);
            socket.write(encodeJsonLine(message));
          }),
        raw: (text) => {
          socket.write(text);
        },
        waitFor: (predicate, ms = 2000) =>
          new Promise<void>((done, fail) => {
            const timer = setTimeout(() => {
              checks.delete(check);
              fail(new Error('condition not reached'));
            }, ms);
            const check = (): void => {
              if (!predicate()) return;
              clearTimeout(timer);
              checks.delete(check);
              done();
            };
            checks.add(check);
            check();
          }),
        close: () => {
          socket.destroy();
        },
      });
    });
  });
