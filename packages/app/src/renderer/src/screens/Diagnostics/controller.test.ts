import { describe, expect, it, vi } from 'vitest';

import { i18nFor, type I18n } from '../../../../i18n';
import type { RsDiagnosis, RsResult } from '../../rs';
import { createDiagnosticsController, failureText, INITIAL_DIAGNOSTICS_UI, inputErrorText, type DiagnosticsUiState } from './controller';
import { COVERED_DOMAIN } from './fixtures';

function harness(diagnose: (target: string) => Promise<RsResult<RsDiagnosis>>, language: () => I18n = () => i18nFor('uz')) {
  let state: DiagnosticsUiState = INITIAL_DIAGNOSTICS_UI;
  const rs = { diagnose: vi.fn(diagnose) };
  const controller = createDiagnosticsController(
    rs,
    (change) => {
      state = change(state);
    },
    () => state,
    language,
  );
  return { rs, controller, state: () => state };
}

describe('the Diagnostika controller', () => {
  it('a refused input is a field error and nothing is sent', async () => {
    const h = harness(() => Promise.resolve({ ok: true, value: COVERED_DOMAIN }));
    for (const input of ['', '*.corp.local', '[::1]', '127.0.0.1', '10.0.0.0/8', 'no such host']) {
      h.controller.setInput(input);
      await h.controller.run();
      expect(h.state().fieldError).not.toBeNull();
    }
    expect(h.rs.diagnose).not.toHaveBeenCalled();
    h.controller.setInput('corp.local');
    expect(h.state().fieldError).toBeNull();
  });

  it('sends the cleaned-up target once and keeps the diagnosis', async () => {
    const h = harness(() => Promise.resolve({ ok: true, value: COVERED_DOMAIN }));
    h.controller.setInput('  https://Corp.Local:8443/x?y ');
    const run = h.controller.run();
    expect(h.state().running).toBe(true);
    await run;
    expect(h.rs.diagnose).toHaveBeenCalledExactlyOnceWith('corp.local');
    expect(h.state()).toMatchObject({ running: false, diagnosis: COVERED_DOMAIN, failure: null, fieldError: null });
  });

  it('a second press while one runs sends nothing', async () => {
    let answer: (value: RsResult<RsDiagnosis>) => void = () => undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.controller.setInput('corp.local');
    const first = h.controller.run();
    await h.controller.run();
    await h.controller.run();
    expect(h.rs.diagnose).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: COVERED_DOMAIN });
    await first;
    void h.controller.run();
    expect(h.rs.diagnose).toHaveBeenCalledTimes(2);
  });

  it('a failure is said in the language of the moment it arrives; the previous result is dropped', async () => {
    let language = i18nFor('uz');
    let calls = 0;
    const h = harness(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ ok: true, value: COVERED_DOMAIN });
        language = i18nFor('en');
        return Promise.resolve({ ok: false, code: 'not-connected', error: 'There is no connection to the helper' });
      },
      () => language,
    );
    h.controller.setInput('corp.local');
    await h.controller.run();
    await h.controller.run();
    expect(h.state().failure).toMatch(/^Could not check: /);
    expect(h.state().diagnosis).toBeNull();
  });

  it('a rejected call (no main process) is a failure, not an exception', async () => {
    const h = harness(() => Promise.reject(new Error('No handler registered')));
    h.controller.setInput('10.1.2.3');
    await h.controller.run();
    expect(h.state()).toMatchObject({ running: false, failure: expect.stringContaining("Tekshirib bo'lmadi") as unknown });
  });

  it('inputErrorText: the input reasons and the shared validators, in every language', () => {
    expect(inputErrorText('corp.local')).toBeNull();
    expect(inputErrorText('')).toBe('Xost, IP manzil yoki URL kiriting.');
    expect(inputErrorText('127.0.0.1', i18nFor('ru'))).toBe(i18nFor('ru').t.validation.loopback);
    expect(inputErrorText('fe80::1', i18nFor('en'))).toContain('IPv6');
  });

  // DELTA-20 QA follow-up (TASK-DELTA-21): the helper's limits have codes of their own.
  it.each([
    ['rate-limited', "Bir daqiqadan keyin qayta urinib ko'ring."],
    ['busy', 'boshqa tekshiruv bilan band'],
  ] as const)('the helper refuses with %s: its own words, not the generic failure', async (code, words) => {
    const error = 'any message — never shown';
    const h = harness(() => Promise.resolve({ ok: false, code, error }));
    h.controller.setInput('corp.local');
    await h.controller.run();
    expect(h.state().failure).toContain(words);
    expect(h.state().failure).not.toContain('Amal bajarilmadi');
    expect(h.state().failure).not.toContain(error);
    expect(h.state().failure).toBe(failureText(code));
    expect(h.state().failure).not.toContain("Tekshirib bo'lmadi");
  });

  it('other failures keep the generic words, whatever the message; the limit words are translated', () => {
    expect(failureText('operation-failed')).toBe("Tekshirib bo'lmadi: Amal bajarilmadi.");
    expect(failureText('timeout')).toContain("Tekshirib bo'lmadi: ");
    expect(failureText('rate-limited', i18nFor('ru'))).toContain('Повторите через минуту');
    expect(failureText('rate-limited', i18nFor('en'))).toContain('Try again in a minute');
    expect(failureText('busy', i18nFor('en'))).toContain('busy');
  });
});
