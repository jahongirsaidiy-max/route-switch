// The main-process side of `window.rs`: one `ipcMain.handle` per method of the
// renderer API (`src/renderer/src/rs.d.ts`) and the `rs:state`, `rs:log` and
// `rs:language` pushes, and `rs:rulesIntent` to the rules window.
//
// The renderer is treated as untrusted. Every call is checked, in this order:
// it must come from the top frame of the app's own page; its arguments must
// stay within `STRUCTURE_LIMITS`; and they must parse with the shared zod
// schemas. A call that fails any check is answered `{ ok: false }` and
// nothing reaches the helper. Nothing here throws back into the renderer:
// every outcome, a helper failure included, is an `RsResult`.
//
// The app never writes the config file. A rule is changed by reading the
// config from the helper, changing it here and sending the whole config back
// with `setConfig`; the helper validates and stores it.

import {
  Config as ConfigSchema,
  DiagnoseRequest,
  describeIssues,
  findStructureViolation,
  Language,
  Rule,
  RulesWindowIntent,
  SetEnabledRequest,
  TestRequest,
  type Config,
  type RuleInput,
} from '@routeswitch/shared';

import type {
  RsIfaceOverrides,
  RsConnection,
  RsInvokeChannel,
  RsInvokeChannels,
  RsLanguage,
  RsLanguageChannel,
  RsLogChannel,
  RsResult,
  RsRulesIntent,
  RsRulesIntentChannel,
  RsSnapshot,
  RsStateChannel,
} from '../renderer/src/rs';
import { readConfigFile, writeConfigFile, type ConfigFileSystem } from './configFile';
import { createConnectionJournal } from './connectionJournal';
import { createDiagnoser, type NameLookup, type Timers } from './diagnose';
import type { HelperClient, HelperStatus } from './helperClient';
import type { Installer } from './installer';
import { createLogBuffer, type LogBuffer } from './logBuffer';
import type { Logger } from './logger';
import type { PreferencesStore } from './preferences';
import type { RulesBackupStore } from './rulesBackup';
import { isAllowedNavigation } from './security';
import type { Settings } from './settings';
import { VIEW_PARAM, type WindowView } from './windows';

// `RsConnection` is the renderer's copy of `HelperStatus`; this line fails to
// compile as soon as the two drift apart.
const toConnection = (status: HelperStatus): RsConnection => status;

export const STATE_CHANNEL: RsStateChannel = 'rs:state';
export const LOG_CHANNEL: RsLogChannel = 'rs:log';
export const LANGUAGE_CHANNEL: RsLanguageChannel = 'rs:language';
export const RULES_INTENT_CHANNEL: RsRulesIntentChannel = 'rs:rulesIntent';

/** How long an intent waits for the rules window to take it (TASK-DELTA-21). */
export const RULES_INTENT_TTL_MS = 60_000;

/** The view of the app page at `url` (`?view=`), or null when it names none. */
export function viewOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get(VIEW_PARAM);
  } catch {
    return null;
  }
}

/** The channels handled here, in the order of the renderer API. */
export const INVOKE_CHANNELS = [
  'rs:getState',
  'rs:getConfig',
  'rs:saveRule',
  'rs:deleteRule',
  'rs:toggleRule',
  'rs:setEnabled',
  'rs:apply',
  'rs:test',
  'rs:diagnose',
  'rs:import',
  'rs:applyImport',
  'rs:export',
  'rs:getLog',
  'rs:getSettings',
  'rs:setOpenAtLogin',
  'rs:setIfaceOverrides',
  'rs:getServiceOrder',
  'rs:copyServiceOrderCommand',
  'rs:uninstall',
  'rs:openRulesWindow',
  'rs:takeRulesIntent',
  'rs:reconnect',
  'rs:resetConfig',
  'rs:installHelper',
  'rs:removeHelper',
  'rs:getLanguage',
  'rs:setLanguage',
  'rs:getBackup',
  'rs:restoreBackup',
  'rs:deleteBackup',
  'rs:dismissBackup',
] as const satisfies readonly RsInvokeChannel[];

/** What "Bo'sh config bilan boshlash" stores in place of a config the helper cannot load. */
export const EMPTY_CONFIG: Config = { version: 1, enabled: true, rules: [] };

