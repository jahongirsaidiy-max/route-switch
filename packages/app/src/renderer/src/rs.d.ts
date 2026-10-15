// The renderer's whole view of the system: `window.rs`, exposed by the preload
// (`src/preload/index.ts`) and answered by the main process (`src/main/ipc.ts`).
// Types only — the renderer imports nothing else from outside the page, and the
// main process and the preload type their side of the channels against this.

import type {
  Config,
  DiagnoseResult,
  EngineState,
  ErrorCode,
  EventLogLevel,
  IfaceRole,
  Language,
  RuleInput,
  RulesWindowIntent,
  SetConfigResult,
  StateResult,
  TestResult,
  UninstallResult,
} from '@routeswitch/shared';

/**
 * The app's connection to the helper, as the main process sees it.
 * - `connecting`    — a (re)connect is under way;
 * - `connected`     — requests can be made, `state` is present;
 * - `not-installed` — there is no helper socket: the helper was never installed (or was removed);
 * - `disconnected`  — installed, but there is no connection right now (`reason` says why);
 * - `config-unreadable` — the helper runs, but its stored config cannot be loaded: it applies
 *                     nothing until a new config replaces it (`applyImport`, `resetConfig`);
 *                     calls can be made, `state` is null;
 * - `incompatible`  — the helper speaks another protocol version and must be reinstalled;
 * - `stopped`       — the app is shutting down.
 */
export type RsConnection =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly helperVersion: string }
  | { readonly kind: 'not-installed' }
  | {
      readonly kind: 'disconnected';
      readonly reason: 'not-running' | 'permission-denied' | 'connection-lost' | 'protocol-error' | 'timeout' | 'error';
    }
  | { readonly kind: 'config-unreadable'; readonly helperVersion: string }
  | {
      readonly kind: 'incompatible';
      readonly helperVersion: string;
      readonly protocolVersion: number;
      readonly expectedProtocolVersion: number;
    };

/** What `getState` returns and `onState` delivers. `state` is null whenever `connection` is not `connected`. */
export interface RsSnapshot {
  readonly connection: RsConnection;
  readonly state: EngineState | null;
}

/**
 * One line of the journal, numbered by the main process: a `log` event of the
 * helper, or an event of the app itself (`source: 'app'` — the helper
 * connection was lost, came back, …), written in the UI's words.
 */
export interface RsLogEntry {
  /** 1 for the first entry of this app run, then +1 for each; never reused. Newer entries have higher numbers. */
  readonly seq: number;
  readonly level: EventLogLevel;
  readonly msg: string;
  /** When the helper (or the app) logged it (ISO 8601, UTC). */
  readonly at: string;
  /** Present on the app's own entries only; an entry without it came from the helper. */
  readonly source?: 'app';
}

/** The app's own settings, kept by macOS rather than in the helper's config. */
export interface RsSettings {
  /** The app is a login item (`app.getLoginItemSettings().openAtLogin`). */
  readonly openAtLogin: boolean;
}

/** One network service of `networksetup -listnetworkserviceorder`. */
export interface RsNetworkService {
  readonly name: string;
  readonly hardwarePort: string | null;
  readonly device: string | null;
  /** Listed with `(*)`: switched off in System Settings. */
  readonly enabled: boolean;
}

/**
 * The network service order, read without root, and the command that would
 * put Wi‑Fi first. The app never runs that command: it shows it, and copies it
 * on request, for the user to run in Terminal.
 */
export interface RsServiceOrder {
  readonly services: readonly RsNetworkService[];
  /** The service of the Wi‑Fi adapter; null when there is none. */
  readonly wifiService: string | null;
  /** Wi‑Fi is already the first enabled service, i.e. the default channel. */
  readonly wifiFirst: boolean;
  /** `sudo networksetup -ordernetworkservices …` with every name shell-quoted; null without a Wi‑Fi service. */
  readonly command: string | null;
}

/** A UI language: `uz`, `ru` or `en` (the shared `Language` enum). */
export type RsLanguage = Language;

/** Device overrides of the roles (`Config.ifaceOverrides`): a role without one is detected automatically. */
export type RsIfaceOverrides = Partial<Record<IfaceRole, string>>;

