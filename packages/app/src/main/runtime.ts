// What differs between a production run (the app serves its own bundled
// renderer from app://routeswitch/) and a development run (the renderer comes
// from the electron-vite dev server). Decided once at startup.

export const APP_SCHEME = 'app';
export const APP_HOST = 'routeswitch';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

export interface Runtime {
  readonly kind: 'production' | 'development';
  /** The only document a window ever loads or navigates to. */
  readonly entryUrl: string;
  /** Whether the renderer may request `url` at all. */
  readonly isAllowedRequest: (url: string) => boolean;
  /**
   * A policy the session must add to responses, or `null` when the server of
   * the page sends it itself (the app:// handler does).
   */
  readonly injectedCsp: string | null;
  /**
   * Chromium proxy-bypass rules for the session's black-hole proxy (see
   * `lockDownSession`): which hosts, if any, may still be reached directly.
   */
  readonly proxyBypassRules: string;
  /**
   * Chromium `--host-resolver-rules`: which host names its resolver may look
   * up at all. Set as a command-line switch before the app is ready.
   */
  readonly hostResolverRules: string;
}

/**
 * Every host name fails to resolve inside Chromium, without a DNS query: a
 * page cannot leak data through the names it asks for (`dns-prefetch` reaches
 * the system resolver past CSP, `webRequest` and the proxy). IP literals need
 * no resolution, and Node's own `dns`/`net` in the main process is unaffected.
 */
export const RESOLVE_NOTHING = 'MAP * ~NOTFOUND';

/**
 * `<-loopback>` removes Chromium's implicit "never proxy localhost" rule, so
 * with nothing else listed every host — loopback included — goes to the proxy.
 */
export const PROXY_NOTHING_BYPASSED = '<-loopback>';

/** True for a URL of the bundled renderer: `app://routeswitch/…`, no credentials. */
export function isAppUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST && url.username === '' && url.password === ''
  );
}

export const PRODUCTION_RUNTIME: Runtime = Object.freeze({
  kind: 'production',
  entryUrl: APP_ENTRY_URL,
  isAllowedRequest: isAppUrl,
  injectedCsp: null,
  proxyBypassRules: PROXY_NOTHING_BYPASSED,
  hostResolverRules: RESOLVE_NOTHING,
});

/** Builds the development runtime from `ELECTRON_RENDERER_URL`; `null` if it is not a dev-server URL. */
export type DevelopmentRuntimeFactory = (rendererUrl: string | undefined) => Runtime | null;

export interface RuntimeInputs {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `process.env.ELECTRON_RENDERER_URL`, set by `electron-vite dev`. */
  readonly rendererUrl: string | undefined;
  /**
   * `createDevelopmentRuntime` in a development build of the main process and
   * `null` in a production build, where that module is not even bundled.
   */
  readonly development: DevelopmentRuntimeFactory | null;
}

// Development needs all three: a development build, an unpackaged app and a
// loopback dev-server URL. A packaged or production-built app can therefore
// never be talked into the looser development rules through its environment.
export function resolveRuntime(inputs: RuntimeInputs): Runtime {
  if (inputs.development === null || inputs.isPackaged) return PRODUCTION_RUNTIME;
  return inputs.development(inputs.rendererUrl) ?? PRODUCTION_RUNTIME;
}
