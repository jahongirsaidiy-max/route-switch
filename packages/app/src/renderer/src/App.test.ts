import { createElement, type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import { App, SCREENS, VIEWS, VIEW_TITLES, parseView, type View } from './App';
import { renderMarkup } from './components/test-utils';

describe('parseView', () => {
  it('reads the view the main process puts in the query', () => {
    expect(parseView('?view=popover')).toBe('popover');
    expect(parseView('?view=rules')).toBe('rules');
    expect(parseView('view=rules')).toBe('rules');
  });

  it('refuses a missing, unknown, repeated or differently spelled view', () => {
    for (const search of ['', '?', '?view=', '?view=Rules', '?view=settings', '?view=rules&view=popover', '?views=rules']) {
      expect(parseView(search)).toBeNull();
    }
  });

  it('ignores other parameters', () => {
    expect(parseView('?x=1&view=popover&y=2')).toBe('popover');
  });
});

describe('App', () => {
  const screen = (view: View) => () => createElement('p', { 'data-screen': view });
  const screens: Record<View, ComponentType> = { popover: screen('popover'), rules: screen('rules') };

  it.each(VIEWS)('shows the %s screen for its view', (view) => {
    const html = renderMarkup(createElement(App, { search: `?view=${view}`, screens }));
    expect(html).toContain(`data-view="${view}"`);
    expect(html).toContain(`data-screen="${view}"`);
    expect(html.match(/data-screen=/g)).toHaveLength(1);
  });

  it('shows a notice instead of guessing a screen', () => {
    const html = renderMarkup(createElement(App, { search: '?view=nope', screens }));
    expect(html).toContain('data-view="unknown"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-screen');
  });

  it('has a placeholder screen for every view until the screens land', () => {
    for (const view of VIEWS) {
      const html = renderMarkup(createElement(App, { search: `?view=${view}` }));
      expect(html).toContain(VIEW_TITLES[view]);
      expect(SCREENS[view]).toBeTypeOf('function');
    }
  });
});
