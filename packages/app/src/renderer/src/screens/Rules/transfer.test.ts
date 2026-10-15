import type { Config } from '@routeswitch/shared';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Toggle } from '../../components';
import { renderMarkup } from '../../components/test-utils';
import type { ConfigView } from '../../hooks/useConfig';
import type { RsResult } from '../../rs';
import { CONFIG, ID, NOW, STATE } from '../MenuBar/fixtures';
import type { RulesUiState } from './controller';
import { INITIAL_RECOVERY_UI } from './recovery';
import { RulesPanel, type RulesPanelProps } from './RulesScreen';
import {
  createTransferController,
  importFailureText,
  importQuestion,
  importSummary,
  INITIAL_TRANSFER_UI,
  returnImportFocus,
  transferPanelProps,
  type TransferApi,
  type TransferUiState,
} from './transfer';

const TOKEN = '99999999-9999-4999-8999-999999999999';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const IMPORTED: Config = {
  version: 1,
  enabled: false,
  ifaceOverrides: { ethernet: 'en7' },
  rules: [
    // unchanged
    ...CONFIG.rules.slice(0, 2),
    // changed (interface)
    ...CONFIG.rules.slice(2, 3).map((rule) => ({ ...rule, iface: 'wifi' as const })),
    // new
    { id: NEW_ID, kind: 'ip', target: '10.9.8.7', iface: 'ethernet', enabled: true, refreshSec: 600 },
  ],
};

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

function harness(rs: Partial<TransferApi> = {}, initial: TransferUiState = INITIAL_TRANSFER_UI) {
  let state = initial;
  const api: TransferApi = {
    importConfig: vi.fn(() => Promise.resolve({ ok: true as const, value: { token: TOKEN, config: IMPORTED } })),
    applyImport: vi.fn(() => Promise.resolve({ ok: true as const, value: { config: IMPORTED, state: STATE } })),
    exportConfig: vi.fn(() => Promise.resolve({ ok: true as const, value: { rules: 6, bytes: 900 } })),
    ...rs,
  };
  const controller = createTransferController(
    api,
    (change) => {
      state = change(state);
    },
    () => state,
  );
  return { api, controller, state: () => state };
}

