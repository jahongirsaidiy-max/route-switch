import type { SetConfigResult } from '@routeswitch/shared';
import { describe, expect, it, vi } from 'vitest';

import type { RsResult } from '../../rs';
import { CONFIG, ID, STATE } from '../MenuBar/fixtures';
import type { RulesApi } from './actions';
import { createRulesController, focusTrashButton, INITIAL_RULES_UI, rulesHandlers, type RulesUiState } from './controller';

const STORED: RsResult<SetConfigResult> = { ok: true, value: { config: CONFIG, state: STATE } };
const FAILED: RsResult<SetConfigResult> = { ok: false, code: 'timeout', error: 'English' };

/** A call the test settles by hand, so the state while it waits can be seen. */
function deferred() {
  let settle: (result: RsResult<SetConfigResult>) => void = () => undefined;
  const promise = new Promise<RsResult<SetConfigResult>>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function harness(start: RulesUiState = INITIAL_RULES_UI) {
  let state = start;
  const toggle = deferred();
  const remove = deferred();
  const rs = {
    toggleRule: vi.fn<RulesApi['toggleRule']>(() => toggle.promise),
    deleteRule: vi.fn<RulesApi['deleteRule']>(() => remove.promise),
  };
  const controller = createRulesController(
    rs,
    (change) => {
      state = change(state);
    },
    () => state,
  );
  return { rs, controller, state: () => state, toggle, remove };
}

describe('toggle', () => {
  it.each([true, false])('sends exactly the requested value (%s), busy while it waits', async (enabled) => {
    const h = harness();
    const done = h.controller.toggle(ID.host, enabled);
    expect(h.rs.toggleRule).toHaveBeenCalledTimes(1);
    expect(h.rs.toggleRule).toHaveBeenCalledWith(ID.host, enabled);
    expect(h.state().busy.has(ID.host)).toBe(true);
    h.toggle.settle(STORED);
    await done;
    expect(h.state().busy.has(ID.host)).toBe(false);
    expect(h.state().feedback).toBeNull();
    expect(h.rs.deleteRule).not.toHaveBeenCalled();
  });

  it('a failure becomes the message; a second click while busy sends nothing', async () => {
    const h = harness();
    const done = h.controller.toggle(ID.host, false);
    await h.controller.toggle(ID.host, true);
    expect(h.rs.toggleRule).toHaveBeenCalledTimes(1);
    h.toggle.settle(FAILED);
    await done;
    expect(h.state().feedback?.text).toMatch(/^Qoida o'chirilmadi: /);
    expect(h.state().busy.size).toBe(0);
  });

  it('a new action clears the previous message', () => {
    const h = harness({ ...INITIAL_RULES_UI, feedback: { tone: 'danger', text: 'old' } });
    void h.controller.toggle(ID.host, true);
    expect(h.state().feedback).toBeNull();
  });
});

describe('delete', () => {
  it('the trash button only asks: nothing is sent', () => {
    const h = harness();
    h.controller.askDelete(ID.domain);
    expect(h.state().confirmingDelete).toBe(ID.domain);
    expect(h.rs.deleteRule).not.toHaveBeenCalled();
    expect(h.rs.toggleRule).not.toHaveBeenCalled();
  });

  it('cancel closes the question, sends nothing, and asks for the focus to go back to the trash button', () => {
    const h = harness();
    h.controller.askDelete(ID.domain);
    h.controller.cancelDelete();
    expect(h.state()).toMatchObject({ confirmingDelete: null, focusTrash: ID.domain });
    expect(h.rs.deleteRule).not.toHaveBeenCalled();
    h.controller.focusDone();
    expect(h.state().focusTrash).toBeNull();
  });

  it('cancel with nothing asked changes nothing', () => {
    const h = harness();
    h.controller.cancelDelete();
    expect(h.state()).toBe(INITIAL_RULES_UI);
  });

  it('confirm removes exactly that rule once; busy while it waits; the question closes on success', async () => {
    const h = harness();
    h.controller.askDelete(ID.domain);
    const done = h.controller.confirmDelete(ID.domain);
    expect(h.rs.deleteRule).toHaveBeenCalledTimes(1);
    expect(h.rs.deleteRule).toHaveBeenCalledWith(ID.domain);
    expect(h.state().busy.has(ID.domain)).toBe(true);
    expect(h.state().confirmingDelete).toBe(ID.domain);
    // A second press while it waits sends nothing more.
    await h.controller.confirmDelete(ID.domain);
    expect(h.rs.deleteRule).toHaveBeenCalledTimes(1);
    h.remove.settle(STORED);
    await done;
    expect(h.state()).toMatchObject({ confirmingDelete: null, feedback: null });
    expect(h.state().busy.size).toBe(0);
  });

  it('a failed removal keeps the question open with the reason, for another try', async () => {
    const h = harness();
    h.controller.askDelete(ID.domain);
    const done = h.controller.confirmDelete(ID.domain);
    h.remove.settle(FAILED);
    await done;
    expect(h.state().confirmingDelete).toBe(ID.domain);
    expect(h.state().feedback?.text).toMatch(/^Qoida o'chirib tashlanmadi: /);
    expect(h.state().busy.size).toBe(0);
  });

  it('confirm for a rule that is not being asked about sends nothing', async () => {
    const h = harness();
    await h.controller.confirmDelete(ID.domain);
    h.controller.askDelete(ID.host);
    await h.controller.confirmDelete(ID.domain);
    expect(h.rs.deleteRule).not.toHaveBeenCalled();
  });

  it('asking about another rule meanwhile is kept when the first removal ends', async () => {
    const h = harness();
    h.controller.askDelete(ID.domain);
    const done = h.controller.confirmDelete(ID.domain);
    h.controller.askDelete(ID.host);
    h.remove.settle(STORED);
    await done;
    expect(h.state().confirmingDelete).toBe(ID.host);
  });
});

describe('focusTrashButton', () => {
  it('focuses the button of the rule when it is on the page', () => {
    const button = { focus: vi.fn() };
    const buttons = new Map([[ID.domain, button]]);
    expect(focusTrashButton(buttons, ID.domain)).toBe(true);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(focusTrashButton(buttons, ID.host)).toBe(false);
    expect(focusTrashButton(buttons, null)).toBe(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });
});

describe('rulesHandlers (the screen\'s wiring of the panel)', () => {
  it('trash asks, cancel cancels, confirm removes, toggle sends the value — each to its own controller call', () => {
    const controller = {
      toggle: vi.fn(() => Promise.resolve()),
      askDelete: vi.fn(),
      cancelDelete: vi.fn(),
      confirmDelete: vi.fn(() => Promise.resolve()),
      focusDone: vi.fn(),
    };
    const handlers = rulesHandlers(controller);
    handlers.onAskDelete(ID.domain);
    expect(controller.askDelete).toHaveBeenCalledWith(ID.domain);
    expect(controller.confirmDelete).not.toHaveBeenCalled();
    handlers.onCancelDelete();
    expect(controller.cancelDelete).toHaveBeenCalledTimes(1);
    expect(controller.confirmDelete).not.toHaveBeenCalled();
    handlers.onConfirmDelete(ID.domain);
    expect(controller.confirmDelete).toHaveBeenCalledWith(ID.domain);
    handlers.onToggleRule(ID.host, false);
    expect(controller.toggle).toHaveBeenCalledWith(ID.host, false);
    expect(controller.askDelete).toHaveBeenCalledTimes(1);
  });

  it('end to end with the real controller: trash, cancel, trash, confirm', async () => {
    const h = harness();
    const handlers = rulesHandlers(h.controller);
    handlers.onAskDelete(ID.domain);
    handlers.onCancelDelete();
    expect(h.rs.deleteRule).not.toHaveBeenCalled();
    handlers.onAskDelete(ID.domain);
    handlers.onConfirmDelete(ID.domain);
    expect(h.rs.deleteRule).toHaveBeenCalledWith(ID.domain);
    handlers.onToggleRule(ID.host, true);
    expect(h.rs.toggleRule).toHaveBeenCalledWith(ID.host, true);
    h.remove.settle(STORED);
    h.toggle.settle(STORED);
    await Promise.resolve();
  });
});
