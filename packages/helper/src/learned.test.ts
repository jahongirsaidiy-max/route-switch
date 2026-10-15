import { LEARNED_ROUTE_LIMITS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { clampTtlSec, createLearnedRoutes, type LearnedLimits } from './learned';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const SEC = 1000;
const SMALL: LearnedLimits = { perRule: 3, total: 5, minTtlSec: 900, maxTtlSec: 86_400 };

const ip = (n: number): string => `172.16.${String(Math.floor(n / 250))}.${String((n % 250) + 1)}`;

describe('clampTtlSec', () => {
  it.each([
    [0, 900],
    [-5, 900],
    [1, 900],
    [899, 900],
    [900, 900],
    [900.9, 900],
    [3600, 3600],
    [86_400, 86_400],
    [86_401, 86_400],
    [2 ** 32 - 1, 86_400],
    [Number.POSITIVE_INFINITY, 86_400],
    [Number.NEGATIVE_INFINITY, 900],
    [Number.NaN, 900],
  ])('clamps %s to %s', (ttl, expected) => {
    expect(clampTtlSec(ttl)).toBe(expected);
  });

  it('uses the limits of the protocol by default', () => {
    expect(clampTtlSec(0)).toBe(LEARNED_ROUTE_LIMITS.minTtlSec);
    expect(clampTtlSec(10 ** 9)).toBe(LEARNED_ROUTE_LIMITS.maxTtlSec);
  });
});

describe('createLearnedRoutes', () => {
  it('records new addresses once, in input order, and renews known ones', () => {
    const set = createLearnedRoutes(SMALL);

    expect(set.learn('a', [ip(1), ip(2), ip(1)], 60, T0)).toEqual({ added: [ip(1), ip(2)], renewed: [], evicted: [] });
    expect(set.learn('a', [ip(2), ip(3)], 60, T0 + SEC)).toEqual({ added: [ip(3)], renewed: [ip(2)], evicted: [] });
    // Least recently seen first: ip(2) was seen again after ip(1).
    expect(set.addressesOf('a')).toEqual([ip(1), ip(2), ip(3)]);
    expect(set.size('a')).toBe(3);
    expect(set.size()).toBe(3);
    expect(set.lastLearnedAt('a')).toBe(T0 + SEC);
    expect(set.addressesOf('b')).toEqual([]);
    expect(set.lastLearnedAt('b')).toBeNull();
  });

  it('keeps addresses of different owners apart', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1)], 60, T0);

    expect(set.learn('b', [ip(1)], 60, T0)).toEqual({ added: [ip(1)], renewed: [], evicted: [] });
    expect(set.size()).toBe(2);
    expect(set.size('a')).toBe(1);
  });

  it('reads at most perRule addresses of one answer', () => {
    const set = createLearnedRoutes(SMALL);

    const outcome = set.learn('a', [ip(1), ip(2), ip(3), ip(4), ip(5)], 60, T0);

    expect(outcome.added).toEqual([ip(1), ip(2), ip(3)]);
    expect(outcome.evicted).toEqual([]);
    expect(set.isTruncated('a', T0)).toBe(false);
  });

  it('lives for the clamped TTL and expires exactly at its end', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1)], 10, T0);
    set.learn('a', [ip(2)], 10 ** 9, T0);

    expect(set.countExpired(T0 + 899 * SEC)).toBe(0);
    expect(set.expire(T0 + 899 * SEC)).toEqual([]);
    expect(set.countExpired(T0 + 900 * SEC)).toBe(1);
    expect(set.expire(T0 + 900 * SEC)).toEqual([{ owner: 'a', address: ip(1), seenAt: T0, expiresAt: T0 + 900 * SEC }]);
    expect(set.addressesOf('a')).toEqual([ip(2)]);
    expect(set.expire(T0 + 86_400 * SEC - 1)).toEqual([]);
    expect(set.expire(T0 + 86_400 * SEC)).toHaveLength(1);
    expect(set.size()).toBe(0);
  });

  it('renews the lifetime with every answer; a shorter TTL never shortens it', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1)], 3600, T0);
    set.learn('a', [ip(1)], 900, T0 + 100 * SEC);

    expect(set.countExpired(T0 + 3599 * SEC)).toBe(0);
    expect(set.countExpired(T0 + 3600 * SEC)).toBe(1);

    set.learn('a', [ip(1)], 3600, T0 + 3000 * SEC);
    expect(set.countExpired(T0 + 6599 * SEC)).toBe(0);
    expect(set.countExpired(T0 + 6600 * SEC)).toBe(1);
  });

  it('expires an entry when the clock was set back by more than the longest lifetime', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1)], 900, T0);

    expect(set.countExpired(T0 - 86_400 * SEC)).toBe(0);
    expect(set.countExpired(T0 - 86_400 * SEC - 1)).toBe(1);
    expect(set.expire(T0 - 86_400 * SEC - 1)).toHaveLength(1);
  });

  it('drops the address of the owner seen longest ago when the owner is full, and reports truncation until it would have expired', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1)], 900, T0);
    set.learn('a', [ip(2), ip(3)], 3600, T0 + SEC);
    set.learn('a', [ip(1)], 900, T0 + 2 * SEC); // ip(1) is now the most recently seen

    const outcome = set.learn('a', [ip(4)], 900, T0 + 3 * SEC);

    expect(outcome.added).toEqual([ip(4)]);
    expect(outcome.evicted).toEqual([{ owner: 'a', address: ip(2), seenAt: T0 + SEC, expiresAt: T0 + SEC + 3600 * SEC }]);
    expect(set.addressesOf('a')).toEqual([ip(3), ip(1), ip(4)]);
    expect(set.isTruncated('a', T0 + 3 * SEC)).toBe(true);
    expect(set.isTruncated('b', T0 + 3 * SEC)).toBe(false);
    // Until the dropped entry would have expired, whatever expire() is called with in between.
    set.expire(T0 + 3600 * SEC);
    expect(set.isTruncated('a', T0 + 3600 * SEC)).toBe(true);
    set.expire(T0 + 3601 * SEC);
    expect(set.isTruncated('a', T0 + 3601 * SEC)).toBe(false);
  });

  it('drops the address seen longest ago of all owners when the total is reached', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1), ip(2)], 900, T0);
    set.learn('b', [ip(3), ip(4)], 900, T0 + SEC);
    set.learn('c', [ip(5)], 900, T0 + 2 * SEC);

    const outcome = set.learn('c', [ip(6), ip(7)], 900, T0 + 3 * SEC);

    expect(outcome.added).toEqual([ip(6), ip(7)]);
    expect(outcome.evicted.map((entry) => [entry.owner, entry.address])).toEqual([
      ['a', ip(1)],
      ['a', ip(2)],
    ]);
    expect(set.size()).toBe(SMALL.total);
    expect(set.addressesOf('a')).toEqual([]);
    expect(set.isTruncated('a', T0 + 3 * SEC)).toBe(true);
    expect(set.isTruncated('c', T0 + 3 * SEC)).toBe(false);
  });

  it('never exceeds its bounds, whatever the sequence (property)', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const set = createLearnedRoutes(SMALL);
    let now = T0;
    for (let step = 0; step < 5000; step += 1) {
      const owner = ['a', 'b', 'c'][random(3)] ?? 'a';
      const choice = random(10);
      if (choice < 7) {
        const addresses = Array.from({ length: random(6) }, () => ip(random(12)));
        const before = new Set(set.addressesOf(owner));
        const outcome = set.learn(owner, addresses, random(4000), now);
        for (const address of outcome.added) expect(before.has(address)).toBe(false);
        for (const address of outcome.renewed) expect(before.has(address)).toBe(true);
        // Making room never drops an address of the answer itself.
        for (const entry of outcome.evicted) expect(entry.owner === owner && addresses.slice(0, SMALL.perRule).includes(entry.address)).toBe(false);
      } else if (choice < 9) {
        now += random(1200) * SEC;
        for (const entry of set.expire(now)) expect(now >= entry.expiresAt).toBe(true);
        expect(set.countExpired(now)).toBe(0);
      } else {
        set.retain((candidate) => candidate !== owner);
        expect(set.size(owner)).toBe(0);
      }
      expect(set.size()).toBeLessThanOrEqual(SMALL.total);
      for (const candidate of ['a', 'b', 'c']) {
        const addresses = set.addressesOf(candidate);
        expect(addresses.length).toBeLessThanOrEqual(SMALL.perRule);
        expect(new Set(addresses).size).toBe(addresses.length);
      }
      expect(set.size()).toBe(set.size('a') + set.size('b') + set.size('c'));
    }
  });

  it('retain drops whole owners and their truncation; clear drops everything', () => {
    const set = createLearnedRoutes(SMALL);
    set.learn('a', [ip(1), ip(2), ip(3)], 900, T0);
    set.learn('a', [ip(4)], 900, T0);
    set.learn('b', [ip(5)], 900, T0);

    expect(set.retain((owner) => owner === 'b')).toBe(3);
    expect(set.isTruncated('a', T0)).toBe(false);
    expect(set.size()).toBe(1);
    expect(set.retain(() => true)).toBe(0);
    expect(set.clear()).toBe(1);
    expect(set.size()).toBe(0);
    expect(set.clear()).toBe(0);
  });

  it('uses the protocol bounds by default', () => {
    const set = createLearnedRoutes();
    const many = Array.from({ length: LEARNED_ROUTE_LIMITS.perRule + 10 }, (_unused, index) => ip(index));

    expect(set.learn('a', many, 60, T0).added).toHaveLength(LEARNED_ROUTE_LIMITS.perRule);
    for (let owner = 1; owner < LEARNED_ROUTE_LIMITS.total / LEARNED_ROUTE_LIMITS.perRule; owner += 1) {
      expect(set.learn(`o${String(owner)}`, many, 60, T0).evicted).toEqual([]);
    }
    expect(set.size()).toBe(LEARNED_ROUTE_LIMITS.total);
    expect(set.learn('z', [ip(1)], 60, T0 + SEC).evicted).toHaveLength(1);
    expect(set.size()).toBe(LEARNED_ROUTE_LIMITS.total);
  });
});
