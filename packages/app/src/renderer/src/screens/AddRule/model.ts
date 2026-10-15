// The add / edit rule form as plain data and functions: what the fields hold,
// what the shared schema says about them, the command the helper would run and
// the address "Sinab ko'rish" asks about. No React, no `window.rs`.
//
// Validation is the shared package's own: `Rule.safeParse` for the rule and
// `Config.safeParse` for the config it would produce (one target bound to two
// interfaces, more than 500 rules). Nothing here re-implements a rule; the
// renderer only turns the schema's codes into words.

import {
  Config,
  LIMITS,
  Rule,
  destinationKey,
  isIpWildcard,
  isWildcardDomain,
  normalizeHostAddress,
  normalizeRuleTarget,
  parseIpv4Destination,
  type EngineState,
  type IfaceRole,
  type RuleKind,
  type RuleState,
  type TestResult,
} from '@routeswitch/shared';

import type { I18n } from '../../../../i18n';
import { ROLE_LABELS } from '../../components';
import { dnsWarningBanners, isValidationCode, UZ, type DnsWarningBanner } from '../../text';

/** The fields that can carry an error of their own. */
export type FormField = 'target' | 'dns' | 'refreshSec' | 'note';

/** The order errors are reported in and the focus goes to after a refused save. */
export const FORM_FIELDS: readonly FormField[] = ['target', 'dns', 'refreshSec', 'note'];

/** What the inputs hold, as typed. */
export interface RuleForm {
  readonly kind: RuleKind;
  readonly target: string;
  readonly iface: IfaceRole;
  /** "Ichki DNS server orqali resolve qilish" (domain rules only). */
  readonly useDns: boolean;
  readonly dns: string;
  /** Seconds, as typed (domain rules only). */
  readonly refreshSec: string;
  readonly note: string;
  /** Kept as the rule has it; a new rule is on. The form has no switch of its own (the table has). */
  readonly enabled: boolean;
  /** `refreshSec` of the rule being edited, kept for a rule that is not (or no longer) a domain rule. */
  readonly keptRefreshSec: number;
}

/** A new rule: a subnet through Ethernet, as the design opens. */
export const NEW_RULE_FORM: RuleForm = {
  kind: 'subnet',
  target: '',
  iface: 'ethernet',
  useDns: false,
  dns: '',
  refreshSec: String(LIMITS.refreshSecDefault),
  note: '',
  enabled: true,
  keptRefreshSec: LIMITS.refreshSecDefault,
};

/** The form for a stored rule. */
export function formOfRule(rule: Rule): RuleForm {
  return {
    kind: rule.kind,
    target: rule.target,
    iface: rule.iface,
    useDns: rule.dns !== undefined,
    dns: rule.dns ?? '',
    refreshSec: String(rule.refreshSec),
    note: rule.note ?? '',
    enabled: rule.enabled,
    keptRefreshSec: rule.refreshSec,
  };
}

const KINDS: readonly RuleKind[] = ['ip', 'subnet', 'domain'];

/** The kind segment's options in the UI language (`UZ` when not given). */
export const kindOptions = (i18n: I18n = UZ): readonly { readonly value: RuleKind; readonly label: string }[] =>
  KINDS.map((value) => ({ value, label: i18n.t.addRule.kinds[value] }));

export const KIND_OPTIONS = kindOptions();

/** Examples, not words: the same in every language. */
const PLACEHOLDERS: Readonly<Record<RuleKind, string>> = { ip: '172.16.12.40', subnet: '10.0.0.0/8', domain: 'corp.local' };

/** Label, placeholder and hint of the address field for a kind (the design's words), in the UI language. */
export function targetField(kind: RuleKind, i18n: I18n = UZ): { readonly label: string; readonly placeholder: string; readonly hint: string } {
  return { ...i18n.t.addRule.targetField[kind], placeholder: PLACEHOLDERS[kind] };
}

export const TARGET_FIELD: Readonly<Record<RuleKind, { readonly label: string; readonly placeholder: string; readonly hint: string }>> = {
  ip: targetField('ip'),
  subnet: targetField('subnet'),
  domain: targetField('domain'),
};

// ---------------------------------------------------------------------------
// Words for the shared validation codes
// ---------------------------------------------------------------------------

/** Wildcard domains need a DNS proxy: out of the MVP (RouteSwitch.md §Maqsad va doira). Uzbek. */
export const WILDCARD_TEXT = UZ.t.addRule.errors.wildcardDomain;