/**
 * Why a call did not produce a value.
 *
 * The helper's own codes (`ErrorCode`, e.g. `invalid-config` when the helper —
 * or the main process before sending — refuses the resulting config), plus:
 * - `not-connected`  — there is no connection to the helper; nothing was sent
 *                      (see `RsSnapshot.connection` for why);
 * - `disconnected`   — the connection was lost while the call was waiting;
 * - `timeout`        — the helper did not answer in time;
 * - `busy`           — too many calls are waiting for the helper;
 * - `unspecified`    — the helper refused without giving a code;
 * - `invalid-input`  — the arguments of the call were refused; nothing was sent;
 * - `rule-not-found` — `deleteRule` / `toggleRule` named a rule the config does not hold;
 * - `forbidden`      — the call did not come from the app's own page;
 * - `file-unreadable`, `file-not-regular`, `file-too-large`, `file-not-text`,
 *   `file-not-json` — `importConfig`: the chosen file is not a readable regular
 *   file of at most 1 MiB of UTF-8 JSON (a schema refusal is `invalid-config`,
 *   with `issue`); nothing was sent;
 * - `import-expired` — `applyImport`: the token is unknown, used or older than
 *   10 minutes (choose the file again); nothing was sent;
 * - `write-failed`   — `exportConfig`: the file could not be written; the chosen
 *   path is left as it was; `deleteBackup`: the backup could not be removed;
 * - `no-backup`      — `restoreBackup`: the app holds no rules backup; nothing was sent;
 * - `install-unavailable` — `installHelper` / `removeHelper`: the app holds no
 *   usable helper package (not packaged, a file missing, a symbolic link, or
 *   writable by another user); nothing was run;
 * - `install-cancelled` — the user closed the password dialog; nothing was run;
 * - `install-denied`    — the system refused the authorization; nothing was run;
 * - `install-failed`    — the script ran as root and failed (`detail` holds its
 *   error line), or could not be started.
 *
 * For a call that changes something (`saveRule`, `deleteRule`, `toggleRule`,
 * `setEnabled`, `apply`), `disconnected` and `timeout` mean the outcome is
 * unknown: the helper may have applied it. The state and config that arrive
 * after the reconnect are what holds.
 */
export type RsErrorCode =
  | ErrorCode
  | 'not-connected'
  | 'disconnected'
  | 'timeout'
  | 'busy'
  | 'unspecified'
  | 'invalid-input'
  | 'rule-not-found'
  | 'forbidden'
  | 'file-unreadable'
  | 'file-not-regular'
  | 'file-too-large'
  | 'file-not-text'
  | 'file-not-json'
  | 'import-expired'
  | 'write-failed'
  | 'no-backup'
  | 'install-unavailable'
  | 'install-cancelled'
  | 'install-denied'
  | 'install-failed';

/**
 * Where a refused import file breaks the config schema: the first issue.
 * `path` holds array indexes and the schema's own field names only (anything
 * else is `?`); `code` is the shared validation code (`default-route`,
 * `iface-conflict`, …) when there is one, otherwise zod's (`invalid_type`, …).
 */
export interface RsConfigIssue {
  readonly path: readonly (string | number)[];
  readonly code: string | null;
}

/** A config file read and accepted by `importConfig`, waiting for the user's confirmation. */
export interface RsImportPreview {
  /** Hand back to `applyImport` to store exactly this config. One use, 10 minutes. */
  readonly token: string;
  /** The config as the shared schema parsed it (normalised). It replaces the stored one as a whole. */
  readonly config: Config;
}

/**
 * The app's copy of the last config it saw (`userData/rules-backup.json`,
 * TASK-DELTA-16), as the page may know it: no rule, only how many.
 */
export interface RsBackupInfo {
  /** When the app wrote it (ISO, UTC). */
  readonly savedAt: string;
  readonly ruleCount: number;
  /** The user turned down the restore offer for exactly this backup (a newer backup is offered again). */
  readonly dismissed: boolean;
}

/** A config written by `exportConfig`. */
export interface RsExportResult {
  readonly rules: number;
  readonly bytes: number;
}

/** What `installHelper` / `removeHelper` give back: the outcome arrives as a new connection in `onState`. */
export type RsHelperSetupResult = null;

/**
 * Every call settles with one of these and never rejects. `error` is a short English sentence for the log, not for display.
 * `detail` (only with `install-failed`) is the script's own error line, one line of at most 300 characters, shown as is.
 */
export type RsResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: RsErrorCode;
      readonly error: string;
      readonly issue?: RsConfigIssue;
      readonly detail?: string;
    };

/**
 * How the main process resolved a name no enabled domain rule covers (the
 * helper answered `name-not-covered`): the system resolver, with the user's
 * rights (`dns.lookup`, IPv4 only, 3 s).
 * - `ok`        — it gave addresses (some may be `excluded`);
 * - `not-found` — the name does not exist or has no IPv4 address;
 * - `timeout`   — no answer within 3 s;
 * - `failed`    — the lookup failed otherwise.
 */
