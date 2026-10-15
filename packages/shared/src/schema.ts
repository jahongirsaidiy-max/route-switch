import { z } from 'zod';

import {
  MAX_DOMAIN_LENGTH,
  cidrContains,
  isIpWildcard,
  normalizeDomainTarget,
  normalizeHostAddress,
  normalizeQueryName,
  normalizeSubnet,
  parseIpWildcard,
  parseIpv4Destination,
  wildcardBase,
  type Normalised,
} from './cidr';

/** Hard limits from the security requirements. */
export const LIMITS = {
  maxRules: 500,
  /** Enforced by the helper's DNS resolver, kept here next to the others. */
  maxIpsPerDomain: 32,
  refreshSecMin: 60,
  refreshSecMax: 86_400,
  refreshSecDefault: 600,
  noteMaxLength: 200,
  targetMaxLength: MAX_DOMAIN_LENGTH,
} as const;

export const IfaceRole = z.enum(['ethernet', 'wifi']);
export type IfaceRole = z.infer<typeof IfaceRole>;

export const RuleKind = z.enum(['ip', 'subnet', 'domain']);
export type RuleKind = z.infer<typeof RuleKind>;

const TARGET_NORMALISERS: Record<RuleKind, (input: string) => Normalised> = {
  ip: normalizeHostAddress,
  subnet: normalizeSubnet,
  domain: normalizeDomainTarget,
};

/** A rule target after normalisation, with the kind it is stored as. */
export interface NormalisedTarget {
  readonly kind: RuleKind;
  readonly target: string;
}

/**
 * Validates and normalises a rule target for its kind (`10.1.2.3/8` →
 * `10.0.0.0/8`). An `ip` or `subnet` input with a `*` is an IPv4 wildcard:
 * it becomes the `subnet` rule it stands for (`10.*.*.*` → `subnet`
 * `10.0.0.0/8`) and then passes the same checks as any subnet (forbidden
 * ranges, minimum prefix). A stored `ip` / `subnet` target therefore never
 * holds a `*`. A domain with a `*` must be a wildcard domain (`*.corp.local`,
 * subdomains only, ADR-002); it is stored as typed.
 */
export const normalizeRuleTarget = (kind: RuleKind, target: string): Normalised<NormalisedTarget> => {
  const wildcard = kind !== 'domain' && isIpWildcard(target);
  const kindOut: RuleKind = wildcard ? 'subnet' : kind;
  let result: Normalised;
  if (wildcard) {
    const cidr = parseIpWildcard(target);
    result = cidr.ok ? normalizeSubnet(cidr.value) : cidr;
  } else {
    result = TARGET_NORMALISERS[kind](target);
  }
  return result.ok ? { ok: true, value: { kind: kindOut, target: result.value } } : result;
};

/**
 * The normalised target alone (see `normalizeRuleTarget`). For a wildcard the
 * value is the subnet's CIDR, so a caller that stores the rule must take the
 * kind from `normalizeRuleTarget` (or from the parsed `Rule`).
 */
export const normalizeTarget = (kind: RuleKind, target: string): Normalised => {
  const result = normalizeRuleTarget(kind, target);
  return result.ok ? { ok: true, value: result.value.target } : result;
};

/** DNS server for a domain rule: a routable IPv4 address (it gets its own host route). */
const DnsServer = z.string().transform((value, ctx) => {
  const result = normalizeHostAddress(value);
  if (result.ok) return result.value;
  ctx.issues.push({ code: 'custom', message: result.error.message, input: value, params: result.error });
  return z.NEVER;
});

