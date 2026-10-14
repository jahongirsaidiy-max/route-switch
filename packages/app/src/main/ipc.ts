// The main-process side of `window.rs`: one `ipcMain.handle` per method of the
// renderer API (`src/renderer/src/rs.d.ts`) and the `rs:state` push.
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
  describeIssues,
  findStructureViolation,
  Rule,
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
  RsLogChannel,
  RsResult,
  RsSnapshot,
  RsStateChannel,
} from '../renderer/src/rs';
import type { HelperClient, HelperStatus } from './helperClient';
import { createLogBuffer, type LogBuffer } from './logBuffer';
import type { Logger } from './logger';
import { isAllowedNavigation } from './security';
import type { Settings } from './settings';

// `RsConnection` is the renderer's copy of `HelperStatus`; this line fails to
// compile as soon as the two drift apart.
const toConnection = (status: HelperStatus): RsConnection => status;

export const STATE_CHANNEL: RsStateChannel = 'rs:state';
export const LOG_CHANNEL: RsLogChannel = 'rs:log';

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
  'rs:import',
  'rs:export',
  'rs:getLog',
  'rs:getSettings',
  'rs:setOpenAtLogin',
  'rs:setIfaceOverrides',
  'rs:getServiceOrder',
  'rs:copyServiceOrderCommand',
  'rs:uninstall',
] as const satisfies readonly RsInvokeChannel[];

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
  readonly helperClient: Pick<HelperClient, 'request' | 'snapshot' | 'onStatus' | 'onState' | 'onLog'>;
  /** The app's page (`Runtime.entryUrl`): the only document whose calls are answered. */
  readonly entryUrl: string;
  readonly logger: Logger;
  /** The renderers to send `rs:state` and `rs:log` to. Each is sent to only while it shows the app's page. */
  readonly listRecipients: () => readonly StateRecipient[];
  /** Where the helper's `log` events are kept for the journal; a new 500-entry buffer by default. */
  readonly logBuffer?: LogBuffer;
  /** The login item and the network service order (settings screen). */
  readonly settings: Settings;
}

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
const RuleArgument: Schema<Rule> = Rule;
/** Device overrides per role: only `ethernet` / `wifi` keys, each an `en*` name. Required (no `undefined`). */
const IfaceOverrides: Schema<RsIfaceOverrides> = ConfigSchema.shape.ifaceOverrides.unwrap();

const ARGUMENTS = {
  'rs:getState': argumentsOf(),
  'rs:getConfig': argumentsOf(),
  'rs:saveRule': argumentsOf(RuleArgument),
  'rs:deleteRule': argumentsOf(RuleId),
  'rs:toggleRule': argumentsOf(RuleId, Flag),
  'rs:setEnabled': argumentsOf(Flag),
  'rs:apply': argumentsOf(),
  'rs:test': argumentsOf(TestTarget),
  'rs:import': argumentsOf(),
  'rs:export': argumentsOf(),
  'rs:getLog': argumentsOf(),
  'rs:getSettings': argumentsOf(),
  'rs:setOpenAtLogin': argumentsOf(Flag),
  'rs:setIfaceOverrides': argumentsOf(IfaceOverrides),
  'rs:getServiceOrder': argumentsOf(),
  'rs:copyServiceOrderCommand': argumentsOf(),
  'rs:uninstall': argumentsOf(),
} as const satisfies Readonly<Record<RsInvokeChannel, ArgsParser<readonly unknown[]>>>;

type ParsedArgs<C extends RsInvokeChannel> = (typeof ARGUMENTS)[C] extends ArgsParser<infer A> ? A : never;

type Handlers = { readonly [C in RsInvokeChannel]: (args: ParsedArgs<C>) => Promise<RsResult<RsInvokeChannels[C]['value']>> };

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
  const { ipcMain, helperClient, entryUrl, settings } = deps;
  const logger = deps.logger.child({ component: 'ipc' });
  // Everything below can be triggered by the page at will, so each kind of
  // line has its own rate-limit budget.
  const senderLog = logger.limited('ipc-untrusted-sender');
  const inputLog = logger.limited('ipc-invalid-input');
  const failureLog = logger.limited('ipc-call-failed');
  const changeLog = logger.limited('ipc-change');
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
    // TASK-215 replaces these two: import and export go through a dialog of
    // the main process. Until then the methods exist and say so.
    'rs:import': () => Promise.resolve(failure('not-implemented', 'Importing a config is not available yet (TASK-215)')),
    'rs:export': () => Promise.resolve(failure('not-implemented', 'Exporting the config is not available yet (TASK-215)')),
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
  const PUSHED: Readonly<Record<RsStateChannel | RsLogChannel, string>> = {
    'rs:state': 'the state',
    'rs:log': 'a journal entry',
  };
  const broadcast = (channel: RsStateChannel | RsLogChannel, payload: unknown): void => {
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

  const unsubscribes = [
    helperClient.onStatus(push),
    helperClient.onState(push),
    // Every `log` event of the helper goes into the journal, and from there to the open windows.
    helperClient.onLog((event) => {
      logBuffer.push(event);
    }),
    logBuffer.subscribe((entry) => {
      broadcast(LOG_CHANNEL, entry);
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
