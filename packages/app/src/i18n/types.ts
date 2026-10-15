// The types of the dictionary. `uz.ts` is the source of the keys: `Messages`
// is its shape with every literal widened to `string`, and `ru.ts` / `en.ts`
// are declared as `Messages`, so a key missing from (or added to) either one
// fails `tsc`.

import type { Language } from '@routeswitch/shared';

import type { uz } from './uz';

/** A UI language: `uz`, `ru` or `en`. */
export type Locale = Language;

/**
 * The words for one count, by `Intl.PluralRules` category. Uzbek and English
 * use `one` / `other`; Russian also `few` (2–4, 22–24, …) and `many` (5–20,
 * 25–30, …), and `other` for fractions. A missing `few` / `many` reads as `other`.
 */
export interface PluralForms {
  readonly one: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/** The shape every language fills: literal strings widened, functions kept, objects walked. */
export type Shape<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T extends object
      ? { readonly [K in keyof T]: Shape<T[K]> }
      : T;

/** Every text of the UI, in one language. */
export type Messages = Shape<typeof uz>;

/** The words of "N daq oldin" (`formatAgo`). */
export type TimeWords = Messages['time'];
