import type { StateResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor } from '../../../../i18n';
import type { RsResult } from '../../rs';
import { openHelp, openRules, reapply, setRouting, type MenuBarApi } from './actions';
import { STATE } from './fixtures';

const done: RsResult<StateResult> = { ok: true, value: { state: STATE } };

const api = (result: RsResult<never> | null = null): MenuBarApi & { [K in keyof MenuBarApi]: ReturnType<typeof vi.fn> } => ({
  setEnabled: vi.fn(() => Promise.resolve(result ?? done)),
  apply: vi.fn(() => Promise.resolve(result ?? done)),
  openRulesWindow: vi.fn(() => Promise.resolve(result ?? { ok: true as const, value: null })),
});

describe('menu bar actions', () => {
  it('succeed silently: the new state arrives through onState', async () => {
    const rs = api();
    expect(await setRouting(rs, false)).toBeNull();
    expect(rs.setEnabled).toHaveBeenCalledWith(false);
    expect(await reapply(rs)).toBeNull();
    expect(rs.apply).toHaveBeenCalledWith();
    expect(await openRules(rs)).toBeNull();
    expect(rs.openRulesWindow).toHaveBeenCalledWith();
  });

  it('a failure becomes a message in the UI’s words (the English error is not shown)', async () => {
    const rs = api({ ok: false, code: 'not-connected', error: 'No connection to the helper' });
    const toggled = await setRouting(rs, true);
    expect(toggled).toEqual({ tone: 'danger', text: "Helper bilan aloqa yo'q — hech narsa yuborilmadi." });
    expect(await reapply(rs)).toEqual(toggled);
    expect(JSON.stringify(toggled)).not.toContain('No connection');
  });

  it('a lost answer says the outcome is unknown', async () => {
    const rs = api({ ok: false, code: 'timeout', error: 'timed out' });
    expect((await reapply(rs))?.text).toContain("noma'lum");
  });

  it('"?" opens the rules window at its Help section (TASK-DELTA-22)', async () => {
    const rs = api();
    expect(await openHelp(rs, i18nFor('uz'))).toBeNull();
    expect(rs.openRulesWindow).toHaveBeenCalledWith({ kind: 'section', section: 'help' });
    const forbidden = api({ ok: false, code: 'forbidden', error: 'x' });
    expect((await openHelp(forbidden, i18nFor('en')))?.text).toBe('The rules window did not open. This window is not allowed to do that.');
  });

  it('a rules window that would not open says so', async () => {
    const rs = api({ ok: false, code: 'forbidden', error: 'Calls are answered only for the app page' });
    expect(await openRules(rs)).toEqual({ tone: 'danger', text: "Qoidalar oynasi ochilmadi. Bu oynadan ruxsat yo'q." });
  });

  it('the messages are in the language given (TASK-DELTA-12)', async () => {
    const forbidden = api({ ok: false, code: 'forbidden', error: 'x' });
    expect(await openRules(forbidden, i18nFor('en'))).toEqual({
      tone: 'danger',
      text: 'The rules window did not open. This window is not allowed to do that.',
    });
    expect((await openRules(forbidden, i18nFor('ru')))?.text).toMatch(/^Окно правил не открылось\. /);
    const lost = api({ ok: false, code: 'not-connected', error: 'x' });
    expect(await setRouting(lost, true, i18nFor('en'))).toEqual({ tone: 'danger', text: 'No connection to the helper — nothing was sent.' });
    expect((await reapply(lost, i18nFor('ru')))?.text).toBe(i18nFor('ru').t.errors['not-connected']);
  });
});
