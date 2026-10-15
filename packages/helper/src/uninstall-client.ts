import { createConnection, type Socket } from 'node:net';

import { createJsonLinesDecoder, encodeJsonLine, parseServerMessage } from '@routeswitch/shared';

import type { ClearTimer, SetTimer } from './dns';

/**
 * The `uninstall` request of `com.routeswitch.helper --uninstall` (TASK-115),
 * sent by `scripts/uninstall.sh` to the helper that runs under launchd BEFORE
 * the script boots it out: the running helper removes every route and managed
 * resolver file it applied and answers, so the script knows the cleanup
 * succeeded before it deletes `state.json`. The client only ever sends this
 * one request; it never forwards anything else to the root daemon.
 */

/**
 * How long the client waits for the answer. The helper answers within 55 s
 * (`UNINSTALL_REPLY_DEADLINE_MS` in `server.ts`) after its queued changes; the
 * app waits 60 s as well.
 */
export const UNINSTALL_REPLY_TIMEOUT_MS = 60_000;

/** The id of the one request the client sends. */
const REQUEST_ID = 1;

/** Longest helper error text passed on to the terminal. */
const MAX_ERROR_TEXT = 300;

export type UninstallReply =
  /** The helper removed everything and answered `{}`. */
  | { readonly kind: 'done' }
  /** The helper answered with an error: something could not be removed (its log says what). */
  | { readonly kind: 'refused'; readonly code: string | null; readonly error: string }
  /** Nothing listens on the socket (`ENOENT`, `ECONNREFUSED`): no helper is running. */
  | { readonly kind: 'no-helper'; readonly code: string }
  /** No usable answer: timeout, closed without an answer, connection refused for another reason. */
  | { readonly kind: 'failed'; readonly reason: 'timeout' | 'closed' | 'connect-error'; readonly code: string | null };

export interface UninstallClientOptions {
  readonly socketPath: string;
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  /** Defaults to `UNINSTALL_REPLY_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** Opens the connection; defaults to `net.createConnection`. */
  readonly connect?: ((path: string) => Socket) | undefined;
}

const NO_LISTENER_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);

const errorCodeOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
};

/** The helper's own fixed-text error, on one line and bounded, for the terminal. */
const printable = (text: string): string => {
  let flattened = '';
  for (const char of text.slice(0, MAX_ERROR_TEXT)) {
    const code = char.codePointAt(0) ?? 0;
    flattened += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return flattened;
};

/** Sends `uninstall` over the helper socket and waits for its answer. Never rejects. */
export const requestUninstall = (options: UninstallClientOptions): Promise<UninstallReply> =>
  new Promise<UninstallReply>((resolve) => {
    const connect = options.connect ?? ((path: string) => createConnection({ path }));
    const decoder = createJsonLinesDecoder();
    let connected = false;
    let settled = false;
    let socket: Socket | null = null;

    const settle = (reply: UninstallReply): void => {
      if (settled) return;
      settled = true;
      options.clearTimer(timer);
      socket?.destroy();
      resolve(reply);
    };

    const timer = options.setTimer(() => {
      settle({ kind: 'failed', reason: 'timeout', code: null });
    }, options.timeoutMs ?? UNINSTALL_REPLY_TIMEOUT_MS);

    let connection: Socket;
    try {
      connection = connect(options.socketPath);
    } catch (error) {
      settle({ kind: 'failed', reason: 'connect-error', code: errorCodeOf(error) });
      return;
    }
    socket = connection;

    connection.on('connect', () => {
      connected = true;
      connection.write(encodeJsonLine({ id: REQUEST_ID, method: 'uninstall' }));
    });
    connection.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        // State and log events, and anything unreadable, are not the answer: keep waiting for it.
        if (!line.ok) continue;
        const message = parseServerMessage(line.value);
        if (!message.ok || message.value.kind !== 'response') continue;
        const { response } = message.value;
        if (response.id !== REQUEST_ID) continue;
        if (response.ok) settle({ kind: 'done' });
        else settle({ kind: 'refused', code: response.code ?? null, error: printable(response.error) });
        return;
      }
    });
    connection.on('error', (error) => {
      const code = errorCodeOf(error);
      if (!connected && code !== null && NO_LISTENER_CODES.has(code)) settle({ kind: 'no-helper', code });
      else settle({ kind: 'failed', reason: connected ? 'closed' : 'connect-error', code });
    });
    connection.on('close', () => {
      settle({ kind: 'failed', reason: 'closed', code: null });
    });
  });
