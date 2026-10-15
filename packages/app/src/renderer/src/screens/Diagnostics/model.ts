// A diagnosis (`window.rs.diagnose`) put into words: the verdict with one
// piece of advice, the matching rule and why it wins, a row per address
// (actual route against the expected interface), DNS and the notes. Pure:
// every text comes from the codes through the dictionary of the given
// language; nothing the helper sends is shown as prose.

import type { Config, DiagnoseAddress, DiagnoseMatch, DiagnoseNote, DiagnoseResult, IfaceRole } from '@routeswitch/shared';

import type { I18n } from '../../../../i18n';
import type { DiagnosticRowStatus, DiagnosticSourceKey } from '../../../../i18n/sections/diagnostics.uz';
import { ROLE_LABELS } from '../../components';
import type { RsDiagnosis } from '../../rs';
import { errorText, UZ } from '../../text';

export type VerdictTone = 'ok' | 'warning' | 'danger' | 'neutral';

export interface AddressRowView {
  readonly address: string;
  /** Where the address comes from (rule cache, the helper's query, the system resolver). */
  readonly source: string;
  /** The kernel's route: device, role, gateway — or "no route". */
  readonly actual: string;
  /** The rule's interface, or the default route. */
  readonly expected: string;
  readonly status: DiagnosticRowStatus;
  readonly statusLabel: string;
  /** The rule this address falls under (system-resolved names only: each address has its own). */
  readonly rule: string | null;
  /** Why the address could not be checked. */
  readonly failure: string | null;
}

export interface DnsView {
  readonly server: string;
  readonly via: string | null;
  readonly outcome: string;
  readonly tone: VerdictTone;
  readonly resolverFile: string;
}

export interface DiagnosisView {
  readonly target: string;
  readonly verdict: { readonly tone: VerdictTone; readonly title: string; readonly advice: string | null };
  /** The matching rule of the target itself; null when none matches (then `noMatch` is said). */
  readonly match: { readonly rule: string; readonly why: string } | null;
  /** Shown instead of `match` when no rule matches the target. Null when the addresses carry their own rules. */
  readonly noMatch: string | null;
  /** The app's lookup of a name no rule covers: how it went. */
  readonly lookup: readonly string[];
  readonly rows: readonly AddressRowView[];
  readonly dns: DnsView | null;
  /** Said when a domain rule matches but has no DNS server of its own. */
  readonly dnsNote: string | null;
  readonly notes: readonly string[];
}

type Rules = Config['rules'];

/** "corp.local → Ethernet", or a placeholder while the rules are not read. */
export function ruleLabel(ruleId: string, rules: Rules | null, i18n: I18n = UZ): string {
  const words = i18n.t.diagnostics;
  const rule = rules?.find((candidate) => candidate.id === ruleId);
  return rule === undefined ? words.unknownRule : words.matchRule(rule.target, ROLE_LABELS[rule.iface]);
}

function matchText(match: DiagnoseMatch, rules: Rules | null, i18n: I18n): { readonly rule: string; readonly why: string } {
  const words = i18n.t.diagnostics;
  return { rule: `${words.via[match.via]}: ${ruleLabel(match.ruleId, rules, i18n)}`, why: words.precedence[match.precedence] };
}

export function rowStatus(address: Pick<DiagnoseAddress, 'matchesExpected' | 'expectedRole'>): DiagnosticRowStatus {
  if (address.matchesExpected === true) return 'ok';
  if (address.matchesExpected === false) return 'mismatch';
  return address.expectedRole === null ? 'default' : 'unknown';
}

export function actualRoute(route: DiagnoseAddress['route'], i18n: I18n = UZ): string {
  const words = i18n.t.diagnostics;
  if (route === null) return words.noRoute;
  const role = route.role === null ? words.noRole : ROLE_LABELS[route.role];
  return [route.device, role, route.gateway === null ? words.direct : words.gateway(route.gateway)].join(' · ');
}

const expectedText = (role: IfaceRole | null, i18n: I18n): string =>
  role === null ? i18n.t.diagnostics.defaultRoute : ROLE_LABELS[role];

function addressRow(address: DiagnoseAddress, source: DiagnosticSourceKey, rule: string | null, i18n: I18n): AddressRowView {
  const words = i18n.t.diagnostics;
  const status = rowStatus(address);
  return {
    address: address.address,
    source: words.sources[source],
    actual: actualRoute(address.route, i18n),
    expected: expectedText(address.expectedRole, i18n),
    status,
    statusLabel: words.status[status],
    rule,
    failure: null,
  };
}

function failedRow(address: string, failure: string, i18n: I18n): AddressRowView {
  const words = i18n.t.diagnostics;
  return {
    address,
    source: words.sources.system,
    actual: '—',
    expected: '—',
    status: 'failed',
    statusLabel: words.status.failed,
    rule: null,
    failure: words.rowFailed(failure),
  };
}

/** The rows and the per-address results of a diagnosis, in order. */
function rowsOf(diagnosis: RsDiagnosis, rules: Rules | null, i18n: I18n): { rows: AddressRowView[]; results: DiagnoseResult[] } {
  const { result, lookup } = diagnosis;
  if (lookup === null) {
    return { rows: result.addresses.map((address) => addressRow(address, address.source, null, i18n)), results: [result] };
  }
  const rows: AddressRowView[] = [];
  const results: DiagnoseResult[] = [result];
  for (const entry of lookup.addresses) {
    if (!entry.ok) {
      rows.push(failedRow(entry.address, errorText(entry.code, i18n), i18n));
      continue;
    }
    results.push(entry.result);
    const own = entry.result.addresses.find((candidate) => candidate.address === entry.address);
    const rule = entry.result.match === null ? null : matchText(entry.result.match, rules, i18n).rule;
    rows.push(
      own === undefined
        ? failedRow(entry.address, i18n.t.diagnostics.noRoute, i18n)
        : addressRow(own, 'system', rule, i18n),
    );
  }
  return { rows, results };
}

