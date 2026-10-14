// The renderer's whole view of the system: `window.rs`, exposed by the preload
// (`src/preload/index.ts`) and answered by the main process (`src/main/ipc.ts`).
// Types only — the renderer imports nothing else from outside the page, and the
// main process and the preload type their side of the channels against this.

import type {
  Config,
  EngineState,
  ErrorCode,
  RuleInput,
  SetConfigResult,
  StateResult,
  TestResult,
} from '@routeswitch/shared';

/**
 * The app's connection to the helper, as the main process sees it.
 * - `connecting`    — a (re)connect is under way;
 * - `connected`     — requests can be made, `state` is present;
 * - `not-installed` — there is no helper socket: the helper was never installed (or was removed);
 * - `disconnected`  — installed, but there is no connection right now (`reason` says why);
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
 * - `forbidden`      — the call did not come from the app's own page.
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
  | 'forbidden';

/** Every call settles with one of these and never rejects. `error` is a short English sentence for the log, not for display. */
export type RsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RsErrorCode; readonly error: string };

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
  /** Not available yet: always fails with `not-implemented` until TASK-215 adds it. */
  importConfig(): Promise<RsResult<never>>;
  /** Not available yet: always fails with `not-implemented` until TASK-215 adds it. */
  exportConfig(): Promise<RsResult<never>>;
  /**
   * Calls `listener` with a new snapshot whenever the connection or the engine
   * state changes. Nothing is replayed: subscribe first, then call `getState`.
   */
  onState(listener: (snapshot: RsSnapshot) => void): RsUnsubscribe;
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
  'rs:import': { readonly args: readonly []; readonly value: never };
  'rs:export': { readonly args: readonly []; readonly value: never };
}

export type RsInvokeChannel = keyof RsInvokeChannels;

/** The one channel the main process sends on: every new `RsSnapshot`. */
export type RsStateChannel = 'rs:state';

declare global {
  interface Window {
    readonly rs: RsApi;
  }
}
