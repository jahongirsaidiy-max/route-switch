// Test data for the menu bar window (imported by its tests only). Sample
// addresses are the generic ones of the docs (`10.0.0.0/8`, `corp.local`).

import type { Config, EngineState, RuleState } from '@routeswitch/shared';

import type { RsServiceOrder } from '../../rs';

export const ID = {
  subnet: '11111111-1111-4111-8111-111111111111',
  host: '22222222-2222-4222-8222-222222222222',
  dnsDomain: '33333333-3333-4333-8333-333333333333',
  domain: '44444444-4444-4444-8444-444444444444',
  test: '55555555-5555-4555-8555-555555555555',
  off: '66666666-6666-4666-8666-666666666666',
} as const;

export const CONFIG: Config = {
  version: 1,
  enabled: true,
  rules: [
    { id: ID.subnet, kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet', enabled: true, refreshSec: 600, note: 'Ichki tarmoq' },
    { id: ID.off, kind: 'ip', target: '10.9.9.9', iface: 'ethernet', enabled: false, refreshSec: 600 },
    { id: ID.dnsDomain, kind: 'domain', target: 'corp.local', iface: 'ethernet', enabled: true, refreshSec: 600, dns: '10.20.0.10' },
    { id: ID.host, kind: 'ip', target: '172.16.12.40', iface: 'ethernet', enabled: true, refreshSec: 600, note: 'Firebird DB' },
    { id: ID.domain, kind: 'domain', target: 'github.com', iface: 'wifi', enabled: true, refreshSec: 600 },
    { id: ID.test, kind: 'subnet', target: '192.168.50.0/24', iface: 'ethernet', enabled: true, refreshSec: 600, note: 'Test stend' },
  ],
};

export const ruleState = (ruleId: string, extra: Partial<RuleState> = {}): RuleState => ({
  ruleId,
  status: 'active',
  reasonCode: null,
  reason: null,
  appliedDestinations: [],
  lastResolvedAt: null,
  ...extra,
});

/** 2026-10-14 11:00 local time. */
export const NOW = new Date(2026, 9, 14, 11, 0, 0).getTime();
const local = (hours: number, minutes: number) => new Date(2026, 9, 14, hours, minutes).toISOString();

export const STATE: EngineState = {
  helperVersion: '0.1.0',
  seq: 7,
  configRevision: 3,
  enabled: true,
  interfaces: {
    ethernet: { device: 'en5', ip: '10.20.4.37', gateway: '10.20.4.1', up: true },
    wifi: { device: 'en0', ip: '192.168.0.104', gateway: '192.168.0.1', up: true },
  },
  adapters: [
    { device: 'en0', port: 'Wi-Fi', ip: '192.168.0.104' },
    { device: 'en5', port: 'USB 10/100/1000 LAN', ip: '10.20.4.37' },
  ],
  rules: [
    ruleState(ID.subnet, { appliedDestinations: ['10.0.0.0/8'] }),
    ruleState(ID.off, { status: 'disabled', reasonCode: 'rule-disabled', reason: 'Rule is disabled' }),
    ruleState(ID.dnsDomain, { appliedDestinations: ['10.20.0.10', '10.20.1.5'], lastResolvedAt: local(10, 50) }),
    ruleState(ID.host, { appliedDestinations: ['172.16.12.40'] }),
    ruleState(ID.domain, { appliedDestinations: ['140.82.112.3', '140.82.112.4', '140.82.113.3'], lastResolvedAt: local(10, 58) }),
    ruleState(ID.test, { appliedDestinations: ['192.168.50.0/24'] }),
  ],
  lastApplyAt: local(10, 58),
  lastReconcileReason: 'network-change',
};

export const ORDER_WIFI_FIRST: RsServiceOrder = {
  services: [
    { name: 'Wi-Fi', hardwarePort: 'Wi-Fi', device: 'en0', enabled: true },
    { name: 'USB 10/100/1000 LAN', hardwarePort: 'USB 10/100/1000 LAN', device: 'en5', enabled: true },
  ],
  wifiService: 'Wi-Fi',
  wifiFirst: true,
  command: "sudo networksetup -ordernetworkservices 'Wi-Fi' 'USB 10/100/1000 LAN'",
};
