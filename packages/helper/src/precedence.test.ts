import { Config } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { isExplicitTarget, planningOrder } from './precedence';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('planningOrder', () => {
  it('puts ip and subnet rules before domain rules and keeps the config order within each group', () => {
    const { rules } = Config.parse({
      version: 1,
      rules: [
        { id: id(1), kind: 'domain', target: 'a.corp.local', iface: 'wifi' },
        { id: id(2), kind: 'subnet', target: '10.0.0.0/8', iface: 'ethernet' },
        { id: id(3), kind: 'domain', target: 'b.corp.local', iface: 'wifi' },
        { id: id(4), kind: 'ip', target: '10.1.2.3', iface: 'wifi' },
      ],
    });
    expect(planningOrder(rules).map((rule) => rule.id)).toEqual([id(2), id(4), id(1), id(3)]);
    expect(planningOrder([])).toEqual([]);
  });
});

describe('isExplicitTarget', () => {
  it('the target of an ip or subnet rule and the DNS server of a domain rule are explicit', () => {
    expect(isExplicitTarget({ kind: 'ip' }, '10.1.2.3')).toBe(true);
    expect(isExplicitTarget({ kind: 'subnet' }, '10.0.0.0/8')).toBe(true);
    expect(isExplicitTarget({ kind: 'domain', dns: '10.20.0.10' }, '10.20.0.10')).toBe(true);
  });

  it('a resolved address of a domain rule is not', () => {
    expect(isExplicitTarget({ kind: 'domain', dns: '10.20.0.10' }, '10.30.0.5')).toBe(false);
    expect(isExplicitTarget({ kind: 'domain' }, '10.30.0.5')).toBe(false);
  });
});
