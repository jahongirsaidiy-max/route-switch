// The rules backup's restore offer and its flow (TASK-DELTA-16): plain
// functions over the preload API, tested without a DOM.

import type { Config } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor, type Locale } from '../../../../i18n';
import type { EngineStateView } from '../../hooks/useEngineState';
import type { RsBackupInfo, RsResult } from '../../rs';
import { CONFIG, NOW, STATE } from '../MenuBar/fixtures';
import { backupKey, backupOffer, dismissBackupOffer, followBackup, INITIAL_BACKUP_VIEW, removeBackup, type BackupView } from './recovery';
import { cancelPreview, confirmPreview, INITIAL_TRANSFER_UI, previewQuestion, startRestore, type TransferUiState } from './transfer';

const TOKEN = '99999999-9999-4999-8999-999999999999';
const SAVED_AT = '2026-10-15T08:30:00.000Z';
const EMPTY: Config = { ...CONFIG, rules: [] };
const INFO: RsBackupInfo = { savedAt: SAVED_AT, ruleCount: CONFIG.rules.length, dismissed: false };
const READY: BackupView = { phase: 'ready', info: INFO };
const connected: EngineStateView = { helper: 'connected', connection: { kind: 'connected', helperVersion: '0.2.0' }, state: STATE, error: null };

describe('backupOffer: connected, no rules in the helper, rules in a backup not turned down', () => {
  it('offers the backup with its count and time', () => {
    expect(backupOffer(connected, EMPTY, READY)).toEqual({ count: CONFIG.rules.length, savedAt: SAVED_AT });
  });

  it.each<[string, Pick<EngineStateView, 'helper'>, Config | null, BackupView]>([
    ['the helper holds rules', connected, CONFIG, READY],
    ['the config is not read yet', connected, null, READY],
    ['the helper is not connected', { helper: 'not-installed' }, EMPTY, READY],
    ['the helper cannot load its config', { helper: 'config-unreadable' }, EMPTY, READY],
    ['there is no backup', connected, EMPTY, { phase: 'ready', info: null }],
    ['the backup is still being read', connected, EMPTY, INITIAL_BACKUP_VIEW],
    ['the backup could not be read', connected, EMPTY, { phase: 'failed', info: null }],
    ['the backup has no rules', connected, EMPTY, { phase: 'ready', info: { ...INFO, ruleCount: 0 } }],
    ['the user turned this backup down', connected, EMPTY, { phase: 'ready', info: { ...INFO, dismissed: true } }],
  ])('no offer when %s', (_name, engine, config, backup) => {
    expect(backupOffer(engine, config, backup)).toBeNull();
  });

  it('backupKey changes with the connection and the config revision', () => {
    expect(backupKey(connected)).toBe(`connected:${String(STATE.configRevision)}`);
    expect(backupKey({ ...connected, state: { ...STATE, configRevision: STATE.configRevision + 1 } })).not.toBe(backupKey(connected));
    expect(backupKey({ helper: 'not-installed', state: null })).toBe('not-installed:');
  });
});

describe('followBackup', () => {
  it('reads now and on every show; a failed read is no offer', async () => {
    let show: () => void = () => undefined;
    const answers: RsResult<RsBackupInfo | null>[] = [{ ok: true, value: INFO }, { ok: false, code: 'internal', error: 'x' }];
    const getBackup = vi.fn(() => Promise.resolve(answers.shift() ?? { ok: true as const, value: null }));
    const views: BackupView[] = [];
    const reader = followBackup({ getBackup }, (view) => views.push(view), (tick) => {
      show = tick;
      return () => undefined;
    });
    await Promise.resolve();
    show();
    await Promise.resolve();
    await Promise.resolve();
    expect(views).toEqual([READY, { phase: 'failed', info: null }]);
    reader.stop();
  });
});

function harness(initial: TransferUiState = INITIAL_TRANSFER_UI) {
  let state = initial;
  const update = (change: (current: TransferUiState) => TransferUiState) => {
    state = change(state);
  };
  return { update, state: () => state };
}

