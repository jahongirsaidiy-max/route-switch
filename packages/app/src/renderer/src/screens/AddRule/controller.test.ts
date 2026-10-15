import type { TestResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsResult } from '../../rs';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import { saveErrorText, saveRule, testRoute, type AddRuleApi } from './actions';
import { createAddRuleController, initialAddRuleUi, type AddRuleUiState } from './controller';
import { NEW_RULE_FORM } from './model';

const NEW_ID = '77777777-7777-4777-8777-777777777777';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const SAVED: RsResult<{ config: typeof CONFIG; state: typeof STATE }> = { ok: true, value: { config: CONFIG, state: STATE } };
const TESTED = (target: string): TestResult => ({ target, destination: 'default', gateway: '192.168.0.1', device: 'en0', role: 'wifi', ruleId: null });

function harness(rs: Partial<AddRuleApi> = {}, id = NEW_ID, initial: AddRuleUiState = initialAddRuleUi()) {
  let state = initial;
  const api: AddRuleApi = {
    saveRule: vi.fn(() => Promise.resolve(SAVED)),
    test: vi.fn((target: string) => Promise.resolve({ ok: true as const, value: TESTED(target) })),
    ...rs,
  };
  const onSaved = vi.fn();
  const controller = createAddRuleController(
    api,
    id,
    (change) => {
      state = change(state);
    },
    () => state,
    onSaved,
  );
  return { api, controller, onSaved, state: () => state };
}

describe('createAddRuleController — editing', () => {
  it('changing the kind keeps everything typed (and the id is the controller’s)', () => {
    const { controller, state } = harness();
    controller.setField('target', '10.1.2.3');
    controller.setKind('ip');
    expect(state().form).toMatchObject({ kind: 'ip', target: '10.1.2.3' });
    const same = state();
    controller.setKind('ip');
    expect(state().form).toBe(same.form);
  });

  it('interface, text fields and the DNS box; an edit clears the last feedback', () => {
    const { controller, state } = harness(undefined, NEW_ID, { ...initialAddRuleUi(), feedback: { tone: 'danger', text: 'x' } });
    controller.setIface('wifi');
    expect(state().form.iface).toBe('wifi');
    expect(state().feedback).toBeNull();
    controller.setField('useDns', true);
    controller.setField('dns', '10.20.0.10');
    controller.setField('note', 'n');
    controller.setField('refreshSec', '900');
    expect(state().form).toMatchObject({ useDns: true, dns: '10.20.0.10', note: 'n', refreshSec: '900' });
  });

  it('blur marks a field touched once', () => {
    const { controller, state } = harness();
    controller.blur('target');
    const touched = state().touched;
    controller.blur('target');
    expect(state().touched).toBe(touched);
    expect([...touched]).toEqual(['target']);
  });

  it('load fills the form from the stored rule once; later loads do not overwrite typing', () => {
    const rule = CONFIG.rules[0];
    if (rule === undefined) throw new Error('fixture');
    const { controller, state } = harness(undefined, rule.id);
    controller.load(rule);
    expect(state()).toMatchObject({ loaded: true, form: { kind: 'subnet', target: '10.0.0.0/8', note: 'Ichki tarmoq' } });
    controller.setField('target', '10.0.0.0/16');
    controller.load(rule);
    expect(state().form.target).toBe('10.0.0.0/16');
  });
});