describe('import', () => {
  it('a read file waits for confirmation; nothing is applied until "Almashtirish"', async () => {
    const { api, controller, state } = harness();
    const run = controller.startImport();
    expect(state().phase).toBe('importing');
    await run;
    expect(state()).toMatchObject({ phase: 'idle', preview: { token: TOKEN, config: IMPORTED }, feedback: null });
    expect(api.applyImport).not.toHaveBeenCalled();
  });

  it('a cancelled dialog changes nothing', async () => {
    const { controller, state } = harness({ importConfig: () => Promise.resolve({ ok: true, value: null }) });
    await controller.startImport();
    expect(state()).toEqual(INITIAL_TRANSFER_UI);
  });

  it('a refused file says why, in words, and nothing waits', async () => {
    const refused = (): Promise<RsResult<never>> =>
      Promise.resolve({ ok: false, code: 'invalid-config', error: 'x', issue: { path: ['rules', 2, 'target'], code: 'default-route' } });
    const { controller, state } = harness({ importConfig: refused });
    await controller.startImport();
    expect(state()).toMatchObject({
      phase: 'idle',
      preview: null,
      feedback: { tone: 'danger', text: "Import qilinmadi: 3-qoida, manzil: Default route (0.0.0.0/0) hech qachon o'zgartirilmaydi." },
    });
  });

  it('a second click while busy is ignored', async () => {
    const answer = deferred<RsResult<null>>();
    const importConfig = vi.fn(() => answer.promise);
    const { api, controller } = harness({ importConfig });
    const first = controller.startImport();
    await controller.startImport();
    await controller.startExport();
    expect(importConfig).toHaveBeenCalledTimes(1);
    expect(api.exportConfig).not.toHaveBeenCalled();
    answer.resolve({ ok: true, value: null });
    await first;
  });

  it('confirm applies exactly that token, once; success closes and returns the focus to "Import"', async () => {
    const answer = deferred<RsResult<never>>();
    const applyImport = vi.fn(() => answer.promise);
    const { controller, state } = harness({ applyImport });
    await controller.startImport();
    await controller.confirmImport('00000000-0000-4000-8000-000000000000');
    expect(applyImport).not.toHaveBeenCalled();
    const run = controller.confirmImport(TOKEN);
    expect(state().phase).toBe('applying');
    await controller.confirmImport(TOKEN);
    controller.cancelImport();
    controller.dismiss();
    expect(state().preview).not.toBeNull();
    expect(applyImport).toHaveBeenCalledTimes(1);
    expect(applyImport).toHaveBeenCalledWith(TOKEN);
    answer.resolve({ ok: true, value: undefined as never });
    await run;
    expect(state()).toMatchObject({ phase: 'idle', preview: null, focusImport: true, feedback: { tone: 'success', text: 'Config import qilindi: 4 ta qoida.' } });
    controller.focusDone();
    expect(state().focusImport).toBe(false);
  });

  it('a refused replacement closes the question (the token is used up) and says why', async () => {
    const { controller, state } = harness({ applyImport: () => Promise.resolve({ ok: false, code: 'not-connected', error: 'x' }) });
    await controller.startImport();
    await controller.confirmImport(TOKEN);
    expect(state()).toMatchObject({ preview: null, feedback: { tone: 'danger', text: "Config almashtirilmadi: Helper bilan aloqa yo'q — hech narsa yuborilmadi." } });
    const expired = harness({ applyImport: () => Promise.resolve({ ok: false, code: 'import-expired', error: 'x' }) });
    await expired.controller.startImport();
    await expired.controller.confirmImport(TOKEN);
    expect(expired.state().feedback?.text).toBe("Import qilinmadi: Tanlangan fayl muddati o'tdi — faylni qayta tanlang.");
  });

  it('cancel forgets the file and returns the focus; dismiss forgets it without moving the focus', async () => {
    const { api, controller, state } = harness();
    await controller.startImport();
    controller.cancelImport();
    expect(state()).toMatchObject({ preview: null, focusImport: true });
    expect(api.applyImport).not.toHaveBeenCalled();
    const other = harness();
    await other.controller.startImport();
    other.controller.dismiss();
    expect(other.state()).toMatchObject({ preview: null, focusImport: false });
    const same = other.state();
    other.controller.cancelImport();
    expect(other.state()).toBe(same);
  });
});

describe('export', () => {
  it('success says how many rules were saved; cancel says nothing; failure says why', async () => {
    const { controller, state } = harness();
    await controller.startExport();
    expect(state()).toMatchObject({ phase: 'idle', feedback: { tone: 'success', text: 'Config faylga saqlandi: 6 ta qoida.' } });
    const cancelled = harness({ exportConfig: () => Promise.resolve({ ok: true, value: null }) });
    await cancelled.controller.startExport();
    expect(cancelled.state().feedback).toBeNull();
    const failed = harness({ exportConfig: () => Promise.resolve({ ok: false, code: 'write-failed', error: 'x' }) });
    await failed.controller.startExport();
    expect(failed.state().feedback).toEqual({ tone: 'danger', text: "Export qilinmadi: Faylni yozib bo'lmadi — boshqa joyni tanlang." });
  });
});

