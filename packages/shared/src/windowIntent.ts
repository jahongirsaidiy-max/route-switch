import { z } from 'zod';

import { TestRequest } from './protocol';
import { IfaceRole } from './schema';

/**
 * What the rules window is opened for (`rs:openRulesWindow`, TASK-DELTA-21).
 * App-only, like the preferences: the helper never sees it; it lives here so
 * that the main process checks the IPC argument with zod without importing
 * zod itself. A new section is one more entry of `RULES_WINDOW_SECTIONS`
 * (TASK-DELTA-22 added `help`); a new kind, one more member of the union.
 */

/** The sidebar sections of the rules window (`help`: the in-app guide, TASK-DELTA-22). */
export const RULES_WINDOW_SECTIONS = ['rules', 'log', 'diagnostics', 'settings', 'help'] as const;
export const RulesWindowSection = z.enum(RULES_WINDOW_SECTIONS);
export type RulesWindowSection = z.infer<typeof RulesWindowSection>;

/**
 * - `section`   — show that section.
 * - `dns-offer` — a DNS warning's "qoidasini qo'shish": open the add-rule form
 *                 filled in for the warning of `server` and `role`. It names
 *                 the warning, never a rule: the window builds the form from
 *                 its own state, and only the user's "Saqlash" saves it.
 *                 `server` is a routable IPv4 address (ADR-001), normalised.
 */
export const RulesWindowIntent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('section'), section: RulesWindowSection }),
  z.strictObject({ kind: z.literal('dns-offer'), server: TestRequest.shape.target, role: IfaceRole }),
]);
export type RulesWindowIntent = z.infer<typeof RulesWindowIntent>;