/** The part of a `WebFrameMain` a call is checked against. */
export interface SenderFrame {
  readonly url: string;
  readonly parent: unknown;
}

/** The part of an `IpcMainInvokeEvent` used here. */
export interface InvokeEvent {
  readonly senderFrame: SenderFrame | null;
}

/** The part of `ipcMain` used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEvent, ...args: unknown[]) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** A renderer that may receive `rs:state` and `rs:log` (the part of a `WebContents` used here). */
export interface StateRecipient {
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, payload: unknown): void;
}

export interface IpcDeps {
  readonly ipcMain: IpcMainLike;
  readonly helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'reconnectNow' | 'onStatus' | 'onState' | 'onLog'>;
  /** The app's page (`Runtime.entryUrl`): the only document whose calls are answered. */
  readonly entryUrl: string;
  readonly logger: Logger;
  /** The renderers to send `rs:state` and `rs:log` to. Each is sent to only while it shows the app's page. */
  readonly listRecipients: () => readonly StateRecipient[];
  /** Where the helper's `log` events (and the app's own connection events) are kept for the journal; a new 500-entry buffer by default. */
  readonly logBuffer?: LogBuffer;
  /** The login item and the network service order (settings screen). */
  readonly settings: Settings;
  /** The UI language, kept in `userData/preferences.json`; every change is pushed to the windows as `rs:language`. */
  readonly preferences: Pick<PreferencesStore, 'language' | 'setLanguage' | 'onLanguage' | 'dismissedBackupAt' | 'setDismissedBackupAt'>;
  /** The app's copy of the last config it saw (`userData/rules-backup.json`, TASK-DELTA-16). */
  readonly backup: Pick<RulesBackupStore, 'read' | 'remove'>;
  /** Runs the app's own install / uninstall script as root after the system password dialog (`installer.ts`). */
  readonly installer: Installer;
  /** Opens the rules window or brings it to the front (`WindowManager.openRules`). Main process only, no helper call. */
  readonly openRulesWindow: () => void;
  /** The system file dialogs of config import / export; null when the user cancels. The path never reaches the page. */
  readonly configDialogs: ConfigDialogs;
  /** File access for import / export; `node:fs/promises` by default. */
  readonly configFs?: ConfigFileSystem;
  /** Token of an import waiting for confirmation; `crypto.randomUUID` by default. */
  readonly newToken?: () => string;
  /** Milliseconds since the epoch, for the age of a waiting import and the time of the app's journal lines; `Date.now` by default. */
  readonly now?: () => number;
  /** "Diagnostika": the system resolver for a name no rule covers, with the user's rights; `dns.lookup` by default. */
  readonly lookupName?: NameLookup;
  /** Timers of that lookup's 3 s limit; the real ones by default. */
  readonly diagnoseTimers?: Timers;
}

/** `dialog.showOpenDialog` / `dialog.showSaveDialog`, reduced to the chosen path. */
export interface ConfigDialogs {
  readonly chooseImportFile: () => Promise<string | null>;
  readonly chooseExportFile: () => Promise<string | null>;
}

/** How long a read import file waits for "Almashtirish". */
export const IMPORT_TTL_MS = 10 * 60 * 1000;

export interface IpcRegistration {
  /** Removes the handlers and the helper-client subscriptions. Idempotent. */
  readonly dispose: () => void;
}

type Failure = Extract<RsResult<never>, { ok: false }>;

const failure = (code: Failure['code'], error: string): Failure => ({ ok: false, code, error });

// ---------------------------------------------------------------------------
// Arguments — every value is checked with a schema of `@routeswitch/shared`;
// none is a copy. (The app does not import zod itself: the shared package
// carries its own copy, and mixing two would be a quiet source of drift.)
// ---------------------------------------------------------------------------

type SchemaError = Parameters<typeof describeIssues>[0];

/** The part of a zod schema used here. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: SchemaError };
}

type ArgsResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string };

/** Checks the argument list of one call: exactly as many values as `schemas`, each one parsed by its schema. */
type ArgsParser<A> = (args: readonly unknown[]) => ArgsResult<A>;

/** Like `argumentsOf(a)`, but the one argument may also be left out (not `undefined`: absent). */
function optionalArgumentOf<A>(a: Schema<A>): ArgsParser<readonly [] | readonly [A]> {
  const one = argumentsOf(a);
  return (args) => (args.length === 0 ? { ok: true, value: [] } : one(args));
}

