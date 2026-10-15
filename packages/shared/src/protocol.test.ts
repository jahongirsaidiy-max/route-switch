import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { MAX_LINE_BYTES, createJsonLinesDecoder, encodeJsonLine, type JsonLineErrorCode } from './jsonl';
import {
  DIAGNOSE_ADDRESS_SOURCES,
  DIAGNOSE_DNS_OUTCOMES,
  DIAGNOSE_MATCH_VIA,
  DIAGNOSE_NOTES,
  DIAGNOSE_PRECEDENCE_CODES,
  DIAGNOSE_TARGET_KINDS,
  DNS_WARNING_CODES,
  DNS_WARNING_SOURCES,
  DiagnoseResult,
  DnsWarning,
  ERROR_CODES,
  EVENT_LOG_LEVELS,
  EngineState,
  ErrorResponse,
  Event,
  HelperVersionInfo,
  InterfaceState,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  RECONCILE_REASONS,
  REQUEST_METHODS,
  RESULT_SCHEMAS,
  RULE_REASON_CODES,
  RULE_STATUSES,
  Request,
  RequestId,
  Response,
  RuleState,
  STRUCTURE_LIMITS,
  TestResult,
  describeIssues,
  diagnoseTargetKind,
  errorResponse,
  findStructureViolation,
  normalizeDiagnoseTarget,
  parseRequest,
  parseResult,
  parseServerMessage,
  type ErrorCode,
  type OkResponseOf,
  type ParamsInputOf,
  type ParamsOf,
  type RequestMethod,
  type RequestOf,
  type ResultOf,
} from './protocol';
import { LIMITS, type Config, type ConfigInput } from './schema';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AT = '2026-10-12T08:30:00.000Z';

const configInput = (): ConfigInput => ({
  version: 1,
  rules: [
    { id: uuid(1), kind: 'subnet', target: '10.1.2.3/8', iface: 'ethernet', note: 'Internal network' },
    { id: uuid(2), kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10' },
    { id: uuid(3), kind: 'ip', target: '172.16.12.40', iface: 'wifi', enabled: false },
  ],
});

const stateInput = (): Record<string, unknown> => ({
  helperVersion: '0.1.0',
  seq: 7,
  configRevision: 2,
  enabled: true,
  interfaces: {
    ethernet: { device: 'en5', ip: '10.20.4.17', gateway: '10.20.4.1', up: true },
    wifi: { device: 'en0', ip: '192.168.1.23', gateway: '192.168.1.1', up: true },
  },
  adapters: [
    { device: 'en0', port: 'Wi-Fi', ip: '192.168.1.23' },
    { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.17' },
    { device: 'en7', port: 'Thunderbolt Ethernet', ip: null },
  ],
  rules: [
    {
      ruleId: uuid(1),
      status: 'active',
      reasonCode: null,
      reason: null,
      appliedDestinations: ['10.0.0.0/8'],
      lastResolvedAt: null,
    },
    {
      ruleId: uuid(2),
      status: 'error',
      reasonCode: 'resolve-failed',
      reason: 'DNS query for corp.local timed out',
      appliedDestinations: ['10.30.0.5', '10.30.0.6', '10.20.0.10'],
      lastResolvedAt: AT,
    },
    {
      ruleId: uuid(3),
      status: 'disabled',
      reasonCode: 'rule-disabled',
      reason: null,
      appliedDestinations: [],
      lastResolvedAt: null,
    },
  ],
  lastApplyAt: AT,
  lastReconcileReason: 'network-change',
});

const ruleStateInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ruleId: uuid(1),
  status: 'active',
  reasonCode: null,
  reason: null,
  appliedDestinations: [],
  lastResolvedAt: null,
  ...overrides,
});

const withState = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...stateInput(), ...overrides });

const testResultInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  target: '172.16.12.40',
  destination: '10.0.0.0',
  gateway: '10.20.4.1',
  device: 'en5',
  role: 'ethernet',
  ruleId: uuid(1),
  ...overrides,
});

const dnsWarningInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  server: '192.168.1.53',
  source: 'interface',
  role: 'ethernet',
  via: 'wifi',
  code: 'other-interface-subnet',
  ...overrides,
});

const diagnoseAddressInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: '10.30.0.5',
  source: 'rule-cache',
  route: { device: 'en5', gateway: '10.20.4.1', role: 'ethernet' },
  expectedRole: 'ethernet',
  matchesExpected: true,
  ...overrides,
});

const diagnoseResultInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  target: 'corp.local',
  targetKind: 'domain',
  match: { ruleId: uuid(2), via: 'domain', precedence: 'only-match' },
  addresses: [diagnoseAddressInput(), diagnoseAddressInput({ address: '10.30.0.6', source: 'query' })],
  dns: { server: '10.20.0.10', role: 'ethernet', resolverFile: '/etc/resolver/corp.local', outcome: 'ok', ms: 12 },
  notes: [],
  ...overrides,
});

/** A valid result for every method, as the helper would send it. */
const RESULT_INPUTS: Record<RequestMethod, Record<string, unknown>> = {
  status: { protocolVersion: PROTOCOL_VERSION, helperVersion: '0.1.0', state: stateInput() },
  getConfig: { config: configInput(), configRevision: 3 },
  setConfig: { config: configInput(), state: stateInput() },
  apply: { state: stateInput() },
  setEnabled: { state: stateInput() },
  test: testResultInput(),
  uninstall: {},
  diagnose: diagnoseResultInput(),
};

/** A valid request for every method, as the app would send it. */
const REQUEST_INPUTS: Record<RequestMethod, Record<string, unknown>> = {
  status: { id: 1, method: 'status' },
  getConfig: { id: 2, method: 'getConfig' },
  setConfig: { id: 3, method: 'setConfig', config: configInput() },
  apply: { id: 4, method: 'apply' },
  setEnabled: { id: 5, method: 'setEnabled', enabled: false },
  test: { id: 6, method: 'test', target: '172.16.12.40' },
  uninstall: { id: 7, method: 'uninstall' },
  diagnose: { id: 8, method: 'diagnose', target: 'corp.local' },
};

const errorOf = (result: { ok: true } | { ok: false; error: { code: ErrorCode; id: number | null } }): string =>
  result.ok ? 'ok' : `${result.error.code}#${String(result.error.id)}`;

describe('constants', () => {
  it('has exactly the eight methods and nothing that runs a command', () => {
    expect(REQUEST_METHODS).toEqual([
      'status',
      'getConfig',
      'setConfig',
      'apply',
      'setEnabled',
      'test',
      'uninstall',
      'diagnose',
    ]);
    expect(Request.options.map((option) => option.shape.method.value)).toEqual([...REQUEST_METHODS]);
    expect(Object.keys(RESULT_SCHEMAS)).toEqual([...REQUEST_METHODS]);
  });

  it('pins the protocol version and the closed enumerations', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(RULE_STATUSES).toEqual(['active', 'pending', 'error', 'disabled']);
    expect(EVENT_LOG_LEVELS).toEqual(['info', 'warn', 'error']);
    expect(ERROR_CODES).toEqual([
      'invalid-json',
      'line-too-long',
      'invalid-request',
      'unknown-method',
      'invalid-config',
      'operation-failed',
      'not-implemented',
      'internal',
      'invalid-response',
      'rate-limited',
      'busy',
    ]);
    expect(RECONCILE_REASONS).toEqual([
      'startup',
      'config-change',
      'enabled-change',
      'manual',
      'network-change',
      'dns-refresh',
      'drift-check',
    ]);
    expect(RULE_REASON_CODES).toEqual([
      'rule-disabled',
      'globally-disabled',
      'interface-down',
      'no-gateway',
      'resolving',
      'resolve-failed',
      'no-addresses',
      'forbidden-destination',
      'connected-network',
      'route-failed',
      'resolver-conflict',
      'resolver-failed',
      'internal',
      'addresses-truncated',
      'overridden-by-rule',
      'dns-server-excluded',
    ]);
    expect(DNS_WARNING_CODES).toEqual(['other-interface-subnet', 'routed-via-other-interface']);
    expect(DNS_WARNING_SOURCES).toEqual(['interface', 'rule']);
    expect(DIAGNOSE_TARGET_KINDS).toEqual(['ip', 'domain']);
    expect(DIAGNOSE_MATCH_VIA).toEqual(['ip', 'subnet', 'domain', 'wildcard', 'dns-server']);
    expect(DIAGNOSE_PRECEDENCE_CODES).toEqual([
      'only-match',
      'host-route',
      'domain-address',
      'longest-prefix',
      'exact-domain',
      'deeper-wildcard',
      'config-order',
    ]);
    expect(DIAGNOSE_ADDRESS_SOURCES).toEqual(['rule-cache', 'query']);
    expect(DIAGNOSE_DNS_OUTCOMES).toEqual(['ok', 'timeout', 'refused', 'error', 'not-queried']);
    expect(DIAGNOSE_NOTES).toEqual([
      'name-not-covered',
      'no-matching-rule',
      'rule-disabled',
      'globally-disabled',
      'interface-down',
      'no-gateway',
      'not-applied',
      'route-mismatch',
      'connected-network',
      'dns-server-excluded',
      'no-addresses',
      'resolve-failed',
      'addresses-truncated',
    ]);
    expect(PROTOCOL_LIMITS.maxDnsWarnings).toBe(16);
    expect(PROTOCOL_LIMITS.maxDiagnoseAddresses).toBe(LIMITS.maxIpsPerDomain);
    expect(STRUCTURE_LIMITS).toEqual({ maxNodes: 65_536, maxArrayLength: 500, maxDepth: 12, maxStringLength: 4096 });
    expect(PROTOCOL_LIMITS.maxAppliedDestinationsPerRule).toBe(LIMITS.maxIpsPerDomain + 1);
  });

  it('keeps the codec error codes inside the protocol error codes', () => {
    expectTypeOf<JsonLineErrorCode>().toExtend<ErrorCode>();
  });
});

