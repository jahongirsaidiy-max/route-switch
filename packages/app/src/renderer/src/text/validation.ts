// The words for the shared validators' codes (`@routeswitch/shared` `cidr.ts`)
// and for a refused config file, shared by the add-rule form (TASK-213) and
// config import (TASK-215). The verdicts are the shared schema's; this only
// puts them into words.

import { LIMITS, MIN_SUBNET_PREFIX, type ValidationCode } from '@routeswitch/shared';

import type { RsConfigIssue } from '../rs';

/** One sentence per code of the shared validators. A missing code fails `tsc`. */
export const VALIDATION_TEXT: Readonly<Record<ValidationCode, string>> = {
  'invalid-ipv4': 'IPv4 manzil kiriting, masalan 172.16.12.40.',
  'invalid-cidr': "Subnetni CIDR ko'rinishida kiriting, masalan 10.0.0.0/8.",
  'invalid-prefix': `Prefiks ${String(MIN_SUBNET_PREFIX)} dan 32 gacha bo'lishi kerak.`,
  'prefix-too-wide': `Subnet juda keng: prefiks kamida /${String(MIN_SUBNET_PREFIX)} bo'lishi kerak.`,
  'invalid-domain': "Domen faqat kichik lotin harflari, raqamlar, «-» va «.» dan iborat bo'ladi, masalan corp.local.",
  'invalid-destination': 'IPv4 manzil yoki CIDR subnet kiriting.',
  'default-route': "Default route (0.0.0.0/0) hech qachon o'zgartirilmaydi.",
  'this-network': '0.0.0.0/8 manzillari route qilinmaydi.',
  loopback: 'Loopback manzillari (127.0.0.0/8) route qilinmaydi.',
  'link-local': 'Link-local manzillari (169.254.0.0/16) route qilinmaydi.',
  multicast: 'Multicast manzillari (224.0.0.0/4) route qilinmaydi.',
  broadcast: '255.255.255.255 route qilinmaydi.',
};

export const isValidationCode = (code: string | null | undefined): code is ValidationCode =>
  typeof code === 'string' && Object.hasOwn(VALIDATION_TEXT, code);

/** Field names of a rule, as the form labels them. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  id: 'id',
  kind: 'turi',
  target: 'manzil',
  iface: 'interfeys',
  dns: 'DNS server',
  refreshSec: "yangilash oralig'i",
  note: 'izoh',
  enabled: 'holat',
};

/** Codes that are not the validators' own: the config's cross-rule checks, the structure walk, zod's. */
const OTHER_CODE_TEXT: Readonly<Record<string, string>> = {
  'iface-conflict': "bir manzil ikki interfeysga bog'langan.",
  'duplicate-id': 'qoida id\'si takrorlangan.',
  'too-many-values': "fayl juda katta yoki juda chuqur.",
  'array-too-long': `${String(LIMITS.maxRules)} tadan ortiq qoida.`,
  'too-deep': "fayl juda katta yoki juda chuqur.",
  'string-too-long': 'juda uzun matn.',
  invalid_type: "qiymat turi noto'g'ri yoki qiymat yo'q.",
  invalid_value: "qiymat noto'g'ri.",
  too_small: 'qiymat juda kichik yoki qisqa.',
  too_big: 'qiymat juda katta yoki uzun.',
  invalid_format: "qiymat ko'rinishi noto'g'ri.",
};

/**
 * Where and why a config file breaks the schema, from the main process's
 * `RsConfigIssue` (indexes and field names only): e.g. "3-qoida, manzil:
 * Default route (0.0.0.0/0) hech qachon o'zgartirilmaydi."
 */
export function configIssueText(issue: RsConfigIssue | undefined): string {
  if (issue === undefined) return "Fayl config ko'rinishiga mos emas.";
  const [first, index, field] = issue.path;
  if (first === 'version') return 'Config versiyasi mos emas (kutilgan: 1) — fayl boshqa versiyadan.';
  if (first === 'rules' && index === undefined && issue.code === 'too_big') return `${String(LIMITS.maxRules)} tadan ortiq qoida.`;
  const why = isValidationCode(issue.code)
    ? VALIDATION_TEXT[issue.code]
    : (issue.code === null ? undefined : OTHER_CODE_TEXT[issue.code]) ?? "qiymat noto'g'ri.";
  let where = '';
  if (first === 'rules' && typeof index === 'number') {
    const fieldWord = typeof field === 'string' ? FIELD_WORDS[field] : undefined;
    where = `${String(index + 1)}-qoida${fieldWord === undefined ? '' : `, ${fieldWord}`}: `;
  } else if (first === 'ifaceOverrides') {
    where = 'Interfeys almashtirishlari: ';
  } else if (first === 'enabled') {
    where = 'Umumiy holat: ';
  }
  return `${where}${why}`;
}