/** The words for a refused domain: the shared code says "invalid", the input says which way. */
function domainText(input: string, i18n: I18n): string {
  if (input.includes('*')) return i18n.t.addRule.errors.wildcardDomain;
  if (/[A-Z]/.test(input) && !/[^A-Za-z0-9.-]/.test(input)) return i18n.t.addRule.errors.upperCase;
  return i18n.t.validation['invalid-domain'];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type FieldErrors = Partial<Record<FormField, string>>;

export interface FormCheck {
  /** The rule as the shared schema parsed it (normalised), or null while any field is refused. */
  readonly rule: Rule | null;
  readonly errors: FieldErrors;
  /** A refusal that belongs to no field (the 500-rule limit). */
  readonly formError: string | null;
  /** The target as it will be stored, when that differs from what was typed (`10.1.2.3/8` → `10.0.0.0/8`); null for a wildcard. */
  readonly normalisedTarget: string | null;
  /** The subnet an accepted IP wildcard is saved as (`10.*.*.*` → `10.0.0.0/8`, kind `subnet`), from the shared normaliser. */
  readonly wildcardCidr: string | null;
  /** Another rule already routes the same destination through the same interface (allowed; a hint only). */
  readonly sameAs: string | null;
}

interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly params?: Record<string, unknown> | undefined;
}

const codeOf = (issue: IssueLike): string | null => {
  const code = issue.params?.['code'];
  return typeof code === 'string' ? code : null;
};


/** The words for an issue of one field of `Rule`. */
function fieldText(field: FormField, issue: IssueLike, input: string, i18n: I18n): string {
  const code = codeOf(issue);
  const validation = i18n.t.validation;
  const words = i18n.t.addRule.errors;
  if (field === 'target') {
    if (code === 'invalid-domain' || code === 'invalid-wildcard-domain') return domainText(input, i18n);
    if (isValidationCode(code)) return validation[code];
    if (issue.code === 'too_small') return words.targetEmpty;
    if (issue.code === 'too_big') return words.targetLong;
    return validation['invalid-destination'];
  }
  if (field === 'dns') {
    if (input === '') return words.dnsEmpty;
    return isValidationCode(code) ? validation[code] : validation['invalid-ipv4'];
  }
  if (field === 'refreshSec') return words.refresh;
  return words.note;
}

const isFormField = (value: PropertyKey | undefined): value is FormField =>
  typeof value === 'string' && (FORM_FIELDS as readonly string[]).includes(value);

/** A refresh interval as typed: a plain decimal integer, or a value the schema refuses. */
const refreshValue = (typed: string): number | string => (/^\d{1,9}$/.test(typed.trim()) ? Number(typed.trim()) : typed);

/**
 * The value `saveRule` gets for the form: only what the kind uses. Leading and
 * trailing white space of the address and the DNS server is dropped (a paste
 * often carries it); everything else is left to the schema, which refuses
 * rather than rewrites.
 */
export function ruleInputOf(form: RuleForm, id: string): Record<string, unknown> {
  const domain = form.kind === 'domain';
  const note = form.note.trim();
  return {
    id,
    enabled: form.enabled,
    kind: form.kind,
    target: form.target.trim(),
    iface: form.iface,
    ...(domain && form.useDns ? { dns: form.dns.trim() } : {}),
    refreshSec: domain ? refreshValue(form.refreshSec) : form.keptRefreshSec,
    ...(note === '' ? {} : { note }),
  };
}

const roleOf = (iface: IfaceRole) => ROLE_LABELS[iface];

/**
 * Checks the form with the shared schema: the rule on its own (`Rule`), then
 * the config with the rule added or replaced (`Config`) — a target bound to
 * the other interface by another rule, or a 501st rule, is refused there.
 * Without a config (not read yet) only the rule is checked; the main process
 * checks the config again before sending it, and the helper after.
 */
