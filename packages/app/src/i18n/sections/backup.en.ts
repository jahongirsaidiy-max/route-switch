// The rules backup (TASK-DELTA-16), in English.

import { plural } from '../plural';
import type { Messages } from '../types';

const rules = (count: number): string => `${String(count)} ${plural('en', count, { one: 'rule', other: 'rules' })}`;

export const backupEn: Messages['backup'] = {
  offerTitle: (count) => `Restore previous rules (${String(count)})`,
  offerText: (time) => `The helper holds no rules, but the app has a backup from ${time}. Review it — nothing changes until you confirm.`,
  review: 'Review',
  dismiss: 'Not needed',
  openRules: 'Open in the rules window',
  previewFrom: (time) => `Backup (${time}).`,
  restored: (count) => `Rules restored from the backup: ${rules(count)}.`,
  restoreFailed: (why) => `Could not restore: ${why}`,
  dismissFailed: (why) => `Could not hide the offer: ${why}`,
  settings: {
    title: 'Rules backup',
    hint: 'The app keeps the last copy of your rules it got from the helper in your user folder (only you can read it). The backup stays when the helper is removed; restoring happens only after you review and confirm.',
    summary: (count, time) => `Backup: ${rules(count)}, ${time}`,
    none: 'No backup yet — it is saved automatically once there are rules.',
    loading: 'Reading the backup…',
    restore: 'Restore from backup',
    remove: 'Delete the backup',
    removeQuestion: 'Delete the backup? The rules in the helper are not touched.',
    removeConfirm: 'Yes, delete',
    cancel: 'Cancel',
    removed: 'The backup was deleted.',
    removeFailed: (why) => `The backup was not deleted: ${why}`,
    needsHelper: 'The helper must be connected to restore.',
  },
};