describe('RequestId', () => {
  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])('accepts %s', (id) => {
    expect(RequestId.safeParse(id).success).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, true])(
    'rejects %s',
    (id) => {
      expect(RequestId.safeParse(id).success).toBe(false);
    },
  );
});

describe('Request', () => {
  it.each(REQUEST_METHODS)('accepts %s', (method) => {
    const result = parseRequest(REQUEST_INPUTS[method]);
    expect(result.ok && result.value.method).toBe(method);
    expect(Request.safeParse(REQUEST_INPUTS[method]).success).toBe(true);
  });

  it.each(REQUEST_METHODS)('rejects %s with an extra top-level key', (method) => {
    const request = { ...REQUEST_INPUTS[method], extra: true };
    expect(errorOf(parseRequest(request))).toBe(`invalid-request#${String(REQUEST_INPUTS[method]['id'])}`);
    expect(Request.safeParse(request).success).toBe(false);
  });

  it('never repeats client text in a refusal', () => {
    const hostile = 'EVIL\n\u001b[31mroot';
    const requests: unknown[] = [
      { id: 1, method: 'status', [hostile]: 1 },
      { id: 1, method: hostile },
      { id: 1, method: 'test', target: hostile },
      { id: 1, method: 'diagnose', target: hostile },
      { id: 1, method: 'diagnose', target: hostile, extra: hostile },
      { id: 1, method: 'setEnabled', enabled: hostile },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [], ifaceOverrides: { [hostile]: 'en5' } } },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [], ifaceOverrides: { ethernet: hostile } } },
      { id: 1, method: 'setConfig', config: { version: hostile, rules: [] } },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [{ [hostile]: hostile }] } },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [{ id: uuid(1), kind: 'domain', target: hostile, iface: 'wifi' }] } },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [{ id: hostile, kind: hostile, target: '10.0.0.1', iface: hostile }] } },
      { id: 1, method: 'setConfig', config: { [hostile]: 1 }, [hostile]: 2 },
      { id: 1, method: 'setConfig', config: { version: 1, rules: [{ note: hostile.repeat(2000) }] } },
      { id: 1, method: 'status', [hostile.repeat(1000)]: 1 },
      { [hostile]: hostile },
    ];
    for (const request of requests) {
      const result = parseRequest(request);
      const message = result.ok ? 'accepted' : result.error.message;
      expect(message).not.toBe('accepted');
      expect(message).toMatch(/^[A-Za-z0-9 .:()+?-]+$/);
      expect(message).not.toMatch(/EVIL|root|\[31m/);
      expect(message.length).toBeLessThanOrEqual(200);
    }
  });

  it('describes a refusal with known field names, indexes and fixed text only', () => {
    const message = (request: unknown): string => {
      const result = parseRequest(request);
      return result.ok ? 'accepted' : result.error.message;
    };
    expect(message({ id: 1, method: 'status', extra: 1 })).toBe('Message: has an unknown key');
    expect(message({ id: 1, method: 'setEnabled', enabled: 'yes' })).toBe('enabled: has the wrong type');
    expect(message({ id: 1, method: 'test', target: '127.0.0.1' })).toBe('target: is invalid (loopback)');
    expect(message({ id: 1, method: 'diagnose', target: '127.0.0.1' })).toBe('target: is invalid (loopback)');
    expect(message({ id: 1, method: 'diagnose', target: '*.corp.local' })).toBe('target: is invalid (invalid-domain)');
    expect(message({ id: 1, method: 'setConfig', config: { version: 1, rules: [], ifaceOverrides: { vpn: 'en5' } } })).toBe(
      'config.ifaceOverrides: has an unknown key',
    );
    const duplicate = { id: uuid(1), kind: 'ip', target: '10.0.0.1', iface: 'wifi' };
    expect(message({ id: 1, method: 'setConfig', config: { version: 1, rules: [duplicate, duplicate] } })).toBe(
      'config.rules.1.id: is invalid (duplicate-id)',
    );
  });

  it('normalises the config of setConfig and applies its defaults', () => {
    const result = parseRequest(REQUEST_INPUTS.setConfig);
    if (!result.ok || result.value.method !== 'setConfig') throw new Error('expected a setConfig request');
    const { config } = result.value;
    expect(config.enabled).toBe(true);
    expect(config.rules.map((rule) => rule.target)).toEqual(['10.0.0.0/8', 'corp.local', '172.16.12.40']);
    expect(config.rules.map((rule) => rule.enabled)).toEqual([true, true, false]);
    expect(config.rules[0]?.refreshSec).toBe(LIMITS.refreshSecDefault);
  });

  it('keeps the parsed test target as the validator returned it', () => {
    const result = parseRequest({ id: 0, method: 'test', target: '192.168.1.1' });
    expect(result).toEqual({ ok: true, value: { id: 0, method: 'test', target: '192.168.1.1' } });
  });

  it.each([
    ['a domain', 'corp.local'],
    ['a subnet', '10.0.0.0/8'],
    ['an IPv6 address', '::1'],
    ['loopback', '127.0.0.1'],
    ['the unspecified address', '0.0.0.0'],
    ['a link-local address', '169.254.1.1'],
    ['multicast', '224.0.0.251'],
    ['broadcast', '255.255.255.255'],
    ['an octal octet', '010.1.1.1'],
    ['a padded address', ' 10.0.0.1'],
    ['a path', '../etc'],
    ['an option', '-ifscope'],
    ['an empty string', ''],
    ['a long string', '1'.repeat(300)],
    ['a number', 167772161],
    ['null', null],
  ])('rejects a test target that is %s', (_name, target) => {
    expect(errorOf(parseRequest({ id: 6, method: 'test', target }))).toBe('invalid-request#6');
  });

  it.each([
    ['an address', '172.16.12.40'],
    ['a domain', 'corp.local'],
    ['a single-label name', 'intranet'],
    ['a long domain', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`],
  ])('accepts a diagnose target that is %s, unchanged', (_name, target) => {
    expect(parseRequest({ id: 8, method: 'diagnose', target })).toEqual({
      ok: true,
      value: { id: 8, method: 'diagnose', target },
    });
  });

  it.each([
    ['loopback', '127.0.0.1', 'loopback'],
    ['the unspecified address', '0.0.0.0', 'default-route'],
    ['a this-network address', '0.1.2.3', 'this-network'],
    ['a link-local address', '169.254.1.1', 'link-local'],
    ['multicast', '224.0.0.251', 'multicast'],
    ['broadcast', '255.255.255.255', 'broadcast'],
    ['an octal octet', '010.1.1.1', 'invalid-ipv4'],
    ['three octets', '10.1.1', 'invalid-ipv4'],
    ['an octet out of range', '256.1.1.1', 'invalid-ipv4'],
    ['a subnet', '10.0.0.0/8', 'invalid-domain'],
    ['an IP wildcard', '10.*.*.*', 'invalid-domain'],
    ['a domain wildcard', '*.corp.local', 'invalid-domain'],
    ['a bare *', '*', 'invalid-domain'],
    ['upper case', 'Corp.Local', 'invalid-domain'],
    ['a URL', 'https://corp.local/x', 'invalid-domain'],
    ['a host with a port', 'corp.local:443', 'invalid-domain'],
    ['a path', '../etc', 'invalid-domain'],
    ['an option', '-ifscope', 'invalid-domain'],
    ['a padded name', ' corp.local', 'invalid-domain'],
    ['a trailing dot', 'corp.local.', 'invalid-domain'],
    ['an IPv6 address', '::1', 'invalid-domain'],
    ['an empty string', '', 'invalid-domain'],
  ])('rejects a diagnose target that is %s (%s)', (_name, target, code) => {
    expect(errorOf(parseRequest({ id: 8, method: 'diagnose', target }))).toBe('invalid-request#8');
    const result = normalizeDiagnoseTarget(target);
    expect(result.ok ? null : result.error.code).toBe(code);
  });

  it.each([
    ['a name longer than 253 characters', `${'a.'.repeat(126)}ab`],
    ['a number', 167772161],
    ['null', null],
    ['an array', ['corp.local']],
  ])('rejects a diagnose target that is %s', (_name, target) => {
    expect(errorOf(parseRequest({ id: 8, method: 'diagnose', target }))).toBe('invalid-request#8');
  });

  it.each([
    ['without a target', { id: 8, method: 'diagnose' }],
    ['with an extra key', { id: 8, method: 'diagnose', target: 'corp.local', resolve: true }],
    ['with a server to ask', { id: 8, method: 'diagnose', target: 'corp.local', dns: '10.20.0.10' }],
  ])('rejects a diagnose request %s', (_name, request) => {
    expect(errorOf(parseRequest(request))).toBe('invalid-request#8');
  });

  it('tells an address from a domain', () => {
    expect(diagnoseTargetKind('10.0.0.1')).toBe('ip');
    expect(diagnoseTargetKind('10.1.1')).toBe('ip');
    expect(diagnoseTargetKind('corp.local')).toBe('domain');
    expect(diagnoseTargetKind('1st.example.org')).toBe('domain');
  });

  it.each([
    ['exec', { id: 1, method: 'exec', command: '/bin/sh', args: ['-c', 'id'] }],
    ['run', { id: 1, method: 'run' }],
    ['eval', { id: 1, method: 'eval', code: '1' }],
    ['a method in another case', { id: 1, method: 'Status' }],
    ['a padded method', { id: 1, method: 'status ' }],
    ['an empty method', { id: 1, method: '' }],
    ['an inherited property name', { id: 1, method: 'constructor' }],
    ['__proto__', { id: 1, method: '__proto__' }],
  ])('rejects the unknown method %s', (_name, request) => {
    const result = parseRequest(request);
    expect(errorOf(result)).toBe('unknown-method#1');
    expect(result.ok ? '' : result.error.message).toBe('Unknown method');
    expect(Request.safeParse(request).success).toBe(false);
  });

  it.each([
    ['no method', { id: 1 }, 'invalid-request#1'],
    ['a method that is not a string', { id: 1, method: 7 }, 'invalid-request#1'],
    ['a method that is an array', { id: 1, method: ['status'] }, 'invalid-request#1'],
    ['no id', { method: 'status' }, 'invalid-request#null'],
    ['a string id', { id: '1', method: 'status' }, 'invalid-request#null'],
    ['a negative id', { id: -1, method: 'status' }, 'invalid-request#null'],
    ['a fractional id', { id: 1.5, method: 'status' }, 'invalid-request#null'],
    ['an unsafe id', { id: 2 ** 53, method: 'status' }, 'invalid-request#null'],
    ['a null id', { id: null, method: 'status' }, 'invalid-request#null'],
    ['an extra key', { id: 1, method: 'status', command: 'id' }, 'invalid-request#1'],
    ['parameters of another method', { id: 1, method: 'apply', enabled: true }, 'invalid-request#1'],
    ['setEnabled without enabled', { id: 1, method: 'setEnabled' }, 'invalid-request#1'],
    ['setEnabled with a string', { id: 1, method: 'setEnabled', enabled: 'true' }, 'invalid-request#1'],
    ['setEnabled with a number', { id: 1, method: 'setEnabled', enabled: 1 }, 'invalid-request#1'],
    ['test without target', { id: 1, method: 'test' }, 'invalid-request#1'],
    ['setConfig without config', { id: 1, method: 'setConfig' }, 'invalid-config#1'],
    ['setConfig with an extra key', { id: 1, method: 'setConfig', config: configInput(), path: '/etc' }, 'invalid-request#1'],
  ])('rejects a request with %s', (_name, request, expected) => {
    expect(errorOf(parseRequest(request))).toBe(expected);
    expect(Request.safeParse(request).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'status'],
    ['a number', 1],
    ['an array', [{ id: 1, method: 'status' }]],
    ['undefined', undefined],
    ['a boolean', true],
  ])('rejects %s as a request', (_name, value) => {
    const result = parseRequest(value);
    expect(errorOf(result)).toBe('invalid-request#null');
  });

  it.each([
    ['a forbidden subnet', { version: 1, rules: [{ id: uuid(1), kind: 'subnet', target: '0.0.0.0/0', iface: 'wifi' }] }],
    ['a too wide subnet', { version: 1, rules: [{ id: uuid(1), kind: 'subnet', target: '0.0.0.0/1', iface: 'wifi' }] }],
    ['a traversal domain', { version: 1, rules: [{ id: uuid(1), kind: 'domain', target: '../etc', iface: 'wifi' }] }],
    ['an unknown version', { version: 2, rules: [] }],
    ['a config that is not an object', 'config'],
    [
      'a duplicate rule id',
      {
        version: 1,
        rules: [
          { id: uuid(1), kind: 'ip', target: '10.0.0.1', iface: 'wifi' },
          { id: uuid(1), kind: 'ip', target: '10.0.0.2', iface: 'wifi' },
        ],
      },
    ],
  ])('rejects setConfig with %s as invalid-config', (_name, config) => {
    const result = parseRequest({ id: 9, method: 'setConfig', config });
    expect(errorOf(result)).toBe('invalid-config#9');
  });

  it('says where a config is wrong without exceeding the message limit', () => {
    const rules = Array.from({ length: 3 }, (_unused, index) => ({
      id: uuid(index + 1),
      kind: 'subnet',
      target: '10.0.0.0/33',
      iface: 'ethernet',
    }));
    const result = parseRequest({ id: 9, method: 'setConfig', config: { version: 1, rules } });
    const message = result.ok ? '' : result.error.message;
    expect(message).toMatch(/^config\.rules\.0\.target: .+ \(\+2 more\)$/);
    expect(message.length).toBeLessThanOrEqual(PROTOCOL_LIMITS.errorMessageMaxLength);
  });

  it('rejects more rules than the limit', () => {
    const rules = Array.from({ length: LIMITS.maxRules + 1 }, (_unused, index) => ({
      id: uuid(index + 1),
      kind: 'ip',
      target: '10.0.0.1',
      iface: 'ethernet',
    }));
    expect(errorOf(parseRequest({ id: 1, method: 'setConfig', config: { version: 1, rules } }))).toBe(
      'invalid-config#1',
    );
  });

  it('exposes typed parameters per method', () => {
    expectTypeOf<ParamsOf<'status'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<ParamsOf<'uninstall'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<ResultOf<'uninstall'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<ParamsOf<'setEnabled'>>().toEqualTypeOf<{ enabled: boolean }>();
    expectTypeOf<ParamsOf<'test'>>().toEqualTypeOf<{ target: string }>();
    expectTypeOf<ParamsOf<'diagnose'>>().toEqualTypeOf<{ target: string }>();
    expectTypeOf<ResultOf<'diagnose'>>().toEqualTypeOf<DiagnoseResult>();
    expectTypeOf<ParamsOf<'setConfig'>>().toEqualTypeOf<{ config: Config }>();
    expectTypeOf<ParamsInputOf<'setConfig'>>().toEqualTypeOf<{ config: ConfigInput }>();
    expectTypeOf<RequestOf<'apply'>>().toEqualTypeOf<{ id: number; method: 'apply' }>();
  });
});

describe('EngineState', () => {
  it('accepts a full state and keeps it unchanged', () => {
    const result = EngineState.safeParse(stateInput());
    expect(result.success && result.data).toEqual(stateInput());
  });

  it('accepts the state of a helper that has not reconciled yet', () => {
    const down = { device: null, ip: null, gateway: null, up: false };
    const result = EngineState.safeParse({
      helperVersion: '0.1.0-beta.1',
      seq: 0,
      configRevision: 0,
      enabled: false,
      interfaces: { ethernet: down, wifi: down },
      adapters: [],
      rules: [],
      lastApplyAt: null,
      lastReconcileReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('drops unknown keys from a newer helper', () => {
    const result = EngineState.safeParse(withState({ uptimeSec: 12 }));
    expect(result.success && 'uptimeSec' in result.data).toBe(false);
  });

  it('accepts the largest counters', () => {
    const result = EngineState.safeParse(
      withState({ seq: Number.MAX_SAFE_INTEGER, configRevision: Number.MAX_SAFE_INTEGER }),
    );
    expect(result.success && [result.data.seq, result.data.configRevision]).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it.each(RECONCILE_REASONS)('accepts the reconcile reason %s', (reason) => {
    expect(EngineState.safeParse(withState({ lastReconcileReason: reason })).success).toBe(true);
  });

  it.each([
    ['no helper version', { helperVersion: undefined }],
    ['a helper version that is not a version', { helperVersion: 'latest' }],
    ['a helper version with a newline', { helperVersion: '0.1.0\n' }],
    ['enabled as a string', { enabled: 'yes' }],
    ['no seq', { seq: undefined }],
    ['a negative seq', { seq: -1 }],
    ['a fractional seq', { seq: 1.5 }],
    ['an unsafe seq', { seq: 2 ** 53 }],
    ['a string seq', { seq: '7' }],
    ['no config revision', { configRevision: undefined }],
    ['a negative config revision', { configRevision: -1 }],
    ['a string config revision', { configRevision: '2' }],
    ['a timestamp without milliseconds', { lastApplyAt: '2026-10-12T08:30:00Z' }],
    ['a timestamp with microseconds', { lastApplyAt: '2026-10-12T08:30:00.000000Z' }],
    ['a timestamp with thousands of fractional digits', { lastApplyAt: `2026-10-12T08:30:00.${'0'.repeat(3000)}Z` }],
    ['a timestamp with an offset', { lastApplyAt: '2026-10-12T08:30:00.000+05:00' }],
    [
      'the same adapter twice',
      {
        adapters: [
          { device: 'en0', port: 'Wi-Fi', ip: null },
          { device: 'en0', port: 'Ethernet', ip: null },
        ],
      },
    ],
    ['an adapter with an overlong device name', { adapters: [{ device: `en${'1'.repeat(15)}`, port: 'Ethernet', ip: null }] }],
    ['a missing role', { interfaces: { ethernet: { device: null, ip: null, gateway: null, up: false } } }],
    ['interfaces as an array', { interfaces: [] }],
    ['an unknown reconcile reason', { lastReconcileReason: 'because' }],
    ['a timestamp without a zone', { lastApplyAt: '2026-10-12T08:30:00' }],
    ['a numeric timestamp', { lastApplyAt: 1_791_793_800_000 }],
    ['a date-only timestamp', { lastApplyAt: '2026-10-12' }],
    ['rules that are not an array', { rules: {} }],
    ['an adapter that is not en*', { adapters: [{ device: 'utun3', port: 'VPN', ip: null }] }],
    ['an adapter without a port name', { adapters: [{ device: 'en0', port: '', ip: null }] }],
    [
      'a duplicate rule id',
      { rules: [ruleStateInput(), ruleStateInput({ status: 'disabled', reasonCode: 'rule-disabled' })] },
    ],
    [
      'a duplicate rule id in another case',
      {
        rules: [
          ruleStateInput({ ruleId: '00000000-0000-4000-8000-00000000000a' }),
          ruleStateInput({ ruleId: '00000000-0000-4000-8000-00000000000A' }),
        ],
      },
    ],
  ])('rejects a state with %s', (_name, overrides) => {
    expect(EngineState.safeParse(withState(overrides)).success).toBe(false);
  });

  it('is bounded: more rules or adapters than the limits are rejected', () => {
    const rules = Array.from({ length: LIMITS.maxRules + 1 }, (_unused, index) =>
      ruleStateInput({ ruleId: uuid(index + 1) }),
    );
    expect(EngineState.safeParse(withState({ rules: rules.slice(0, LIMITS.maxRules) })).success).toBe(true);
    expect(EngineState.safeParse(withState({ rules })).success).toBe(false);

    const adapters = Array.from({ length: PROTOCOL_LIMITS.maxAdapters + 1 }, (_unused, index) => ({
      device: `en${String(index)}`,
      port: 'Ethernet',
      ip: null,
    }));
    expect(EngineState.safeParse(withState({ adapters: adapters.slice(0, PROTOCOL_LIMITS.maxAdapters) })).success).toBe(
      true,
    );
    expect(EngineState.safeParse(withState({ adapters })).success).toBe(false);
  });
});

describe('EngineState.dnsWarnings', () => {
  it('is optional: a state without it is still valid', () => {
    const result = EngineState.safeParse(stateInput());
    expect(result.success && result.data.dnsWarnings).toBeUndefined();
  });

  it('accepts warnings from an interface and from a rule', () => {
    const dnsWarnings = [
      dnsWarningInput(),
      dnsWarningInput({ server: '10.20.0.10', source: 'rule', role: 'ethernet', via: null, ruleId: uuid(2), code: 'routed-via-other-interface' }),
      dnsWarningInput({ server: '10.20.4.53', role: 'wifi', via: 'ethernet' }),
    ];
    const result = EngineState.safeParse(withState({ dnsWarnings }));
    expect(result.success && result.data.dnsWarnings).toEqual(dnsWarnings);
  });

  it('accepts up to the limit and no more', () => {
    const warnings = (count: number) =>
      Array.from({ length: count }, (_unused, index) => dnsWarningInput({ server: `192.168.1.${String(index + 1)}` }));
    expect(EngineState.safeParse(withState({ dnsWarnings: warnings(PROTOCOL_LIMITS.maxDnsWarnings) })).success).toBe(true);
    expect(EngineState.safeParse(withState({ dnsWarnings: warnings(PROTOCOL_LIMITS.maxDnsWarnings + 1) })).success).toBe(false);
  });

  it.each([
    ['a rule warning without ruleId', dnsWarningInput({ source: 'rule' })],
    ['an interface warning with a ruleId', dnsWarningInput({ ruleId: uuid(1) })],
    ['a warning reached through its own role', dnsWarningInput({ via: 'ethernet' })],
    ['an unknown code', dnsWarningInput({ code: 'slow' })],
    ['an unknown source', dnsWarningInput({ source: 'dhcp' })],
    ['a role that is a device', dnsWarningInput({ role: 'en5' })],
    ['a server that is a name', dnsWarningInput({ server: 'dns.corp.local' })],
    ['a server with a prefix', dnsWarningInput({ server: '10.0.0.1/32' })],
    ['a ruleId that is not a UUID', dnsWarningInput({ source: 'rule', ruleId: 'first' })],
    ['no via', { server: '192.168.1.53', source: 'interface', role: 'ethernet', code: 'other-interface-subnet' }],
  ])('rejects %s', (_name, warning) => {
    expect(DnsWarning.safeParse(warning).success).toBe(false);
    expect(EngineState.safeParse(withState({ dnsWarnings: [warning] })).success).toBe(false);
  });

  it('rejects dnsWarnings that is not an array', () => {
    expect(EngineState.safeParse(withState({ dnsWarnings: dnsWarningInput() })).success).toBe(false);
    expect(EngineState.safeParse(withState({ dnsWarnings: null })).success).toBe(false);
  });
});

describe('InterfaceState', () => {
  it('accepts a link-local address on an interface and normalises nothing away', () => {
    const input = { device: 'en5', ip: '169.254.10.20', gateway: null, up: true };
    const result = InterfaceState.safeParse(input);
    expect(result.success && result.data).toEqual(input);
  });

  it.each([
    ['a device that is not en*', { device: 'utun3' }],
    ['a device with a path', { device: '../en0' }],
    ['an upper-case device', { device: 'EN5' }],
    ['an IPv6 address', { ip: 'fe80::1' }],
    ['an address with a prefix', { ip: '10.20.4.17/24' }],
    ['a gateway that is not an address', { gateway: 'link#12' }],
    ['up as a number', { up: 1 }],
    ['a missing gateway', { gateway: undefined }],
    ['a device name longer than 16 characters', { device: `en${'1'.repeat(15)}` }],
    ['up without a device', { device: null }],
    ['up without an ip', { ip: null }],
  ])('rejects %s', (_name, overrides) => {
    const input = { device: 'en5', ip: '10.20.4.17', gateway: '10.20.4.1', up: true, ...overrides };
    expect(InterfaceState.safeParse(input).success).toBe(false);
  });

  it('says which field an interface that is up lacks', () => {
    const result = InterfaceState.safeParse({ device: null, ip: null, gateway: null, up: true });
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['device', 'ip']);
  });

  it.each([
    ['up without a gateway', { device: 'en5', ip: '10.20.4.17', gateway: null, up: true }],
    ['down with a device and no ip', { device: 'en5', ip: null, gateway: null, up: false }],
    ['down with everything known', { device: 'en5', ip: '10.20.4.17', gateway: '10.20.4.1', up: false }],
    ['a 16-character device name', { device: `en${'1'.repeat(14)}`, ip: null, gateway: null, up: false }],
  ])('accepts an interface that is %s', (_name, input) => {
    expect(InterfaceState.safeParse(input).success).toBe(true);
  });
});

describe('RuleState', () => {
  it.each(RULE_STATUSES)('accepts the status %s with a reason code', (status) => {
    expect(RuleState.safeParse(ruleStateInput({ status, reasonCode: 'internal' })).success).toBe(true);
  });

  it.each(RULE_REASON_CODES)('accepts the reason code %s', (reasonCode) => {
    expect(RuleState.safeParse(ruleStateInput({ status: 'error', reasonCode })).success).toBe(true);
  });

  it('lets only an active rule go without a reason code', () => {
    expect(RuleState.safeParse(ruleStateInput({ status: 'active', reasonCode: null })).success).toBe(true);
    for (const status of ['pending', 'error', 'disabled']) {
      const result = RuleState.safeParse(ruleStateInput({ status, reasonCode: null }));
      expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['reasonCode']);
    }
  });

  it('normalises applied destinations', () => {
    const result = RuleState.safeParse(ruleStateInput({ appliedDestinations: ['10.1.2.3/8', '172.16.12.40'] }));
    expect(result.success && result.data.appliedDestinations).toEqual(['10.0.0.0/8', '172.16.12.40']);
  });

  it.each([
    ['an unknown status', { status: 'ok' }],
    ['an unknown reason code', { status: 'error', reasonCode: 'oops' }],
    ['a rule id that is not a uuid', { ruleId: 'rule-1' }],
    ['a reason that is too long', { reason: 'x'.repeat(PROTOCOL_LIMITS.reasonMaxLength + 1) }],
    ['a missing reason', { reason: undefined }],
    ['the default route as applied', { appliedDestinations: ['0.0.0.0/0'] }],
    ['the default keyword as applied', { appliedDestinations: ['default'] }],
    ['loopback as applied', { appliedDestinations: ['127.0.0.1'] }],
    ['a too wide subnet as applied', { appliedDestinations: ['128.0.0.0/1'] }],
    ['a domain as applied', { appliedDestinations: ['corp.local'] }],
    ['an IPv6 address as applied', { appliedDestinations: ['::1'] }],
    [
      'too many applied destinations',
      {
        appliedDestinations: Array.from(
          { length: PROTOCOL_LIMITS.maxAppliedDestinationsPerRule + 1 },
          (_unused, index) => `10.0.0.${String(index + 1)}`,
        ),
      },
    ],
    ['a resolve time that is not a timestamp', { lastResolvedAt: 'yesterday' }],
  ])('rejects %s', (_name, overrides) => {
    expect(RuleState.safeParse(ruleStateInput(overrides)).success).toBe(false);
  });

  it('accepts the maximum number of applied destinations', () => {
    const appliedDestinations = Array.from(
      { length: PROTOCOL_LIMITS.maxAppliedDestinationsPerRule },
      (_unused, index) => `10.0.0.${String(index + 1)}`,
    );
    expect(RuleState.safeParse(ruleStateInput({ appliedDestinations })).success).toBe(true);
  });
});

describe('results', () => {
  it.each(REQUEST_METHODS)('accepts the result of %s', (method) => {
    expect(parseResult(method, RESULT_INPUTS[method]).ok).toBe(true);
  });

  it('returns the status result typed and parsed', () => {
    const result = parseResult('status', RESULT_INPUTS.status);
    if (!result.ok) throw new Error(result.error.message);
    expectTypeOf(result.value).toEqualTypeOf<ResultOf<'status'>>();
    expect(result.value.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.value.state.interfaces.ethernet.device).toBe('en5');
  });

  it('normalises the config of a getConfig result', () => {
    const result = parseResult('getConfig', RESULT_INPUTS.getConfig);
    expect(result.ok && result.value.config.rules[0]?.target).toBe('10.0.0.0/8');
    expect(result.ok && result.value.configRevision).toBe(3);
  });

  it('refuses a getConfig result without configRevision', () => {
    expect(parseResult('getConfig', { config: configInput() }).ok).toBe(false);
  });

  it.each([
    ['status', { protocolVersion: 1, helperVersion: '0.1.0' }],
    ['status', { protocolVersion: 0, helperVersion: '0.1.0', state: stateInput() }],
    ['status', { protocolVersion: '1', helperVersion: '0.1.0', state: stateInput() }],
    ['getConfig', {}],
    ['getConfig', { config: configInput(), configRevision: -1 }],
    ['getConfig', { config: configInput(), configRevision: 1.5 }],
    ['getConfig', { config: { version: 1, rules: [{ id: uuid(1), kind: 'ip', target: '127.0.0.1', iface: 'wifi' }] } }],
    ['setConfig', { config: configInput() }],
    ['apply', {}],
    ['setEnabled', { state: withState({ enabled: 'no' }) }],
    ['test', testResultInput({ device: 'en5; rm' })],
    ['test', testResultInput({ device: null })],
    ['test', testResultInput({ role: 'vpn' })],
    ['test', testResultInput({ gateway: 'link#12' })],
    ['test', testResultInput({ destination: '' })],
    ['test', testResultInput({ target: '127.0.0.1' })],
    ['test', testResultInput({ ruleId: 'first' })],
    ['uninstall', null],
    ['uninstall', 'done'],
    ['diagnose', diagnoseResultInput({ target: '127.0.0.1', targetKind: 'ip' })],
    ['diagnose', diagnoseResultInput({ target: '*.corp.local' })],
    ['diagnose', diagnoseResultInput({ targetKind: 'ip' })],
    ['diagnose', diagnoseResultInput({ targetKind: 'host' })],
    ['diagnose', diagnoseResultInput({ match: { ruleId: uuid(2), via: 'regex', precedence: 'only-match' } })],
    ['diagnose', diagnoseResultInput({ match: { ruleId: uuid(2), via: 'domain', precedence: 'luck' } })],
    ['diagnose', diagnoseResultInput({ match: { ruleId: 'first', via: 'domain', precedence: 'only-match' } })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput({ address: 'corp.local' })] })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput({ source: 'guess' })] })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput({ route: { device: 'en5; rm', gateway: null, role: null } })] })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput({ expectedRole: 'vpn' })] })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput({ matchesExpected: 'yes' })] })],
    ['diagnose', diagnoseResultInput({ addresses: [diagnoseAddressInput(), diagnoseAddressInput()] })],
    [
      'diagnose',
      diagnoseResultInput({
        addresses: Array.from({ length: LIMITS.maxIpsPerDomain + 1 }, (_unused, index) =>
          diagnoseAddressInput({ address: `10.30.0.${String(index + 1)}` }),
        ),
      }),
    ],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: '/etc/passwd', outcome: 'ok', ms: 1 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: '/etc/resolver/../passwd', outcome: 'ok', ms: 1 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: '/etc/resolver/', outcome: 'ok', ms: 1 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: null, outcome: 'maybe', ms: 1 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: null, outcome: 'ok', ms: -1 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: null, outcome: 'ok', ms: 60_001 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: '10.20.0.10', role: null, resolverFile: null, outcome: 'ok', ms: 1.5 } })],
    ['diagnose', diagnoseResultInput({ dns: { server: 'dns.corp.local', role: null, resolverFile: null, outcome: 'ok', ms: 1 } })],
    ['diagnose', diagnoseResultInput({ notes: ['no-matching-rule', 'no-matching-rule'] })],
    ['diagnose', diagnoseResultInput({ notes: ['all-good'] })],
    ['diagnose', diagnoseResultInput({ notes: undefined })],
  ] as const)('rejects a malformed %s result', (method, result) => {
    const parsed = parseResult(method, result);
    expect(errorOf(parsed)).toBe('invalid-response#null');
  });

  it('accepts a diagnose result for an address no rule covers', () => {
    const result = parseResult(
      'diagnose',
      diagnoseResultInput({
        target: '172.16.12.40',
        targetKind: 'ip',
        match: null,
        addresses: [
          diagnoseAddressInput({
            address: '172.16.12.40',
            source: 'query',
            route: { device: 'utun3', gateway: null, role: null },
            expectedRole: null,
            matchesExpected: null,
          }),
        ],
        dns: null,
        notes: ['no-matching-rule'],
      }),
    );
    expect(result.ok && result.value.notes).toEqual(['no-matching-rule']);
  });

  it('accepts a diagnose result for a name the helper did not resolve', () => {
    const result = parseResult(
      'diagnose',
      diagnoseResultInput({ target: 'example.com', match: null, addresses: [], dns: null, notes: ['name-not-covered'] }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts every note, outcome and precedence code once', () => {
    const result = DiagnoseResult.safeParse(
      diagnoseResultInput({
        notes: [...DIAGNOSE_NOTES],
        addresses: Array.from({ length: LIMITS.maxIpsPerDomain }, (_unused, index) =>
          diagnoseAddressInput({ address: `10.30.0.${String(index + 1)}`, route: null, matchesExpected: null }),
        ),
      }),
    );
    expect(result.success).toBe(true);
    for (const outcome of DIAGNOSE_DNS_OUTCOMES) {
      const dns = { server: '10.20.0.10', role: 'wifi', resolverFile: null, outcome, ms: outcome === 'not-queried' ? null : 3000 };
      expect(DiagnoseResult.safeParse(diagnoseResultInput({ dns })).success).toBe(true);
    }
    for (const precedence of DIAGNOSE_PRECEDENCE_CODES) {
      for (const via of DIAGNOSE_MATCH_VIA) {
        const match = { ruleId: uuid(1), via, precedence };
        expect(DiagnoseResult.safeParse(diagnoseResultInput({ match })).success).toBe(true);
      }
    }
  });

  it('drops unknown keys of a diagnose result from a newer helper', () => {
    const result = DiagnoseResult.safeParse({ ...diagnoseResultInput(), hint: 'new' });
    expect(result.success && result.data).not.toHaveProperty('hint');
  });

  it('accepts a test result for a route that belongs to no rule and no role', () => {
    const result = TestResult.safeParse(
      testResultInput({ destination: 'default', device: 'utun3', gateway: null, role: null, ruleId: null }),
    );
    expect(result.success).toBe(true);
  });

  it('reads the versions of a status result even when the rest is unknown', () => {
    const result = HelperVersionInfo.safeParse({ protocolVersion: 2, helperVersion: '0.2.0', state: { shape: 'new' } });
    expect(result.success && result.data).toEqual({ protocolVersion: 2, helperVersion: '0.2.0' });
    expect(parseResult('status', { protocolVersion: 2, helperVersion: '0.2.0', state: { shape: 'new' } }).ok).toBe(
      false,
    );
  });

  it('types the response the helper builds', () => {
    const response = { id: 1, ok: true, result: {} } satisfies OkResponseOf<'uninstall'>;
    expect(Response.safeParse(response).success).toBe(true);
    expectTypeOf<ResultOf<'apply'>>().toEqualTypeOf<{ state: EngineState }>();
    expectTypeOf<ResultOf<'getConfig'>>().toEqualTypeOf<{ config: Config; configRevision: number }>();
  });
});

describe('Response', () => {
  it.each(REQUEST_METHODS)('round-trips the response of %s through the codec', (method) => {
    const response = { id: 11, ok: true, result: RESULT_INPUTS[method] };
    const [line] = createJsonLinesDecoder().push(encodeJsonLine(response));
    const message = parseServerMessage(line?.ok === true ? line.value : undefined);
    expect(message).toEqual({ ok: true, value: { kind: 'response', response } });
    const result = message.ok && message.value.kind === 'response' && message.value.response.ok;
    expect(result).toBe(true);
  });

  it('round-trips an error response with and without a code', () => {
    const withCode = errorResponse(4, 'invalid-config', 'config.rules.0.target: Must be an IPv4 subnet');
    expect(withCode).toEqual({
      id: 4,
      ok: false,
      error: 'config.rules.0.target: Must be an IPv4 subnet',
      code: 'invalid-config',
    });
    expect(parseServerMessage(JSON.parse(encodeJsonLine(withCode)))).toEqual({
      ok: true,
      value: { kind: 'response', response: withCode },
    });

    const documented = { id: 4, ok: false, error: 'boom' };
    expect(parseServerMessage(documented)).toEqual({ ok: true, value: { kind: 'response', response: documented } });
  });

  it('allows a null id only on an error response', () => {
    expect(Response.safeParse(errorResponse(null, 'invalid-json', 'Line is not valid JSON')).success).toBe(true);
    expect(Response.safeParse({ id: null, ok: true, result: {} }).success).toBe(false);
  });

  it.each(ERROR_CODES)('accepts the error code %s', (code) => {
    expect(ErrorResponse.safeParse({ id: 1, ok: false, error: 'failed', code }).success).toBe(true);
  });

  it('truncates a long error message and never sends an empty one', () => {
    const long = errorResponse(1, 'internal', 'x'.repeat(PROTOCOL_LIMITS.errorMessageMaxLength + 500));
    expect(long.error).toHaveLength(PROTOCOL_LIMITS.errorMessageMaxLength);
    expect(long.error.endsWith('…')).toBe(true);
    expect(Response.safeParse(long).success).toBe(true);

    const exact = errorResponse(1, 'internal', 'x'.repeat(PROTOCOL_LIMITS.errorMessageMaxLength));
    expect(exact.error).toBe('x'.repeat(PROTOCOL_LIMITS.errorMessageMaxLength));

    expect(errorResponse(1, 'internal', '').error).toBe('internal');
  });

  it.each([
    ['no id', { ok: true, result: {} }, null],
    ['no ok', { id: 1, result: {} }, 1],
    ['ok as a string', { id: 1, ok: 'true', result: {} }, 1],
    ['no result', { id: 1, ok: true }, 1],
    ['a null result', { id: 1, ok: true, result: null }, 1],
    ['a result that is not an object', { id: 1, ok: true, result: 'done' }, 1],
    ['an array result', { id: 1, ok: true, result: [] }, 1],
    ['no error message', { id: 1, ok: false }, 1],
    ['an empty error message', { id: 1, ok: false, error: '' }, 1],
    ['an error that is not a string', { id: 1, ok: false, error: { message: 'x' } }, 1],
    ['an oversized error message', { id: 1, ok: false, error: 'x'.repeat(2001) }, 1],
    ['an unknown error code', { id: 1, ok: false, error: 'x', code: 'weird' }, 1],
    ['a negative id', { id: -1, ok: false, error: 'x' }, null],
    ['a request', { id: 1, method: 'status' }, 1],
  ])('rejects a response with %s', (_name, value, id) => {
    const result = parseServerMessage(value);
    expect(errorOf(result)).toBe(`invalid-response#${String(id)}`);
    expect(Response.safeParse(value).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an array', []],
    ['a number', 3],
  ])('rejects %s as a server message', (_name, value) => {
    expect(errorOf(parseServerMessage(value))).toBe('invalid-response#null');
  });
});

