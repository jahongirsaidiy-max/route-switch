// Diagnoses as the main process returns them, for the Diagnostika tests.
// Generic sample data only (`10.0.0.0/8`, `corp.local`, documentation ranges).

import type { Config, DiagnoseAddress, DiagnoseResult } from '@routeswitch/shared';

import type { RsDiagnosis } from '../../rs';

export const RULE = {
  subnet: '11111111-1111-4111-8111-111111111111',
  domain: '22222222-2222-4222-8222-222222222222',
} as const;

export const RULES: Config['rules'] = [
  { id: RULE.subnet, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: true, refreshSec: 600 },
  { id: RULE.domain, kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.20.0.10', enabled: true, refreshSec: 600 },
];

export const address = (value: string, extra: Partial<DiagnoseAddress> = {}): DiagnoseAddress => ({
  address: value,
  source: 'query',
  route: { device: 'en5', gateway: '10.20.4.1', role: 'ethernet' },
  expectedRole: 'ethernet',
  matchesExpected: true,
  ...extra,
});

export const result = (target: string, extra: Partial<DiagnoseResult> = {}): DiagnoseResult => ({
  target,
  targetKind: /^[\d.]+$/.test(target) ? 'ip' : 'domain',
  match: null,
  addresses: [],
  dns: null,
  notes: [],
  ...extra,
});

/** `corp.local`, covered by its domain rule: two addresses through Ethernet, its DNS server answering. */
export const COVERED_DOMAIN: RsDiagnosis = {
  result: result('corp.local', {
    match: { ruleId: RULE.domain, via: 'domain', precedence: 'only-match' },
    addresses: [address('10.20.4.37', { source: 'rule-cache' }), address('10.20.4.38', { source: 'rule-cache' })],
    dns: { server: '10.20.0.10', role: 'ethernet', resolverFile: '/etc/resolver/corp.local', outcome: 'ok', ms: 24 },
  }),
  lookup: null,
};

/** An address under the 10.0.0.0/8 rule that the kernel sends through Wi‑Fi. */
export const MISMATCH: RsDiagnosis = {
  result: result('10.1.2.3', {
    match: { ruleId: RULE.subnet, via: 'subnet', precedence: 'only-match' },
    addresses: [address('10.1.2.3', { route: { device: 'en0', gateway: '192.168.1.1', role: 'wifi' }, matchesExpected: false })],
    notes: ['route-mismatch'],
  }),
  lookup: null,
};

/** `example.com`, no rule: resolved by the app, each address on the default route. */
export const NOT_COVERED: RsDiagnosis = {
  result: result('example.com', { notes: ['name-not-covered'] }),
  lookup: {
    outcome: 'ok',
    truncated: false,
    excluded: 1,
    addresses: [
      {
        address: '203.0.113.7',
        ok: true,
        result: result('203.0.113.7', {
          addresses: [address('203.0.113.7', { route: { device: 'en0', gateway: '192.168.1.1', role: 'wifi' }, expectedRole: null, matchesExpected: null })],
          notes: ['no-matching-rule'],
        }),
      },
      { address: '198.51.100.2', ok: false, code: 'operation-failed' },
    ],
  },
};
