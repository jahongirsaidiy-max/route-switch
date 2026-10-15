// Plural forms with the platform's own rules (`Intl.PluralRules`, CLDR): no
// library and no hand-written rules to get wrong.

import type { Locale, PluralForms } from './types';

const RULES = new Map<Locale, Intl.PluralRules>();

const rulesFor = (locale: Locale): Intl.PluralRules => {
  let rules = RULES.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    RULES.set(locale, rules);
  }
  return rules;
};

/**
 * The form of `forms` that goes with `n` in `locale`: Russian 1, 21 → `one`;
 * 2, 22 → `few`; 5, 11, 25 → `many`; Uzbek and English 1 → `one`, else `other`.
 */
export function plural(locale: Locale, n: number, forms: PluralForms): string {
  switch (rulesFor(locale).select(n)) {
    case 'one':
      return forms.one;
    case 'few':
      return forms.few ?? forms.other;
    case 'many':
      return forms.many ?? forms.other;
    default:
      return forms.other;
  }
}

/** Russian forms: `other` (fractions: "1,5 минуты") takes the `few` form. */
export const ruForms = (one: string, few: string, many: string): PluralForms => ({ one, few, many, other: few });