describe('createAddRuleController — save', () => {
  it('a refused form is not sent: every error shows and the focus goes to the first', async () => {
    const { api, controller, onSaved, state } = harness();
    controller.setKind('domain');
    controller.setField('target', '*.com');
    controller.setField('useDns', true);
    controller.setField('dns', 'x');
    await controller.save(CONFIG);
    expect(api.saveRule).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ submitted: true, saving: false, focusField: 'target', feedback: null });
    controller.focusDone();
    expect(state().focusField).toBeNull();
    const after = state();
    controller.focusDone();
    expect(state()).toBe(after);
  });

  it.each(['10.0.0.0/33', '0.0.0.0/0'])('subnet %s is never sent', async (target) => {
    const { api, controller } = harness();
    controller.setField('target', target);
    await controller.save(CONFIG);
    expect(api.saveRule).not.toHaveBeenCalled();
  });

  it('a conflict with the stored config is not sent', async () => {
    const { api, controller, state } = harness();
    controller.setKind('ip');
    controller.setField('target', '172.16.12.40');
    controller.setIface('wifi');
    await controller.save(CONFIG);
    expect(api.saveRule).not.toHaveBeenCalled();
    expect(state().focusField).toBe('target');
  });

  it('the rule limit is a form error', async () => {
    const rules = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      kind: 'ip' as const,
      target: `10.1.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
      iface: 'ethernet' as const,
      enabled: true,
      refreshSec: 600,
    }));
    const { api, controller, state } = harness();
    controller.setField('target', '10.200.0.0/16');
    await controller.save({ ...CONFIG, rules });
    expect(api.saveRule).not.toHaveBeenCalled();
    expect(state().feedback).toEqual({ tone: 'danger', text: "500 tadan ortiq qoida qo'shib bo'lmaydi." });
    expect(state().focusField).toBeNull();
  });

  it('a valid form is sent once, normalised, with its id; success closes the form', async () => {
    const answer = deferred<typeof SAVED>();
    const { api, controller, onSaved, state } = harness({ saveRule: vi.fn(() => answer.promise) });
    controller.setField('target', '10.1.2.3/8');
    controller.setField('note', ' Ichki ');
    const first = controller.save(CONFIG);
    expect(state().saving).toBe(true);
    await controller.save(CONFIG);
    expect(api.saveRule).toHaveBeenCalledTimes(1);
    expect(api.saveRule).toHaveBeenCalledWith({
      id: NEW_ID,
      enabled: true,
      kind: 'subnet',
      target: '10.0.0.0/8',
      iface: 'ethernet',
      refreshSec: 600,
      note: 'Ichki',
    });
    answer.resolve(SAVED);
    await first;
    expect(state()).toMatchObject({ saving: false, feedback: null });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('without a config read the rule alone is checked and sent (main and helper check the config)', async () => {
    const { api, controller } = harness();
    controller.setField('target', '10.0.0.0/8');
    await controller.save(null);
    expect(api.saveRule).toHaveBeenCalledTimes(1);
  });

  it('editing keeps the id and the stored switch, even when the kind changes', async () => {
    const rule = CONFIG.rules.find((candidate) => candidate.id === ID.off);
    if (rule === undefined) throw new Error('fixture');
    const { api, controller } = harness(undefined, ID.off);
    controller.load(rule);
    controller.setKind('subnet');
    controller.setField('target', '10.9.9.0/24');
    await controller.save(CONFIG);
    expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: ID.off, enabled: false, kind: 'subnet', target: '10.9.9.0/24' }));
  });

  it('a refusal by the helper keeps the form open with the reason; another try is possible', async () => {
    const saveRuleMock = vi.fn((): Promise<RsResult<never>> => Promise.resolve({ ok: false, code: 'invalid-config', error: 'x' }));
    const { api, controller, onSaved, state } = harness({ saveRule: saveRuleMock });
    controller.setField('target', '10.0.0.0/8');
    await controller.save(CONFIG);
    expect(onSaved).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ saving: false, feedback: { tone: 'danger', text: saveErrorText('invalid-config') } });
    await controller.save(CONFIG);
    expect(api.saveRule).toHaveBeenCalledTimes(2);
  });
});

describe('createAddRuleController — test', () => {
  it('runs, then shows the answer for that address', async () => {
    const { api, controller, state } = harness();
    const run = controller.runTest('10.0.0.1');
    expect(state().test).toEqual({ phase: 'running', address: '10.0.0.1' });
    await run;
    expect(api.test).toHaveBeenCalledWith('10.0.0.1');
    expect(state().test).toEqual({ phase: 'done', address: '10.0.0.1', result: TESTED('10.0.0.1') });
  });

  it('a failed lookup shows why', async () => {
    const { controller, state } = harness({ test: vi.fn(() => Promise.resolve({ ok: false as const, code: 'operation-failed' as const, error: 'x' })) });
    await controller.runTest('10.0.0.1');
    expect(state().test).toEqual({ phase: 'failed', address: '10.0.0.1', text: 'Bu manzil uchun route topilmadi.' });
  });

  it('an answer that arrives after a newer request is dropped', async () => {
    const slow = deferred<RsResult<TestResult>>();
    const fast = deferred<RsResult<TestResult>>();
    const test = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { controller, state } = harness({ test });
    const first = controller.runTest('10.0.0.1');
    const second = controller.runTest('172.16.12.40');
    fast.resolve({ ok: true, value: TESTED('172.16.12.40') });
    await second;
    slow.resolve({ ok: true, value: TESTED('10.0.0.1') });
    await first;
    expect(state().test).toMatchObject({ phase: 'done', address: '172.16.12.40' });
  });
});

describe('actions', () => {
  it('saveRule: null on success, the reason otherwise', async () => {
    const rule = CONFIG.rules[0];
    if (rule === undefined) throw new Error('fixture');
    expect(await saveRule({ saveRule: () => Promise.resolve(SAVED), test: vi.fn() }, rule)).toBeNull();
    expect(await saveRule({ saveRule: () => Promise.resolve({ ok: false, code: 'not-connected', error: 'x' }), test: vi.fn() }, rule)).toEqual({
      tone: 'danger',
      text: "Qoida saqlanmadi: Helper bilan aloqa yo'q — hech narsa yuborilmadi.",
    });
  });

  it('saveErrorText: a refused config is said plainly; unknown outcomes say so', () => {
    expect(saveErrorText('invalid-config')).toContain('helper uni qabul qilmadi');
    expect(saveErrorText('invalid-input')).toBe(saveErrorText('invalid-config'));
    expect(saveErrorText('timeout')).toContain("natija noma'lum");
  });

  it('testRoute: value, no route, other failure', async () => {
    const value = TESTED('10.0.0.1');
    expect(await testRoute({ saveRule: vi.fn(), test: () => Promise.resolve({ ok: true, value }) }, '10.0.0.1')).toEqual({ ok: true, result: value });
    expect(await testRoute({ saveRule: vi.fn(), test: () => Promise.resolve({ ok: false, code: 'disconnected', error: 'x' }) }, '10.0.0.1')).toEqual({
      ok: false,
      text: "Sinab bo'lmadi: Javob kelmadi: natija noma'lum. Helper qayta ulanganda holat yangilanadi.",
    });
  });
});

it('initialAddRuleUi: a new rule form', () => {
  expect(initialAddRuleUi()).toMatchObject({ form: NEW_RULE_FORM, loaded: false, submitted: false, saving: false, test: { phase: 'idle' } });
});