describe('restore: the backup into the import preview; only "Almashtirish" sends it', () => {
  it('startRestore shows the preview of the backup and sends nothing to the helper', async () => {
    const h = harness();
    const rs = {
      restoreBackup: vi.fn(() => Promise.resolve({ ok: true as const, value: { token: TOKEN, config: CONFIG } })),
      applyImport: vi.fn(),
    };
    const run = startRestore(rs, SAVED_AT, h.update, h.state);
    expect(h.state().phase).toBe('importing');
    await run;
    expect(h.state()).toMatchObject({ phase: 'idle', preview: { token: TOKEN, config: CONFIG, source: { kind: 'backup', savedAt: SAVED_AT } } });
    // No consent yet: nothing applied.
    expect(rs.applyImport).not.toHaveBeenCalled();
    // A second click while one is on its way is ignored.
    await startRestore(rs, SAVED_AT, h.update, () => ({ ...h.state(), phase: 'applying' }));
    expect(rs.restoreBackup).toHaveBeenCalledTimes(1);
  });

  it('cancel forgets the preview without sending anything', async () => {
    const h = harness();
    const applyImport = vi.fn();
    await startRestore({ restoreBackup: () => Promise.resolve({ ok: true, value: { token: TOKEN, config: CONFIG } }) }, SAVED_AT, h.update, h.state);
    cancelPreview(h.update);
    expect(h.state().preview).toBeNull();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it('"Almashtirish" applies the token once and says the rules were restored', async () => {
    const h = harness();
    await startRestore({ restoreBackup: () => Promise.resolve({ ok: true, value: { token: TOKEN, config: CONFIG } }) }, SAVED_AT, h.update, h.state);
    const applyImport = vi.fn(() => Promise.resolve({ ok: true as const, value: { config: CONFIG, state: STATE } }));
    await confirmPreview({ applyImport }, TOKEN, h.update, h.state);
    expect(applyImport).toHaveBeenCalledWith(TOKEN);
    expect(h.state()).toMatchObject({ phase: 'idle', preview: null, feedback: { tone: 'success', text: i18nFor('uz').t.backup.restored(CONFIG.rules.length) } });
    // Used up: a second confirmation sends nothing.
    await confirmPreview({ applyImport }, TOKEN, h.update, h.state);
    expect(applyImport).toHaveBeenCalledTimes(1);
  });

  it.each<[string, RsResult<never>]>([
    ['no backup', { ok: false, code: 'no-backup', error: 'x' }],
    ['a refused backup', { ok: false, code: 'invalid-config', error: 'x' }],
  ])('%s is a message; no preview opens', async (_name, answer) => {
    const h = harness();
    await startRestore({ restoreBackup: () => Promise.resolve(answer) }, SAVED_AT, h.update, h.state);
    expect(h.state().preview).toBeNull();
    expect(h.state().feedback?.tone).toBe('danger');
  });

  it.each<Locale>(['uz', 'ru', 'en'])('the preview question names the backup first (%s)', (locale) => {
    const i18n = i18nFor(locale);
    const question = previewQuestion({ token: TOKEN, config: CONFIG, source: { kind: 'backup', savedAt: SAVED_AT } }, EMPTY, NOW, i18n);
    expect(question.startsWith(i18n.t.backup.previewFrom(i18n.formatTime(SAVED_AT, NOW)))).toBe(true);
    expect(question).toContain(i18n.t.rules.importCounts(CONFIG.rules.length, 0, 0, 0));
    // A file says nothing of a backup.
    expect(previewQuestion({ token: TOKEN, config: CONFIG }, EMPTY, NOW, i18n)).not.toContain(i18n.t.backup.previewFrom(i18n.formatTime(SAVED_AT, NOW)));
  });
});

describe('dismissal and removal', () => {
  it('dismissBackupOffer: success needs no words; a failure is a message', async () => {
    expect(await dismissBackupOffer({ dismissBackup: () => Promise.resolve({ ok: true, value: null }) })).toBeNull();
    expect(await dismissBackupOffer({ dismissBackup: () => Promise.resolve({ ok: false, code: 'internal', error: 'x' }) }, i18nFor('en'))).toMatchObject({
      tone: 'danger',
    });
  });

  it('removeBackup says how it went', async () => {
    expect(await removeBackup({ deleteBackup: () => Promise.resolve({ ok: true, value: null }) }, i18nFor('ru'))).toEqual({
      tone: 'success',
      text: i18nFor('ru').t.backup.settings.removed,
    });
    expect(await removeBackup({ deleteBackup: () => Promise.resolve({ ok: false, code: 'write-failed', error: 'x' }) })).toMatchObject({ tone: 'danger' });
  });
});
