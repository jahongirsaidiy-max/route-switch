import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../../components/test-utils';
import { HELP_DOCS, HELP_TOPICS, type HelpDoc } from '../../help';
import { I18nProvider } from '../../hooks/useI18n';
import { HelpPanel, HelpScreen, scrollToTopic, topicHeadingId } from './HelpScreen';

interface AnyProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}
function elementsOf(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(elementsOf);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elementsOf(node.props.children)];
}

/** Renders the function components down to host elements, so their handlers can be called. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return (node as ReactNode[]).map(expand);
  if (!isValidElement<AnyProps>(node)) return node;
  if (typeof node.type === 'function') return expand((node.type as (props: unknown) => ReactNode)(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } } as ReactElement<AnyProps>;
}

const panel = (doc: HelpDoc = HELP_DOCS.uz, onOpenSection = vi.fn(), onOpenTopic = vi.fn()) =>
  createElement(HelpPanel, { doc, onOpenSection, onOpenTopic });

describe('HelpPanel', () => {
  it('a title, a table of contents and every topic under its own heading', () => {
    const html = renderMarkup(panel());
    expect(html).toContain('<h1 id="help-title"');
    expect(html).toContain('Yordam');
    expect(html).toContain('<nav aria-label="Mundarija"');
    for (const topic of HELP_TOPICS) {
      expect(html).toContain(`id="${topicHeadingId(topic)}"`);
      expect(html).toContain(HELP_DOCS.uz.topics[topic].title.replace(/'/g, '&#x27;'));
    }
    // Code blocks are named groups; UI names are strong; nothing is a web link.
    expect(html).toContain('role="group" aria-label="Wi‑Fi&#x27;ni birinchi qiladigan buyruq (namuna)"');
    expect(html).toContain('<strong');
    expect(html).not.toMatch(/<a\b|href=|<script|<iframe/);
  });

  it('text is text: markup in the content is shown, never interpreted', () => {
    const doc: HelpDoc = {
      ...HELP_DOCS.en,
      topics: { ...HELP_DOCS.en.topics, start: { title: '<b>start</b>', blocks: [{ kind: 'paragraph', text: ['<img src=x onerror=alert(1)>'] }] } },
    };
    const html = renderMarkup(panel(doc));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;start&lt;/b&gt;');
    expect(html).not.toContain('<img');
  });

  it('the table of contents goes to a topic, and a link to a section or another topic', () => {
    const onOpenSection = vi.fn();
    const onOpenTopic = vi.fn();
    const buttons = elementsOf(expand(panel(HELP_DOCS.uz, onOpenSection, onOpenTopic))).filter((element) => element.type === 'button');
    const toc = buttons.slice(0, HELP_TOPICS.length);
    toc[5]?.props.onClick?.();
    expect(onOpenTopic).toHaveBeenCalledWith('backup');
    const links = buttons.slice(HELP_TOPICS.length);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) link.props.onClick?.();
    expect(onOpenSection.mock.calls.map(([section]) => section as string).sort()).toEqual(
      expect.arrayContaining(['diagnostics', 'log', 'rules', 'settings']),
    );
    expect(onOpenTopic.mock.calls.map(([topic]) => topic as string)).toEqual(expect.arrayContaining(['backup', 'diagnostics']));
  });
});

describe('scrollToTopic', () => {
  it("brings the topic's heading into view and focuses it", () => {
    const heading = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const getElementById = vi.fn(() => heading as unknown as HTMLElement);
    expect(scrollToTopic('problems', { getElementById })).toBe(true);
    expect(getElementById).toHaveBeenCalledWith('help-topic-problems');
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('nothing when the heading is not on the page, or there is no page', () => {
    expect(scrollToTopic('start', { getElementById: () => null })).toBe(false);
    expect(scrollToTopic('start', undefined)).toBe(false);
  });
});

describe('HelpScreen', () => {
  it.each([
    ['uz', 'Mundarija', 'Boshlash'],
    ['ru', 'Содержание', 'Начало работы'],
    ['en', 'Contents', 'Getting started'],
  ] as const)('%s: the guide in the UI language', (language, contents, first) => {
    const html = renderMarkup(createElement(I18nProvider, { language }, createElement(HelpScreen, { onOpenSection: vi.fn() })));
    expect(html).toContain(`<nav aria-label="${contents}"`);
    expect(html).toContain(first);
    if (language !== 'uz') expect(html).not.toContain('Mundarija');
  });
});