describe('Event', () => {
  it('round-trips a state event through the codec', () => {
    const event = { event: 'state', state: stateInput() };
    const [line] = createJsonLinesDecoder().push(encodeJsonLine(event));
    expect(parseServerMessage(line?.ok === true ? line.value : undefined)).toEqual({
      ok: true,
      value: { kind: 'event', event },
    });
  });

  it.each(EVENT_LOG_LEVELS)('round-trips a %s log event through the codec', (level) => {
    const event = { event: 'log', level, msg: 'Ethernet gateway changed to 10.20.4.1', at: AT };
    const [line] = createJsonLinesDecoder().push(encodeJsonLine(event));
    expect(parseServerMessage(line?.ok === true ? line.value : undefined)).toEqual({
      ok: true,
      value: { kind: 'event', event },
    });
  });

  it.each([
    ['an unknown event', { event: 'exec', command: 'id' }],
    ['a debug log', { event: 'log', level: 'debug', msg: 'tick', at: AT }],
    ['a log without a time', { event: 'log', level: 'info', msg: 'tick' }],
    ['a log with a local time', { event: 'log', level: 'info', msg: 'tick', at: '12.10.2026 08:30' }],
    ['a log without a message', { event: 'log', level: 'info', at: AT }],
    [
      'a log with an oversized message',
      { event: 'log', level: 'info', msg: 'x'.repeat(PROTOCOL_LIMITS.logMessageMaxLength + 1), at: AT },
    ],
    ['a state event without a state', { event: 'state' }],
    [
      'a state event with a broken state',
      { event: 'state', state: withState({ rules: [ruleStateInput({ status: 'x' })] }) },
    ],
    ['an event that is not a string', { event: 1 }],
    ['an event that also looks like a response', { event: 'nope', id: 1, ok: true, result: {} }],
  ])('rejects %s', (_name, value) => {
    expect(errorOf(parseServerMessage(value))).toBe('invalid-response#null');
    expect(Event.safeParse(value).success).toBe(false);
  });
});

