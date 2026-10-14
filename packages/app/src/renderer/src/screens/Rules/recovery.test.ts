import { describe, expect, it, vi } from 'vitest';

import type { RsResult } from '../../rs';
import {
  createRecoveryController,
  focusResetButton,
  INITIAL_RECOVERY_UI,
  recoveryHandlers,
  RESET_DONE,
  type RecoveryApi,
  type RecoveryUiState,
} from './recovery';

function harness(answer: () => Promise<RsResult<never>> | Promise<RsResult<unknown>>) {
  let state: RecoveryUiState = INITIAL_RECOVERY_UI;
  const resetConfig = vi.fn(answer);
  const controller = createRecoveryController(
    { resetConfig } as unknown as RecoveryApi,
    (change) => {
      state = change(state);
    },
    () => state,
  );
  return { controller, resetConfig, state: () => state };
}

const okReset = () => Promise.resolve({ ok: true as const, value: {} });

describe('createRecoveryController', () => {
  it('the button only asks; nothing is sent', () => {
    const h = harness(okReset);
    h.controller.ask();
    expect(h.state()).toEqual({ confirming: true, busy: false, feedback: null, focusReset: false });
    expect(h.resetConfig).not.toHaveBeenCalled();
  });

  it('cancel closes the question and asks for the focus back; nothing is sent', () => {
    const h = harness(okReset);
    h.controller.ask();
    h.controller.cancel();
    expect(h.state()).toMatchObject({ confirming: false, focusReset: true });
    h.controller.focusDone();
    expect(h.state().focusReset).toBe(false);
    expect(h.resetConfig).not.toHaveBeenCalled();
    // A cancel without a question changes nothing.
    const before = h.state();
    h.controller.cancel();
    expect(h.state()).toBe(before);
  });

  it('confirm sends once, is busy meanwhile, and closes with the success line', async () => {
    let settle: (value: RsResult<unknown>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (settle = resolve)));
    h.controller.ask();
    const first = h.controller.confirm();
    expect(h.state()).toMatchObject({ busy: true, confirming: true });
    void h.controller.confirm();
    // Neither a second confirm, nor a cancel, nor another ask while it is on its way.
    h.controller.cancel();
    h.controller.ask();
    expect(h.state()).toMatchObject({ busy: true, confirming: true, focusReset: false });
    settle({ ok: true, value: {} });
    await first;
    expect(h.resetConfig).toHaveBeenCalledTimes(1);
    expect(h.state()).toEqual({ confirming: false, busy: false, feedback: { tone: 'success', text: RESET_DONE }, focusReset: false });
  });

  it('a refusal keeps the question open with the reason, for another try', async () => {
    const h = harness(() => Promise.resolve({ ok: false as const, code: 'operation-failed' as const, error: 'x' }));
    h.controller.ask();
    await h.controller.confirm();
    expect(h.state()).toEqual({
      confirming: true,
      busy: false,
      feedback: { tone: 'danger', text: 'Config almashtirilmadi: Amal bajarilmadi.' },
      focusReset: false,
    });
  });

  it('confirm without a question sends nothing', async () => {
    const h = harness(okReset);
    await h.controller.confirm();
    expect(h.resetConfig).not.toHaveBeenCalled();
  });

  it('recoveryHandlers wires the panel to the controller', async () => {
    const h = harness(okReset);
    const handlers = recoveryHandlers(h.controller);
    handlers.onAskReset();
    expect(h.state().confirming).toBe(true);
    handlers.onCancelReset();
    expect(h.state().confirming).toBe(false);
    handlers.onAskReset();
    handlers.onConfirmReset();
    await Promise.resolve();
    expect(h.resetConfig).toHaveBeenCalledTimes(1);
  });
});

describe('focusResetButton', () => {
  it('focuses the button only while it is on the page', () => {
    const focus = vi.fn();
    expect(focusResetButton({ isConnected: true, focus })).toBe(true);
    expect(focusResetButton({ isConnected: false, focus })).toBe(false);
    expect(focusResetButton(null)).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