export const Rule = z
  .object({
    id: z.uuid(),
    enabled: z.boolean().default(true),
    kind: RuleKind,
    // '172.16.12.40' | '10.0.0.0/8' | 'corp.local' | '*.corp.local'
    target: z.string().min(1).max(LIMITS.targetMaxLength),
    iface: IfaceRole,
    // Only used by domain rules: written to /etc/resolver/<domain>.
    dns: DnsServer.optional(),
    refreshSec: z
      .number()
      .int()
      .min(LIMITS.refreshSecMin)
      .max(LIMITS.refreshSecMax)
      .default(LIMITS.refreshSecDefault),
    note: z.string().max(LIMITS.noteMaxLength).optional(),
  })
  .transform((rule, ctx) => {
    const result = normalizeRuleTarget(rule.kind, rule.target);
    if (result.ok) return { ...rule, kind: result.value.kind, target: result.value.target };
    ctx.issues.push({
      code: 'custom',
      message: result.error.message,
      input: rule.target,
      path: ['target'],
      params: result.error,
    });
    return z.NEVER;
  });
export type Rule = z.infer<typeof Rule>;
/** A rule as it may be written by hand or sent by the UI, before defaults. */
export type RuleInput = z.input<typeof Rule>;

type RoutedRule = Pick<Rule, 'kind' | 'target' | 'iface'>;

/**
 * The canonical CIDR of an `ip` / `subnet` target as typed, an IPv4 wildcard
 * included (`10.*.*.*` → `10.0.0.0/8`), so drafts compare by what they would
 * be stored as. Null when it is not valid IPv4 syntax.
 */
const routedCidrOf = (target: string): string | null => {
  if (isIpWildcard(target)) {
    const cidr = parseIpWildcard(target);
    return cidr.ok ? cidr.value : null;
  }
  return parseIpv4Destination(target)?.cidr ?? null;
};

/**
 * The routing-table identity of a rule: an `ip` rule and a `/32` subnet rule
 * for the same address are the same destination. Null when the target is not
 * valid for its kind.
 */
export const destinationKey = (rule: Pick<Rule, 'kind' | 'target'>): string | null => {
  if (rule.kind === 'domain') return `domain:${rule.target}`;
  const cidr = routedCidrOf(rule.target);
  return cidr === null ? null : `net:${cidr}`;
};

/** How a domain rule covers a name: its exact target, or as a wildcard over the subdomains of its base. */
export type DomainMatchVia = 'domain' | 'wildcard';

export interface DomainMatch<T> {
  readonly rule: T;
  /** Index of `rule` in the `rules` array. */
  readonly index: number;
  readonly via: DomainMatchVia;
}

type MatchableRule = Pick<Rule, 'kind' | 'target' | 'enabled'>;

const labelCount = (domain: string): number => domain.split('.').length;

/**
 * The enabled domain rule that owns a name (ADR-002 §3): an exact domain rule
 * for the name itself wins; otherwise the wildcard whose base is the deepest
 * strict suffix of the name (`*.a.example.com` beats `*.example.com`); equal
 * rank goes to the earlier rule. `*.B` never matches `B` itself. The name is
 * folded first (`normalizeQueryName`: case, one trailing dot); a name that is
 * not a valid domain matches nothing. Pure: the helper's DNS proxy, its
 * engine and `diagnose` all decide with this one function.
 */
export const matchDomainRule = <T extends MatchableRule>(name: string, rules: readonly T[]): DomainMatch<T> | null => {
  const folded = normalizeQueryName(name);
  if (folded === null) return null;

  let best: { rule: T; index: number; depth: number } | null = null;
  for (const [index, rule] of rules.entries()) {
    if (!rule.enabled || rule.kind !== 'domain') continue;
    if (rule.target === folded) return { rule, index, via: 'domain' };
    const base = wildcardBase(rule.target);
    if (base === null || !folded.endsWith(`.${base}`)) continue;
    const depth = labelCount(base);
    if (best === null || depth > best.depth) best = { rule, index, depth };
  }
  return best === null ? null : { rule: best.rule, index: best.index, via: 'wildcard' };
};

/** The labels of a wildcard rule's base (`*.a.example.com` → 3), the depth `compareClaim` ranks wildcards by; 0 for any other target. */
export const wildcardDepth = (target: string): number => {
  const base = wildcardBase(target);
  return base === null ? 0 : labelCount(base);
};