describe('message sizes', () => {
  const escaped = (length: number): string => '\u0001'.repeat(length);
  const longDomain = (n: number): string => {
    const label = 'a'.repeat(63);
    const head = n.toString(36).padStart(8, '0');
    return `${head}.${label}.${label}.${label}.${'a'.repeat(52)}`;
  };

  const countValues = (value: unknown): number => {
    if (typeof value !== 'object' || value === null) return 1;
    return Object.values(value).reduce<number>((sum, child) => sum + countValues(child), 1);
  };

  const largestConfig = (): Record<string, unknown> => ({
    version: 1,
    enabled: true,
    ifaceOverrides: { ethernet: `en${'1'.repeat(14)}`, wifi: `en${'2'.repeat(14)}` },
    rules: Array.from({ length: LIMITS.maxRules }, (_unused, index) => ({
      id: uuid(index + 1),
      enabled: true,
      kind: 'domain',
      target: longDomain(index),
      iface: 'ethernet',
      dns: '255.255.255.254',
      refreshSec: LIMITS.refreshSecMax,
      note: escaped(LIMITS.noteMaxLength),
    })),
  });

  const largestState = (): Record<string, unknown> => ({
    helperVersion: `1.2.3-${'a'.repeat(PROTOCOL_LIMITS.helperVersionMaxLength - 6)}`,
    seq: Number.MAX_SAFE_INTEGER,
    configRevision: Number.MAX_SAFE_INTEGER,
    enabled: true,
    interfaces: {
      ethernet: { device: `en${'1'.repeat(14)}`, ip: '255.255.255.254', gateway: '255.255.255.254', up: true },
      wifi: { device: `en${'2'.repeat(14)}`, ip: '255.255.255.254', gateway: '255.255.255.254', up: true },
    },
    adapters: Array.from({ length: PROTOCOL_LIMITS.maxAdapters }, (_unused, index) => ({
      device: `en${String(10_000_000_000_000 + index)}`,
      port: escaped(PROTOCOL_LIMITS.adapterPortMaxLength),
      ip: '255.255.255.254',
    })),
    rules: Array.from({ length: LIMITS.maxRules }, (_unused, index) => ({
      ruleId: uuid(index + 1),
      status: 'error',
      reasonCode: 'forbidden-destination',
      reason: escaped(PROTOCOL_LIMITS.reasonMaxLength),
      appliedDestinations: Array.from(
        { length: PROTOCOL_LIMITS.maxAppliedDestinationsPerRule },
        (_inner, octet) => `255.255.255.${String(100 + octet)}/32`,
      ),
      lastResolvedAt: AT,
    })),
    lastApplyAt: AT,
    lastReconcileReason: 'network-change',
    dnsWarnings: Array.from({ length: PROTOCOL_LIMITS.maxDnsWarnings }, (_unused, index) => ({
      server: `255.255.255.${String(200 + index)}`,
      source: 'rule',
      role: 'ethernet',
      via: 'wifi',
      ruleId: uuid(index + 1),
      code: 'routed-via-other-interface',
    })),
  });

  it('fits the largest possible diagnose response in one line', () => {
    const target = longDomain(1);
    const result = parseResult('diagnose', {
      target,
      targetKind: 'domain',
      match: { ruleId: uuid(1), via: 'dns-server', precedence: 'deeper-wildcard' },
      addresses: Array.from({ length: PROTOCOL_LIMITS.maxDiagnoseAddresses }, (_unused, index) => ({
        address: `255.255.255.${String(100 + index)}`,
        source: 'rule-cache',
        route: { device: `bridge${'1'.repeat(4)}`, gateway: '255.255.255.254', role: 'ethernet' },
        expectedRole: 'wifi',
        matchesExpected: false,
      })),
      dns: { server: '255.255.255.254', role: 'ethernet', resolverFile: `/etc/resolver/${target}`, outcome: 'not-queried', ms: null },
      notes: [...DIAGNOSE_NOTES],
    });
    if (!result.ok) throw new Error(result.error.message);
    const bytes = new TextEncoder().encode(encodeJsonLine({ id: Number.MAX_SAFE_INTEGER, ok: true, result: result.value })).length;
    expect(bytes).toBeLessThan(MAX_LINE_BYTES / 100);
  });

  it('fits the largest possible setConfig response, the largest message of all, in one line', () => {
    const result = parseResult('setConfig', { config: largestConfig(), state: largestState() });
    if (!result.ok) throw new Error(result.error.message);
    const response = { id: Number.MAX_SAFE_INTEGER, ok: true, result: result.value };

    const line = encodeJsonLine(response);
    const bytes = new TextEncoder().encode(line).length;
    expect(bytes).toBeGreaterThan(2_000_000);
    expect(bytes).toBeLessThan(MAX_LINE_BYTES * 0.6);

    expect(countValues(response)).toBeGreaterThan(20_000);
    expect(countValues(response)).toBeLessThan(STRUCTURE_LIMITS.maxNodes / 2);

    const [decoded] = createJsonLinesDecoder().push(line);
    const message = parseServerMessage(decoded?.ok === true ? decoded.value : undefined);
    expect(message.ok && message.value.kind).toBe('response');
  });

  it('fits the largest possible setConfig request in one line', () => {
    const request = parseRequest({ id: Number.MAX_SAFE_INTEGER, method: 'setConfig', config: largestConfig() });
    if (!request.ok || request.value.method !== 'setConfig') throw new Error('expected a setConfig request');
    expect(request.value.config.rules[0]?.target).toHaveLength(LIMITS.targetMaxLength);

    const bytes = new TextEncoder().encode(encodeJsonLine(request.value)).length;
    expect(bytes).toBeGreaterThan(500_000);
    expect(bytes).toBeLessThan(MAX_LINE_BYTES / 2);
  });

  it('fits the largest possible state event in one line', () => {
    const state = EngineState.safeParse(largestState());
    if (!state.success) throw new Error(state.error.message);

    const bytes = new TextEncoder().encode(encodeJsonLine({ event: 'state', state: state.data })).length;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(MAX_LINE_BYTES / 2);
  });
});