export type RsLookupOutcome = 'ok' | 'not-found' | 'timeout' | 'failed';

/** One address of a resolved name and the helper's `diagnose` of it; `code` when that call failed. */
export type RsDiagnosedAddress =
  | { readonly address: string; readonly ok: true; readonly result: DiagnoseResult }
  | { readonly address: string; readonly ok: false; readonly code: RsErrorCode };

/** The app's own lookup of a name the helper does not resolve. */
export interface RsNameLookup {
  readonly outcome: RsLookupOutcome;
  /** At most 8, in the resolver's order, each diagnosed one after the other. */
  readonly addresses: readonly RsDiagnosedAddress[];
  /** The resolver gave more routable addresses than 8; the rest were not diagnosed. */
  readonly truncated: boolean;
  /** Addresses that are never routed (loopback, link-local, …) and were left out. */
  readonly excluded: number;
}

/**
 * What `diagnose` returns: the helper's answer for the target as asked and,
 * only when the helper did not resolve the name (`name-not-covered`), the
 * app's lookup of it with an answer per address.
 */
export interface RsDiagnosis {
  readonly result: DiagnoseResult;
  readonly lookup: RsNameLookup | null;
}

/** Removes the subscription it was returned for. Calling it again does nothing. */
export type RsUnsubscribe = () => void;