/**
 * Why a rule wants one routed address, from strongest to weakest:
 * - `explicit`     — the target of an `ip` / `/32` `subnet` rule, or the `dns`
 *                    server of a domain rule (its host route);
 * - `exact-domain` — an address an exact domain rule resolved to;
 * - `wildcard`     — an address learned for a wildcard domain rule.
 * A wider `subnet` is no claim on an address: the kernel's longest prefix
 * already prefers any host route inside it.
 */
export type ClaimKind = 'explicit' | 'exact-domain' | 'wildcard';

export interface AddressClaim {
  readonly kind: ClaimKind;
  /** For `wildcard`: the labels of the rule's base (`wildcardDepth`), deeper wins. Ignored otherwise. */
  readonly depth: number;
  /** Tie-break between equal claims: the rule's position, lower wins (config order). */
  readonly order: number;
}

const CLAIM_RANK: Readonly<Record<ClaimKind, number>> = { explicit: 0, 'exact-domain': 1, wildcard: 2 };

/** The claim a rule makes on an address it wants: see `ClaimKind`. `isExplicit` says the address is the rule's own target or `dns` server. */
export const claimOf = (rule: Pick<Rule, 'kind' | 'target'>, isExplicit: boolean, order: number): AddressClaim => {
  if (rule.kind !== 'domain' || isExplicit) return { kind: 'explicit', depth: 0, order };
  const depth = wildcardDepth(rule.target);
  return depth === 0 ? { kind: 'exact-domain', depth, order } : { kind: 'wildcard', depth, order };
};

/**
 * Orders two claims on the same address (ADR-002 §3): negative when `a`
 * wins, positive when `b` wins, 0 only for the same rank and order. Rank:
 * `explicit` > `exact-domain` > deeper `wildcard` > shallower `wildcard` >
 * config order (earlier wins). Usable as an `Array.sort` comparator (winner
 * first). Two exact domain rules are ranked by order too; what the engine does
 * with the loser of that pair (`route-failed`, TASK-DELTA-07) is its own rule.
 */
export const compareClaim = (a: AddressClaim, b: AddressClaim): number => {
  const rank = CLAIM_RANK[a.kind] - CLAIM_RANK[b.kind];
  if (rank !== 0) return rank;
  if (a.kind === 'wildcard' && a.depth !== b.depth) return b.depth - a.depth;
  return a.order - b.order;
};

/** Which rule of `compareClaim` decided between a winner and a loser: the wording `diagnose` reports. */
export type ClaimPrecedence = 'host-route' | 'exact-domain' | 'deeper-wildcard' | 'config-order';

/** Why `winner` beats `loser` (call it with `compareClaim(winner, loser) <= 0`). */
export const claimPrecedence = (winner: AddressClaim, loser: AddressClaim): ClaimPrecedence => {
  if (winner.kind !== loser.kind) return winner.kind === 'explicit' ? 'host-route' : 'exact-domain';
  if (winner.kind === 'wildcard' && winner.depth !== loser.depth) return 'deeper-wildcard';
  return 'config-order';
};

/**
 * The warning a wildcard rule carries for an address another rule won:
 * `overridden-by-rule` against an explicit target or DNS server
 * (TASK-DELTA-07's meaning), `shared-address` against another name rule.
 */
export const lostClaimCode = (winner: AddressClaim): 'overridden-by-rule' | 'shared-address' =>
  winner.kind === 'explicit' ? 'overridden-by-rule' : 'shared-address';

export interface IfaceConflict {
  /** Index of the earlier rule in the `rules` array. */
  readonly first: number;
  /** Index of the later rule that binds the same target to another interface. */
  readonly second: number;
}

