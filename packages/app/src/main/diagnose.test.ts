import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { createDiagnoser, NAME_LOOKUP_LIMITS, resolveName, systemLookup, type NameLookup } from './diagnose';
import type { HelperClient } from './helperClient';
import { memoryLogger } from './helperClient.fixtures';

const lookupOf =
  (...addresses: string[]): NameLookup =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address, family: 4 })));

const failing =
  (code: string | undefined): NameLookup =>
  () =>
    Promise.reject(Object.assign(new Error('lookup failed'), code === undefined ? {} : { code }));

describe('systemLookup', () => {
  it('is dns.lookup for every IPv4 address of the name, as the user', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '203.0.113.7', family: 4 }]);
    expect(await systemLookup('example.com')).toEqual([{ address: '203.0.113.7', family: 4 }]);
    expect(dns.lookup).toHaveBeenCalledWith('example.com', { all: true, family: 4 });
  });
});

describe('resolveName', () => {
  it('keeps routable IPv4 addresses once, in order; refused destinations are counted, not kept', async () => {
    const resolved = await resolveName('example.com', lookupOf('203.0.113.7', '127.0.0.1', '203.0.113.7', '169.254.1.1', '0.0.0.0', '198.51.100.2', '::1'));
    expect(resolved).toEqual({ outcome: 'ok', addresses: ['203.0.113.7', '198.51.100.2'], truncated: false, excluded: 4 });
  });

  it(`at most ${String(NAME_LOOKUP_LIMITS.maxAddresses)} addresses; more is truncated`, async () => {
    const nine = Array.from({ length: 9 }, (_, index) => `203.0.113.${String(index + 1)}`);
    const resolved = await resolveName('example.com', lookupOf(...nine));
    expect(resolved.addresses).toEqual(nine.slice(0, 8));
    expect(resolved.truncated).toBe(true);
    const eight = await resolveName('example.com', lookupOf(...nine.slice(0, 8)));
    expect(eight.truncated).toBe(false);
  });

  it('only refused destinations: ok with no address, all excluded', async () => {
    expect(await resolveName('localhost', lookupOf('127.0.0.1'))).toEqual({ outcome: 'ok', addresses: [], truncated: false, excluded: 1 });
  });

  it.each(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA'])('%s is not-found', async (code) => {
    expect(await resolveName('nope.example', failing(code))).toEqual({ outcome: 'not-found', addresses: [], truncated: false, excluded: 0 });
  });

  it.each([['ESERVFAIL'], ['ECONNREFUSED'], [undefined]])('%s is failed', async (code) => {
    expect((await resolveName('example.com', failing(code))).outcome).toBe('failed');
  });

  it('an empty answer is not-found; an answer that is not a list is failed', async () => {
    expect((await resolveName('example.com', lookupOf())).outcome).toBe('not-found');
    const odd = (() => Promise.resolve({ address: '203.0.113.7' })) as unknown as NameLookup;
    expect((await resolveName('example.com', odd)).outcome).toBe('failed');
    const junk = (() => Promise.resolve([null, 7, { address: 5 }, { family: 4 }])) as unknown as NameLookup;
    expect(await resolveName('example.com', junk)).toEqual({ outcome: 'not-found', addresses: [], truncated: false, excluded: 0 });
  });

  describe('time limit', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('no answer within 3 s is timeout; a late answer is dropped', async () => {
      let answer: (value: { address: string; family: number }[]) => void = () => undefined;
      const slow: NameLookup = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      const pending = resolveName('slow.example', slow);
      await vi.advanceTimersByTimeAsync(NAME_LOOKUP_LIMITS.timeoutMs - 1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ outcome: 'timeout', addresses: [], truncated: false, excluded: 0 });
      answer([{ address: '203.0.113.7', family: 4 }]);
    });

    it('an answer in time clears the timer', async () => {
      const resolved = await resolveName('example.com', lookupOf('203.0.113.7'));
      expect(resolved.outcome).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('createDiagnoser', () => {
  const ipResult = (target: string) => ({
    target,
    targetKind: 'ip' as const,
    match: null,
    addresses: [{ address: target, source: 'query' as const, route: null, expectedRole: null, matchesExpected: null }],
    dns: null,
    notes: ['no-matching-rule' as const],
  });

  it('stops sending once the connection is gone; the remaining addresses carry that code', async () => {
    const { logger } = memoryLogger();
    const request = vi.fn((_method: string, args: { target: string }) => {
      if (args.target === 'example.com') {
        return Promise.resolve({ ok: true, value: { ...ipResult('example.com'), targetKind: 'domain', addresses: [], notes: ['name-not-covered'] } });
      }
      if (args.target === '203.0.113.1') return Promise.resolve({ ok: false, code: 'disconnected', error: 'gone' });
      return Promise.resolve({ ok: true, value: ipResult(args.target) });
    });
    const diagnose = createDiagnoser({
      request: request as unknown as HelperClient['request'],
      logger,
      lookup: lookupOf('203.0.113.1', '203.0.113.2', '203.0.113.3'),
    });
    const result = await diagnose('example.com');
    expect(request.mock.calls.map(([, args]) => args.target)).toEqual(['example.com', '203.0.113.1']);
    expect(result).toMatchObject({
      ok: true,
      value: {
        lookup: {
          addresses: [
            { address: '203.0.113.1', ok: false, code: 'disconnected' },
            { address: '203.0.113.2', ok: false, code: 'disconnected' },
            { address: '203.0.113.3', ok: false, code: 'disconnected' },
          ],
        },
      },
    });
  });

  it('logs the target and the addresses at debug only', async () => {
    const { logger, entries } = memoryLogger();
    const request = vi.fn((_method: string, args: { target: string }) =>
      Promise.resolve({ ok: true, value: args.target === 'private.example' ? { ...ipResult('private.example'), targetKind: 'domain', addresses: [], notes: ['name-not-covered'] } : ipResult(args.target) }),
    );
    const diagnose = createDiagnoser({ request: request as unknown as HelperClient['request'], logger, lookup: lookupOf('203.0.113.9') });
    await diagnose('private.example');
    const above = JSON.stringify(entries.filter((entry) => entry.level !== 'debug'));
    expect(above).not.toContain('private.example');
    expect(above).not.toContain('203.0.113.9');
    expect(entries.find((entry) => entry.msg === 'Diagnostics made')).toMatchObject({ level: 'info', kind: 'domain', lookup: 'ok', addresses: 1, failed: 0 });
  });
});