export interface RsApi {
  /** The current connection and engine state, from the main process's memory (no helper round trip). */
  getState(): Promise<RsResult<RsSnapshot>>;
  /** The stored config, read from the helper. */
  getConfig(): Promise<RsResult<Config>>;
  /** Adds the rule, or replaces the rule with the same `id`. The value is the config as stored and the state after it was applied. */
  saveRule(rule: RuleInput): Promise<RsResult<SetConfigResult>>;
  deleteRule(id: string): Promise<RsResult<SetConfigResult>>;
  toggleRule(id: string, enabled: boolean): Promise<RsResult<SetConfigResult>>;
  /** The global toggle. Off removes every route and resolver file the helper applied. */
  setEnabled(on: boolean): Promise<RsResult<StateResult>>;
  /** Re-applies every rule with fresh interface data. */
  apply(): Promise<RsResult<StateResult>>;
  /** Which interface the system would use for one IPv4 address (`route -n get`). Read-only. */
  test(target: string): Promise<RsResult<TestResult>>;
  /**
   * Explains how traffic to a host or IPv4 address leaves the machine
   * (read-only): the matching rule and why, the kernel's route for each
   * address against the rule's interface, the rule's DNS server and whether it
   * answers. `target` is a bare IPv4 address or domain, as `diagnose` takes it
   * (the page strips a URL down to its host first). A name no enabled domain
   * rule covers is resolved by the main process with the user's rights and
   * each address diagnosed. `busy` while another diagnosis runs.
   */
  diagnose(target: string): Promise<RsResult<RsDiagnosis>>;
  /**
   * Asks the user for a config file (system dialog of the main process), reads
   * and checks it with the shared `Config` schema, and returns it for a
   * confirmation; nothing is sent to the helper. Null when the dialog was
   * cancelled. The page never learns the path. `busy` while a file dialog is open.
   */
  importConfig(): Promise<RsResult<RsImportPreview | null>>;
  /**
   * Replaces the stored config with the one `importConfig` returned for
   * `token` (`setConfig`, queued with the other changes). The token is used up
   * either way.
   */
  applyImport(token: string): Promise<RsResult<SetConfigResult>>;
  /**
   * Writes the stored config (`getConfig`) to a JSON file the user chooses in
   * the system save dialog; atomically, and nowhere else. Null when cancelled.
   */
  exportConfig(): Promise<RsResult<RsExportResult | null>>;
  /**
   * Calls `listener` with a new snapshot whenever the connection or the engine
   * state changes. Nothing is replayed: subscribe first, then call `getState`.
   */
  onState(listener: (snapshot: RsSnapshot) => void): RsUnsubscribe;
  /**
   * The journal: the last 500 entries of this run, oldest first — `log` events
   * of the helper and the app's own events about the helper connection. Kept by
   * the main process, so it includes events from before the window was opened.
   */
  getLog(): Promise<RsResult<readonly RsLogEntry[]>>;
  /**
   * Calls `listener` with every new journal entry. Nothing is replayed:
   * subscribe first, then call `getLog`, and drop entries whose `seq` the
   * history already holds.
   */
  onLog(listener: (entry: RsLogEntry) => void): RsUnsubscribe;
  /** The app's own settings. */
  getSettings(): Promise<RsResult<RsSettings>>;
  /** Adds or removes the app as a login item; the value is the setting read back afterwards. */
  setOpenAtLogin(on: boolean): Promise<RsResult<RsSettings>>;
  /**
   * Replaces `Config.ifaceOverrides` (getConfig -> change -> setConfig, like a rule edit).
   * `{}` removes every override; a device must be an `en*` name.
   */
  setIfaceOverrides(overrides: RsIfaceOverrides): Promise<RsResult<SetConfigResult>>;
  /** The current network service order and the Wi‑Fi-first command. Read-only (`operation-failed` when it cannot be read). */
  getServiceOrder(): Promise<RsResult<RsServiceOrder>>;
  /**
   * Puts the Wi‑Fi-first command on the clipboard. The main process builds it
   * from a fresh read; the page passes no text. Nothing is run.
   */
  copyServiceOrderCommand(): Promise<RsResult<RsServiceOrder>>;
  /**
   * Asks the helper to remove every route and resolver file it applied, and
   * itself (`uninstall`). On success the helper exits and the connection
   * becomes `not-installed`. `disconnected` / `timeout` mean the outcome is unknown.
   */
  uninstallHelper(): Promise<RsResult<UninstallResult>>;
  /**
   * Opens the rules window, or brings the open one to the front ("Qoidalarni
   * boshqarish" of the menu bar window). Main process only: nothing is sent to
   * the helper. The value is null. With `intent` (checked with the shared
   * `RulesWindowIntent`; anything else is `invalid-input` and nothing opens),
   * the main process keeps it for the rules window — a minute at most, the
   * last one wins — and tells that window through `onRulesIntent`; the window
   * takes it with `takeRulesIntent` (TASK-DELTA-21).
   */
  openRulesWindow(intent?: RsRulesIntent): Promise<RsResult<null>>;
  /**
   * The intent waiting for the rules window, once: it is gone after this call.
   * Null when there is none (or it is older than a minute). Answered to the
   * rules window only (`forbidden` elsewhere).
   */
  takeRulesIntent(): Promise<RsResult<RsRulesIntent | null>>;
  /**
   * Calls `listener` when an intent is waiting (sent to the rules window only;
   * no value — take it with `takeRulesIntent`). Subscribe first, then take
   * once for one that arrived before.
   */
  onRulesIntent(listener: () => void): RsUnsubscribe;
  /**
   * Tries to connect to the helper now instead of waiting for the next
   * automatic attempt ("Qayta ulanish"). The value is null; the outcome
   * arrives as a new connection in `onState`. Does nothing while connected.
   */
  reconnectHelper(): Promise<RsResult<null>>;
  /**
   * Replaces a stored config the helper cannot load with an empty one
   * (`setConfig` of `{version: 1, enabled: true, rules: []}`), queued with
   * the other changes. Refused (`operation-failed`, nothing sent) unless the
   * connection is `config-unreadable`.
   */
  resetConfig(): Promise<RsResult<SetConfigResult>>;
  /**
   * Installs the helper, or reinstalls it (`incompatible`): the system asks
   * for the administrator password once and runs the app's own
   * `install-helper.sh` as root. The page passes nothing. On success the main
   * process reconnects at once (`reconnectNow`). `busy` while an install or
   * removal runs.
   */
  installHelper(): Promise<RsResult<RsHelperSetupResult>>;
  /**
   * Removes the helper completely (`uninstall.sh` as root, after the
   * administrator password): routes and resolver files, the daemon, its
   * files, config and log. `install-unavailable` when the app holds no
   * `uninstall.sh`; then `uninstallHelper` is the way (files stay).
   */
  removeHelper(): Promise<RsResult<RsHelperSetupResult>>;
  /**
   * The UI language (`uz`, `ru`, `en`), kept by the main process in
   * `userData/preferences.json`; on a first start, from the system's
   * preferred languages.
   */
  getLanguage(): Promise<RsResult<RsLanguage>>;
  /**
   * Sets and stores the UI language; every open window hears of it through
   * `onLanguage`. The value is the language now in force (it holds for this
   * run even when the file could not be written; that is logged).
   */
  setLanguage(language: RsLanguage): Promise<RsResult<RsLanguage>>;
  /**
   * Calls `listener` with every new language. Nothing is replayed: subscribe
   * first, then call `getLanguage`.
   */
  onLanguage(listener: (language: RsLanguage) => void): RsUnsubscribe;
  /** The rules backup the app keeps (TASK-DELTA-16); null when there is none. Works without the helper. */
  getBackup(): Promise<RsResult<RsBackupInfo | null>>;
  /**
   * Reads the backup for a restore: like `importConfig` without the dialog —
   * the config (checked again with the shared schema) and a one-use token for
   * `applyImport`, 10 minutes. Nothing reaches the helper before
   * `applyImport`. `no-backup` when there is none.
   */
  restoreBackup(): Promise<RsResult<RsImportPreview>>;
  /** Removes the backup. `write-failed` when the file could not be removed. */
  deleteBackup(): Promise<RsResult<null>>;
  /** Turns down the restore offer for the current backup (kept in the preferences). Nothing is removed. */
  dismissBackup(): Promise<RsResult<null>>;
}