describe('importSummary / importQuestion', () => {
  it('counts rules by id: added, removed, changed, unchanged; the global switch and overrides', () => {
    const summary = importSummary(CONFIG, IMPORTED);
    expect(summary).toEqual({ rules: 4, current: 6, added: 1, removed: 3, changed: 1, unchanged: 2, enabledChange: 'off', overridesChanged: true });
    expect(importQuestion(summary)).toBe(
      "Import joriy configni to'liq almashtiradi: 4 ta qoida (hozir 6 ta). Qo'shiladi: 1, o'chiriladi: 3, o'zgaradi: 1, o'zgarmaydi: 2. Routing o'chiriladi. Interfeys almashtirishlari ham almashadi.",
    );
    expect(importQuestion(importSummary(CONFIG, CONFIG))).toBe(
      "Import joriy configni to'liq almashtiradi: 6 ta qoida (hozir 6 ta). Qo'shiladi: 0, o'chiriladi: 0, o'zgaradi: 0, o'zgarmaydi: 6.",
    );
    expect(importSummary({ ...CONFIG, enabled: false }, CONFIG).enabledChange).toBe('on');
    expect(importQuestion(importSummary(null, IMPORTED))).toBe("Import joriy configni to'liq almashtiradi: 4 ta qoida.");
  });

  it('ids match regardless of case; a note change counts as a change', () => {
    const upper: Config = { ...CONFIG, rules: CONFIG.rules.map((rule) => ({ ...rule, id: rule.id.toUpperCase() })) };
    expect(importSummary(CONFIG, upper)).toMatchObject({ unchanged: 6, added: 0, removed: 0 });
    const noted: Config = { ...CONFIG, rules: CONFIG.rules.map((rule, i) => (i === 0 ? { ...rule, note: 'boshqa' } : rule)) };
    expect(importSummary(CONFIG, noted)).toMatchObject({ changed: 1, unchanged: 5 });
  });
});

it('importFailureText: file problems and schema issues in words', () => {
  expect(importFailureText({ ok: false, code: 'file-not-json', error: 'x' })).toBe('Import qilinmadi: Fayl JSON emas yoki buzilgan.');
  expect(importFailureText({ ok: false, code: 'invalid-config', error: 'x', issue: { path: ['version'], code: 'invalid_value' } })).toBe(
    'Import qilinmadi: Config versiyasi mos emas (kutilgan: 1) — fayl boshqa versiyadan.',
  );
});

// ---------------------------------------------------------------------------
// The panel's confirmation (hook-free: element tree, no DOM)
// ---------------------------------------------------------------------------

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: { key: string }) => void;
  readonly label?: string;
  readonly busy?: boolean;
  readonly autoFocus?: boolean;
  readonly role?: string;
  readonly ref?: unknown;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  const own: ReactElement<AnyProps>[] = [node, ...elementsOf(node.props.children)];
  if (typeof node.type === 'function' && node.type !== Button && node.type !== Toggle) {
    own.push(...elementsOf((node.type as (p: AnyProps) => ReactNode)(node.props)));
  }
  return own;
}
const panelProps = (extra: Partial<RulesPanelProps> = {}): RulesPanelProps => ({
  engine: { helper: 'connected', connection: { kind: 'connected', helperVersion: '0.1.0' }, state: STATE, error: null },
  config: { phase: 'ready', config: CONFIG, revision: 3, error: null } satisfies ConfigView,
  now: NOW,
  query: '',
  filter: 'all',
  busy: new Set(),
  confirmingDelete: null,
  feedback: null,
  onQueryChange: vi.fn(),
  onFilterChange: vi.fn(),
  onToggleRule: vi.fn(),
  onAskDelete: vi.fn(),
  onCancelDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onReloadConfig: vi.fn(),
  transfer: INITIAL_TRANSFER_UI,
  onImport: vi.fn(),
  onExport: vi.fn(),
  onConfirmImport: vi.fn(),
  onCancelImport: vi.fn(),
  recovery: INITIAL_RECOVERY_UI,
  onAskReset: vi.fn(),
  onCancelReset: vi.fn(),
  onConfirmReset: vi.fn(),
  ...extra,
});
const buttonNamed = (elements: ReactElement<AnyProps>[], name: string) =>
  elements.find((element) => element.type === Button && (element.props.children === name || element.props.label === name));

