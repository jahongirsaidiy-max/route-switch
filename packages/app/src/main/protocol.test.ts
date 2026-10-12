import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProductionCsp } from './csp';
import { createAppProtocolHandler, registerAppScheme, resolveAsset } from './protocol';

const ROOT = path.join(path.sep, 'opt', 'routeswitch', 'renderer');
const inRoot = (...segments: string[]): string => path.join(ROOT, ...segments);

describe('registerAppScheme', () => {
  it('registers app:// as a standard, secure scheme that cannot bypass the CSP', () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerAppScheme({ registerSchemesAsPrivileged });
    expect(registerSchemesAsPrivileged.mock.calls).toEqual([
      [[{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]],
    ]);
  });
});

describe('resolveAsset', () => {
  it.each([
    ['app://routeswitch/', inRoot('index.html'), 'text/html; charset=utf-8'],
    ['app://routeswitch/index.html', inRoot('index.html'), 'text/html; charset=utf-8'],
    ['app://routeswitch/index.html?view=rules#x', inRoot('index.html'), 'text/html; charset=utf-8'],
    ['app://routeswitch/assets/index-Dx.js', inRoot('assets', 'index-Dx.js'), 'text/javascript; charset=utf-8'],
    ['app://routeswitch/assets/index-CS.css', inRoot('assets', 'index-CS.css'), 'text/css; charset=utf-8'],
    ['app://routeswitch/assets/icon.SVG', inRoot('assets', 'icon.SVG'), 'image/svg+xml'],
    ['app://routeswitch/assets/a%20b.png', inRoot('assets', 'a b.png'), 'image/png'],
  ])('maps %s into the renderer directory', (url, filePath, contentType) => {
    expect(resolveAsset(ROOT, url)).toEqual({ filePath, contentType });
  });

  it.each([
    // Another origin, or not ours at all.
    'https://evil.example/index.html',
    'file:///etc/passwd',
    'app://evil.example/index.html',
    'app://routeswitch.evil.example/index.html',
    'app://routeswitch@evil.example/index.html',
    'app://user:pass@routeswitch/index.html',
    'app://routeswitch:8080/index.html',
    'not a url',
    '',
    // Traversal, in every spelling.
    'app://routeswitch/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    'app://routeswitch/..%2f..%2fetc%2fpasswd.html',
    'app://routeswitch/assets/..%2f..%2f..%2fetc%2fhosts.html',
    'app://routeswitch/%2fetc%2fpasswd.html',
    'app://routeswitch//etc/passwd.html',
    'app://routeswitch/assets//index.js',
    'app://routeswitch/..%5c..%5cetc%5cpasswd.html',
    'app://routeswitch/assets\\..\\..\\secret.html',
    'app://routeswitch/index.html%00.png',
    'app://routeswitch/%ZZ.html',
    'app://routeswitch/%c0%ae%c0%ae/index.html',
    // Hidden files and types the renderer has no business loading.
    'app://routeswitch/.env',
    'app://routeswitch/.git/config.json',
    'app://routeswitch/assets/.hidden.js',
    'app://routeswitch/assets/index.js.map',
    'app://routeswitch/assets/tool.node',
    'app://routeswitch/assets/noextension',
    'app://routeswitch/assets/',
    'app://routeswitch/index.html/',
  ])('refuses %s', (url) => {
    expect(resolveAsset(ROOT, url)).toBeNull();
  });

  it('never returns a path outside the renderer directory', () => {
    // `new URL` already collapses dot segments; whatever is left must stay inside.
    for (const url of [
      'app://routeswitch/../../etc/passwd.html',
      'app://routeswitch/assets/../../../etc/hosts.html',
      'app://routeswitch/./../x.html',
      'app://routeswitch/%2e%2e/%2e%2e/etc/passwd.html',
    ]) {
      const asset = resolveAsset(ROOT, url);
      if (asset !== null) expect(asset.filePath.startsWith(ROOT + path.sep)).toBe(true);
    }
  });
});

const body = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

const failure = (code: string): Error => Object.assign(new Error(code), { code });

function handlerWith(
  readFileStub: (filePath: string) => Promise<Uint8Array<ArrayBuffer>>,
  realpathStub: (filePath: string) => Promise<string> = (filePath) => Promise.resolve(filePath),
) {
  const onError = vi.fn();
  const read = vi.fn(readFileStub);
  const handle = createAppProtocolHandler({
    rendererRoot: ROOT,
    csp: buildProductionCsp(),
    readFile: read,
    realpath: realpathStub,
    onError,
  });
  return { handle, read, onError };
}

