// The production Content-Security-Policy. Pure and dependency-free: the
// app:// handler (response header) and the Vite build (the <meta> element of
// the built index.html) both take the policy from here.
//
// The looser development policy lives in `development.ts`, which is left out
// of production builds altogether.

export type CspDirective = readonly [name: string, ...sources: string[]];

export const PRODUCTION_DIRECTIVES: readonly CspDirective[] = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self'"],
  ['font-src', "'self'"],
  ['connect-src', "'self'"],
  ['object-src', "'none'"],
  ['frame-src', "'none'"],
  ['worker-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

export type CspDelivery = 'header' | 'meta';

// Browsers ignore `frame-ancestors` (and log an error) when the policy comes
// from a <meta> element, so that variant leaves it out.
export function serializeCsp(directives: readonly CspDirective[], delivery: CspDelivery = 'header'): string {
  return directives
    .filter(([name]) => delivery === 'header' || name !== 'frame-ancestors')
    .map((directive) => directive.join(' '))
    .join('; ');
}

export function buildProductionCsp(delivery: CspDelivery = 'header'): string {
  return serializeCsp(PRODUCTION_DIRECTIVES, delivery);
}

/** The element the build prepends to the <head> of index.html. */
export function productionCspMetaTag(): {
  readonly tag: 'meta';
  readonly attrs: { readonly 'http-equiv': string; readonly content: string };
} {
  return {
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: buildProductionCsp('meta') },
  };
}