export function checkForm(form: RuleForm, id: string, config: Config | null, i18n: I18n = UZ): FormCheck {
  const words = i18n.t.addRule.errors;
  const input = ruleInputOf(form, id);
  const typedTarget = form.target.trim();
  const target = normalizeRuleTarget(form.kind, typedTarget);
  // The shared normaliser turns an `ip` / `subnet` wildcard into a subnet: say which, not "saved as".
  const wildcardCidr = target.ok && form.kind !== 'domain' && isIpWildcard(typedTarget) ? target.value.target : null;
  const normalisedTarget = target.ok && wildcardCidr === null && target.value.target !== typedTarget ? target.value.target : null;
  const parsed = Rule.safeParse(input);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (!isFormField(field) || errors[field] !== undefined) continue;
      const typed = field === 'target' ? typedTarget : field === 'dns' ? form.dns.trim() : '';
      errors[field] = fieldText(field, issue, typed, i18n);
    }
    // zod stops before the rule's target check when another field is refused:
    // the target's own verdict comes from the same shared normaliser.
    if (errors.target === undefined && !target.ok && typedTarget !== '') {
      errors.target = fieldText('target', { code: 'custom', path: ['target'], params: { code: target.error.code } }, typedTarget, i18n);
    }
    // A wildcard domain passes the shared check but the form still refuses it (see below).
    if (errors.target === undefined && form.kind === 'domain' && isWildcardDomain(typedTarget)) errors.target = words.wildcardDomain;
    // A refusal on a field the form does not show (the id) still blocks the save.
    const blocked = Object.keys(errors).length === 0;
    return { rule: null, errors, formError: blocked ? words.invalidRule : null, normalisedTarget, wildcardCidr, sameAs: null };
  }

  const rule = parsed.data;
  // The shared schema accepts `*.corp.local` since protocol 4 (ADR-002); the form offers it only
  // once the helper routes it (TASK-DELTA-29), so until then it is refused here as before.
  if (rule.kind === 'domain' && isWildcardDomain(rule.target)) {
    return { rule: null, errors: { target: words.wildcardDomain }, formError: null, normalisedTarget: null, wildcardCidr, sameAs: null };
  }
  let formError: string | null = null;
  let sameAs: string | null = null;

  if (config !== null) {
    const index = config.rules.findIndex((existing) => existing.id === id);
    const rules = index === -1 ? [...config.rules, rule] : config.rules.map((existing, i) => (i === index ? rule : existing));
    const ours = index === -1 ? rules.length - 1 : index;
    const checked = Config.safeParse({ ...config, rules });
    if (!checked.success) {
      for (const issue of checked.error.issues as readonly IssueLike[]) {
        const code = codeOf(issue);
        if (code === 'iface-conflict') {
          const first = issue.params?.['first'];
          const second = issue.params?.['second'];
          if (first !== ours && second !== ours) continue;
          const other = rules[first === ours ? (second as number) : (first as number)];
          if (other === undefined || errors.target !== undefined) continue;
          errors.target = words.ifaceConflict(other.target, roleOf(other.iface));
        } else if (issue.path.length === 1 && issue.path[0] === 'rules' && issue.code === 'too_big') {
          formError = words.tooManyRules;
        }
      }
    }
    const key = destinationKey(rule);
    const twin = config.rules.find((existing) => existing.id !== id && existing.iface === rule.iface && destinationKey(existing) === key);
    if (twin !== undefined) sameAs = twin.target;
  }

  const refused = Object.keys(errors).length > 0 || formError !== null;
  return { rule: refused ? null : rule, errors, formError, normalisedTarget, wildcardCidr, sameAs };
}

/**
 * The kind, target and DNS server as the shared normalisers accept them, for
 * the preview and the test. The kind is the one the rule is saved with: an IP
 * wildcard typed under `ip` is a `subnet` (`10.*.*.*` → `10.0.0.0/8`); while
 * the target is refused or empty it stays the form's kind and `target` is null.
 */
export function acceptedValues(form: RuleForm): { readonly kind: RuleKind; readonly target: string | null; readonly dns: string | null } {
  const target = normalizeRuleTarget(form.kind, form.target.trim());
  const dnsTyped = form.dns.trim();
  const dns = form.kind === 'domain' && form.useDns && dnsTyped !== '' ? normalizeHostAddress(dnsTyped) : null;
  return {
    kind: target.ok ? target.value.kind : form.kind,
    target: target.ok ? target.value.target : null,
    dns: dns?.ok === true ? dns.value : null,
  };
}