const DNS_PROBLEMS: ReadonlySet<string> = new Set(['timeout', 'refused', 'error']);

function dnsView(dns: DiagnoseResult['dns'], i18n: I18n): DnsView | null {
  if (dns === null) return null;
  const words = i18n.t.diagnostics;
  const outcome = words.dnsOutcome[dns.outcome];
  return {
    server: words.dnsServer(dns.server),
    via: dns.role === null ? null : words.dnsVia(ROLE_LABELS[dns.role]),
    outcome: dns.ms === null || dns.outcome === 'timeout' ? outcome : `${outcome} · ${words.dnsMs(dns.ms)}`,
    tone: dns.outcome === 'ok' ? 'ok' : DNS_PROBLEMS.has(dns.outcome) ? 'danger' : 'neutral',
    resolverFile: dns.resolverFile === null ? words.noResolverFile : words.resolverFile(dns.resolverFile),
  };
}

function verdictOf(
  diagnosis: RsDiagnosis,
  rows: readonly AddressRowView[],
  notes: ReadonlySet<DiagnoseNote>,
  anyRule: boolean,
  i18n: I18n,
): DiagnosisView['verdict'] {
  const words = i18n.t.diagnostics;
  const { lookup, result } = diagnosis;
  if (lookup !== null && lookup.outcome !== 'ok') {
    return {
      tone: 'danger',
      title: words.lookup.outcomes[lookup.outcome],
      advice: lookup.outcome === 'not-found' ? words.advice.noAddresses : null,
    };
  }
  if (rows.length === 0) {
    // `localhost` and the like: the resolver answered, but only with addresses that are never routed.
    if (lookup !== null && lookup.excluded > 0) return { tone: 'neutral', title: words.verdict.onlyExcluded, advice: words.advice.onlyExcluded };
    return { tone: 'warning', title: words.verdict.noAddresses, advice: words.advice.noAddresses };
  }
  if (rows.some((row) => row.status === 'mismatch' || row.status === 'unknown')) {
    const advice = notes.has('interface-down') || notes.has('no-gateway')
      ? words.advice.interfaceDown
      : notes.has('not-applied')
        ? words.advice.notApplied
        : words.advice.mismatch;
    return { tone: 'danger', title: words.verdict.mismatch, advice };
  }
  if (result.dns !== null && DNS_PROBLEMS.has(result.dns.outcome)) {
    return { tone: 'warning', title: words.verdict.dnsDown, advice: words.advice.dnsDown };
  }
  if (rows.some((row) => row.status === 'failed')) return { tone: 'warning', title: words.verdict.partial, advice: words.advice.partial };
  if (!anyRule) {
    const advice = notes.has('globally-disabled')
      ? words.advice.globallyDisabled
      : notes.has('rule-disabled')
        ? words.advice.ruleDisabled
        : words.advice.noRule;
    return { tone: 'neutral', title: words.verdict.noRule, advice };
  }
  const roles = new Set<IfaceRole>();
  if (lookup === null) {
    for (const address of result.addresses) if (address.expectedRole !== null) roles.add(address.expectedRole);
  } else {
    for (const entry of lookup.addresses) {
      if (!entry.ok) continue;
      for (const address of entry.result.addresses) if (address.expectedRole !== null) roles.add(address.expectedRole);
    }
  }
  const [only] = roles;
  return { tone: 'ok', title: roles.size === 1 && only !== undefined ? words.verdict.okVia(ROLE_LABELS[only]) : words.verdict.ok, advice: null };
}

function lookupLines(diagnosis: RsDiagnosis, i18n: I18n): string[] {
  const { lookup } = diagnosis;
  if (lookup === null) return [];
  const words = i18n.t.diagnostics.lookup;
  // A failed lookup is the verdict itself; it is not repeated.
  if (lookup.outcome !== 'ok') return [];
  // Only addresses that are never routed: one line that says so (not "0 IPv4 addresses" next to the excluded ones).
  if (lookup.addresses.length === 0 && lookup.excluded > 0) return [words.onlyExcluded(lookup.excluded)];
  // Truncated: only the first addresses were diagnosed (the main process's limit) — as many as are listed.
  const lines = [lookup.truncated ? words.truncated(lookup.addresses.length) : words.ok(lookup.addresses.length)];
  if (lookup.excluded > 0) lines.push(words.excluded(lookup.excluded));
  return lines;
}

/** Everything the result panel shows, in the language of `i18n`. */
export function diagnosisView(diagnosis: RsDiagnosis, rules: Rules | null, i18n: I18n = UZ): DiagnosisView {
  const words = i18n.t.diagnostics;
  const { result, lookup } = diagnosis;
  const { rows, results } = rowsOf(diagnosis, rules, i18n);
  const noteSet = new Set<DiagnoseNote>();
  for (const each of results) for (const note of each.notes) noteSet.add(note);
  const anyRule = result.match !== null || rows.some((row) => row.rule !== null);
  const match = result.match === null ? null : matchText(result.match, rules, i18n);
  return {
    target: result.target,
    verdict: verdictOf(diagnosis, rows, noteSet, anyRule, i18n),
    match,
    noMatch: match === null && (lookup === null || !anyRule) ? words.noMatch : null,
    lookup: lookupLines(diagnosis, i18n),
    rows,
    dns: dnsView(result.dns, i18n),
    dnsNote: result.targetKind === 'domain' && result.match !== null && result.dns === null ? words.noDns : null,
    notes: [...noteSet].map((note) => words.notes[note]),
  };
}