describe('describeIssues', () => {
  const hostile = 'EVIL\n\u001b[31mroot';
  const errorOfSchema = (schema: z.ZodType, value: unknown): z.ZodError => {
    const result = schema.safeParse(value);
    if (result.success) throw new Error('expected the value to be rejected');
    return result.error;
  };

  it('prints a path segment that is not a field of the contract as a question mark', () => {
    const schema = z.object({ config: z.record(z.string(), z.object({ rules: z.array(z.number()) })) });
    const error = errorOfSchema(schema, { config: { [hostile]: { rules: [1, 'x'] } } });
    expect(error.issues[0]?.path).toEqual(['config', hostile, 'rules', 1]);
    expect(describeIssues(error)).toBe('config.?.rules.1: has the wrong type');
  });

  it('prints a symbol segment as a question mark and the root as Message', () => {
    const key = Symbol('rules');
    const withSymbol = new z.ZodError([{ code: 'custom', message: hostile, path: [key, 0], input: 1 }]);
    expect(describeIssues(withSymbol)).toBe('?.0: is invalid');
    expect(describeIssues(errorOfSchema(z.string(), 1))).toBe('Message: has the wrong type');
    expect(describeIssues(new z.ZodError([]))).toBe('Message is invalid');
  });

  it('never copies the message or an unknown code of a custom issue', () => {
    const issue = (params: Record<string, unknown>): z.ZodError =>
      new z.ZodError([{ code: 'custom', message: hostile, path: ['target'], input: hostile, params }]);
    expect(describeIssues(issue({ code: hostile }))).toBe('target: is invalid');
    expect(describeIssues(issue({ code: 7 }))).toBe('target: is invalid');
    expect(describeIssues(issue({ code: 'toString' }))).toBe('target: is invalid');
    expect(describeIssues(issue({ code: 'default-route' }))).toBe('target: is invalid (default-route)');
  });

  it('uses fixed text for an issue kind it has no wording for', () => {
    const unknownKind = errorOfSchema(z.string().refine(() => false), 'x');
    expect(describeIssues(unknownKind)).toBe('Message: is invalid');
    const prototypeKind = { code: 'constructor', message: hostile, path: [], input: 1 } as unknown as z.core.$ZodIssue;
    expect(describeIssues(new z.ZodError([prototypeKind]))).toBe('Message: is invalid');
  });

  it('counts the further issues and stays within the message limit', () => {
    const error = errorOfSchema(z.array(z.number()), Array.from({ length: 400 }, () => 'x'));
    expect(describeIssues(error)).toBe('0: has the wrong type (+399 more)');
    expect(describeIssues(error).length).toBeLessThanOrEqual(PROTOCOL_LIMITS.errorMessageMaxLength);
  });
});