describe('RulesPanel — import / export', () => {
  it('"Import" and "Export" are enabled and call their handlers; both are busy while a transfer runs', () => {
    const props = panelProps();
    const elements = elementsOf(RulesPanel(props));
    buttonNamed(elements, 'Config import (JSON fayldan)')?.props.onClick?.();
    buttonNamed(elements, 'Config export (JSON faylga)')?.props.onClick?.();
    expect(props.onImport).toHaveBeenCalledTimes(1);
    expect(props.onExport).toHaveBeenCalledTimes(1);
    const busy = elementsOf(RulesPanel(panelProps({ transfer: { ...INITIAL_TRANSFER_UI, phase: 'exporting' } })));
    expect(buttonNamed(busy, 'Config import (JSON fayldan)')?.props.busy).toBe(true);
    expect(buttonNamed(busy, 'Config export (JSON faylga)')?.props.busy).toBe(true);
  });

  it('a waiting file shows the replacement question; the safe choice has the focus; Escape cancels', () => {
    const props = panelProps({ transfer: { ...INITIAL_TRANSFER_UI, preview: { token: TOKEN, config: IMPORTED } }, confirmingDelete: ID.subnet });
    const html = renderMarkup(createElement(RulesPanel, props));
    expect(html).toContain('role="alertdialog" aria-labelledby="rules-import-question"');
    expect(html).toContain("Import joriy configni to&#x27;liq almashtiradi: 4 ta qoida (hozir 6 ta).");
    // One question at a time: the delete question is not shown with it.
    expect(html).not.toContain('rules-delete-question');
    const elements = elementsOf(RulesPanel(props));
    expect(buttonNamed(elements, 'Bekor qilish')?.props.autoFocus).toBe(true);
    buttonNamed(elements, 'Almashtirish')?.props.onClick?.();
    expect(props.onConfirmImport).toHaveBeenCalledWith(TOKEN);
    const dialog = elements.find((element) => element.props.role === 'alertdialog');
    dialog?.props.onKeyDown?.({ key: 'Enter' });
    expect(props.onCancelImport).not.toHaveBeenCalled();
    dialog?.props.onKeyDown?.({ key: 'Escape' });
    buttonNamed(elements, 'Bekor qilish')?.props.onClick?.();
    expect(props.onCancelImport).toHaveBeenCalledTimes(2);
  });

  it('"Almashtirish" is busy while the replacement is on its way; feedback is shown', () => {
    const elements = elementsOf(RulesPanel(panelProps({ transfer: { phase: 'applying', preview: { token: TOKEN, config: IMPORTED }, feedback: null, focusImport: false } })));
    expect(buttonNamed(elements, 'Almashtirish')?.props.busy).toBe(true);
    const html = renderMarkup(createElement(RulesPanel, panelProps({ transfer: { ...INITIAL_TRANSFER_UI, feedback: { tone: 'danger', text: 'Import qilinmadi: x' } } })));
    expect(html).toMatch(/role="alert"[^>]*>Import qilinmadi: x/);
    const ok = renderMarkup(createElement(RulesPanel, panelProps({ transfer: { ...INITIAL_TRANSFER_UI, feedback: { tone: 'success', text: 'Config faylga saqlandi: 6 ta qoida.' } } })));
    expect(ok).toMatch(/role="status"[^>]*>Config faylga saqlandi/);
  });
});

