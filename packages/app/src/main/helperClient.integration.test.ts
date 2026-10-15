// The client against a real Unix domain socket and a tiny helper stand-in that
// speaks the real codec. Sockets live in a fresh directory under the system
// temp directory and are removed afterwards. Nothing here sleeps: every step
// waits for an event.

import { link, mkdtemp, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createJsonLinesDecoder, encodeJsonLine, parseRequest, type Request } from '@routeswitch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHelperClient, type HelperClient, type HelperStatus } from './helperClient';
import { emptyConfig, engineState, memoryLogger, oneRuleConfig, statusResult } from './helperClient.fixtures';

interface StandIn {
  readonly server: Server;
  readonly connections: Socket[];
  readonly requests: Request[];
  seq: number;
  readonly close: () => Promise<void>;
}

/** Answers the seven methods the way a helper would, from fixtures. */
function standIn(socketPath: string): Promise<StandIn> {
  const connections: Socket[] = [];
  const requests: Request[] = [];
  const helper = { seq: 1 };
  const server = createServer((socket) => {
    connections.push(socket);
    const decoder = createJsonLinesDecoder();
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      for (const line of decoder.push(chunk)) {
        if (!line.ok) continue;
        const request = parseRequest(line.value);
        if (!request.ok) continue;
        requests.push(request.value);
        const { id, method } = request.value;
        helper.seq += 1;
        const state = engineState(helper.seq, 1);
        const result =
          method === 'status'
            ? statusResult(state)
            : method === 'getConfig'
              ? { config: emptyConfig(), configRevision: 1 }
              : method === 'setConfig'
                ? { config: request.value.config, state }
                : { state };
        socket.write(encodeJsonLine({ id, ok: true, result }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        server,
        connections,
        requests,
        get seq() {
          return helper.seq;
        },
        set seq(value: number) {
          helper.seq = value;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of connections) socket.destroy();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** Resolves when the client reaches a status the predicate accepts. */
function waitForStatus(client: HelperClient, accept: (status: HelperStatus) => boolean): Promise<HelperStatus> {
  return new Promise((resolve) => {
    const current = client.snapshot().status;
    if (accept(current)) {
      resolve(current);
      return;
    }
    const unsubscribe = client.onStatus((status) => {
      if (!accept(status)) return;
      unsubscribe();
      resolve(status);
    });
  });
}

describe('helper client over a real Unix socket', () => {
  let directory = '';
  let socketPath = '';
  let client: HelperClient | null = null;
  let helper: StandIn | null = null;

  /** Real timers, but reconnects are immediate so that no test waits two seconds. */
  const start = (): HelperClient => {
    client = createHelperClient({
      socketPath,
      logger: memoryLogger().logger,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs === 2000 ? 0 : delayMs),
    });
    client.start();
    return client;
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'rs-hc-'));
    socketPath = path.join(directory, 'h.sock');
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    await helper?.close();
    helper = null;
    await rm(directory, { recursive: true, force: true });
  });

  it('connects, handshakes and exchanges requests', async () => {
    helper = await standIn(socketPath);
    const live = start();
    expect(await waitForStatus(live, (status) => status.kind === 'connected')).toEqual({ kind: 'connected', helperVersion: '1.2.3' });
    expect(helper.requests.map((request) => request.method)).toEqual(['status', 'getConfig']);
    expect(live.snapshot()).toMatchObject({ state: { seq: 2 }, config: emptyConfig(), configRevision: 1 });

    const [apply, setConfig, test] = await Promise.all([
      live.request('apply'),
      live.request('setConfig', { config: oneRuleConfig() }),
      live.request('setEnabled', { enabled: true }),
    ]);
    expect(apply).toMatchObject({ ok: true, value: { state: { seq: 4 } } });
    expect(setConfig).toMatchObject({ ok: true, value: { config: oneRuleConfig(), state: { seq: 5 } } });
    expect(test).toMatchObject({ ok: true, value: { state: { seq: 6 } } });
    expect(live.snapshot().state?.seq).toBe(6);
  });

  it('receives a message split across chunks and several messages in one chunk', async () => {
    helper = await standIn(socketPath);
    const live = start();
    await waitForStatus(live, (status) => status.kind === 'connected');
    const seen = new Promise<number[]>((resolve) => {
      const seqs: number[] = [];
      live.onState((state) => {
        seqs.push(state.seq);
        if (seqs.length === 3) resolve(seqs);
      });
    });
    const [connection] = helper.connections;
    const lines = [100, 101, 102].map((seq) => encodeJsonLine({ event: 'state', state: engineState(seq, 1) })).join('');
    connection?.write(lines.slice(0, 37));
    connection?.write(lines.slice(37, 400));
    connection?.write(lines.slice(400));
    expect(await seen).toEqual([100, 101, 102]);
  });

  it('settles pending requests when the helper goes away, then reconnects and handshakes again', async () => {
    helper = await standIn(socketPath);
    const live = start();
    await waitForStatus(live, (status) => status.kind === 'connected');

    // A helper that stops answering, then dies with a request outstanding.
    const [connection] = helper.connections;
    connection?.removeAllListeners('data');
    const pending = live.request('apply');
    const lost = waitForStatus(live, (status) => status.kind === 'disconnected');
    connection?.destroy();
    expect(await pending).toEqual({ ok: false, code: 'disconnected', error: 'The connection to the helper was lost' });
    expect(await lost).toEqual({ kind: 'disconnected', reason: 'connection-lost' });
    expect(live.snapshot().state).toBeNull();

    // The server is still listening — a restarted helper whose counters began again.
    helper.seq = 0;
    await waitForStatus(live, (status) => status.kind === 'connected');
    expect(helper.connections).toHaveLength(2);
    expect(helper.requests.map((request) => `${String(request.id)}:${request.method}`)).toEqual([
      '0:status',
      '1:getConfig',
      '0:status',
      '1:getConfig',
    ]);
    expect(live.snapshot().state?.seq).toBe(1);
    expect(await live.request('apply')).toMatchObject({ ok: true });
  });

  it('reports not-installed while the socket file does not exist, and connects once it appears', async () => {
    const live = start();
    expect(await waitForStatus(live, (status) => status.kind !== 'connecting')).toEqual({ kind: 'not-installed' });
    expect(await live.request('status')).toMatchObject({ ok: false, code: 'not-connected' });

    helper = await standIn(socketPath);
    expect(await waitForStatus(live, (status) => status.kind === 'connected')).toMatchObject({ kind: 'connected' });
  });

  it('goes back to not-installed when the helper and its socket file are removed', async () => {
    helper = await standIn(socketPath);
    const live = start();
    await waitForStatus(live, (status) => status.kind === 'connected');
    const gone = waitForStatus(live, (status) => status.kind === 'not-installed');
    await helper.close(); // closing a listening Unix socket removes its file
    helper = null;
    await rm(socketPath, { force: true });
    expect(await gone).toEqual({ kind: 'not-installed' });
  });

  it('reports a socket file nobody listens on as installed but not running', async () => {
    helper = await standIn(socketPath);
    // What a crashed daemon leaves behind: the socket file, with no listener.
    // (Closing a server removes its file, so a hard link keeps it.)
    const kept = `${socketPath}.kept`;
    await link(socketPath, kept);
    await helper.close();
    helper = null;
    await rename(kept, socketPath);

    const live = start();
    expect(await waitForStatus(live, (status) => status.kind !== 'connecting')).toEqual({ kind: 'disconnected', reason: 'not-running' });
  });

  it('stops cleanly in the middle of everything', async () => {
    helper = await standIn(socketPath);
    const live = start();
    await waitForStatus(live, (status) => status.kind === 'connected');
    const pending = live.request('uninstall');
    live.stop();
    expect(await pending).toMatchObject({ ok: false, code: 'disconnected' });
    expect(live.snapshot().status).toEqual({ kind: 'stopped' });
  });
});