const expectLockedDown = (response: Response): void => {
  expect(response.headers.get('Content-Security-Policy')).toBe(buildProductionCsp());
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
};

describe('createAppProtocolHandler', () => {
  it('serves a bundled file with its type and the production CSP header', async () => {
    const { handle, read } = handlerWith(() => Promise.resolve(body('<!doctype html>')));
    const response = await handle(new Request('app://routeswitch/index.html'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expectLockedDown(response);
    expect(await response.text()).toBe('<!doctype html>');
    expect(read.mock.calls).toEqual([[inRoot('index.html')]]);
  });

  it.each([
    'app://routeswitch/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    'app://evil.example/index.html',
    'app://routeswitch/.env',
    'app://routeswitch/assets/index.js.map',
  ])('answers 404 for %s without touching the disk', async (url) => {
    const { handle, read } = handlerWith(() => Promise.resolve(body('secret')));
    const response = await handle(new Request(url));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expectLockedDown(response);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('answers 405 to %s without touching the disk', async (method) => {
    const { handle, read } = handlerWith(() => Promise.resolve(body('x')));
    const response = await handle(new Request('app://routeswitch/index.html', { method }));
    expect(response.status).toBe(405);
    expectLockedDown(response);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG'])('answers 404 when the file is missing (%s) and reports nothing', async (code) => {
    const { handle, onError } = handlerWith(() => Promise.reject(failure(code)));
    const response = await handle(new Request('app://routeswitch/assets/gone.js'));
    expect(response.status).toBe(404);
    expectLockedDown(response);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP'])(
    'answers 404 when the path cannot be resolved (%s) and never reads',
    async (code) => {
      const { handle, read } = handlerWith(
        () => Promise.resolve(body('x')),
        () => Promise.reject(failure(code)),
      );
      const response = await handle(new Request('app://routeswitch/index.html/x.js'));
      expect(response.status).toBe(404);
      expectLockedDown(response);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('answers 404 to any other read failure and reports only its code — never the path', async () => {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${inRoot('assets', 'secret-name.js')}'`), {
      code: 'EACCES',
    });
    const { handle, onError } = handlerWith(() => Promise.reject(error));
    const response = await handle(new Request('app://routeswitch/assets/secret-name.js'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expectLockedDown(response);
    expect(onError.mock.calls).toEqual([['Failed to read a renderer file', 'EACCES']]);
    expect(JSON.stringify(onError.mock.calls)).not.toContain('secret-name');
  });

  it('reports each kind of failure once, however often a page provokes it', async () => {
    let code = 'EACCES';
    const { handle, onError } = handlerWith(() => Promise.reject(failure(code)));
    for (let i = 0; i < 50; i += 1) await handle(new Request(`app://routeswitch/assets/a${String(i)}.js`));
    code = 'EIO';
    for (let i = 0; i < 50; i += 1) await handle(new Request(`app://routeswitch/assets/b${String(i)}.js`));
    expect(onError.mock.calls).toEqual([
      ['Failed to read a renderer file', 'EACCES'],
      ['Failed to read a renderer file', 'EIO'],
    ]);
  });

  it.each([
    ['a code that is not a plain token', Object.assign(new Error('x'), { code: 'E\n{"level":"error"}' })],
    ['a non-string code', Object.assign(new Error('x'), { code: 42 })],
    ['no code', new Error('/opt/routeswitch/renderer/assets/whatever.js')],
    ['a thrown string', '/opt/routeswitch/renderer/assets/whatever.js'],
  ])('reports UNKNOWN for %s', async (_name, thrown) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the handler must cope with any rejection value
    const { handle, onError } = handlerWith(() => Promise.reject(thrown));
    const response = await handle(new Request('app://routeswitch/assets/whatever.js'));
    expect(response.status).toBe(404);
    expect(onError.mock.calls).toEqual([['Failed to read a renderer file', 'UNKNOWN']]);
  });

  it('refuses a file whose real path is outside the renderer directory', async () => {
    const { handle, read, onError } = handlerWith(
      () => Promise.resolve(body('root:*:0:0')),
      (filePath) => Promise.resolve(filePath === ROOT ? ROOT : '/etc/passwd'),
    );
    for (let i = 0; i < 3; i += 1) {
      const response = await handle(new Request('app://routeswitch/assets/link.js'));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
      expectLockedDown(response);
    }
    expect(read).not.toHaveBeenCalled();
    expect(onError.mock.calls).toEqual([
      ['Refused a renderer file that resolves outside the renderer directory', 'OUTSIDE_ROOT'],
    ]);
  });

  it.each([`${ROOT}-evil/x.js`, `${ROOT}evil.js`, `${ROOT}.js`, path.dirname(ROOT), ROOT])(
    'refuses a real path that merely starts with the renderer directory: %s',
    async (realFile) => {
      const { handle, read, onError } = handlerWith(
        () => Promise.resolve(body('evil')),
        (filePath) => Promise.resolve(filePath === ROOT ? ROOT : realFile),
      );
      const response = await handle(new Request('app://routeswitch/assets/link.js'));
      expect(response.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
      expect(onError.mock.calls).toEqual([
        ['Refused a renderer file that resolves outside the renderer directory', 'OUTSIDE_ROOT'],
      ]);
    },
  );

  it('reads the resolved path, and accepts a renderer directory that is itself reached through a link', async () => {
    const real = path.join(path.sep, 'private', 'opt', 'renderer');
    const { handle, read } = handlerWith(
      () => Promise.resolve(body('ok')),
      (filePath) => Promise.resolve(filePath.replace(ROOT, real)),
    );
    const response = await handle(new Request('app://routeswitch/assets/index.js'));
    expect(response.status).toBe(200);
    expect(read.mock.calls).toEqual([[path.join(real, 'assets', 'index.js')]]);
  });
});

describe('createAppProtocolHandler on a real directory', () => {
  let base = '';
  let root = '';

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'routeswitch-protocol-')));
    root = path.join(base, 'renderer');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await mkdir(path.join(base, 'outside'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html>');
    await writeFile(path.join(root, 'assets', 'real.js'), 'inside');
    await writeFile(path.join(base, 'outside', 'secret.js'), 'TOP-SECRET');
    await symlink(path.join(base, 'outside', 'secret.js'), path.join(root, 'assets', 'leak.js'));
    await symlink(path.join(base, 'outside'), path.join(root, 'linked'));
    // A sibling whose name starts with the renderer directory's name.
    await mkdir(path.join(base, 'renderer-evil'));
    await writeFile(path.join(base, 'renderer-evil', 'x.js'), 'EVIL');
    await symlink(path.join(base, 'renderer-evil', 'x.js'), path.join(root, 'assets', 'sibling.js'));
    await symlink(path.join(base, 'renderer-evil'), path.join(root, 'sibling'));
    await symlink(path.join(root, 'assets', 'real.js'), path.join(root, 'assets', 'alias.js'));
    await symlink(path.join(root, 'assets', 'nowhere.js'), path.join(root, 'assets', 'dangling.js'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const serve = () => {
    const onError = vi.fn();
    const handle = createAppProtocolHandler({ rendererRoot: root, csp: buildProductionCsp(), readFile, realpath, onError });
    return { handle, onError };
  };

  it('serves real files and links that stay inside', async () => {
    const { handle, onError } = serve();
    expect(await (await handle(new Request('app://routeswitch/index.html'))).text()).toBe('<!doctype html>');
    expect(await (await handle(new Request('app://routeswitch/assets/real.js'))).text()).toBe('inside');
    expect(await (await handle(new Request('app://routeswitch/assets/alias.js'))).text()).toBe('inside');
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    'app://routeswitch/assets/leak.js',
    'app://routeswitch/linked/secret.js',
    'app://routeswitch/assets/sibling.js',
    'app://routeswitch/sibling/x.js',
  ])(
    'does not follow a symlink out of the directory: %s',
    async (url) => {
      const { handle, onError } = serve();
      const response = await handle(new Request(url));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
      expect(onError.mock.calls).toEqual([
        ['Refused a renderer file that resolves outside the renderer directory', 'OUTSIDE_ROOT'],
      ]);
    },
  );

  it.each([
    'app://routeswitch/assets/dangling.js',
    'app://routeswitch/assets/missing.js',
    'app://routeswitch/index.html/x.js',
    `app://routeswitch/assets/${'a'.repeat(5000)}.js`,
    'app://routeswitch/assets',
  ])('answers 404 and reports nothing for %s', async (url) => {
    const { handle, onError } = serve();
    const response = await handle(new Request(url));
    expect(response.status).toBe(404);
    expect(onError).not.toHaveBeenCalled();
  });
});
