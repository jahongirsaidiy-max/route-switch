import { chmodSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertFsGuardInstalled } from './test-fs-guard-check';
import { UNINSTALL_REPLY_TIMEOUT_MS, requestUninstall, type UninstallClientOptions } from './uninstall-client';

// Sockets in a temporary directory: never without the guard of the test setup.
assertFsGuardInstalled();

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const socketPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'routeswitch-uninstall-client-'));
  dirs.push(dir);
  return join(dir, 's.sock');
};

/** A helper stand-in: records every line it receives and answers with `answer(line, socket)`. */
const listen = async (path: string, answer: (line: string, socket: Socket) => void): Promise<{ lines: string[] }> => {
  const lines: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        lines.push(line);
        answer(line, socket);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { lines };
};

/** Real timers would make the timeout test wait a minute: this one fires on demand. */
const manualTimer = (): Pick<UninstallClientOptions, 'setTimer' | 'clearTimer'> & { fire(): void; delays: number[]; cleared: number } => {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  const timer = {
    delays,
    cleared: 0,
    setTimer: (callback: () => void, delayMs: number): unknown => {
      next += 1;
      pending.set(next, callback);
      delays.push(delayMs);
      return next;
    },
    clearTimer: (handle: unknown): void => {
      if (typeof handle === 'number' && pending.delete(handle)) timer.cleared += 1;
    },
    fire: (): void => {
      for (const [handle, callback] of [...pending]) {
        pending.delete(handle);
        callback();
      }
    },
  };
  return timer;
};

describe('requestUninstall', () => {
  it('sends one uninstall request and reports the confirmation, past events and unreadable lines', async () => {
    const path = socketPath();
    const helper = await listen(path, (_line, socket) => {
      socket.write('not json\n');
      socket.write(`${JSON.stringify({ event: 'log', level: 'info', msg: 'x', at: '2026-10-14T08:30:00.000Z' })}\n`);
      socket.write(`${JSON.stringify({ id: 7, ok: true, result: {} })}\n`);
      socket.write(`${JSON.stringify({ id: 1, ok: true, result: {} })}\n`);
    });
    const timer = manualTimer();

    expect(await requestUninstall({ socketPath: path, ...timer })).toEqual({ kind: 'done' });
    expect(helper.lines).toEqual([JSON.stringify({ id: 1, method: 'uninstall' })]);
    expect(timer.delays).toEqual([UNINSTALL_REPLY_TIMEOUT_MS]);
    expect(timer.cleared).toBe(1);
  });

  it('waits 60 s by default, like the app', () => {
    expect(UNINSTALL_REPLY_TIMEOUT_MS).toBe(60_000);
  });

  it('reports an error answer with its code, on one bounded line', async () => {
    const path = socketPath();
    await listen(path, (_line, socket) => {
      socket.write(`${JSON.stringify({ id: 1, ok: false, code: 'operation-failed', error: `cleanup\nfailed\u001b[2J${'x'.repeat(400)}` })}\n`);
    });
    const reply = await requestUninstall({ socketPath: path, ...manualTimer() });
    expect(reply).toMatchObject({ kind: 'refused', code: 'operation-failed' });
    const error = reply.kind === 'refused' ? reply.error : '';
    expect(error.startsWith('cleanup failed [2J')).toBe(true);
    expect(error).toHaveLength(300);
    expect(Array.from(error, (char) => char.codePointAt(0) ?? 0).filter((code) => code < 0x20 || code === 0x7f)).toEqual([]);
  });

  it('says that no helper runs when the socket does not exist', async () => {
    const timer = manualTimer();
    expect(await requestUninstall({ socketPath: socketPath(), ...timer })).toEqual({ kind: 'no-helper', code: 'ENOENT' });
    expect(timer.cleared).toBe(1);
  });

  it('says that no helper runs when nobody listens on a socket file left behind', async () => {
    const path = socketPath();
    const ghost = createServer();
    await new Promise<void>((resolve) => ghost.listen(path, resolve));
    // Node removes the file on close: keep it aside, close, put it back without a listener.
    renameSync(path, `${path}.keep`);
    await new Promise<void>((resolve) => {
      ghost.close(() => {
        resolve();
      });
    });
    renameSync(`${path}.keep`, path);
    expect(await requestUninstall({ socketPath: path, ...manualTimer() })).toEqual({ kind: 'no-helper', code: 'ECONNREFUSED' });
  });

  it('fails (not "no helper") when the socket refuses this user', async () => {
    const path = socketPath();
    await listen(path, () => undefined);
    chmodSync(path, 0o000);
    expect(await requestUninstall({ socketPath: path, ...manualTimer() })).toEqual({ kind: 'failed', reason: 'connect-error', code: 'EACCES' });
  });

  it('fails after the timeout when the helper never answers, and closes the connection', async () => {
    const path = socketPath();
    let closed = false;
    const server = createServer((socket) => {
      // Read (and drop) the request: a paused socket never sees the end of the connection.
      socket.resume();
      socket.on('close', () => {
        closed = true;
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const timer = manualTimer();
    const reply = requestUninstall({ socketPath: path, ...timer });
    await new Promise((resolve) => setTimeout(resolve, 50));
    timer.fire();
    expect(await reply).toEqual({ kind: 'failed', reason: 'timeout', code: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it('fails when the helper closes the connection without an answer', async () => {
    const path = socketPath();
    await listen(path, (_line, socket) => {
      socket.write(`${JSON.stringify({ id: 2, ok: true, result: {} })}\n`);
      socket.end();
    });
    expect(await requestUninstall({ socketPath: path, ...manualTimer() })).toEqual({ kind: 'failed', reason: 'closed', code: null });
  });

  it('fails when the connection cannot even be opened', async () => {
    const reply = await requestUninstall({
      socketPath: '/nonexistent',
      ...manualTimer(),
      connect: () => {
        throw Object.assign(new Error('boom'), { code: 'EMFILE' });
      },
    });
    expect(reply).toEqual({ kind: 'failed', reason: 'connect-error', code: 'EMFILE' });
  });
});
