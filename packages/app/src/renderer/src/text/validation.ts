// The words for the shared validators' codes (`@routeswitch/shared` `cidr.ts`)
// and for a refused config file, shared by the add-rule form (TASK-213) and
// config import (TASK-215). The verdicts are the shared schema's; this only
// puts them into words (the dictionary's `t.validation`, `t.configFile`).

import type { ValidationCode } from '@routeswitch/shared';

import type { ConfigFieldKey, ConfigIssueKey, I18n } from '../../../i18n';
import type { RsConfigIssue } from '../rs';
import { UZ } from './errors';

/** One sentence per code of the shared validators, in Uzbek (`t.validation` per language). A missing code fails `tsc` in `uz.ts`. */
export const VALIDATION_TEXT: Readonly<Record<ValidationCode, string>> = UZ.t.validation;

export const isValidationCode = (code: string | null | undefined): code is ValidationCode =>
  typeof code === 'string' && Object.hasOwn(VALIDATION_TEXT, code);

const isFieldKey = (field: unknown): field is ConfigFieldKey => typeof field === 'string' && Object.hasOwn(UZ.t.configFile.fields, field);
const isIssueKey = (code: string): code is ConfigIssueKey => Object.hasOwn(UZ.t.configFile.issues, code);

/**
 * Where and why a config file breaks the schema, from the main process's
 * `RsConfigIssue` (indexes and field names only): e.g. "3-qoida, manzil:
 * Default route (0.0.0.0/0) hech qachon o'zgartirilmaydi."
 */
export function configIssueText(issue: RsConfigIssue | undefined, i18n: I18n = UZ): string {
  const words = i18n.t.configFile;
  if (issue === undefined) return words.notAConfig;
  const [first, index, field] = issue.path;
  if (first === 'version') return words.wrongVersion;
  if (first === 'rules' && index === undefined && issue.code === 'too_big') return words.tooManyRules;
  const code = issue.code;
  const why =
    code === null
      ? words.invalidValue
      : isValidationCode(code)
        ? i18n.t.validation[code]
        : isIssueKey(code)
          ? words.issues[code]
          : words.invalidValue;
  let where = '';
  if (first === 'rules' && typeof index === 'number') {
    where = words.ruleAt(index + 1, isFieldKey(field) ? words.fields[field] : null);
  } else if (first === 'ifaceOverrides') {
    where = words.ifaceOverridesAt;
  } else if (first === 'enabled') {
    where = words.enabledAt;
  }
  return `${where}${why}`;
}
