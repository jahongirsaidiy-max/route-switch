// Test helpers for renderer components. The test environment is Node (no
// DOM): components are rendered to static markup, and event handlers are
// reached through the element a component returns.

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function renderMarkup(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The handler props tests call on a returned element. */
export interface ElementProps {
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
}
