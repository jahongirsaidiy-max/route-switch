// The in-app Help (TASK-DELTA-22): one typed document per UI language.

import type { Locale } from '../../../i18n';
import { helpEn } from './en';
import { helpRu } from './ru';
import type { HelpDoc } from './types';
import { helpUz } from './uz';

export { HELP_TOPICS, type HelpAppSection, type HelpBlock, type HelpDoc, type HelpInline, type HelpLinkTarget, type HelpText, type HelpTopic } from './types';

/** The Help in every UI language: a language without a document fails `tsc`. */
export const HELP_DOCS: Readonly<Record<Locale, HelpDoc>> = { uz: helpUz, ru: helpRu, en: helpEn };
