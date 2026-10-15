// The journal screen (TASK-DELTA-14), in English.

import { plural } from '../plural';
import type { Messages } from '../types';

const entries = (count: number): string => plural('en', count, { one: 'entry', other: 'entries' });
const messages = (count: number): string => plural('en', count, { one: 'message', other: 'messages' });

export const logEn: Messages['log'] = {
  title: 'Log',
  subtitle: (limit) =>
    `The helper's last ${String(limit)} ${messages(limit)} and the app's own entries about its connection to the helper. Everything since the app started is kept.`,
  levels: {
    info: 'Info',
    warn: 'Warning',
    error: 'Error',
  },
  all: 'All',
  filterLabel: 'Level',
  loading: 'Loading the log…',
  emptyTitle: 'The log is empty for now',
  emptyText: 'Messages from the helper (applying rules, errors, network changes) will appear here.',
  noneAtLevel: 'No entries at this level.',
  historyFailed: 'Could not read the log history. New messages will show as they arrive.',
  columns: { time: 'Time', level: 'Level', message: 'Message' },
  entriesLabel: 'Log entries',
  appTag: 'App',
  appTagTitle: "The app's own entry (not the helper's)",
  count: (count) => `${String(count)} ${entries(count)} · newest first`,
  kept: (limit) => `The last ${String(limit)} are kept`,
};
