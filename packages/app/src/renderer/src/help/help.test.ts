import { describe, expect, it } from 'vitest';

import { LOCALES } from '../../../i18n';
import { HELP_DOCS, HELP_TOPICS, type HelpBlock, type HelpDoc, type HelpInline, type HelpTopic } from './index';
import { helpUz } from './uz';

/** Every inline piece of a document, with the kind of block it is in. */
function piecesOf(doc: HelpDoc): HelpInline[] {
  const ofBlock = (block: HelpBlock): HelpInline[] => {
    switch (block.kind) {
      case 'paragraph':
      case 'note':
        return [...block.text];
      case 'list':
        return block.items.flat();
      case 'code':
        return [block.label, ...block.lines.map((line) => ({ kind: 'code' as const, text: line }))];
      case 'subheading':
        return [block.text];
    }
  };
  return [doc.title, doc.subtitle, doc.contents, ...HELP_TOPICS.flatMap((topic) => [doc.topics[topic].title, ...doc.topics[topic].blocks.flatMap(ofBlock)])];
}

const textOf = (piece: HelpInline): string => (typeof piece === 'string' ? piece : piece.text);
const allText = (doc: HelpDoc): string => piecesOf(doc).map(textOf).join('\n');

describe('the Help documents', () => {
  it('exist for every UI language, with the same topics in the same order', () => {
    expect(Object.keys(HELP_DOCS).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const doc = HELP_DOCS[locale];
      expect(Object.keys(doc.topics)).toEqual([...HELP_TOPICS]);
      for (const topic of HELP_TOPICS) {
        expect(doc.topics[topic].title.trim()).not.toBe('');
        expect(doc.topics[topic].blocks.length).toBeGreaterThan(0);
      }
    }
  });

  it('cover the topics the task names', () => {
    expect(HELP_TOPICS).toEqual(['start', 'rule-types', 'precedence', 'default-route', 'backup', 'diagnostics', 'problems', 'uninstall']);
    for (const locale of LOCALES) {
      const text = allText(HELP_DOCS[locale]);
      // Rule types and their examples, the IP wildcard, the DNS server field.
      for (const sample of ['10.20.30.40', '10.0.0.0/8', '10.*.*.*', 'corp.local', '10.0.0.53', '/etc/resolver/corp.local']) expect(text).toContain(sample);
      // "Default" and the command that puts Wi‑Fi first.
      expect(text).toContain('networksetup -ordernetworkservices');
      expect(text).toContain('route -n get default');
      // Secure DNS in the browser, and the diagnostics limit of 10 a minute.
      expect(text).toMatch(/DNS.over.HTTPS/);
      expect(text).toMatch(/\b10\b/);
    }
  });

  it('a missing topic is a type error', () => {
    const rest: Omit<HelpDoc['topics'], 'uninstall'> = helpUz.topics;
    // @ts-expect-error — a document without the "uninstall" topic is not a HelpDoc (`tsc` checks this line).
    const broken: HelpDoc = { ...helpUz, topics: rest };
    expect(broken.title).toBe(helpUz.title);
  });

  it('links lead only to sections of the rules window or to topics — never to a URL', () => {
    for (const locale of LOCALES) {
      for (const piece of piecesOf(HELP_DOCS[locale])) {
        if (typeof piece === 'string' || piece.kind !== 'link') continue;
        if ('section' in piece.to) expect(['rules', 'log', 'diagnostics', 'settings']).toContain(piece.to.section);
        else expect(HELP_TOPICS).toContain<HelpTopic>(piece.to.topic);
        expect(piece.text).not.toMatch(/:\/\/|www\./);
      }
    }
  });

  it('names no real network: only generic examples, and a URL only as a code sample of example.com', () => {
    for (const locale of LOCALES) {
      const pieces = piecesOf(HELP_DOCS[locale]);
      for (const piece of pieces) {
        const text = textOf(piece);
        if (/:\/\/|www\./.test(text)) {
          expect(typeof piece === 'string' ? 'text' : piece.kind).toBe('code');
          expect(text).toBe('https://example.com/page');
        }
      }
      const text = allText(HELP_DOCS[locale]);
      for (const address of text.match(/\b\d{1,3}(?:\.(?:\d{1,3}|\*)){3}\b/g) ?? []) expect(address).toMatch(/^(10\.|0\.0\.0\.0$)/);
      for (const name of text.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|local|lan|corp|io|uz|ru)\b/gi) ?? []) {
        expect(['corp.local', 'app.corp.local', 'example.com']).toContain(name.toLowerCase());
      }
    }
  });

  it('Russian and English are not Uzbek copies', () => {
    const uzbek = /\b(qoida|bo'l|o'rnat|tugma|ulang|kerak)\w*/i;
    for (const locale of ['ru', 'en'] as const) expect(allText(HELP_DOCS[locale])).not.toMatch(uzbek);
    expect(allText(HELP_DOCS.en)).not.toMatch(/[А-Яа-яЁё]/);
    expect(allText(HELP_DOCS.ru)).toMatch(/[А-Яа-яЁё]/);
  });
});
