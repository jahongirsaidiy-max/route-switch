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
  normalizeHostAddress,
  normalizeTarget,
  parseIpv4Destination,
  type EngineState,
  type IfaceRole,
  type RuleKind,
  type RuleState,
  type TestResult,
} from '@routeswitch/shared';

import { ROLE_LABELS } from '../../components';
import { isValidationCode, VALIDATION_TEXT } from '../../text';

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

export const KIND_OPTIONS: readonly { readonly value: RuleKind; readonly label: string }[] = [
  { value: 'ip', label: 'IP' },
  { value: 'subnet', label: 'Subnet' },
  { value: 'domain', label: 'Domen' },
];

/** Label, placeholder and hint of the address field, per kind (the design's words). */
export const TARGET_FIELD: Readonly<Record<RuleKind, { readonly label: string; readonly placeholder: string; readonly hint: string }>> = {
  ip: { label: 'IP manzil', placeholder: '172.16.12.40', hint: "Bitta host uchun route qo'shiladi." },
  subnet: { label: 'Subnet (CIDR)', placeholder: '10.0.0.0/8', hint: 'Butun ichki tarmoq uchun eng ishonchli variant.' },
  domain: {
    label: 'Domen',
    placeholder: 'corp.local',
    hint: "Domen IP'ga resolve qilinib, har bir IP uchun route qo'shiladi.",
  },
};

// ---------------------------------------------------------------------------
// Words for the shared validation codes
// ---------------------------------------------------------------------------

/** Wildcard domains need a DNS proxy: out of the MVP (RouteSwitch.md §Maqsad va doira). */
export const WILDCARD_TEXT = "Wildcard domen (*.corp.local) qo'llab-quvvatlanmaydi — aniq domen kiriting, masalan corp.local.";
const UPPER_CASE_TEXT = 'Domenni kichik harflarda yozing, masalan corp.local.';

/** The words for a refused domain: the shared code says "invalid", the input says which way. */
function domainText(input: string): string {
  if (input.includes('*')) return WILDCARD_TEXT;
  if (/[A-Z]/.test(input) && !/[^A-Za-z0-9.-]/.test(input)) return UPPER_CASE_TEXT;
  return VALIDATION_TEXT['invalid-domain'];
}

const REFRESH_TEXT = `${String(LIMITS.refreshSecMin)} dan ${String(LIMITS.refreshSecMax)} gacha butun son (soniya) kiriting.`;
const NOTE_TEXT = `Izoh ${String(LIMITS.noteMaxLength)} belgidan oshmasin.`;
const TARGET_EMPTY_TEXT = 'Manzilni kiriting.';
const TARGET_LONG_TEXT = `Manzil ${String(LIMITS.targetMaxLength)} belgidan oshmasin.`;
const DNS_EMPTY_TEXT = 'DNS server manzilini kiriting (yoki belgini olib tashlang).';

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
  /** The target as it will be stored, when that differs from what was typed (`10.1.2.3/8` → `10.0.0.0/8`). */
  readonly normalisedTarget: string | null;
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
function fieldText(field: FormField, issue: IssueLike, input: string): string {
  const code = codeOf(issue);
  if (field === 'target') {
    if (code === 'invalid-domain') return domainText(input);
    if (isValidationCode(code)) return VALIDATION_TEXT[code];
    if (issue.code === 'too_small') return TARGET_EMPTY_TEXT;
    if (issue.code === 'too_big') return TARGET_LONG_TEXT;
    return VALIDATION_TEXT['invalid-destination'];
  }
  if (field === 'dns') {
    if (input === '') return DNS_EMPTY_TEXT;
    return isValidationCode(code) ? VALIDATION_TEXT[code] : VALIDATION_TEXT['invalid-ipv4'];
  }
  if (field === 'refreshSec') return REFRESH_TEXT;
  return NOTE_TEXT;
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
export function checkForm(form: RuleForm, id: string, config: Config | null): FormCheck {
  const input = ruleInputOf(form, id);
  const typedTarget = form.target.trim();
  const target = normalizeTarget(form.kind, typedTarget);
  const normalisedTarget = target.ok && target.value !== typedTarget ? target.value : null;
  const parsed = Rule.safeParse(input);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (!isFormField(field) || errors[field] !== undefined) continue;
      const typed = field === 'target' ? typedTarget : field === 'dns' ? form.dns.trim() : '';
      errors[field] = fieldText(field, issue, typed);
    }
    // zod stops before the rule's target check when another field is refused:
    // the target's own verdict comes from the same shared normaliser.
    if (errors.target === undefined && !target.ok && typedTarget !== '') {
      errors.target = fieldText('target', { code: 'custom', path: ['target'], params: { code: target.error.code } }, typedTarget);
    }
    // A refusal on a field the form does not show (the id) still blocks the save.
    const blocked = Object.keys(errors).length === 0;
    return { rule: null, errors, formError: blocked ? 'Qoida yaroqsiz.' : null, normalisedTarget, sameAs: null };
  }

  const rule = parsed.data;
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
          errors.target = `Bu manzil «${other.target}» qoidasida ${roleOf(other.iface)} orqali yo'naltirilgan — bitta manzil ikki interfeysga bog'lanmaydi.`;
        } else if (issue.path.length === 1 && issue.path[0] === 'rules' && issue.code === 'too_big') {
          formError = `${String(LIMITS.maxRules)} tadan ortiq qoida qo'shib bo'lmaydi.`;
        }
      }
    }
    const key = destinationKey(rule);
    const twin = config.rules.find((existing) => existing.id !== id && existing.iface === rule.iface && destinationKey(existing) === key);
    if (twin !== undefined) sameAs = twin.target;
  }

  const refused = Object.keys(errors).length > 0 || formError !== null;
  return { rule: refused ? null : rule, errors, formError, normalisedTarget, sameAs };
}