function argumentsOf(): ArgsParser<readonly []>;
function argumentsOf<A>(a: Schema<A>): ArgsParser<readonly [A]>;
function argumentsOf<A, B>(a: Schema<A>, b: Schema<B>): ArgsParser<readonly [A, B]>;
function argumentsOf(...schemas: Schema<unknown>[]): ArgsParser<readonly unknown[]> {
  return (args) => {
    if (args.length !== schemas.length) {
      return { ok: false, error: `Expected ${String(schemas.length)} argument(s), got ${String(args.length)}` };
    }
    const values: unknown[] = [];
    for (const [index, schema] of schemas.entries()) {
      const parsed = schema.safeParse(args[index]);
      if (!parsed.success) return { ok: false, error: `Argument ${String(index + 1)}: ${describeIssues(parsed.error)}` };
      values.push(parsed.data);
    }
    return { ok: true, value: values };
  };
}

/** A rule id: a UUID, as `Rule` requires. */
const RuleId: Schema<string> = Rule.in.shape.id;
/** A plain boolean — no default, so a missing value is refused rather than read as `true`. */
const Flag: Schema<boolean> = SetEnabledRequest.shape.enabled;
/** One routable IPv4 address, normalised (forbidden destinations refused, ADR-001). */
const TestTarget: Schema<string> = TestRequest.shape.target;
/** A routable IPv4 address or a domain, normalised exactly as the helper's `diagnose` takes it (no wildcard, no URL). */
const DiagnoseTarget: Schema<string> = DiagnoseRequest.shape.target;
const RuleArgument: Schema<Rule> = Rule;
/** The token of a waiting import: a UUID, like a rule id. */
const ImportToken: Schema<string> = Rule.in.shape.id;
/** Device overrides per role: only `ethernet` / `wifi` keys, each an `en*` name. Required (no `undefined`). */
const IfaceOverrides: Schema<RsIfaceOverrides> = ConfigSchema.shape.ifaceOverrides.unwrap();
/** A UI language: exactly `uz`, `ru` or `en`. */
const LanguageArgument: Schema<RsLanguage> = Language;
/** What the rules window is opened for: a section, or a DNS offer by routable server and role (shared, strict). */
const IntentArgument: Schema<RsRulesIntent> = RulesWindowIntent;

const ARGUMENTS = {
  'rs:getState': argumentsOf(),
  'rs:getConfig': argumentsOf(),
  'rs:saveRule': argumentsOf(RuleArgument),
  'rs:deleteRule': argumentsOf(RuleId),
  'rs:toggleRule': argumentsOf(RuleId, Flag),
  'rs:setEnabled': argumentsOf(Flag),
  'rs:apply': argumentsOf(),
  'rs:test': argumentsOf(TestTarget),
  'rs:diagnose': argumentsOf(DiagnoseTarget),
  'rs:import': argumentsOf(),
  'rs:applyImport': argumentsOf(ImportToken),
  'rs:export': argumentsOf(),
  'rs:getLog': argumentsOf(),
  'rs:getSettings': argumentsOf(),
  'rs:setOpenAtLogin': argumentsOf(Flag),
  'rs:setIfaceOverrides': argumentsOf(IfaceOverrides),
  'rs:getServiceOrder': argumentsOf(),
  'rs:copyServiceOrderCommand': argumentsOf(),
  'rs:uninstall': argumentsOf(),
  'rs:openRulesWindow': optionalArgumentOf(IntentArgument),
  'rs:takeRulesIntent': argumentsOf(),
  'rs:reconnect': argumentsOf(),
  'rs:resetConfig': argumentsOf(),
  'rs:installHelper': argumentsOf(),
  'rs:removeHelper': argumentsOf(),
  'rs:getLanguage': argumentsOf(),
  'rs:setLanguage': argumentsOf(LanguageArgument),
  'rs:getBackup': argumentsOf(),
  'rs:restoreBackup': argumentsOf(),
  'rs:deleteBackup': argumentsOf(),
  'rs:dismissBackup': argumentsOf(),
} as const satisfies Readonly<Record<RsInvokeChannel, ArgsParser<readonly unknown[]>>>;

type ParsedArgs<C extends RsInvokeChannel> = (typeof ARGUMENTS)[C] extends ArgsParser<infer A> ? A : never;

