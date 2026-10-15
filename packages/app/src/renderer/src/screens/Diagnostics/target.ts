// What the user typed into "Diagnostika", reduced to what the helper's
// `diagnose` takes: one IPv4 address or one domain. Pure: no DOM, no IPC.
//
// A URL is cut down to its host — scheme, user info, port, path, query and
// fragment are dropped (`https://a.example.com:8443/x?y` → `a.example.com`).
// The host is then checked with the shared validators, exactly as the main
// process and the helper check it again: an IPv4 address with
// `normalizeHostAddress` (ADR-001 — loopback, link-local, … refused; octal or
// hex forms refused, never rewritten), a name with `normalizeDomain` after
// lower-casing and dropping one trailing dot. A name in another script
// (IDN) becomes its ASCII (punycode) form through the platform's URL parser;
// a name that turns into an address that way is refused rather than rewritten.

import { normalizeDomain, normalizeHostAddress, type ValidationCode } from '@routeswitch/shared';

import type { DiagnosticInputError } from '../../../../i18n/sections/diagnostics.uz';

/** Longer input is refused before any parsing (a URL of a few KiB is never a host). */
export const MAX_DIAGNOSTIC_INPUT = 2048;

export type DiagnosticTarget =
  | { readonly ok: true; readonly target: string; readonly kind: 'ip' | 'domain' }
  /** `code` is one of the input's own reasons, or the shared validators' code for a refused IPv4 address. */
  | { readonly ok: false; readonly code: DiagnosticInputError | ValidationCode };

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const DIGITS_AND_DOTS = /^[\d.]+$/;
const CIDR = /^[\d.]+\/\d*$/;
const PORT = /:(\d{1,5})$/;

/** Printable ASCII only: a space or control character is never part of a host, and the URL parser would drop some silently. */
const isPrintableAscii = (text: string): boolean => /^[!-~]*$/.test(text);
function hasControlOrSpace(text: string): boolean {
  if (/\s/u.test(text)) return true;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The ASCII (punycode) form of a host name through the WHATWG URL parser; null when it cannot be one. */
function toAscii(host: string): string | null {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
}

export function parseDiagnosticTarget(input: string): DiagnosticTarget {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, code: 'empty' };
  if (trimmed.length > MAX_DIAGNOSTIC_INPUT) return { ok: false, code: 'too-long' };
  if (hasControlOrSpace(trimmed)) return { ok: false, code: 'invalid-host' };
  // A subnet is not one address: refused rather than read as its network address.
  if (CIDR.test(trimmed)) return { ok: false, code: 'invalid-host' };

  // scheme://user:pass@host:port/path?query#fragment → host
  let host = trimmed.replace(SCHEME, '');
  host = host.split(/[/?#]/, 1)[0] ?? '';
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  // `[::1]:443` or a bare `fe80::1`: two colons or more is IPv6, never a host and a port.
  if (host.startsWith('[') || host.indexOf(':') !== host.lastIndexOf(':')) return { ok: false, code: 'ipv6' };
  host = host.replace(PORT, '');
  if (host.includes(':')) return { ok: false, code: 'invalid-host' };
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return { ok: false, code: 'invalid-host' };
  if (host.includes('*')) return { ok: false, code: 'wildcard' };

  if (DIGITS_AND_DOTS.test(host)) {
    if (!/\d/.test(host)) return { ok: false, code: 'invalid-host' };
    const address = normalizeHostAddress(host);
    return address.ok ? { ok: true, target: address.value, kind: 'ip' } : { ok: false, code: address.error.code };
  }

  let name = host.toLowerCase();
  if (!isPrintableAscii(name)) {
    const ascii = toAscii(name);
    // The URL parser also reads some non-ASCII digits as an address: that is not the name typed.
    if (ascii === null || DIGITS_AND_DOTS.test(ascii)) return { ok: false, code: 'invalid-host' };
    name = ascii;
  }
  const domain = normalizeDomain(name);
  return domain.ok ? { ok: true, target: domain.value, kind: 'domain' } : { ok: false, code: 'invalid-host' };
}
