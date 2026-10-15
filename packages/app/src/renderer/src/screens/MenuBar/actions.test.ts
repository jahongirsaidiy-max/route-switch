import type { StateResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsResult } from '../../rs';
import { openRules, reapply, setRouting, type MenuBarApi } from './actions';
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

  it('a rules window that would not open says so', async () => {
    const rs = api({ ok: false, code: 'forbidden', error: 'Calls are answered only for the app page' });
    expect(await openRules(rs)).toEqual({ tone: 'danger', text: "Qoidalar oynasi ochilmadi. Bu oynadan ruxsat yo'q." });
  });
});