/** The first field with an error, in form order. */
export function firstErrorField(errors: FieldErrors): FormField | null {
  return FORM_FIELDS.find((field) => errors[field] !== undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Command preview
// ---------------------------------------------------------------------------

export interface CommandPreview {
  /** `$ route -n add …` lines; empty when there is nothing honest to show. */
  readonly lines: readonly string[];
  /** Why there are no lines, or what the lines depend on. */
  readonly note: string | null;
}

/** Argv placeholders of the preview: part of the command, not translated. */
const PLACEHOLDER: Readonly<Record<RuleKind, string>> = { ip: '<IP>', subnet: '<subnet>', domain: '<domen>' };

/**
 * The `route` command the helper would run for the rule, built the way the
 * helper builds it (`route.ts`: `-n add -host|-net <dst> <gateway>`) from the
 * role's gateway in the engine state. Shown, never run. It is a preview: the
 * helper also skips a destination inside a directly connected network and
 * replaces a route that is already there.
 */
export function commandPreview(
  kind: RuleKind,
  target: string | null,
  dns: string | null,
  iface: IfaceRole,
  interfaces: EngineState['interfaces'] | null,
  i18n: I18n = UZ,
): CommandPreview {
  const words = i18n.t.addRule;
  if (interfaces === null) return { lines: [], note: words.previewNoHelper };
  const role = interfaces[iface];
  if (!role.up || role.gateway === null) {
    const why = role.device === null ? words.previewNoAdapter : role.up ? words.previewNoGateway : words.previewDown;
    return { lines: [], note: why(roleOf(iface)) };
  }
  const gateway = role.gateway;
  const shown = target ?? PLACEHOLDER[kind];
  if (kind === 'domain') {
    const lines = [`$ route -n add -host <resolve(${shown})> ${gateway}`];
    if (dns !== null) lines.push(`$ route -n add -host ${dns} ${gateway}`);
    return {
      lines,
      note: dns === null ? words.previewEachIp : words.previewEachIpDns,
    };
  }
  if (kind === 'ip' || target === null) return { lines: [`$ route -n add -${kind === 'ip' ? 'host' : 'net'} ${shown} ${gateway}`], note: null };
  const destination = parseIpv4Destination(target);
  const argument = destination === null ? `-net ${target}` : destination.isHost ? `-host ${destination.address}` : `-net ${destination.cidr}`;
  return { lines: [`$ route -n add ${argument} ${gateway}`], note: null };
}

// ---------------------------------------------------------------------------
// "Sinab ko'rish"
// ---------------------------------------------------------------------------

export type TestAddress = { readonly address: string } | { readonly reason: string };

const toInt = (address: string): number =>
  address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const toAddress = (value: number): string =>
  [24, 16, 8, 0].map((shift) => String(Math.floor(value / 2 ** shift) % 256)).join('.');

/**
 * The one address `test` asks about (the helper takes a single routable IPv4
 * address): the address of an `ip` rule; the first host of a subnet (the
 * address itself for `/31` and `/32`); for a domain, the first address the
 * helper resolved and routed for this very rule — the renderer resolves
 * nothing itself.
 */
export function testAddressOf(
  kind: RuleKind,
  target: string | null,
  saved: { readonly target: string; readonly kind: RuleKind; readonly dns: string | null; readonly state: RuleState | null } | null,
  i18n: I18n = UZ,
): TestAddress {
  const words = i18n.t.addRule;
  if (target === null) return { reason: words.testEnterValid };
  if (kind === 'ip') return { address: target };
  if (kind === 'subnet') {
    const destination = parseIpv4Destination(target);
    if (destination === null) return { reason: words.testEnterValid };
    const address = destination.prefix >= 31 ? destination.address : toAddress(toInt(destination.address) + 1);
    const routable = normalizeHostAddress(address);
    return routable.ok ? { address: routable.value } : { reason: words.testSubnetUntestable };
  }
  if (saved === null || saved.kind !== 'domain' || saved.target !== target) {
    return { reason: words.testDomainSaveFirst };
  }
  const address = saved.state?.appliedDestinations.find((destination) => !destination.includes('/') && destination !== saved.dns);
  return address === undefined ? { reason: words.testDomainNotResolved } : { address };
}

export interface TestSummary {
  readonly tone: 'success' | 'warning';
  /** `10.0.0.1 → en5 (Ethernet) · gateway 10.20.4.1` */
  readonly route: string;
  readonly verdict: string;
}

/** What the result of `test` says about the rule being edited. */
export function describeTest(result: TestResult, iface: IfaceRole, ruleId: string, saved: boolean, i18n: I18n = UZ): TestSummary {
  const words = i18n.t.addRule;
  const role = result.role === null ? '' : ` (${roleOf(result.role)})`;
  const via = result.gateway === null ? words.testDirect : words.testGateway(result.gateway);
  const route = `${result.target} → ${result.device}${role} · ${via}`;
  if (result.role === iface) {
    const verdict = result.ruleId === ruleId ? words.testByThisRule(roleOf(iface)) : words.testGoesVia(roleOf(iface));
    return { tone: 'success', route, verdict };
  }
  const now = result.role === null ? words.testOtherNow : words.testRoleNow(roleOf(result.role));
  return { tone: 'warning', route, verdict: saved ? words.testNotRole(now, roleOf(iface)) : words.testAfterSave(now, roleOf(iface)) };
}

// ---------------------------------------------------------------------------
// "DNS server boshqa interfeysda": the one-click offer (TASK-DELTA-21)
// ---------------------------------------------------------------------------

/** The rule a DNS warning offers: the server as an `ip` rule through the role it belongs to, noted "DNS server". */
export function dnsRuleForm(server: string, role: IfaceRole, i18n: I18n = UZ): RuleForm {
  return { ...NEW_RULE_FORM, kind: 'ip', target: server, iface: role, note: i18n.t.dnsWarnings.ruleNote };
}

/** The offer's button (it opens the form filled in), or why there is none. */
export type DnsRuleOffer =
  | { readonly kind: 'offer'; readonly form: RuleForm; readonly label: string }
  | { readonly kind: 'blocked'; readonly text: string };

/** The id the offer is checked with: the form gets its own when it opens. Any valid UUID would do. */
const OFFER_CHECK_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Whether the rule a warning offers would be routed, before it is offered:
 * the helper's connected-network guard for a host route (the server is the
 * gateway or the own address of an interface of either role — the state
 * carries no netmask, so this is the part of the guard the renderer can
 * see), the role up with a gateway, then the shared schema against the
 * config, like the form's own save (`checkForm`: a forbidden address, the
 * server bound to the other interface by another rule, the 500-rule limit).
 * A rule for the same destination through the same role is not offered
 * again: it exists (off, or failing — its row says why).
 */