describe('transferPanelProps (the screen\'s wiring of import and delete)', () => {
  const controllers = () => {
    const calls: string[] = [];
    const rules = {
      askDelete: vi.fn((id: string) => calls.push(`askDelete:${id}`)),
      dismissDelete: vi.fn(() => calls.push('dismissDelete')),
    };
    const transfer = {
      startImport: vi.fn(() => {
        calls.push('startImport');
        return Promise.resolve();
      }),
      cancelImport: vi.fn(() => calls.push('cancelImport')),
      dismiss: vi.fn(() => calls.push('dismiss')),
      confirmImport: vi.fn((token: string) => {
        calls.push(`confirmImport:${token}`);
        return Promise.resolve();
      }),
      startExport: vi.fn(() => {
        calls.push('startExport');
        return Promise.resolve();
      }),
      focusDone: vi.fn(() => calls.push('focusDone')),
    };
    return { calls, rules, transfer };
  };

  it('the trash closes the import question, then asks about the rule', () => {
    const { calls, rules, transfer } = controllers();
    transferPanelProps(rules, transfer, INITIAL_TRANSFER_UI, null).onAskDelete(ID.domain);
    expect(calls).toEqual(['dismiss', `askDelete:${ID.domain}`]);
  });

  it('"Import" closes the removal question, then opens the file dialog', () => {
    const { calls, rules, transfer } = controllers();
    transferPanelProps(rules, transfer, INITIAL_TRANSFER_UI, null).onImport();
    expect(calls).toEqual(['dismissDelete', 'startImport']);
  });

  it('export, confirm and cancel go to their own controller calls; the state and the Import ref are passed on', () => {
    const { calls, rules, transfer } = controllers();
    const ref = { current: null };
    const state: TransferUiState = { ...INITIAL_TRANSFER_UI, phase: 'exporting' };
    const props = transferPanelProps(rules, transfer, state, ref);
    expect(props.transfer).toBe(state);
    expect(props.importRef).toBe(ref);
    props.onExport();
    props.onConfirmImport(TOKEN);
    props.onCancelImport();
    expect(calls).toEqual(['startExport', `confirmImport:${TOKEN}`, 'cancelImport']);
  });

  it('end to end with the real controllers: an open import question gives way to the trash, and the reverse', async () => {
    const { createRulesController, INITIAL_RULES_UI } = await import('./controller');
    const rulesState: { current: RulesUiState } = { current: INITIAL_RULES_UI };
    const rulesController = createRulesController(
      { toggleRule: vi.fn(), deleteRule: vi.fn() },
      (change) => {
        rulesState.current = change(rulesState.current);
      },
      () => rulesState.current,
    );
    const t = harness();
    let props = transferPanelProps(rulesController, t.controller, t.state(), null);
    props.onImport();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.state().preview?.token).toBe(TOKEN);
    props = transferPanelProps(rulesController, t.controller, t.state(), null);
    props.onAskDelete(ID.domain);
    expect(t.state().preview).toBeNull();
    expect(rulesState.current.confirmingDelete).toBe(ID.domain);
    props.onImport();
    expect(rulesState.current.confirmingDelete).toBeNull();
    expect(rulesState.current.focusTrash).toBeNull();
  });
});

describe('returnImportFocus', () => {
  it('moves the focus to "Import" once the confirmation closed, and forgets the request', () => {
    const button = { focus: vi.fn() };
    const transfer = { focusDone: vi.fn() };
    expect(returnImportFocus({ focusImport: true }, button, transfer)).toBe(true);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(transfer.focusDone).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing was asked; forgets the request when the button is gone', () => {
    const button = { focus: vi.fn() };
    const transfer = { focusDone: vi.fn() };
    expect(returnImportFocus({ focusImport: false }, button, transfer)).toBe(false);
    expect(button.focus).not.toHaveBeenCalled();
    expect(transfer.focusDone).not.toHaveBeenCalled();
    expect(returnImportFocus({ focusImport: true }, null, transfer)).toBe(false);
    expect(transfer.focusDone).toHaveBeenCalledTimes(1);
  });

  it('with the real controller: cancel asks for the focus, which then lands on the button', async () => {
    const t = harness();
    await t.controller.startImport();
    t.controller.cancelImport();
    const button = { focus: vi.fn() };
    expect(returnImportFocus(t.state(), button, t.controller)).toBe(true);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(t.state().focusImport).toBe(false);
  });
});

it('the panel puts the Import ref on the "Import" button', () => {
  const ref = { current: null };
  const elements = elementsOf(RulesPanel(panelProps({ importRef: ref })));
  expect(buttonNamed(elements, 'Config import (JSON fayldan)')?.props.ref).toBe(ref);
});