describe('findStructureViolation', () => {
  const nested = (depth: number, leaf: unknown = 1): unknown => {
    let value: unknown = leaf;
    for (let level = 0; level < depth; level += 1) value = level % 2 === 0 ? [value] : { a: value };
    return value;
  };

  it.each([
    ['a primitive', 1],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an array of exactly the limit', Array.from({ length: STRUCTURE_LIMITS.maxArrayLength }, () => 0)],
    ['a string of exactly the limit', 'x'.repeat(STRUCTURE_LIMITS.maxStringLength)],
    ['a key of exactly the limit', { ['k'.repeat(STRUCTURE_LIMITS.maxStringLength)]: 1 }],
    ['containers nested exactly to the limit', nested(STRUCTURE_LIMITS.maxDepth)],
    ['exactly the value budget', Array.from({ length: 131 }, () => Array.from({ length: 499 }, () => 0)).concat([Array.from({ length: 34 }, () => 0)])],
  ])('accepts %s', (_name, value) => {
    expect(findStructureViolation(value)).toBeNull();
  });

  it('counts exactly: the budget case above holds maxNodes values', () => {
    expect(1 + 132 + 131 * 499 + 34).toBe(STRUCTURE_LIMITS.maxNodes);
  });

  it.each([
    ['an array one longer than the limit', Array.from({ length: STRUCTURE_LIMITS.maxArrayLength + 1 }, () => 0), 'array-too-long'],
    ['a string one longer than the limit', ['x'.repeat(STRUCTURE_LIMITS.maxStringLength + 1)], 'string-too-long'],
    ['a key one longer than the limit', { ['k'.repeat(STRUCTURE_LIMITS.maxStringLength + 1)]: 1 }, 'string-too-long'],
    ['containers nested one deeper than the limit', nested(STRUCTURE_LIMITS.maxDepth + 1), 'too-deep'],
    [
      'one value more than the budget',
      Array.from({ length: 131 }, () => Array.from({ length: 499 }, () => 0)).concat([Array.from({ length: 35 }, () => 0)]),
      'too-many-values',
    ],
    [
      'an object with more keys than the budget',
      Object.fromEntries(Array.from({ length: STRUCTURE_LIMITS.maxNodes }, (_unused, index) => [`k${String(index)}`, 0])),
      'too-many-values',
    ],
    ['arrays that multiply', nested(0, Array.from({ length: 500 }, () => Array.from({ length: 500 }, () => 0))), 'too-many-values'],
  ])('reports %s', (_name, value, kind) => {
    expect(findStructureViolation(value)?.kind).toBe(kind);
  });

  it('names the top-level key the violation sits under', () => {
    const long = Array.from({ length: 501 }, () => 0);
    expect(findStructureViolation(long)).toEqual({ kind: 'array-too-long', topLevelKey: null });
    expect(findStructureViolation({ id: 1, config: { rules: long } })).toEqual({
      kind: 'array-too-long',
      topLevelKey: 'config',
    });
    expect(findStructureViolation({ id: 1, other: [[long]] })).toEqual({ kind: 'array-too-long', topLevelKey: 'other' });
  });

  it('does not recurse: a million levels of nesting are refused without a stack overflow', () => {
    expect(findStructureViolation(nested(1_000_000))?.kind).toBe('too-deep');
  });
});