type Handlers = { readonly [C in RsInvokeChannel]: (args: ParsedArgs<C>) => Promise<RsResult<RsInvokeChannels[C]['value']>> };

/** Channels answered to one window only; any other page of the app gets `forbidden`. */
const ONLY_FOR_VIEW: Partial<Readonly<Record<RsInvokeChannel, WindowView>>> = { 'rs:takeRulesIntent': 'rules' };

const isTrustedSender = (event: InvokeEvent, entryUrl: string): boolean => {
  // A frame that is gone, or one whose properties cannot be read, is not trusted.
  try {
    const frame = event.senderFrame;
    return frame !== null && frame.parent === null && isAllowedNavigation(frame.url, entryUrl);
  } catch {
    return false;
  }
};

/** Mutations of one rule: returns the new rule list, or null when no rule has `id`. */
type RuleEdit = (rules: Config['rules']) => RuleInput[] | null;

export function registerIpcHandlers(deps: IpcDeps): IpcRegistration {
  const { ipcMain, helperClient, entryUrl, settings, preferences } = deps;
  const logger = deps.logger.child({ component: 'ipc' });
  // Everything below can be triggered by the page at will, so each kind of
  // line has its own rate-limit budget.
  const senderLog = logger.limited('ipc-untrusted-sender');
  const inputLog = logger.limited('ipc-invalid-input');
  const failureLog = logger.limited('ipc-call-failed');
  const changeLog = logger.limited('ipc-change');
  const windowLog = logger.limited('ipc-window');
  const reconnectLog = logger.limited('ipc-reconnect');
  const setupLog = logger.limited('ipc-helper-setup');
  const internalLog = logger.limited('ipc-internal');
  const pushLog = logger.limited('ipc-push-failed');
  const journalLog = logger.limited('ipc-journal-failed');
  const logBuffer =
    deps.logBuffer ??
    createLogBuffer({
      onListenerError: (error) => {
        journalLog.error('A journal listener failed', { detail: error });
      },
    });

  // Every call that changes something runs alone, in order of arrival. A rule
  // edit is read-modify-write over two requests; without this, two edits (or
  // an edit and `setEnabled`) could interleave and the later `setConfig` would
  // undo the other change.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  // -- config import / export (TASK-215) --------------------------------------
  const transferLog = logger.limited('ipc-config-file');
  const configFs = deps.configFs;
  const newToken = deps.newToken ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? Date.now;

  // -- what the rules window is opened for (TASK-DELTA-21) ---------------------
  // One intent waits at a time (the last wins), until the rules window takes it or a minute passes.
  let rulesIntent: { readonly intent: RsRulesIntent; readonly at: number } | null = null;
  const intentLog = logger.limited('ipc-rules-intent');
  /** Tells the rules window (and no other) that an intent is waiting; a new window takes it on load instead. */
  const pushToRulesWindow = (): void => {
    let recipients: readonly StateRecipient[];
    try {
      recipients = deps.listRecipients();
    } catch (error) {
      intentLog.error('Could not list the windows to tell of a waiting intent', { detail: error });
      return;
    }
    for (const recipient of recipients) {
      try {
        if (recipient.isDestroyed()) continue;
        const url = recipient.getURL();
        if (!isAllowedNavigation(url, entryUrl) || viewOf(url) !== 'rules') continue;
        recipient.send(RULES_INTENT_CHANNEL, null);
      } catch (error) {
        intentLog.error('Could not tell the rules window of a waiting intent', { detail: error });
      }
    }
  };

  // At most one system file dialog at a time; a second click is answered `busy`.
  let dialogOpen = false;
  const withDialog = async <T>(task: () => Promise<RsResult<T>>): Promise<RsResult<T>> => {
    if (dialogOpen) return failure('busy', 'A file dialog is already open');
    dialogOpen = true;
    try {
      return await task();
    } finally {
      dialogOpen = false;
    }
  };
  // The one import waiting for confirmation: a newer import replaces it, `applyImport` uses it up.
  let pendingImport: { readonly token: string; readonly config: Config; readonly at: number } | null = null;

  const importConfig = () =>
    withDialog(async (): Promise<RsResult<RsInvokeChannels['rs:import']['value']>> => {
      const file = await deps.configDialogs.chooseImportFile();
      if (file === null) return { ok: true, value: null };
      const read = await readConfigFile(file, configFs);
      if (!read.ok) {
        pendingImport = null;
        transferLog.warn('Refused a config file', { channel: 'rs:import', code: read.code, issue: read.issue?.code ?? null });
        return read.issue === undefined ? failure(read.code, read.error) : { ...failure(read.code, read.error), issue: read.issue };
      }
      const token = newToken();
      pendingImport = { token, config: read.config, at: now() };
      transferLog.info('Config file read for import', { channel: 'rs:import', rules: read.config.rules.length, bytes: read.bytes });
      return { ok: true, value: { token, config: read.config } };
    });

  const applyImport = (token: string) =>
    serially(async (): Promise<RsResult<RsInvokeChannels['rs:applyImport']['value']>> => {
      const waiting = pendingImport;
      if (waiting === null || waiting.token !== token || now() - waiting.at > IMPORT_TTL_MS || now() < waiting.at) {
        if (waiting?.token === token) pendingImport = null;
        return failure('import-expired', 'No import is waiting for this token');
      }
      pendingImport = null;
      // Replaces the stored config as a whole; the helper checks it again.
      const saved = await helperClient.request('setConfig', { config: waiting.config });
      if (saved.ok) changeLog.info('Config imported', { channel: 'rs:applyImport', rules: waiting.config.rules.length });
      return saved;
    });

  // -- the rules backup (TASK-DELTA-16) ---------------------------------------
  // A restore is an import whose file is the app's own backup: the same
  // preview, the same one-use token, the same `applyImport`. Nothing reaches
  // the helper before the user's "Almashtirish".
  const backupLog = logger.limited('ipc-rules-backup');

  const restoreBackup = async (): Promise<RsResult<RsInvokeChannels['rs:restoreBackup']['value']>> => {
    const backup = await deps.backup.read();
    if (backup === null) return failure('no-backup', 'The app holds no rules backup');
    // Checked when it was read; checked again here, as for a file, before it can be sent.
    const violation = findStructureViolation(backup.config);
    const parsed = violation === null ? ConfigSchema.safeParse(backup.config) : null;
    if (parsed === null || !parsed.success) {
      pendingImport = null;
      backupLog.warn('Refused the rules backup', { channel: 'rs:restoreBackup' });
      return failure('invalid-config', 'The rules backup does not hold a valid config');
    }
    const token = newToken();
    pendingImport = { token, config: parsed.data, at: now() };
    backupLog.info('Rules backup read for restore', { channel: 'rs:restoreBackup', rules: parsed.data.rules.length, savedAt: backup.savedAt });
    return { ok: true, value: { token, config: parsed.data } };
  };

  const exportConfig = () =>
    withDialog(async (): Promise<RsResult<RsInvokeChannels['rs:export']['value']>> => {
      // Read first: without a helper there is nothing to export, and no dialog opens.
      const current = await helperClient.request('getConfig');
      if (!current.ok) return current;
      const file = await deps.configDialogs.chooseExportFile();
      if (file === null) return { ok: true, value: null };
      const written = await writeConfigFile(file, current.value.config, configFs);
      if (!written.ok) {
        transferLog.error('Could not write the exported config', { channel: 'rs:export', detail: written.error });
        return failure('write-failed', written.error);
      }
      transferLog.info('Config exported', { channel: 'rs:export', rules: current.value.config.rules.length, bytes: written.bytes });
      return { ok: true, value: { rules: current.value.config.rules.length, bytes: written.bytes } };
    });

  /** The Wi‑Fi role's device as the engine last saw it; it picks the Wi‑Fi service of the order. */
  const wifiDevice = (): string | null => helperClient.snapshot().state?.interfaces.wifi.device ?? null;

  const editRule = (channel: RsInvokeChannel, ruleId: string, edit: RuleEdit) =>
    serially(async (): Promise<RsResult<RsInvokeChannels['rs:saveRule']['value']>> => {
      const current = await helperClient.request('getConfig');
      if (!current.ok) return current;
      const rules = edit(current.value.config.rules);
      if (rules === null) return failure('rule-not-found', 'The config holds no rule with this id');
      // `request` validates the config with the shared schema before sending:
      // a config the helper would refuse (a duplicate id, two interfaces for
      // one target, more than 500 rules) is answered `invalid-config` here.
      const saved = await helperClient.request('setConfig', { config: { ...current.value.config, rules } });
      if (saved.ok) changeLog.info('Config changed', { channel, ruleId, rules: rules.length });
      return saved;
    });

  // Install / full removal: the page sends nothing; the installer runs a fixed
  // script of the app's resources. Afterwards the client tries the socket at
  // once instead of waiting for its backoff (an `incompatible` helper included).
  const setUpHelper = async (channel: 'rs:installHelper' | 'rs:removeHelper', run: () => ReturnType<Installer['install']>) => {
    setupLog.info('Helper setup requested', { channel });
    const result = await run();
    if (result.ok) helperClient.reconnectNow();
    setupLog.info('Helper setup ended', { channel, ok: result.ok, code: result.ok ? null : result.code });
    return result;
  };

  // -- diagnostics (TASK-DELTA-20) --------------------------------------------
  // One at a time: a second click while one runs is answered `busy`, so a
  // page cannot pile up lookups and helper requests.
  const diagnoser = createDiagnoser({
    request: helperClient.request,
    logger,
    ...(deps.lookupName === undefined ? {} : { lookup: deps.lookupName }),
    ...(deps.diagnoseTimers === undefined ? {} : { timers: deps.diagnoseTimers }),
  });
  let diagnosing = false;
  const diagnose = async (target: string): Promise<RsResult<RsInvokeChannels['rs:diagnose']['value']>> => {
    if (diagnosing) return failure('busy', 'A diagnosis is already running');
    diagnosing = true;
    try {
      return await diagnoser(target);
    } finally {
      diagnosing = false;
    }
  };

  const handlers: Handlers = {
    'rs:getState': () => {
      const { status, state } = helperClient.snapshot();
      const snapshot: RsSnapshot = { connection: toConnection(status), state };
      return Promise.resolve({ ok: true, value: snapshot });
    },
    'rs:getConfig': async () => {
      const result = await helperClient.request('getConfig');
      return result.ok ? { ok: true, value: result.value.config } : result;
    },
    'rs:saveRule': ([rule]) =>
      editRule('rs:saveRule', rule.id, (rules) => {
        const index = rules.findIndex((existing) => existing.id === rule.id);
        return index === -1 ? [...rules, rule] : rules.map((existing, i) => (i === index ? rule : existing));
      }),
    'rs:deleteRule': ([id]) =>
      editRule('rs:deleteRule', id, (rules) => {
        const kept = rules.filter((existing) => existing.id !== id);
        return kept.length === rules.length ? null : kept;
      }),
    'rs:toggleRule': ([id, enabled]) =>
      editRule('rs:toggleRule', id, (rules) =>
        rules.some((existing) => existing.id === id)
          ? rules.map((existing) => (existing.id === id ? { ...existing, enabled } : existing))
          : null,
      ),
    'rs:setEnabled': ([enabled]) =>
      serially(async () => {
        const result = await helperClient.request('setEnabled', { enabled });
        if (result.ok) changeLog.info('Routing switched', { channel: 'rs:setEnabled', enabled });
        return result;
      }),
    'rs:apply': () => serially(() => helperClient.request('apply')),
    'rs:test': ([target]) => helperClient.request('test', { target }),
    // Read-only; the target is logged at debug only (`diagnose.ts`).
    'rs:diagnose': ([target]) => diagnose(target),
    // The system dialogs of this process choose the file; the page never sends or sees a path.
    'rs:import': () => importConfig(),
    'rs:applyImport': ([token]) => applyImport(token),
    'rs:export': () => exportConfig(),
    // From the main process's memory: no helper round trip, and it works while the helper is away.
    'rs:getLog': () => Promise.resolve({ ok: true, value: logBuffer.entries() }),
    'rs:getSettings': () => Promise.resolve({ ok: true, value: { openAtLogin: settings.openAtLogin() } }),
    'rs:setOpenAtLogin': ([on]) => Promise.resolve({ ok: true, value: { openAtLogin: settings.setOpenAtLogin(on) } }),
    'rs:setIfaceOverrides': ([overrides]) =>
      serially(async () => {
        const current = await helperClient.request('getConfig');
        if (!current.ok) return current;
        const config: Config = { ...current.value.config };
        delete config.ifaceOverrides;
        if (Object.keys(overrides).length > 0) config.ifaceOverrides = overrides;
        const saved = await helperClient.request('setConfig', { config });
        if (saved.ok) changeLog.info('Interface overrides changed', { channel: 'rs:setIfaceOverrides', roles: Object.keys(overrides) });
        return saved;
      }),
    // Read-only, and never the privileged command itself (GAP-04): the user runs it.
    'rs:getServiceOrder': () => settings.serviceOrder(wifiDevice()),
    'rs:copyServiceOrderCommand': () => settings.copyServiceOrderCommand(wifiDevice()),
    'rs:uninstall': () =>
      serially(async () => {
        const result = await helperClient.request('uninstall');
        changeLog.info('Helper uninstall requested', { channel: 'rs:uninstall', ok: result.ok });
        return result;
      }),
    // A window of this process; the helper is not involved. A throw is answered `internal` below.
    'rs:openRulesWindow': ([intent]) => {
      // Kept before the window opens: a new window takes it once it has loaded.
      if (intent !== undefined) rulesIntent = { intent, at: now() };
      deps.openRulesWindow();
      if (intent !== undefined) pushToRulesWindow();
      // The kind only: a DNS offer's server is the user's network, not for the log above debug.
      windowLog.info('Rules window requested', { channel: 'rs:openRulesWindow', intent: intent?.kind ?? null });
      return Promise.resolve({ ok: true, value: null });
    },
    'rs:takeRulesIntent': () => {
      const waiting = rulesIntent;
      rulesIntent = null;
      const fresh = waiting !== null && now() - waiting.at <= RULES_INTENT_TTL_MS ? waiting.intent : null;
      return Promise.resolve({ ok: true, value: fresh });
    },
    // "Qayta ulanish": the client ignores it while a connection is open or being opened.
    'rs:reconnect': () => {
      reconnectLog.info('Reconnect to the helper requested', { channel: 'rs:reconnect', status: helperClient.snapshot().status.kind });
      helperClient.reconnectNow();
      return Promise.resolve({ ok: true, value: null });
    },
    // Only while the stored config cannot be loaded: then it replaces nothing the user could still read.
    'rs:resetConfig': () =>
      serially(async (): Promise<RsResult<RsInvokeChannels['rs:resetConfig']['value']>> => {
        if (helperClient.snapshot().status.kind !== 'config-unreadable') {
          return failure('operation-failed', 'The stored config is not unreadable; nothing was reset');
        }
        const saved = await helperClient.request('setConfig', { config: EMPTY_CONFIG });
        changeLog.info('Unreadable config replaced with an empty one', { channel: 'rs:resetConfig', ok: saved.ok });
        return saved;
      }),
    'rs:installHelper': () => setUpHelper('rs:installHelper', deps.installer.install),
    'rs:removeHelper': () => setUpHelper('rs:removeHelper', deps.installer.uninstall),
    // The app's own preference: no helper round trip, and it works while the helper is away.
    'rs:getLanguage': async () => ({ ok: true, value: await preferences.language() }),
    'rs:setLanguage': async ([language]) => ({ ok: true, value: await preferences.setLanguage(language) }),
    // The app's own file: answered without the helper. The page learns how many rules, not which.
    'rs:getBackup': async () => {
      const backup = await deps.backup.read();
      if (backup === null) return { ok: true, value: null };
      const dismissed = (await preferences.dismissedBackupAt()) === backup.savedAt;
      return { ok: true, value: { savedAt: backup.savedAt, ruleCount: backup.config.rules.length, dismissed } };
    },
    'rs:restoreBackup': () => restoreBackup(),
    'rs:deleteBackup': async () => {
      const removed = await deps.backup.remove();
      backupLog.info('Rules backup removal requested', { channel: 'rs:deleteBackup', ok: removed });
      return removed ? { ok: true, value: null } : failure('write-failed', 'The rules backup could not be removed');
    },
    // Only the backup on disk now can be turned down: the page names none.
    'rs:dismissBackup': async () => {
      const backup = await deps.backup.read();
      if (backup !== null) await preferences.setDismissedBackupAt(backup.savedAt);
      return { ok: true, value: null };
    },
  };

  const register = (channel: RsInvokeChannel): void => {
    // Both tables are keyed by channel and typed together above (`ParsedArgs`),
    // so the parser of a channel always produces exactly what its handler takes.
    const parseArgs: ArgsParser<readonly unknown[]> = ARGUMENTS[channel];
    const handler = handlers[channel] as (args: readonly unknown[]) => Promise<RsResult<unknown>>;
    ipcMain.handle(channel, async (event, ...args): Promise<RsResult<unknown>> => {
      if (!isTrustedSender(event, entryUrl)) {
        senderLog.warn('Refused a call that did not come from the app page', { channel });
        return failure('forbidden', 'Calls are answered only for the app page');
      }
      const onlyFor = ONLY_FOR_VIEW[channel];
      if (onlyFor !== undefined && viewOf(event.senderFrame?.url ?? '') !== onlyFor) {
        senderLog.warn('Refused a call from another window of the app', { channel });
        return failure('forbidden', `Calls on this channel are answered only for the ${onlyFor} window`);
      }
      // Bounded walk first: zod does not stop early on an oversized array.
      const violation = findStructureViolation(args);
      if (violation !== null) {
        inputLog.warn('Refused oversized arguments', { channel, violation: violation.kind });
        return failure('invalid-input', `The arguments are too large (${violation.kind})`);
      }
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        // Built from fixed text, field names and numbers only (`describeIssues`):
        // nothing the page sent is repeated in the log or the answer.
        inputLog.warn('Refused invalid arguments', { channel, issue: parsed.error });
        return failure('invalid-input', parsed.error);
      }
      try {
        const result = await handler(parsed.value);
        if (!result.ok) failureLog.warn('A call failed', { channel, code: result.code });
        return result;
      } catch (error) {
        internalLog.error('A call failed unexpectedly', { channel, detail: error });
        return failure('internal', 'The app could not carry out the call');
      }
    });
  };

  for (const channel of INVOKE_CHANNELS) register(channel);

  // -- pushes: rs:state, rs:log ----------------------------------------------

  /** Sends to every window that shows the app's page; a failure is logged, never thrown into the sender. */
  const PUSHED: Readonly<Record<RsStateChannel | RsLogChannel | RsLanguageChannel, string>> = {
    'rs:state': 'the state',
    'rs:log': 'a journal entry',
    'rs:language': 'the language',
  };
  const broadcast = (channel: RsStateChannel | RsLogChannel | RsLanguageChannel, payload: unknown): void => {
    let recipients: readonly StateRecipient[];
    try {
      recipients = deps.listRecipients();
    } catch (error) {
      pushLog.error(`Could not list the windows to send ${PUSHED[channel]} to`, { detail: error });
      return;
    }
    for (const recipient of recipients) {
      try {
        if (recipient.isDestroyed() || !isAllowedNavigation(recipient.getURL(), entryUrl)) continue;
        recipient.send(channel, payload);
      } catch (error) {
        pushLog.error(`Could not send ${PUSHED[channel]} to a window`, { detail: error });
      }
    }
  };

  // On connect the client reports the status and then the same first state:
  // a snapshot identical to the last one sent is not sent again.
  let lastPushed: { readonly status: HelperStatus; readonly state: RsSnapshot['state'] } | null = null;
  const push = (): void => {
    const { status, state } = helperClient.snapshot();
    if (lastPushed !== null && lastPushed.status === status && lastPushed.state === state) return;
    lastPushed = { status, state };
    const snapshot: RsSnapshot = { connection: toConnection(status), state };
    broadcast(STATE_CHANNEL, snapshot);
  };

  // The app's own journal lines: the helper cannot report that it is gone. In the UI language of the moment.
  const connectionJournal = createConnectionJournal({ logBuffer, now, language: () => preferences.language() });

  const unsubscribes = [
    helperClient.onStatus(push),
    helperClient.onStatus(connectionJournal.record),
    helperClient.onState(push),
    // Every `log` event of the helper goes into the journal, and from there to the open windows.
    helperClient.onLog((event) => {
      logBuffer.push(event);
    }),
    logBuffer.subscribe((entry) => {
      broadcast(LOG_CHANNEL, entry);
    }),
    // Every window (the popover and the rules window) switches language at once, without a reload.
    preferences.onLanguage((language) => {
      broadcast(LANGUAGE_CHANNEL, language);
    }),
  ];

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}
