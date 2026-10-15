// The in-app Help (TASK-DELTA-22): typed, static content, one document per UI
// language. There is no markup language and no parser: a document is data —
// topics of blocks (paragraph, list, code, note) of inline pieces (text, a UI
// name, code, a link) — rendered as React text nodes only. A link opens a
// section of the rules window or another topic of the Help; there are no URLs.
//
// Every language is typed `HelpDoc`, whose topics are a record over
// `HELP_TOPICS`: a topic missing from (or added to) a language fails `tsc`.

import type { RulesWindowSection } from '@routeswitch/shared';

/** The topics, in the order of the table of contents. */
export const HELP_TOPICS = [
  'start',
  'rule-types',
  'wildcard-domains',
  'precedence',
  'default-route',
  'backup',
  'diagnostics',
  'problems',
  'uninstall',
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

/** The rules window sections a link may open (Help's own topics are `topic` links). */
export type HelpAppSection = Exclude<RulesWindowSection, 'help'>;

export type HelpLinkTarget = { readonly section: HelpAppSection } | { readonly topic: HelpTopic };

/** A piece of a line: plain text, the name of something in the UI, code, or a link inside the app. */
export type HelpInline =
  | string
  | { readonly kind: 'ui'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly to: HelpLinkTarget; readonly text: string };

export type HelpText = readonly HelpInline[];

export type HelpBlock =
  | { readonly kind: 'paragraph'; readonly text: HelpText }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly HelpText[] }
  /** Terminal lines, shown as they are; `label` is the block's accessible name. */
  | { readonly kind: 'code'; readonly label: string; readonly lines: readonly string[] }
  /** A remark set apart (a warning, a tip). */
  | { readonly kind: 'note'; readonly text: HelpText }
  /** A heading inside a topic (one problem of "common problems"). */
  | { readonly kind: 'subheading'; readonly text: string };

export interface HelpTopicContent {
  readonly title: string;
  readonly blocks: readonly HelpBlock[];
}

export interface HelpDoc {
  readonly title: string;
  readonly subtitle: string;
  /** The accessible name of the table of contents. */
  readonly contents: string;
  readonly topics: Readonly<Record<HelpTopic, HelpTopicContent>>;
}

// Builders, so the documents read as text.

export const ui = (text: string): HelpInline => ({ kind: 'ui', text });
export const code = (text: string): HelpInline => ({ kind: 'code', text });
export const toSection = (section: HelpAppSection, text: string): HelpInline => ({ kind: 'link', to: { section }, text });
export const toTopic = (topic: HelpTopic, text: string): HelpInline => ({ kind: 'link', to: { topic }, text });

export const p = (...text: HelpInline[]): HelpBlock => ({ kind: 'paragraph', text });
export const sub = (text: string): HelpBlock => ({ kind: 'subheading', text });
export const note = (...text: HelpInline[]): HelpBlock => ({ kind: 'note', text });
export const list = (...items: HelpText[]): HelpBlock => ({ kind: 'list', ordered: false, items });
export const steps = (...items: HelpText[]): HelpBlock => ({ kind: 'list', ordered: true, items });
export const terminal = (label: string, ...lines: string[]): HelpBlock => ({ kind: 'code', label, lines });