describe('hostile messages at the size of the line limit', () => {
  /** Generous: each of these takes a few milliseconds; before the guard they took seconds and gigabytes. */
  const MAX_MILLISECONDS = 1000;

  /** Builds a line of just under `MAX_LINE_BYTES` by repeating `item` inside `[`…`]`. */
  const hugeArray = (prefix: string, item: string, suffix: string): string => {
    const count = Math.floor((MAX_LINE_BYTES - prefix.length - suffix.length) / (item.length + 1));
    const line = `${prefix}${Array.from({ length: count }, () => item).join(',')}${suffix}`;
    expect(line.length).toBeGreaterThan(MAX_LINE_BYTES - 16);
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_BYTES);
    return line;
  };

  const decode = (line: string): unknown => {
    const [decoded] = createJsonLinesDecoder().push(`${line}\n`);
    if (decoded?.ok !== true) throw new Error('the line itself must be valid JSON within the limit');
    return decoded.value;
  };

  const timed = <T>(run: () => T): { result: T; elapsed: number } => {
    const start = performance.now();
    const result = run();
    return { result, elapsed: performance.now() - start };
  };

  it.each([
    ['setConfig with 1.4 million empty rules', '{"id":1,"method":"setConfig","config":{"version":1,"rules":[', '{}', ']}}', 'invalid-config#1'],
    ['setConfig with 2 million numeric rules', '{"id":1,"method":"setConfig","config":{"version":1,"rules":[', '0', ']}}', 'invalid-config#1'],
    ['setConfig with a huge array in an unknown config key', '{"id":2,"method":"setConfig","config":{"version":1,"rules":[],"x":[', '[]', ']}}', 'invalid-config#2'],
    ['a huge array in an unknown top-level key', '{"id":3,"method":"status","x":[', '{}', ']}', 'invalid-request#3'],
    ['a huge array as the target', '{"id":4,"method":"test","target":[', '"a"', ']}', 'invalid-request#4'],
    ['a huge array as the method', '{"id":5,"method":[', '0', ']}', 'invalid-request#5'],
    ['a huge array with an unknown method', '{"id":6,"method":"exec","args":[', '"x"', ']}', 'invalid-request#6'],
    ['a huge array and no id', '{"method":"setConfig","config":{"version":1,"rules":[', '{}', ']}}', 'invalid-config#null'],
  ])('refuses %s in bounded time', (_name, prefix, item, suffix, expected) => {
    const value = decode(hugeArray(prefix, item, suffix));
    const { result, elapsed } = timed(() => parseRequest(value));
    expect(errorOf(result)).toBe(expected);
    expect(result.ok ? '' : result.error.message).toBe('Message holds an array of more than 500 elements');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('refuses a request with hundreds of thousands of keys in bounded time', () => {
    const keys = Array.from({ length: 300_000 }, (_unused, index) => `"k${String(index)}":0`).join(',');
    const value = decode(`{"id":7,"method":"status",${keys}}`);
    const { result, elapsed } = timed(() => parseRequest(value));
    expect(errorOf(result)).toBe('invalid-request#7');
    expect(result.ok ? '' : result.error.message).toBe('Message holds more than 65536 values');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('refuses a request holding one 4 MiB string in bounded time', () => {
    const value = decode(`{"id":8,"method":"test","target":"${'1'.repeat(MAX_LINE_BYTES - 64)}"}`);
    const { result, elapsed } = timed(() => parseRequest(value));
    expect(errorOf(result)).toBe('invalid-request#8');
    expect(result.ok ? '' : result.error.message).toBe('Message holds a string of more than 4096 characters');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('refuses a request nested a million levels deep in bounded time', () => {
    const depth = 1_000_000;
    const value = decode(`{"id":9,"method":"setConfig","config":${'['.repeat(depth)}${']'.repeat(depth)}}`);
    const { result, elapsed } = timed(() => parseRequest(value));
    expect(errorOf(result)).toBe('invalid-config#9');
    expect(result.ok ? '' : result.error.message).toBe('Message is nested more than 12 levels deep');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('refuses arrays that multiply within the per-array limit in bounded time', () => {
    const row = `[${Array.from({ length: 500 }, () => '{}').join(',')}]`;
    const value = decode(`{"id":10,"method":"setConfig","config":{"version":1,"rules":[${Array.from({ length: 500 }, () => row).join(',')}]}}`);
    const { result, elapsed } = timed(() => parseRequest(value));
    expect(errorOf(result)).toBe('invalid-config#10');
    expect(result.ok ? '' : result.error.message).toBe('Message holds more than 65536 values');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('keeps the schema work small for the worst input the guard lets through', () => {
    const rules = Array.from({ length: STRUCTURE_LIMITS.maxArrayLength }, () => ({}));
    const { result, elapsed } = timed(() => parseRequest({ id: 11, method: 'setConfig', config: { version: 1, rules } }));
    expect(errorOf(result)).toBe('invalid-config#11');
    expect(result.ok ? '' : result.error.message).toMatch(/^config\.rules\.0\.\w+: has the wrong type \(\+\d{4} more\)$/);
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it.each([
    ['a state event with 1.4 million empty rule states', '{"event":"state","state":{"rules":[', '{}', ']}}', 'invalid-response#null'],
    ['a state event with a million adapters', '{"event":"state","state":{"adapters":[', '{}', ']}}', 'invalid-response#null'],
    [
      'a state event with a million applied destinations',
      '{"event":"state","state":{"rules":[{"appliedDestinations":[',
      '"10.0.0.1"',
      ']}]}}',
      'invalid-response#null',
    ],
    ['a log event with a huge array as the message', '{"event":"log","level":"info","msg":[', '0', ']}', 'invalid-response#null'],
    ['a response with a huge array in its result', '{"id":12,"ok":true,"result":{"state":{"rules":[', '{}', ']}}}', 'invalid-response#12'],
    ['an error response with a huge array as the error', '{"id":13,"ok":false,"error":[', '0', ']}', 'invalid-response#13'],
  ])('refuses %s in bounded time', (_name, prefix, item, suffix, expected) => {
    const value = decode(hugeArray(prefix, item, suffix));
    const { result, elapsed } = timed(() => parseServerMessage(value));
    expect(errorOf(result)).toBe(expected);
    expect(result.ok ? '' : result.error.message).toBe('Message holds an array of more than 500 elements');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it.each(REQUEST_METHODS)('refuses a %s result with a huge array in bounded time', (method) => {
    const value = decode(hugeArray('{"state":{"rules":[', '{}', ']},"config":{"version":1,"rules":[]}}'));
    const { result, elapsed } = timed(() => parseResult(method, value));
    expect(errorOf(result)).toBe('invalid-response#null');
    expect(result.ok ? '' : result.error.message).toBe('Message holds an array of more than 500 elements');
    expect(elapsed).toBeLessThan(MAX_MILLISECONDS);
  });

  it('never repeats helper text in an app-side refusal', () => {
    const hostile = 'EVIL\n\u001b[31mroot';
    const messages: unknown[] = [
      { event: hostile },
      { event: 'log', level: hostile, msg: hostile, at: hostile },
      { event: 'state', state: { [hostile]: hostile } },
      { id: 1, ok: false, error: 'x', code: hostile },
      { id: 1, ok: true, result: hostile },
      { [hostile]: hostile },
    ];
    for (const message of messages) {
      const result = parseServerMessage(message);
      const text = result.ok ? 'accepted' : result.error.message;
      expect(text).not.toBe('accepted');
      expect(text).toMatch(/^[A-Za-z0-9 .:()+?-]+$/);
    }
    const result = parseResult('test', testResultInput({ device: hostile, [hostile]: hostile }));
    expect(result.ok ? 'accepted' : result.error.message).toBe('device: has an invalid format');
  });
});