/** Pairs of rules that bind the same destination to two different interfaces. */
export const findIfaceConflicts = (rules: readonly RoutedRule[]): IfaceConflict[] => {
  const firstByKey = new Map<string, { index: number; iface: IfaceRole }>();
  const conflicts: IfaceConflict[] = [];

  rules.forEach((rule, index) => {
    const key = destinationKey(rule);
    if (key === null) return;
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, { index, iface: rule.iface });
    else if (first.iface !== rule.iface) conflicts.push({ first: first.index, second: index });
  });

  return conflicts;
};

export interface DuplicateId {
  /** Index of the first rule that uses the id. */
  readonly first: number;
  /** Index of a later rule that reuses it. */
  readonly second: number;
}

/**
 * Rules that reuse the id of an earlier rule. Ids are compared without regard
 * to case, because a UUID is the same value in either case.
 */
export const findDuplicateIds = (rules: readonly Pick<Rule, 'id'>[]): DuplicateId[] => {
  const firstById = new Map<string, number>();
  const duplicates: DuplicateId[] = [];

  rules.forEach((rule, index) => {
    const key = rule.id.toLowerCase();
    const first = firstById.get(key);
    if (first === undefined) firstById.set(key, index);
    else duplicates.push({ first, second: index });
  });

  return duplicates;
};

export interface Overlap<T> {
  /** The rule with the shorter prefix (or the earlier one when both are equal). */
  readonly wider: T;
  /** The rule whose destination lies inside `wider`. */
  readonly narrower: T;
}

/**
 * Pairs of `ip` / `subnet` rules whose destinations overlap, for the UI to warn
 * about. Overlaps are legal: the kernel picks the longest prefix. Rules with
 * identical destinations are reported too, and a wildcard draft (`10.*.*.*`)
 * is compared as the subnet it stands for. Domain rules and rules with an
 * invalid target are skipped, so drafts can be passed in as they are.
 */
export const findOverlaps = <T extends Pick<Rule, 'kind' | 'target'>>(rules: readonly T[]): Overlap<T>[] => {
  const routed = rules.flatMap((rule) => {
    if (rule.kind === 'domain') return [];
    const cidr = routedCidrOf(rule.target);
    return cidr === null ? [] : [{ rule, cidr }];
  });

  const overlaps: Overlap<T>[] = [];
  routed.forEach((a, index) => {
    for (const b of routed.slice(index + 1)) {
      if (cidrContains(a.cidr, b.cidr)) overlaps.push({ wider: a.rule, narrower: b.rule });
      else if (cidrContains(b.cidr, a.cidr)) overlaps.push({ wider: b.rule, narrower: a.rule });
    }
  });
  return overlaps;
};

/**
 * BSD device name of an Ethernet-like adapter, e.g. `en5`: the only kind of
 * device a role can be bound to. At most 16 characters in total, so a
 * hostile value cannot be arbitrarily long.
 */
export const DEVICE_NAME = /^en\d{1,14}$/;

export const Config = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().default(true),
    ifaceOverrides: z.partialRecord(IfaceRole, z.string().regex(DEVICE_NAME)).optional(),
    rules: z.array(Rule).max(LIMITS.maxRules),
  })
  .check((ctx) => {
    const { rules } = ctx.value;
    for (const { first, second } of findDuplicateIds(rules)) {
      const id = rules[second]?.id ?? '';
      ctx.issues.push({
        code: 'custom',
        message: `Rule id ${id} is already used by rule #${String(first + 1)}`,
        input: id,
        path: ['rules', second, 'id'],
        params: { code: 'duplicate-id', first, second },
      });
    }
    for (const { first, second } of findIfaceConflicts(rules)) {
      const target = rules[second]?.target ?? '';
      ctx.issues.push({
        code: 'custom',
        message: `Target ${target} is already bound to another interface by rule #${String(first + 1)}`,
        input: target,
        path: ['rules', second, 'target'],
        params: { code: 'iface-conflict', first, second },
      });
    }
  });
export type Config = z.infer<typeof Config>;
/** A config as stored in or imported from JSON, before defaults. */
export type ConfigInput = z.input<typeof Config>;
