// The rules window's "Yordam" section (TASK-DELTA-22): the in-app guide in the
// UI language, with a table of contents. The content is typed data
// (`help/`), rendered as React text nodes only — no markup is parsed and no
// HTML is injected. A link is a button: it opens a section of this window or
// scrolls to another topic; there are no URLs to follow.

import type { ReactElement } from 'react';

import { HELP_DOCS, HELP_TOPICS, type HelpAppSection, type HelpBlock, type HelpDoc, type HelpInline, type HelpText, type HelpTopic } from '../../help';
import { useI18n } from '../../hooks/useI18n';
import styles from './HelpScreen.module.css';

/** The id of a topic's heading: the table of contents scrolls to it. */
export const topicHeadingId = (topic: HelpTopic): string => `help-topic-${topic}`;

/** Brings a topic's heading into view and gives it the focus; false when it is not on the page. */
export function scrollToTopic(topic: HelpTopic, doc?: Pick<Document, 'getElementById'>): boolean {
  // No page (tests in Node): nothing to scroll.
  const page = doc ?? (typeof document === 'undefined' ? null : document);
  const heading = page?.getElementById(topicHeadingId(topic)) ?? null;
  if (heading === null) return false;
  heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
  heading.focus({ preventScroll: true });
  return true;
}

interface Navigation {
  readonly onOpenSection: (section: HelpAppSection) => void;
  readonly onOpenTopic: (topic: HelpTopic) => void;
}

function Inline({ piece, nav }: { readonly piece: HelpInline; readonly nav: Navigation }): ReactElement {
  if (typeof piece === 'string') return <>{piece}</>;
  switch (piece.kind) {
    case 'ui':
      return <strong className={styles['ui']}>{piece.text}</strong>;
    case 'code':
      return <code className={styles['code']}>{piece.text}</code>;
    case 'link': {
      const to = piece.to;
      return (
        <button
          type="button"
          className={styles['link']}
          onClick={() => {
            if ('section' in to) nav.onOpenSection(to.section);
            else nav.onOpenTopic(to.topic);
          }}
        >
          {piece.text}
        </button>
      );
    }
  }
}

function Text({ text, nav }: { readonly text: HelpText; readonly nav: Navigation }): ReactElement {
  return (
    <>
      {text.map((piece, index) => (
        <Inline key={index} piece={piece} nav={nav} />
      ))}
    </>
  );
}

function Block({ block, nav }: { readonly block: HelpBlock; readonly nav: Navigation }): ReactElement {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className={styles['paragraph']}>
          <Text text={block.text} nav={nav} />
        </p>
      );
    case 'subheading':
      return <h3 className={styles['subheading']}>{block.text}</h3>;
    case 'note':
      return (
        <p className={styles['note']}>
          <Text text={block.text} nav={nav} />
        </p>
      );
    case 'code':
      return (
        <div role="group" aria-label={block.label}>
          <pre className={styles['terminal']}>
            <code>{block.lines.join('\n')}</code>
          </pre>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Text text={item} nav={nav} />
        </li>
      ));
      return block.ordered ? <ol className={styles['list']}>{items}</ol> : <ul className={styles['list']}>{items}</ul>;
    }
  }
}

export interface HelpPanelProps {
  readonly doc: HelpDoc;
  /** A link to another section of the rules window. */
  readonly onOpenSection: (section: HelpAppSection) => void;
  /** A table-of-contents entry or a link to another topic; scrolls to it by default. */
  readonly onOpenTopic?: (topic: HelpTopic) => void;
}

/** The guide for a given document. */
export function HelpPanel({ doc, onOpenSection, onOpenTopic = (topic) => void scrollToTopic(topic) }: HelpPanelProps): ReactElement {
  const nav: Navigation = { onOpenSection, onOpenTopic };
  return (
    <section className={styles['screen']} aria-labelledby="help-title">
      <header className={styles['header']}>
        <h1 id="help-title" className={styles['title']}>
          {doc.title}
        </h1>
        <p className={styles['subtitle']}>{doc.subtitle}</p>
      </header>
      <div className={styles['body']}>
        <nav aria-label={doc.contents} className={styles['contents']}>
          <ol>
            {HELP_TOPICS.map((topic) => (
              <li key={topic}>
                <button
                  type="button"
                  className={styles['contentsItem']}
                  onClick={() => {
                    onOpenTopic(topic);
                  }}
                >
                  {doc.topics[topic].title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className={styles['topics']}>
          {HELP_TOPICS.map((topic) => (
            <article key={topic} className={styles['topic']} aria-labelledby={topicHeadingId(topic)}>
              <h2 id={topicHeadingId(topic)} className={styles['topicTitle']} tabIndex={-1}>
                {doc.topics[topic].title}
              </h2>
              {doc.topics[topic].blocks.map((block, index) => (
                <Block key={index} block={block} nav={nav} />
              ))}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface HelpScreenProps {
  readonly onOpenSection: (section: HelpAppSection) => void;
}

/** The "Yordam" section: the guide in the UI language, which switches with it at once. */
export function HelpScreen({ onOpenSection }: HelpScreenProps): ReactElement {
  const { locale } = useI18n();
  return <HelpPanel doc={HELP_DOCS[locale]} onOpenSection={onOpenSection} />;
}
