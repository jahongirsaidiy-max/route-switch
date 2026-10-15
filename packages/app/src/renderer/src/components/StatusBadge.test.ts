import { RULE_STATUSES } from '@routeswitch/shared';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { RULE_STATUS_LABELS, RULE_STATUS_TONES, StatusBadge, StatusDot } from './StatusBadge';
import { renderMarkup } from './test-utils';

describe('StatusBadge', () => {
  it.each([
    ['active', 'Faol', 'success'],
    ['pending', 'Kutilmoqda', 'warning'],
    ['error', 'Xato', 'danger'],
  ] as const)('shows %s as "%s" in the %s tone', (status, label, tone) => {
    const html = renderMarkup(createElement(StatusBadge, { status }));
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`data-tone="${tone}"`);
    expect(html).toContain(label);
    expect(html).not.toContain('title=');
  });

  it('has a label and tone for every status of the protocol', () => {
    for (const status of RULE_STATUSES) {
      expect(RULE_STATUS_LABELS[status]).toBeTruthy();
      expect(RULE_STATUS_TONES[status]).toBeTruthy();
    }
    expect(renderMarkup(createElement(StatusBadge, { status: 'disabled' }))).toContain('data-tone="neutral"');
  });

  it('carries the reason as a tooltip and for screen readers', () => {
    const html = renderMarkup(createElement(StatusBadge, { status: 'error', detail: 'DNS javob bermadi' }));
    expect(html).toContain('title="DNS javob bermadi"');
    expect(html).toContain(': DNS javob bermadi');
  });
});

describe('StatusDot', () => {
  it('is a named image in its tone and size', () => {
    const html = renderMarkup(createElement(StatusDot, { tone: 'success', label: 'Ulangan' }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ulangan"');
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('data-size="md"');
    expect(renderMarkup(createElement(StatusDot, { tone: 'danger', label: 'x', size: 'sm' }))).toContain(
      'data-size="sm"',
    );
  });
});