/** Channel -> arguments and value of the call behind it. Main and preload are typed against this table. */
export interface RsInvokeChannels {
  'rs:getState': { readonly args: readonly []; readonly value: RsSnapshot };
  'rs:getConfig': { readonly args: readonly []; readonly value: Config };
  'rs:saveRule': { readonly args: readonly [rule: RuleInput]; readonly value: SetConfigResult };
  'rs:deleteRule': { readonly args: readonly [id: string]; readonly value: SetConfigResult };
  'rs:toggleRule': { readonly args: readonly [id: string, enabled: boolean]; readonly value: SetConfigResult };
  'rs:setEnabled': { readonly args: readonly [on: boolean]; readonly value: StateResult };
  'rs:apply': { readonly args: readonly []; readonly value: StateResult };
  'rs:test': { readonly args: readonly [target: string]; readonly value: TestResult };
  'rs:diagnose': { readonly args: readonly [target: string]; readonly value: RsDiagnosis };
  'rs:import': { readonly args: readonly []; readonly value: RsImportPreview | null };
  'rs:applyImport': { readonly args: readonly [token: string]; readonly value: SetConfigResult };
  'rs:export': { readonly args: readonly []; readonly value: RsExportResult | null };
  'rs:getLog': { readonly args: readonly []; readonly value: readonly RsLogEntry[] };
  'rs:getSettings': { readonly args: readonly []; readonly value: RsSettings };
  'rs:setOpenAtLogin': { readonly args: readonly [on: boolean]; readonly value: RsSettings };
  'rs:setIfaceOverrides': { readonly args: readonly [overrides: RsIfaceOverrides]; readonly value: SetConfigResult };
  'rs:getServiceOrder': { readonly args: readonly []; readonly value: RsServiceOrder };
  'rs:copyServiceOrderCommand': { readonly args: readonly []; readonly value: RsServiceOrder };
  'rs:uninstall': { readonly args: readonly []; readonly value: UninstallResult };
  'rs:openRulesWindow': { readonly args: readonly [] | readonly [intent: RsRulesIntent]; readonly value: null };
  'rs:takeRulesIntent': { readonly args: readonly []; readonly value: RsRulesIntent | null };
  'rs:reconnect': { readonly args: readonly []; readonly value: null };
  'rs:resetConfig': { readonly args: readonly []; readonly value: SetConfigResult };
  'rs:installHelper': { readonly args: readonly []; readonly value: RsHelperSetupResult };
  'rs:removeHelper': { readonly args: readonly []; readonly value: RsHelperSetupResult };
  'rs:getLanguage': { readonly args: readonly []; readonly value: RsLanguage };
  'rs:setLanguage': { readonly args: readonly [language: RsLanguage]; readonly value: RsLanguage };
  'rs:getBackup': { readonly args: readonly []; readonly value: RsBackupInfo | null };
  'rs:restoreBackup': { readonly args: readonly []; readonly value: RsImportPreview };
  'rs:deleteBackup': { readonly args: readonly []; readonly value: null };
  'rs:dismissBackup': { readonly args: readonly []; readonly value: null };
}

export type RsInvokeChannel = keyof RsInvokeChannels;

/** The channel the main process sends every new `RsSnapshot` on. */
export type RsStateChannel = 'rs:state';

/** The channel the main process sends every new journal entry on. */
export type RsLogChannel = 'rs:log';

/** The channel the main process sends every new UI language on. */
export type RsLanguageChannel = 'rs:language';

/** The channel that tells the rules window an intent is waiting (`takeRulesIntent`). No value. */
export type RsRulesIntentChannel = 'rs:rulesIntent';

/** What the rules window is opened for: a section, or a DNS warning's add-rule offer (shared `RulesWindowIntent`). */
export type RsRulesIntent = RulesWindowIntent;

declare global {
  interface Window {
    readonly rs: RsApi;
  }
}
