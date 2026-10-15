import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18nFor, type I18n } from '../../../../i18n';
import { renderMarkup } from '../../components/test-utils';
import { INITIAL_DIAGNOSTICS_UI, type DiagnosticsUiState } from './controller';
import { DiagnosticsPanel, runBlockedReason, type DiagnosticsPanelProps } from './DiagnosticsScreen';
import { COVERED_DOMAIN, MISMATCH, NOT_COVERED, RULES } from './fixtures';
import { diagnosisView } from './model';

const UZ = i18nFor('uz');
const RU = i18nFor('ru');
const EN = i18nFor('en');

const panel = (extra: Partial<DiagnosticsPanelProps> = {}, ui: Partial<DiagnosticsUiState> = {}) =>
  DiagnosticsPanel({
    ui: { ...INITIAL_DIAGNOSTICS_UI, ...ui },
    blocked: null,
    view: null,
    onInput: vi.fn(),
    onRun: vi.fn(),
    ...extra,
  });

interface AnyProps {
  readonly children?: ReactNode;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elementsOf(node.props.children)];
}

describe('DiagnosticsPanel', () => {
  it('before the first check: the input, "Tekshirish" and an empty state', () => {
    const html = renderMarkup(panel());
    expect(html).toContain('<h1 id="diagnostics-title"');
    expect(html).toContain('Diagnostika');
    expect(html).toContain('for="diagnostics-target"');
    expect(html).toContain('Xost, IP yoki URL');
    expect(html).toContain('Tekshirish');
    expect(html).toContain("Hali tekshiruv yo&#x27;q");
    expect(html).not.toContain('disabled=""');
  });

  it('Enter / "Tekshirish" submits the form without a page reload; typing reports the value', () => {
    const onRun = vi.fn();
    const onInput = vi.fn();
    const elements = elementsOf(panel({ onRun, onInput }));
    const preventDefault = vi.fn();
    elements.find((element) => element.type === 'form')?.props.onSubmit?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    elements.find((element) => element.type === 'input')?.props.onChange?.({ target: { value: 'corp.local' } });
    expect(onInput).toHaveBeenCalledWith('corp.local');
  });

  it('without the helper the button is off with the reason, said beside it too', () => {
    expect(runBlockedReason({ helper: 'connected' })).toBeNull();
    for (const helper of ['loading', 'not-installed', 'disconnected', 'incompatible', 'config-unreadable'] as const) {
      expect(runBlockedReason({ helper })).toBe('helper ulanmagan');
    }
    const html = renderMarkup(panel({ blocked: 'helper ulanmagan' }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Tekshirish — helper ulanmagan"');
    expect(html).toContain('Tekshirish — helper ulanmagan</p>');
  });

  it('busy while it runs: the button announces it and a status line says so', () => {
    const html = renderMarkup(panel({}, { running: true, input: 'corp.local' }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/role="status"[^>]*>Tekshirilmoqda…/);
    expect(html).not.toContain("Hali tekshiruv yo&#x27;q");
  });

  it('a refused input is an alert under the field, and the field is marked', () => {
    const html = renderMarkup(panel({}, { fieldError: 'Xost, IP manzil yoki URL kiriting.' }));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/role="alert"[^>]*>Xost, IP manzil yoki URL kiriting\./);
  });

  it('a failed check is an alert', () => {
    expect(renderMarkup(panel({}, { failure: "Tekshirib bo'lmadi: Helper bilan aloqa yo'q" }))).toMatch(/role="alert"[^>]*>Tekshirib bo/);
  });

  it('a result: verdict, rule and why, the address table, DNS and resolver file', () => {
    const html = renderMarkup(panel({ view: diagnosisView(COVERED_DOMAIN, RULES) }));
    expect(html).toContain('aria-label="corp.local natijasi"');
    expect(html).toContain('Hammasi kutilganidek — Ethernet orqali');
    expect(html).toContain('domen qoidasi: corp.local → Ethernet');
    expect(html).toContain('10.20.4.37');
    expect(html).toContain('en5 · Ethernet · gateway 10.20.4.1');
    expect(html).toContain('✓ mos');
    expect(html).toContain('Server: 10.20.0.10');
    expect(html).toContain('/etc/resolver/corp.local');
    expect(html).toContain('data-tone="ok"');
  });

  it('a mismatch and a name no rule covers', () => {
    const mismatch = renderMarkup(panel({ view: diagnosisView(MISMATCH, RULES) }));
    expect(mismatch).toContain('data-tone="danger"');
    expect(mismatch).toContain('✗ mos emas');
    const uncovered = renderMarkup(panel({ view: diagnosisView(NOT_COVERED, RULES) }));
    expect(uncovered).toContain('tizim resolveri');
    expect(uncovered).toContain('Tekshirilmadi: Amal bajarilmadi.');
    expect(uncovered).toContain('Izohlar');
  });

  describe('in Russian and English, no Uzbek is left', () => {
    const UZBEK_WORDS = ['Tekshirish', 'Xost', 'natijasi', 'qoida', 'orqali', 'Manzillar', 'Izohlar', 'kiriting', 'tizim', 'helper ulanmagan'];
    const all = (i18n: I18n) =>
      [
        panel({ i18n }),
        panel({ i18n, blocked: runBlockedReason({ helper: 'disconnected' }, i18n) }),
        panel({ i18n }, { running: true }),
        panel({ i18n, view: diagnosisView(COVERED_DOMAIN, RULES, i18n) }),
        panel({ i18n, view: diagnosisView(MISMATCH, RULES, i18n) }),
        panel({ i18n, view: diagnosisView(NOT_COVERED, RULES, i18n) }),
      ]
        .map(renderMarkup)
        .join('\n');

    it.each([
      ['ru', RU, 'Проверить'],
      ['en', EN, 'Check'],
    ] as const)('%s', (_name, i18n, run) => {
      const html = all(i18n);
      expect(html).toContain(run);
      for (const word of UZBEK_WORDS) expect(html).not.toContain(word);
      expect(all(UZ)).toContain('Tekshirish');
    });
  });
});
