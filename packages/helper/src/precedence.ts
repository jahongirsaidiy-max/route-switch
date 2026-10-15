import type { Rule } from '@routeswitch/shared';

/**
 * Which rule owns a destination when several rules want it. One module, used
 * by the engine when it plans a pass and by `diagnose` when it explains one,
 * so the explanation can never disagree with what the engine does.
 *
 * For one destination (the same `route` key):
 * - an explicit target wins over an address a domain resolved to. Explicit
 *   targets are the target of an `ip` / `subnet` rule and the `dns` server of
 *   a domain rule (its host route is what lets the lookups reach it);
 * - between two of the same kind, the one planned first wins: explicit rules
 *   before domain rules, each group in config order.
 * Across destinations the kernel decides: the longest prefix that covers an
 * address is used.
 */

/** The order the engine plans rules in: `ip` / `subnet` rules first, then domain rules, each group in config order. */
export const planningOrder = <T extends Pick<Rule, 'kind'>>(rules: readonly T[]): T[] => [
  ...rules.filter((rule) => rule.kind !== 'domain'),
  ...rules.filter((rule) => rule.kind === 'domain'),
];

/** True when `target` is an explicit destination of `rule` (see above), false for a resolved address. */
export const isExplicitTarget = (rule: Pick<Rule, 'kind' | 'dns'>, target: string): boolean =>
  rule.kind !== 'domain' || target === rule.dns;
