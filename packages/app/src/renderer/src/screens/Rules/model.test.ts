import type { Config, EngineState } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { RULE_REASON_TEXT } from '../../text';
import { CONFIG, ID, NOW, STATE, ruleState } from '../MenuBar/fixtures';
import {
  activeCount,
  kindLabel,
  notesById,
  overlapWarnings,
  rowDetail,
  rowStatus,
  ruleRows,
  visibleRows,
  type RuleRow,
} from './model';

const ruleOf = (id: string) => {
  const rule = CONFIG.rules.find((entry) => entry.id === id);
  if (rule === undefined) throw new Error(id);
  return rule;
};
const stateOf = (id: string) => STATE.rules.find((entry) => entry.ruleId === id) ?? null;
const withRules = (rules: EngineState['rules']): EngineState => ({ ...STATE, rules });

describe('kindLabel', () => {
  it('names each kind as the design does', () => {
    expect(kindLabel({ kind: 'ip' })).toBe('IP');
    expect(kindLabel({ kind: 'subnet' })).toBe('Subnet');
    expect(kindLabel({ kind: 'domain' })).toBe('Domen');
    expect(kindLabel({ kind: 'domain', dns: '10.20.0.10' })).toBe('Domen + DNS');
  });
});

describe('rowDetail', () => {
  it('the note first', () => {
    expect(rowDetail(ruleOf(ID.subnet), stateOf(ID.subnet))).toBe('Ichki tarmoq');
    expect(rowDetail({ ...ruleOf(ID.host), note: '  ' }, stateOf(ID.host))).toBe('');
  });

  it('a domain: its DNS server, or address count and refresh interval', () => {
    expect(rowDetail(ruleOf(ID.dnsDomain), stateOf(ID.dnsDomain))).toBe('DNS: 10.20.0.10');
    expect(rowDetail(ruleOf(ID.domain), stateOf(ID.domain))).toBe('3 IP · har 10 daq');
    expect(rowDetail(ruleOf(ID.domain), null)).toBe('har 10 daq');
    expect(rowDetail({ ...ruleOf(ID.domain), refreshSec: 3600 }, ruleState(ID.domain))).toBe('har 60 daq');
  });
});

describe('rowStatus', () => {
  it('plain active, disabled and unknown say nothing extra', () => {
    expect(rowStatus(ruleState(ID.host))).toEqual({ kind: 'ok' });
    expect(rowStatus(ruleState(ID.host, { status: 'disabled', reasonCode: 'rule-disabled' }))).toEqual({ kind: 'none' });
    expect(rowStatus(null)).toEqual({ kind: 'none' });
  });

  it('pending and error carry the translated reason', () => {
    expect(rowStatus(ruleState(ID.host, { status: 'pending', reasonCode: 'no-gateway' }))).toEqual({
      kind: 'pending',
      text: "Interfeysda gateway yo'q",
    });
    expect(rowStatus(ruleState(ID.domain, { status: 'error', reasonCode: 'resolve-failed' }))).toEqual({
      kind: 'error',
      text: RULE_REASON_TEXT['resolve-failed'],
    });
  });

  it.each(['addresses-truncated', 'overridden-by-rule', 'dns-server-excluded'] as const)(
    'active + %s is a warning ("Faol"), not an error',
    (code) => {
      expect(rowStatus(ruleState(ID.domain, { reasonCode: code }))).toEqual({ kind: 'warning', text: RULE_REASON_TEXT[code] });
    },
  );
});

describe('ruleRows', () => {
  it('every rule of the config in order, joined with its state and the role device', () => {
    const rows = ruleRows(CONFIG, STATE, NOW);
    expect(rows.map((row) => row.target)).toEqual([
      '10.0.0.0/8',
      '10.9.9.9',
      'corp.local',
      '172.16.12.40',
      'github.com',
      '192.168.50.0/24',
    ]);
    expect(rows[1]).toMatchObject({ enabled: false, kindLabel: 'IP', iface: 'ethernet', device: 'en5', status: { kind: 'none' } });
    expect(rows[4]).toMatchObject({ iface: 'wifi', device: 'en0', kindLabel: 'Domen', detail: '3 IP · har 10 daq' });
  });

  it('a failed domain rule carries its last known addresses; others, and switched-off rules, none', () => {
    const failed = withRules(STATE.rules.map((rule) => (rule.ruleId === ID.domain ? { ...rule, status: 'error' as const, reasonCode: 'resolve-failed' as const } : rule)));
    const rows = ruleRows(CONFIG, failed, NOW);
    expect(rows[4]?.lastKnown).toBe("Oxirgi ma'lum IP'lar (hali yo'naltirilmoqda): 140.82.112.3, 140.82.112.4, 140.82.113.3 · 2 daq oldin");
    expect(rows.filter((row) => row.lastKnown !== null)).toHaveLength(1);
    const off = ruleRows({ ...CONFIG, rules: CONFIG.rules.map((rule) => (rule.id === ID.domain ? { ...rule, enabled: false } : rule)) }, failed, NOW);
    expect(off[4]?.lastKnown).toBeNull();
  });

  it('a role without a device shows none', () => {
    const state = { ...STATE, interfaces: { ...STATE.interfaces, wifi: { device: null, ip: null, gateway: null, up: false } } };
    expect(ruleRows(CONFIG, state, NOW)[4]?.device).toBeNull();
  });
});

