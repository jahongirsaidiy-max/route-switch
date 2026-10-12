// app://routeswitch/ — the only origin the renderer is ever loaded from in
// production. Unlike file://, it is a real origin (so CSP 'self' means "this
// bundle", not "any file on disk"), it can serve nothing outside the renderer
// directory, and its responses carry the CSP as a header.

import path from 'node:path';

import type { Protocol } from 'electron';

import { APP_HOST, APP_SCHEME } from './runtime';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Must run before the app is ready. */
export function registerAppScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export interface ResolvedAsset {
  readonly filePath: string;
  readonly contentType: string;
}

/**
 * Maps a request URL to a file inside `rendererRoot`. Returns `null` for any
 * other host, an unknown file type, a hidden file, or a path that would leave
 * the directory. Purely lexical — the handler also resolves symbolic links.
 */
export function resolveAsset(rendererRoot: string, requestUrl: string): ResolvedAsset | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  if (url.username !== '' || url.password !== '') return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname === '/') pathname = '/index.html';
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return null;

  const segments = pathname.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;

  const filePath = path.join(rendererRoot, ...segments);
  if (!isInside(rendererRoot, filePath)) return null;

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  return contentType === undefined ? null : { filePath, contentType };
}

export interface AppProtocolOptions {
  readonly rendererRoot: string;
  readonly csp: string;
  readonly readFile: (filePath: string) => Promise<Uint8Array<ArrayBuffer>>;
  readonly realpath: (filePath: string) => Promise<string>;
  /** Called once per kind of failure — a page can provoke these at will. */
  readonly onError: (message: string, code: string) => void;
}

// What a request for a file that simply is not there looks like.
const MISSING = new Set(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG']);

const codeOf = (error: unknown): string => {
  const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
};

const isInside = (root: string, filePath: string): boolean => {
  const relative = path.relative(root, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export function createAppProtocolHandler(options: AppProtocolOptions): (request: Request) => Promise<Response> {
  const { rendererRoot, csp, readFile, realpath, onError } = options;
  const respond = (status: number, body: Uint8Array<ArrayBuffer> | null, contentType?: string): Response =>
    new Response(body, {
      status,
      headers: {
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
      },
    });

  // Only the error code is reported, never the path (the page chose it), and
  // each code only once: a page cannot fill the log by asking again.
  const reported = new Set<string>();
  const reportOnce = (message: string, code: string): void => {
    if (reported.has(code)) return;
    reported.add(code);
    onError(message, code);
  };

  return async (request) => {
    if (request.method !== 'GET') return respond(405, null);
    const asset = resolveAsset(rendererRoot, request.url);
    if (asset === null) return respond(404, null);
    try {
      // Symbolic links are resolved first: a link inside the renderer
      // directory must not be a way to read a file outside it.
      const [realRoot, realFile] = await Promise.all([realpath(rendererRoot), realpath(asset.filePath)]);
      if (!isInside(realRoot, realFile)) {
        reportOnce('Refused a renderer file that resolves outside the renderer directory', 'OUTSIDE_ROOT');
        return respond(404, null);
      }
      return respond(200, await readFile(realFile), asset.contentType);
    } catch (error) {
      const code = codeOf(error);
      if (!MISSING.has(code)) reportOnce('Failed to read a renderer file', code);
      return respond(404, null);
    }
  };
}
