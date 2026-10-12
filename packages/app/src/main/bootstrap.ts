// App lifecycle, written against the handful of Electron objects it needs so
// that it runs under vitest without an Electron process. `index.ts` passes the
// real ones.

import type { App, BrowserWindow, BrowserWindowConstructorOptions, Protocol, Session } from 'electron';

import { buildProductionCsp } from './csp';
import { createAppProtocolHandler, registerAppScheme } from './protocol';
import type { HelperClient } from './helperClient';
import type { Logger } from './logger';
import { APP_SCHEME, resolveRuntime, type RuntimeInputs } from './runtime';
import { lockDownSession, lockDownWebContents } from './security';
import { createWindowFactory } from './windows';

export interface BootstrapDeps {
  readonly app: Pick<
    App,
    'requestSingleInstanceLock' | 'quit' | 'exit' | 'on' | 'whenReady' | 'dock' | 'isPackaged' | 'commandLine'
  >;
  readonly BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly protocol: Pick<Protocol, 'registerSchemesAsPrivileged' | 'handle'>;
  /** `session.defaultSession` exists only once the app is ready. */
  readonly getDefaultSession: () => Session;
  readonly platform: NodeJS.Platform;
  readonly development: RuntimeInputs['development'];
  readonly rendererUrl: RuntimeInputs['rendererUrl'];
  readonly preloadPath: string;
  readonly rendererRoot: string;
  readonly readFile: (filePath: string) => Promise<Uint8Array<ArrayBuffer>>;
  readonly realpath: (filePath: string) => Promise<string>;
  readonly logger: Logger;
  /** Connects to the helper in the background; a missing helper is not an error. */
  readonly helperClient: Pick<HelperClient, 'start' | 'stop'>;
}

export function startApp(deps: BootstrapDeps): void {
  const { app, logger } = deps;
  // A web page can trigger these at will, so each kind has its own budget of lines.
  const blockedRequestLog = logger.limited('blocked-request');
  const blockedDownloadLog = logger.limited('blocked-download');

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const runtime = resolveRuntime({
    isPackaged: app.isPackaged,
    rendererUrl: deps.rendererUrl,
    development: deps.development,
  });

  // Both must happen before the app is ready.
  registerAppScheme(deps.protocol);
  app.commandLine.appendSwitch('host-resolver-rules', runtime.hostResolverRules);

  // One way out for everything the app cannot continue after.
  let failed = false;
  const fatal = (message: string, detail: unknown): void => {
    if (failed) return;
    failed = true;
    logger.error(message, { detail });
    app.exit(1);
  };

  app.on('web-contents-created', (_event, contents) => {
    lockDownWebContents(contents, runtime);
  });

  // Every session gets the same lockdown, whoever creates it, the moment it
  // exists. Electron emits `session-created` synchronously on the first access
  // to `session.defaultSession`, so the lockdown of the default session starts
  // here, not at the explicit call below. What is kept per session is therefore
  // the lockdown PROMISE: every caller gets the one in-flight lockdown and
  // really waits for it. A session that cannot be locked down ends the app.
  const lockdowns = new WeakMap<Session, Promise<void>>();
  const lockDown = (session: Session): Promise<void> => {
    const pending = lockdowns.get(session);
    if (pending !== undefined) return pending;
    const lockdown = lockDownSession(session, {
      runtime,
      onBlockedRequest: (url) => {
        blockedRequestLog.warn('Blocked a request outside the app', { url });
      },
      onBlockedDownload: (url) => {
        blockedDownloadLog.warn('Blocked a download', { url });
      },
    });
    lockdowns.set(session, lockdown);
    return lockdown;
  };
  app.on('session-created', (session) => {
    lockDown(session).catch((error: unknown) => {
      fatal('A session could not be locked down', error);
    });
  });

  const createWindow = createWindowFactory({
    BrowserWindow: deps.BrowserWindow,
    runtime,
    preloadPath: deps.preloadPath,
    onLoadError: (error) => {
      logger.error('The app page failed to load', { detail: error });
    },
    onForeignDocument: (url) => {
      logger.warn('A window left the app page and was sent back', { url });
    },
    onUnrecoverable: (url) => {
      fatal('A window kept leaving the app page and was closed', url);
    },
  });

  // The windows the tray opens (TASK-202) are created here, with `createWindow`.
  let window: BrowserWindow | null = null;
  const openWindow = (): void => {
    window = createWindow({ width: 480, height: 320, title: 'RouteSwitch' });
    window.on('closed', () => {
      window = null;
    });
  };

  app.on('second-instance', () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // Until the tray exists the window is the only way to reach the app, so
  // closing it quits. With the tray (TASK-202) the app stays in the menu bar.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    deps.helperClient.stop();
  });

  app
    .whenReady()
    .then(async () => {
      // Menu bar app: no Dock icon. `app.dock` exists only on macOS.
      if (deps.platform === 'darwin') app.dock?.hide();

      // No window is constructed and no page starts to load until the proxy
      // of the default session is in force. Windows only ever use the default
      // session: the window factory accepts no `partition` or `session`.
      await lockDown(deps.getDefaultSession());

      if (runtime.kind === 'production') {
        deps.protocol.handle(
          APP_SCHEME,
          createAppProtocolHandler({
            rendererRoot: deps.rendererRoot,
            csp: buildProductionCsp(),
            readFile: deps.readFile,
            realpath: deps.realpath,
            onError: (message, error) => {
              logger.error(message, { code: error });
            },
          }),
        );
      }

      openWindow();

      // In the background: the window does not wait for the helper, and the
      // helper not being there is an ordinary state the UI shows.
      deps.helperClient.start();
    })
    .catch((error: unknown) => {
      fatal('Startup failed', error);
    });
}
