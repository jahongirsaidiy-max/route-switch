import { z } from 'zod';

import {
  MAX_DOMAIN_LENGTH,
  cidrContains,
  isIpWildcard,
  normalizeDomain,
  normalizeHostAddress,
  normalizeSubnet,
  parseIpWildcard,
  parseIpv4Destination,
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
  domain: normalizeDomain,
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
 * ranges, minimum prefix). A stored target therefore never holds a `*`. A
 * domain with a `*` is refused as before.
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
    // '172.16.12.40' | '10.0.0.0/8' | 'corp.local'
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
