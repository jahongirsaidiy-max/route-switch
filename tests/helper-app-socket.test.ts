// The app's real helper client (`packages/app/src/main/helperClient.ts`) against the helper's
// real daemon (`packages/helper/src/main.ts` `run`, socket server included) over a unix socket
// in a temporary directory. Lives outside `packages/` on purpose: inside them the boundary lint
// forbids app <-> helper imports, and that rule stays as it is for the product code.
// System commands are faked (no route is ever added); the socket, the codec, the protocol
// parsing on both sides and the timers are real.

import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHelperClient, type HelperClient, type HelperStatus } from '../packages/app/src/main/helperClient';
import { createJsonLinesSink, createLogger as createAppLogger } from '../packages/app/src/main/logger';
import { EXIT_CODES, run, type RunDeps } from '../packages/helper/src/main';
import { assertFsGuardInstalled } from '../packages/helper/src/test-fs-guard-check';
import { createFakeCommandRunner, type FakeCommandRunner } from '../packages/helper/src/test-utils';

// Touches the file system (socket, config, state in a temporary directory): never without the guard.
assertFsGuardInstalled();

const ROUTE = '/sbin/route';
const ETH_GW = '10.20.4.1';
const ID_A = '00000000-0000-4000-8000-000000000001';
const PORTS = 'Hardware Port: USB 10/100/1000 LAN\nDevice: en5\n\nHardware Port: Wi-Fi\nDevice: en0\n';
const METRICS = ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire\n       0         0         0         0         0         0      1500         0\n';

/** A Mac with Ethernet (en5) and Wi-Fi (en0) up, and a routing table the fake `route` acts on. */
const machine = (table: Map<string, string>): FakeCommandRunner => {
  const runner = createFakeCommandRunner();
  runner.whenMatching((bin, args) => {
    if (bin === ROUTE) {
      const [, op, kind, dst = '', gateway = ''] = args;
      if (op === 'monitor') return {};
      if (op === 'add') {
        table.set(dst, gateway);
        return { stdout: `add ${kind === '-net' ? 'net' : 'host'} ${dst}: gateway ${gateway}\n` };
      }
      if (op === 'get') {
        // Exact entry, or for a host the /24 network that contains it (the only prefix these tests use).
        const prefix24 = `${dst.split('.').slice(0, 3).join('.')}.0/24`;
        const entry = table.has(dst) ? dst : kind === '-host' && table.has(prefix24) ? prefix24 : undefined;
        const via = entry === undefined ? undefined : table.get(entry);
        const [address = dst] = (entry ?? dst).split('/');
        if (via === undefined) {
          return { stdout: `   route to: ${address}\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n${METRICS}` };
        }
        return {
          stdout: `   route to: ${address}\ndestination: ${address}\n       mask: 255.255.255.0\n    gateway: ${via}\n  interface: en5\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n${METRICS}`,
        };
      }
      if (op === 'delete') {
        table.delete(dst);
        return { stdout: `delete net ${dst}\n` };
      }
      return undefined;
    }
    if (bin === '/usr/sbin/networksetup') return { stdout: PORTS };
    if (bin === '/usr/sbin/netstat') return { stdout: 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n' };
    if (bin === '/usr/sbin/scutil') return { stdout: 'DNS configuration\n' };
    if (bin === '/usr/bin/dscacheutil' || bin === '/usr/bin/killall') return {};
    const wifi = args[1] === 'en0';
    if (args[0] === 'getifaddr') return { stdout: wifi ? '192.168.1.23\n' : '10.20.4.23\n' };
    if (args[2] === 'router') return { stdout: wifi ? '192.168.1.1\n' : `${ETH_GW}\n` };
    return args[2] === 'subnet_mask' ? { stdout: '255.255.255.0\n' } : { exitCode: 1 };
  });
  return runner;
};

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-int-'));
  dirs.push(dir);
  const socketPath = join(dir, 's.sock');
  const table = new Map<string, string>();
  let signal: (name: string) => void = () => undefined;
  const signalled = new Promise<string>((resolve) => {
    signal = resolve;
  });
  const stderr: string[] = [];
  const deps: RunDeps = {
    stdout: { write: () => true },
    stderr: { write: (chunk) => stderr.push(chunk) },
    createRunner: () => machine(table),
    euid: () => 0,
    systemDnsServers: () => [],
    resolverDir: join(dir, 'resolver'),
    statePath: join(dir, 'state.json'),
    socketPath,
    socketOwner: null,
    createSpawner: () => ({ spawn: () => ({ stop: () => undefined }) }),
    waitForSignal: () => signalled,
  };
  const exit = run(['--config', join(dir, 'config.json')], deps);
  const client: HelperClient = createHelperClient({
    socketPath,
    logger: createAppLogger({ sink: createJsonLinesSink(() => undefined) }),
  });
  const statuses: HelperStatus[] = [];
  client.onStatus((status) => statuses.push(status));
  stops.push(() => {
    client.stop();
    signal('SIGTERM');
  });
  return { dir, socketPath, table, client, statuses, exit, signal, stderr };
};

const connected = async (client: HelperClient): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(client.snapshot().status.kind).toBe('connected');
    },
    { timeout: 5000, interval: 20 },
  );
};