export function dnsRuleOffer(
  warning: Pick<DnsWarningBanner, 'server' | 'role'>,
  interfaces: EngineState['interfaces'],
  config: Config | null,
  i18n: I18n = UZ,
): DnsRuleOffer {
  const words = i18n.t.dnsWarnings;
  const { server, role } = warning;
  for (const each of ['ethernet', 'wifi'] as const) {
    const iface = interfaces[each];
    if (iface.gateway === server) return { kind: 'blocked', text: words.blockedGateway(server, roleOf(each)) };
    if (iface.ip === server) return { kind: 'blocked', text: words.blockedOwnAddress(server, roleOf(each)) };
  }
  const own = interfaces[role];
  if (!own.up || own.gateway === null) return { kind: 'blocked', text: words.blockedNoGateway(roleOf(role)) };
  const form = dnsRuleForm(server, role, i18n);
  const check = checkForm(form, OFFER_CHECK_ID, config, i18n);
  if (check.rule === null) {
    const field = firstErrorField(check.errors);
    const reason = (field === null ? null : check.errors[field]) ?? check.formError ?? i18n.t.addRule.errors.invalidRule;
    return { kind: 'blocked', text: words.blockedInvalid(reason) };
  }
  if (check.sameAs !== null) return { kind: 'blocked', text: words.blockedExists(check.sameAs, roleOf(role)) };
  return { kind: 'offer', form, label: words.addRule(server, roleOf(role)) };
}

/** A DNS warning's banner and its offer. */
export interface DnsWarningView extends DnsWarningBanner {
  readonly offer: DnsRuleOffer;
}

/** Every DNS warning of the state, one per server, each with its offer. */
export function dnsWarningViews(state: EngineState, config: Config | null, i18n: I18n = UZ): DnsWarningView[] {
  return dnsWarningBanners(state, config, i18n).map((banner) => ({
    ...banner,
    offer: dnsRuleOffer(banner, state.interfaces, config, i18n),
  }));
}

/**
 * The form a DNS offer opens in the rules window (the menu bar's
 * `openRulesWindow({ kind: 'dns-offer', server, role })`, TASK-DELTA-21): the
 * offer of the same warning in the window's own state — the intent names a
 * warning, not a rule. Null when that state has no such offer (any more).
 */
export function requestedForm(request: { readonly server: string; readonly role: IfaceRole }, views: readonly DnsWarningView[]): RuleForm | null {
  const view = views.find((each) => each.server === request.server && each.role === request.role);
  return view?.offer.kind === 'offer' ? view.offer.form : null;
}
