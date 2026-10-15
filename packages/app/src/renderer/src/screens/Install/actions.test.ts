import { describe, expect, it, vi } from 'vitest';

import type { RsErrorCode, RsResult } from '../../rs';
import { INSTALL_TEXT } from '../../text';
import { installHelper, removeHelper, setupFailureText } from './actions';

const refused = (code: RsErrorCode, detail?: string): Promise<RsResult<never>> =>
  Promise.resolve(detail === undefined ? { ok: false, code, error: 'x' } : { ok: false, code, error: 'x', detail });

describe('installHelper', () => {
  it('asks the main process with no argument; success says it reconnects', async () => {
    const rs = { installHelper: vi.fn(() => Promise.resolve({ ok: true as const, value: null })) };
    expect(await installHelper(rs)).toEqual({ tone: 'success', text: INSTALL_TEXT.installed });
    expect(rs.installHelper).toHaveBeenCalledWith();
  });

  it.each([
    ['install-cancelled', 'Parol oynasi yopildi'],
    ['install-denied', 'paroli qabul qilinmadi'],
    ['install-unavailable', 'helper paketi topilmadi'],
    ['busy', 'band'],
  ] as const)('%s is said in words, with a way to try again', async (code, words) => {
    const line = await installHelper({ installHelper: () => refused(code) });
    expect(line.tone).toBe('danger');
    expect(line.text).toContain(words);
  });

  it("a failed script shows its own error line after the words", async () => {
    const line = await installHelper({
      installHelper: () => refused('install-failed', 'install-helper: error: the new plist is not valid: /x'),
    });
    expect(line.text).toContain('Skript xato bilan tugadi');
    expect(line.text).toContain('(install-helper: error: the new plist is not valid: /x)');
    expect(line.text).toContain("Qayta urinib ko'rishingiz mumkin");
  });
});

describe('setupFailureText', () => {
  it('only install-failed carries a detail; an empty one adds nothing', () => {
    expect(setupFailureText({ ok: false, code: 'install-failed', error: 'x', detail: '' })).not.toContain('(');
    expect(setupFailureText({ ok: false, code: 'install-denied', error: 'x', detail: 'ignored' })).not.toContain('ignored');
  });
});

describe('removeHelper', () => {
  it('the full removal when the app holds uninstall.sh; the socket uninstall is not used', async () => {
    const rs = { removeHelper: vi.fn(() => Promise.resolve({ ok: true as const, value: null })), uninstallHelper: vi.fn() };
    expect(await removeHelper(rs)).toEqual({ tone: 'success', text: INSTALL_TEXT.removed });
    expect(rs.uninstallHelper).not.toHaveBeenCalled();
  });

  it('without a package it falls back to the helper uninstall over the socket', async () => {
    const rs = {
      removeHelper: () => refused('install-unavailable'),
      uninstallHelper: vi.fn(() => Promise.resolve({ ok: true as const, value: {} })),
    };
    expect(await removeHelper(rs)).toMatchObject({ tone: 'success', text: expect.stringContaining('Routing to') as unknown });
    expect(rs.uninstallHelper).toHaveBeenCalledTimes(1);
    expect(await removeHelper({ ...rs, uninstallHelper: () => refused('timeout') })).toMatchObject({ tone: 'danger' });
  });

  it('a cancelled password or a failed script does not fall back (nothing more is removed)', async () => {
    for (const code of ['install-cancelled', 'install-denied', 'install-failed', 'busy'] as const) {
      const rs = { removeHelper: () => refused(code), uninstallHelper: vi.fn() };
      expect(await removeHelper(rs)).toMatchObject({ tone: 'danger' });
      expect(rs.uninstallHelper).not.toHaveBeenCalled();
    }
  });
});
