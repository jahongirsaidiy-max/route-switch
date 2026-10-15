// "Diagnostika" in the main process (TASK-DELTA-20): asks the helper's
// read-only `diagnose` about a host or address and, when the helper did not
// resolve the name because no enabled domain rule covers it
// (`name-not-covered`), resolves it here with the user's own rights and asks
// the helper about each address.
//
// The root helper never resolves an arbitrary name (the MVP principle kept by
// TASK-DELTA-18); the app may: it runs unprivileged, like any browser would.
// The lookup is bounded — one `dns.lookup` (IPv4 only), 3 s, at most 8
// addresses — and the per-address calls run one after the other, because the
// helper allows one diagnosis per connection at a time.
//
// What the user diagnoses is theirs: the name and its addresses are logged at
// `debug` only. The `info` line holds kinds and counts.

import { lookup as dnsLookup } from 'node:dns/promises';

import { diagnoseTargetKind, normalizeDiagnoseTarget, type DiagnoseResult } from '@routeswitch/shared';

import type { RsDiagnosedAddress, RsDiagnosis, RsErrorCode, RsLookupOutcome, RsNameLookup, RsResult } from '../renderer/src/rs';
import type { HelperClient } from './helperClient';
import type { Logger } from './logger';

export const NAME_LOOKUP_LIMITS = {
  /** Addresses of a name that are diagnosed; the rest are reported as `truncated`. */
  maxAddresses: 8,
  /** The system resolver's answer is waited for this long. */
  timeoutMs: 3_000,
} as const;

/** One address of `dns.lookup(name, { all: true, family: 4 })`. */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/** `dns.lookup` reduced to what is used here: all IPv4 addresses of `name`. */
export type NameLookup = (name: string) => Promise<readonly LookupAddress[]>;

/** The system resolver (getaddrinfo, `/etc/hosts` and the scoped resolvers included), as the user. */
export const systemLookup: NameLookup = (name) => dnsLookup(name, { all: true, family: 4 });

export interface Timers {
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** `getaddrinfo` codes that mean "no such name" or "no IPv4 address" rather than a failure. */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']);

const errorCodeOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export interface NameResolution {
  readonly outcome: RsLookupOutcome;
  /** Routable IPv4 addresses, each once, in the resolver's order; at most `maxAddresses`. */
  readonly addresses: readonly string[];
  readonly truncated: boolean;
  /** Addresses the shared validators refuse as a destination (loopback, link-local, …). */
  readonly excluded: number;
}

/**
 * Resolves `name` once with `lookup`, bounded in time; never rejects. Only
 * addresses `diagnose` accepts are kept (a resolver may return `127.0.0.1`
 * for `localhost`, `0.0.0.0` for a blocked name), each once.
 */
export async function resolveName(
  name: string,
  lookup: NameLookup,
  timers: Timers = REAL_TIMERS,
  timeoutMs: number = NAME_LOOKUP_LIMITS.timeoutMs,
): Promise<NameResolution> {
  const empty = (outcome: RsLookupOutcome): NameResolution => ({ outcome, addresses: [], truncated: false, excluded: 0 });
  let handle: unknown = null;
  const timedOut = new Promise<'timeout'>((resolve) => {
    handle = timers.setTimer(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  let answer: readonly LookupAddress[] | 'timeout';
  try {
    // A late answer after the timeout is dropped; `getaddrinfo` cannot be cancelled.
    answer = await Promise.race([lookup(name), timedOut]);
  } catch (error) {
    const code = errorCodeOf(error);
    return empty(code !== null && NOT_FOUND_CODES.has(code) ? 'not-found' : 'failed');
  } finally {
    timers.clearTimer(handle);
  }
  if (answer === 'timeout') return empty('timeout');
  if (!Array.isArray(answer)) return empty('failed');

  const routable: string[] = [];
  const seen = new Set<string>();
  let excluded = 0;
  for (const entry of answer as readonly unknown[]) {
    const address = typeof entry === 'object' && entry !== null ? (entry as { readonly address?: unknown }).address : undefined;
    if (typeof address !== 'string' || seen.has(address)) continue;
    seen.add(address);
    const checked = diagnoseTargetKind(address) === 'ip' ? normalizeDiagnoseTarget(address) : null;
    if (checked === null || !checked.ok) {
      excluded += 1;
      continue;
    }
    if (!routable.includes(checked.value)) routable.push(checked.value);
  }
  if (routable.length === 0 && excluded === 0) return empty('not-found');
  return {
    outcome: 'ok',
    addresses: routable.slice(0, NAME_LOOKUP_LIMITS.maxAddresses),
    truncated: routable.length > NAME_LOOKUP_LIMITS.maxAddresses,
    excluded,
  };
}

/**
 * After one of these the remaining addresses are not sent: the connection is
 * gone, or its per-minute budget of diagnoses is (`rate-limited`: every
 * further request this minute would be refused too).
 */
const STOP_CODES: ReadonlySet<RsErrorCode> = new Set<RsErrorCode>(['not-connected', 'disconnected', 'rate-limited']);

export interface DiagnoserDeps {
  readonly request: HelperClient['request'];
  readonly logger: Logger;
  /** The system resolver; `dns.lookup` by default. */
  readonly lookup?: NameLookup;
  readonly timers?: Timers;
}

/** `diagnose(target)` of `window.rs`, for a target the shared schema has already checked. */
export type Diagnoser = (target: string) => Promise<RsResult<RsDiagnosis>>;

export function createDiagnoser(deps: DiagnoserDeps): Diagnoser {
  const lookup = deps.lookup ?? systemLookup;
  const logger = deps.logger.child({ component: 'diagnose' });

  const lookUp = async (name: string): Promise<RsNameLookup> => {
    const resolution = await resolveName(name, lookup, deps.timers);
    logger.debug('name resolved for diagnostics', {
      name,
      outcome: resolution.outcome,
      addresses: resolution.addresses.join(' '),
      excluded: resolution.excluded,
    });
    const addresses: RsDiagnosedAddress[] = [];
    let stopped: RsErrorCode | null = null;
    for (const address of resolution.addresses) {
      if (stopped !== null) {
        addresses.push({ address, ok: false, code: stopped });
        continue;
      }
      const answer = await deps.request('diagnose', { target: address });
      if (answer.ok) {
        addresses.push({ address, ok: true, result: answer.value });
      } else {
        addresses.push({ address, ok: false, code: answer.code });
        if (STOP_CODES.has(answer.code)) stopped = answer.code;
      }
    }
    return { outcome: resolution.outcome, addresses, truncated: resolution.truncated, excluded: resolution.excluded };
  };

  return async (target) => {
    logger.debug('diagnostics requested', { target });
    const answer = await deps.request('diagnose', { target });
    if (!answer.ok) return answer;
    const result: DiagnoseResult = answer.value;
    const lookupResult = result.notes.includes('name-not-covered') ? await lookUp(result.target) : null;
    logger.info('Diagnostics made', {
      kind: result.targetKind,
      matched: result.match !== null,
      lookup: lookupResult?.outcome ?? null,
      addresses: lookupResult === null ? result.addresses.length : lookupResult.addresses.length,
      failed: lookupResult?.addresses.filter((entry) => !entry.ok).length ?? 0,
    });
    return { ok: true, value: { result, lookup: lookupResult } };
  };
}