describe('visibleRows', () => {
  const rows = ruleRows(CONFIG, withRules([...STATE.rules.slice(0, 3), ruleState(ID.host, { status: 'error', reasonCode: 'route-failed' }), ruleState(ID.domain, { reasonCode: 'overridden-by-rule' }), ruleState(ID.test)]), NOW);
  const notes = notesById(CONFIG);
  const targets = (list: RuleRow[]) => list.map((row) => row.target);

  it('everything without a query', () => {
    expect(visibleRows(rows, notes, '  ', 'all')).toHaveLength(6);
  });

  it('matches the address and the note, ignoring case and surrounding spaces', () => {
    expect(targets(visibleRows(rows, notes, ' GITHUB ', 'all'))).toEqual(['github.com']);
    expect(targets(visibleRows(rows, notes, '10.', 'all'))).toEqual(['10.0.0.0/8', '10.9.9.9']);
    expect(targets(visibleRows(rows, notes, 'firebird', 'all'))).toEqual(['172.16.12.40']);
    expect(targets(visibleRows(rows, notes, 'stend', 'all'))).toEqual(['192.168.50.0/24']);
  });

  it('does not match the derived detail (only the note)', () => {
    expect(visibleRows(rows, notes, 'DNS: 10.20', 'all')).toEqual([]);
    expect(visibleRows(rows, notes, 'nothing-like-this', 'all')).toEqual([]);
  });

  it('filters: problems are enabled rules that are pending, failing or warned; off are switched-off rules', () => {
    expect(targets(visibleRows(rows, notes, '', 'problems'))).toEqual(['172.16.12.40', 'github.com']);
    expect(targets(visibleRows(rows, notes, '', 'off'))).toEqual(['10.9.9.9']);
    expect(targets(visibleRows(rows, notes, 'git', 'off'))).toEqual([]);
  });

  it('a rule switched off in the config whose state still says error (revision in between) is not a problem', () => {
    const config: Config = { ...CONFIG, rules: CONFIG.rules.map((rule) => (rule.id === ID.host ? { ...rule, enabled: false } : rule)) };
    const stale = ruleRows(config, withRules([ruleState(ID.host, { status: 'error', reasonCode: 'route-failed' }), ruleState(ID.subnet, { status: 'pending', reasonCode: 'interface-down' })]), NOW);
    expect(stale.find((row) => row.id === ID.host)).toMatchObject({ enabled: false, status: { kind: 'error' } });
    expect(targets(visibleRows(stale, notes, '', 'problems'))).toEqual(['10.0.0.0/8']);
    expect(targets(visibleRows(stale, notes, '', 'off'))).toEqual(['10.9.9.9', '172.16.12.40']);
  });
});

describe('overlapWarnings', () => {
  const config = (rules: Partial<Config['rules'][number]>[]): Config => ({
    version: 1,
    enabled: true,
    rules: rules.map((rule, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      kind: 'subnet',
      target: '10.0.0.0/8',
      iface: 'ethernet',
      enabled: true,
      refreshSec: 600,
      ...rule,
    })),
  });

  it('none for the sample config', () => {
    expect(overlapWarnings(CONFIG)).toEqual([]);
  });

  it('a subnet inside another, and whether they use different interfaces', () => {
    expect(
      overlapWarnings(
        config([
          { target: '10.0.0.0/8' },
          { target: '10.1.0.0/16', iface: 'wifi' },
          { kind: 'ip', target: '10.0.0.5' },
          { kind: 'domain', target: 'corp.local' },
        ]),
      ),
    ).toEqual([
      { wider: '10.0.0.0/8 (ETH)', narrower: '10.1.0.0/16 (WIFI)', crossInterface: true },
      { wider: '10.0.0.0/8 (ETH)', narrower: '10.0.0.5 (ETH)', crossInterface: false },
    ]);
  });

  it('ignores switched-off rules (they route nothing)', () => {
    expect(overlapWarnings(config([{ target: '10.0.0.0/8' }, { target: '10.1.0.0/16', enabled: false }]))).toEqual([]);
  });
});

describe('activeCount', () => {
  it('counts active rules, warnings included', () => {
    expect(activeCount(STATE)).toBe(5);
    expect(activeCount(withRules([ruleState(ID.domain, { reasonCode: 'dns-server-excluded' }), ruleState(ID.host, { status: 'error', reasonCode: 'route-failed' })]))).toBe(1);
  });
});
