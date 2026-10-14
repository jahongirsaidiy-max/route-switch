import type { SetConfigResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsResult } from '../../rs';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import { removeRule, setRuleEnabled, type RulesApi } from './actions';

const stored: RsResult<SetConfigResult> = { ok: true, value: { config: CONFIG, state: STATE } };
const api = (result: RsResult<SetConfigResult> = stored) => ({
  toggleRule: vi.fn<RulesApi['toggleRule']>(() => Promise.resolve(result)),
  deleteRule: vi.fn<RulesApi['deleteRule']>(() => Promise.resolve(result)),
});

describe('rules actions', () => {
  it('succeed silently and pass the id and value through', async () => {
    const rs = api();
    expect(await setRuleEnabled(rs, ID.host, false)).toBeNull();
    expect(rs.toggleRule).toHaveBeenCalledWith(ID.host, false);
    expect(await removeRule(rs, ID.host)).toBeNull();
    expect(rs.deleteRule).toHaveBeenCalledWith(ID.host);
  });

  it('say what failed, in the UI’s words', async () => {
    const rs = api({ ok: false, code: 'not-connected', error: 'English' });
    expect(await setRuleEnabled(rs, ID.host, true)).toEqual({
      tone: 'danger',
      text: "Qoida yoqilmadi: Helper bilan aloqa yo'q — hech narsa yuborilmadi.",
    });
    expect((await setRuleEnabled(rs, ID.host, false))?.text).toMatch(/^Qoida o'chirilmadi: /);
    expect((await removeRule(rs, ID.host))?.text).toMatch(/^Qoida o'chirib tashlanmadi: /);
  });

  it('a rule removed elsewhere is explained', async () => {
    const rs = api({ ok: false, code: 'rule-not-found', error: 'English' });
    expect((await removeRule(rs, ID.host))?.text).toContain("qoida endi yo'q");
  });
});