/** The target and DNS server as the shared normalisers accept them (null while refused or empty), for the preview and the test. */
export function acceptedValues(form: RuleForm): { readonly target: string | null; readonly dns: string | null } {
  const target = normalizeTarget(form.kind, form.target.trim());
  const dnsTyped = form.dns.trim();
  const dns = form.kind === 'domain' && form.useDns && dnsTyped !== '' ? normalizeHostAddress(dnsTyped) : null;
  return { target: target.ok ? target.value : null, dns: dns?.ok === true ? dns.value : null };
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
): CommandPreview {
  if (interfaces === null) return { lines: [], note: "Buyruq helper ulanganda ko'rinadi (gateway undan olinadi)." };
  const role = interfaces[iface];
  if (!role.up || role.gateway === null) {
    const why = role.device === null ? 'adapteri topilmadi' : role.up ? "gateway'i yo'q" : 'ulanmagan';
    return { lines: [], note: `${roleOf(iface)} ${why} — qoida «Kutilmoqda» bo'ladi va ulanganda qo'llanadi.` };
  }
  const gateway = role.gateway;
  const shown = target ?? PLACEHOLDER[kind];
  if (kind === 'domain') {
    const lines = [`$ route -n add -host <resolve(${shown})> ${gateway}`];
    if (dns !== null) lines.push(`$ route -n add -host ${dns} ${gateway}`);
    return {
      lines,
      note: dns === null ? "Har bir resolve qilingan IP uchun." : "Har bir resolve qilingan IP uchun; DNS server — o'z tarmog'ida bo'lmasa.",
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
): TestAddress {
  if (target === null) return { reason: "Avval to'g'ri manzil kiriting." };
  if (kind === 'ip') return { address: target };
  if (kind === 'subnet') {
    const destination = parseIpv4Destination(target);
    if (destination === null) return { reason: "Avval to'g'ri manzil kiriting." };
    const address = destination.prefix >= 31 ? destination.address : toAddress(toInt(destination.address) + 1);
    const routable = normalizeHostAddress(address);
    return routable.ok ? { address: routable.value } : { reason: 'Bu subnetdagi manzilni sinab bo\'lmaydi.' };
  }
  if (saved === null || saved.kind !== 'domain' || saved.target !== target) {
    return { reason: "Domen IP'lari helper resolve qilgandan keyin sinaladi — avval saqlang." };
  }
  const address = saved.state?.appliedDestinations.find((destination) => !destination.includes('/') && destination !== saved.dns);
  return address === undefined ? { reason: "Domen hali resolve qilinmagan yoki route qo'yilmagan." } : { address };
}

export interface TestSummary {
  readonly tone: 'success' | 'warning';
  /** `10.0.0.1 → en5 (Ethernet) · gateway 10.20.4.1` */
  readonly route: string;
  readonly verdict: string;
}

/** What the result of `test` says about the rule being edited. */
export function describeTest(result: TestResult, iface: IfaceRole, ruleId: string, saved: boolean): TestSummary {
  const role = result.role === null ? '' : ` (${roleOf(result.role)})`;
  const via = result.gateway === null ? "to'g'ridan-to'g'ri" : `gateway ${result.gateway}`;
  const route = `${result.target} → ${result.device}${role} · ${via}`;
  if (result.role === iface) {
    const verdict = result.ruleId === ruleId ? `Shu qoida bo'yicha ${roleOf(iface)} orqali ketadi.` : `Hozir ${roleOf(iface)} orqali ketadi.`;
    return { tone: 'success', route, verdict };
  }
  const now = result.role === null ? 'Hozir boshqa interfeys orqali ketadi' : `Hozir ${roleOf(result.role)} orqali ketadi`;
  return { tone: 'warning', route, verdict: saved ? `${now}, ${roleOf(iface)} emas.` : `${now} — saqlangandan keyin ${roleOf(iface)} orqali bo'ladi.` };
}