describe('app helper client <-> helper daemon over a real socket', () => {
  it('handshakes (status, version check, getConfig), changes the config, follows the state events', async () => {
    const h = start();
    // The daemon may still be starting: the client retries every 2 s until the socket is there.
    await vi.waitFor(
      () => {
        h.client.start();
        expect(h.client.snapshot().status.kind).not.toBe('stopped');
      },
      { timeout: 2000 },
    );
    await connected(h.client);
    expect(h.client.snapshot()).toMatchObject({ status: { kind: 'connected', helperVersion: '0.0.0' }, config: { rules: [] }, configRevision: 0 });

    const states: number[] = [];
    h.client.onState((state) => states.push(state.seq));
    const config = { version: 1 as const, rules: [{ id: ID_A, kind: 'subnet' as const, target: '198.51.100.0/24', iface: 'ethernet' as const }] };
    const set = await h.client.request('setConfig', { config });
    expect(set.ok).toBe(true);
    expect(set.ok && set.value.state.rules[0]).toMatchObject({ ruleId: ID_A, status: 'active', appliedDestinations: ['198.51.100.0/24'] });
    expect(h.table.get('198.51.100.0/24')).toBe(ETH_GW);
    await vi.waitFor(() => {
      expect(h.client.snapshot().config?.rules).toHaveLength(1);
      expect(h.client.snapshot().state?.configRevision).toBe(1);
    });

    const tested = await h.client.request('test', { target: '198.51.100.9' });
    expect(tested).toEqual({
      ok: true,
      value: { target: '198.51.100.9', destination: '198.51.100.0', gateway: ETH_GW, device: 'en5', role: 'ethernet', ruleId: ID_A },
    });

    const off = await h.client.request('setEnabled', { enabled: false });
    expect(off.ok && off.value.state.enabled).toBe(false);
    expect(h.table.size).toBe(0);
    expect(states.length).toBeGreaterThan(0);
    expect(states).toEqual([...states].sort((a, b) => a - b));

    // A bad request never leaves the client: refused locally, the connection stays.
    const bad = await h.client.request('test', { target: '0.0.0.0' });
    expect(bad).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(h.client.snapshot().status.kind).toBe('connected');

    h.client.stop();
    h.signal('SIGTERM');
    expect(await h.exit).toBe(EXIT_CODES.ok);
  });

  it('two clients, 20 quick config changes: each fetches getConfig a bounded number of times and ends on the same config', async () => {
    const h = start();
    // A second client on the same socket, counting the getConfig requests each one writes.
    const counted = () => {
      const count = { getConfig: 0 };
      const client = createHelperClient({
        socketPath: h.socketPath,
        logger: createAppLogger({ sink: createJsonLinesSink(() => undefined) }),
        connect: (path) => {
          const socket = createConnection({ path });
          const write = socket.write.bind(socket) as (data: string) => boolean;
          (socket as unknown as { write: (data: string) => boolean }).write = (data: string) => {
            count.getConfig += data.split('\n').filter((line) => line.includes('"method":"getConfig"')).length;
            return write(data);
          };
          return socket;
        },
      });
      stops.push(() => {
        client.stop();
      });
      return { client, count };
    };
    const writer = counted();
    const watcher = counted();
    await vi.waitFor(
      () => {
        writer.client.start();
        watcher.client.start();
        expect(writer.client.snapshot().status.kind).not.toBe('stopped');
      },
      { timeout: 2000 },
    );
    await connected(writer.client);
    await connected(watcher.client);

    const CHANGES = 20;
    const changes: Promise<unknown>[] = [];
    for (let i = 1; i <= CHANGES; i += 1) {
      changes.push(
        writer.client.request('setConfig', {
          config: { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: `198.51.${String(100 + i)}.0/24`, iface: 'ethernet' }] },
        }),
      );
    }
    await Promise.all(changes);
    await vi.waitFor(
      () => {
        for (const { client } of [writer, watcher]) {
          expect(client.snapshot().config?.rules[0]?.target).toBe(`198.51.${String(100 + CHANGES)}.0/24`);
          expect(client.snapshot().configRevision).toBe(client.snapshot().state?.configRevision);
        }
      },
      { timeout: 5000 },
    );
    // Handshake + at most one fetch per change. Comparing revisions with `!==` measured thousands here.
    expect(writer.count.getConfig).toBeLessThanOrEqual(1 + CHANGES);
    expect(watcher.count.getConfig).toBeLessThanOrEqual(1 + CHANGES);
    expect(watcher.count.getConfig).toBeGreaterThanOrEqual(2);

    h.signal('SIGTERM');
    expect(await h.exit).toBe(EXIT_CODES.ok);
  });

  it('uninstall: the client gets its answer, then the connection goes and the helper counts as not installed', async () => {
    const h = start();
    h.client.start();
    await connected(h.client);
    await h.client.request('setConfig', { config: { version: 1, rules: [{ id: ID_A, kind: 'subnet', target: '198.51.100.0/24', iface: 'ethernet' }] } });
    expect(h.table.size).toBe(1);

    expect(await h.client.request('uninstall', {})).toEqual({ ok: true, value: {} });
    expect(h.table.size).toBe(0);
    await vi.waitFor(
      () => {
        expect(h.statuses.some((status) => status.kind === 'disconnected')).toBe(true);
        expect(['not-installed', 'disconnected', 'connecting']).toContain(h.client.snapshot().status.kind);
      },
      { timeout: 5000 },
    );
    h.client.stop();
    h.signal('SIGTERM');
    expect(await h.exit).toBe(EXIT_CODES.ok);
  });
});
