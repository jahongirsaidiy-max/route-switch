// The app's own lines in the journal: what happened to the helper connection
// (lost, back, never installed, config unreadable). The helper cannot report
// these — it is the one that is gone — so the main process writes them into
// the same buffer as the helper's `log` events, marked `source: 'app'`, in the
// UI's words (`t.journal`, TASK-DELTA-12).
//
// A line is written in the language that is on when it is written, and stays
// so: a later change of language does not rewrite the journal (the helper's
// own lines are English whatever the language).
//
// Only real changes are written: `connecting` and `stopped` are steps, not
// news, and a status equal to the last one written is skipped. A peer that
// makes the status flap could still fill the journal and push the helper's
// own lines out, so the app's lines share a budget per window of time.

import type { EventLogLevel } from '@routeswitch/shared';

import { DEFAULT_LOCALE, i18nFor, isLocale, type I18n, type Locale } from '../i18n';
import type { HelperStatus } from './helperClient';
import type { LogBuffer } from './logBuffer';

/** At most this many app lines per window … */
export const CONNECTION_JOURNAL_BUDGET = 20;
/** … of this length; one more line says that the rest of the window is not written. */
export const CONNECTION_JOURNAL_WINDOW_MS = 10 * 60 * 1000;

export interface JournalLine {
  readonly level: EventLogLevel;
  readonly msg: string;
}

const UZ: I18n = i18nFor(DEFAULT_LOCALE);

/** The line for a status, in the language given (Uzbek without one); null for the steps that are not written (`connecting`, `stopped`). */
export function journalLineOf(status: HelperStatus, i18n: I18n = UZ): JournalLine | null {
  const words = i18n.t.journal;
  switch (status.kind) {
    case 'connecting':
    case 'stopped':
      return null;
    case 'connected':
      return { level: 'info', msg: words.connected(status.helperVersion) };
    case 'not-installed':
      return { level: 'warn', msg: words.notInstalled };
    case 'disconnected':
      return { level: 'warn', msg: words.disconnected(words.disconnectedWhy[status.reason]) };
    case 'config-unreadable':
      return { level: 'error', msg: words.configUnreadable };
    case 'incompatible':
      return {
        level: 'error',
        msg: words.incompatible(status.helperVersion, status.protocolVersion, status.expectedProtocolVersion),
      };
  }
}

/** The line written once when the budget of a window is spent. */
export const flappingLineOf = (i18n: I18n = UZ): JournalLine => ({ level: 'warn', msg: i18n.t.journal.flapping });

/** What makes two statuses the same news. */
const keyOf = (status: HelperStatus): string =>
  status.kind === 'disconnected' ? `disconnected:${status.reason}` : status.kind;

export interface ConnectionJournalDeps {
  readonly logBuffer: Pick<LogBuffer, 'push'>;
  /** Milliseconds since the epoch: the time of a line and of its budget window. */
  readonly now: () => number;
  /**
   * The UI language at the time of a line (`PreferencesStore.language`; never
   * rejects). Lines then go into the buffer once it answers, in the order
   * recorded, with the time they were recorded. Without it: Uzbek, at once.
   */
  readonly language?: () => Promise<Locale>;
}

export interface ConnectionJournal {
  /** Called with every status of the helper client; writes a line when it is news and the budget allows. */
  readonly record: (status: HelperStatus) => void;
}

export function createConnectionJournal(deps: ConnectionJournalDeps): ConnectionJournal {
  let lastKey: string | null = null;
  let windowStart: number | null = null;
  let written = 0;
  let silenced = false;

  const push = (line: JournalLine, at: number): void => {
    deps.logBuffer.push({ level: line.level, msg: line.msg, at: new Date(at).toISOString(), source: 'app' });
  };

  // Lines wait for the language one after another, so they keep their order.
  let queue: Promise<void> = Promise.resolve();
  const write = (lineIn: (i18n: I18n) => JournalLine | null, at: number): void => {
    const { language } = deps;
    if (language === undefined) {
      const line = lineIn(UZ);
      if (line !== null) push(line, at);
      return;
    }
    queue = queue
      .then(() => language().catch(() => DEFAULT_LOCALE))
      .then((locale) => {
        const line = lineIn(i18nFor(isLocale(locale) ? locale : DEFAULT_LOCALE));
        if (line !== null) push(line, at);
      })
      // A failing buffer listener must not stop the lines after it (the buffer reports its own listeners' errors).
      .catch(() => undefined);
  };

  return {
    record: (status) => {
      if (journalLineOf(status) === null) return;
      const key = keyOf(status);
      if (key === lastKey) return;
      lastKey = key;
      const at = deps.now();
      // A clock that went back counts as a new window (never a window that never ends).
      if (windowStart === null || at - windowStart >= CONNECTION_JOURNAL_WINDOW_MS || at < windowStart) {
        windowStart = at;
        written = 0;
        silenced = false;
      }
      if (written < CONNECTION_JOURNAL_BUDGET) {
        written += 1;
        write((i18n) => journalLineOf(status, i18n), at);
        return;
      }
      if (silenced) return;
      silenced = true;
      write(flappingLineOf, at);
    },
  };
}
