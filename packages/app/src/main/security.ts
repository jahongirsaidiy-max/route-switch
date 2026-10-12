// Navigation, window-open, permission and network lockdown. The renderer only
// ever shows the app's own page; everything else is denied, not filtered.

import type { Session, WebContents } from 'electron';

import type { Runtime } from './runtime';

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * True only for the app's own entry page: same scheme, host, port and path as
 * `entryUrl`. Query and fragment are free — they select the view, not the document.
 */
export function isAllowedNavigation(url: string, entryUrl: string): boolean {
  const target = parseUrl(url);
  const entry = parseUrl(entryUrl);
  if (target === null || entry === null) return false;
  return (
    target.protocol === entry.protocol &&
    target.host === entry.host &&
    target.pathname === entry.pathname &&
    target.username === '' &&
    target.password === ''
  );
}

export type LockableWebContents = Pick<WebContents, 'on' | 'setWindowOpenHandler' | 'setWebRTCIPHandlingPolicy'>;

/**
 * WebRTC is invisible to CSP and to `webRequest`. This policy stops it from
 * using UDP at all unless a proxy carries it — no host or server-reflexive
 * candidates, no STUN, no TURN over UDP. What is left, TCP, goes to the
 * session's proxy, which `lockDownSession` points at nothing.
 */
export const WEBRTC_IP_HANDLING_POLICY = 'disable_non_proxied_udp';

/**
 * The proxy every session is given: the loopback "discard" port, where nothing
 * answers. Chromium has no "no network" switch for a session, but it sends
 * every connection it makes for that session — HTTP(S), WebSocket, preconnect,
 * WebRTC over TCP — to the configured proxy and never falls back to a direct
 * connection. The app's own pages are unaffected: app:// is served in-process.
 */
export const BLACK_HOLE_PROXY = 'socks5://127.0.0.1:9';

/** Applied to every `webContents` the app ever creates (`web-contents-created`). */
export function lockDownWebContents(contents: LockableWebContents, runtime: Runtime): void {
  const denyForeign = (event: { readonly url: string; preventDefault: () => void }): void => {
    if (!isAllowedNavigation(event.url, runtime.entryUrl)) event.preventDefault();
  };
  contents.on('will-navigate', denyForeign);
  contents.on('will-redirect', denyForeign);
  contents.on('will-frame-navigate', denyForeign);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
}

export interface LockableSession {
  readonly setPermissionRequestHandler: Session['setPermissionRequestHandler'];
  readonly setPermissionCheckHandler: Session['setPermissionCheckHandler'];
  readonly webRequest: Pick<Session['webRequest'], 'onBeforeRequest' | 'onHeadersReceived'>;
  readonly setProxy: Session['setProxy'];
  readonly on: Session['on'];
}

export interface SessionLockdownOptions {
  readonly runtime: Runtime;
  /** Called with the URL of every request that was cancelled. */
  readonly onBlockedRequest: (url: string) => void;
  /** Called with the URL of every download that was cancelled. */
  readonly onBlockedDownload: (url: string) => void;
}

const isCspHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return lower === 'content-security-policy' || lower === 'content-security-policy-report-only';
};

/**
 * Applied to every session the app ever has (`session-created`). Resolves once
 * the proxy is in force; no window may load anything before that.
 */
export async function lockDownSession(session: LockableSession, options: SessionLockdownOptions): Promise<void> {
  const { runtime, onBlockedRequest, onBlockedDownload } = options;

  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);

  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = runtime.isAllowedRequest(details.url);
    if (!allowed) onBlockedRequest(details.url);
    callback({ cancel: !allowed });
  });

  // The app:// handler sets the policy on its own responses. A dev server
  // knows nothing about it, so there the session adds the policy instead.
  const csp = runtime.injectedCsp;
  if (csp !== null) {
    session.webRequest.onHeadersReceived((details, callback) => {
      const kept = Object.entries(details.responseHeaders ?? {}).filter(([name]) => !isCspHeader(name));
      callback({ responseHeaders: { ...Object.fromEntries(kept), 'Content-Security-Policy': [csp] } });
    });
  }

  // The renderer never saves files: exports go through a dialog in the main
  // process. Any download it starts — `<a download>`, a blob, an attachment
  // response — is cancelled before a byte is written.
  session.on('will-download', (event, item) => {
    event.preventDefault();
    onBlockedDownload(item.getURL());
  });

  await session.setProxy({
    mode: 'fixed_servers',
    proxyRules: BLACK_HOLE_PROXY,
    proxyBypassRules: runtime.proxyBypassRules,
  });
}
