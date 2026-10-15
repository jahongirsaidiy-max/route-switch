import { describe, expect, it } from 'vitest';

import { RULES_WINDOW_SECTIONS, RulesWindowIntent } from './index';

describe('RulesWindowIntent (TASK-DELTA-21)', () => {
  it('a section, or a DNS offer by server and role', () => {
    expect(RULES_WINDOW_SECTIONS).toEqual(['rules', 'log', 'diagnostics', 'settings', 'help']);
    for (const section of RULES_WINDOW_SECTIONS) expect(RulesWindowIntent.parse({ kind: 'section', section })).toEqual({ kind: 'section', section });
    expect(RulesWindowIntent.parse({ kind: 'dns-offer', server: '10.0.0.53', role: 'ethernet' })).toEqual({ kind: 'dns-offer', server: '10.0.0.53', role: 'ethernet' });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'rules'],
    ['an unknown kind', { kind: 'eval', section: 'rules' }],
    ['an unknown section', { kind: 'section', section: 'help-me' }],
    ['an extra key', { kind: 'section', section: 'rules', url: 'https://example.com/' }],
    ['a rule instead of a warning', { kind: 'dns-offer', server: '10.0.0.53', role: 'ethernet', rule: { target: '10.0.0.0/8' } }],
    ['a name', { kind: 'dns-offer', server: 'corp.local', role: 'ethernet' }],
    ['a CIDR', { kind: 'dns-offer', server: '10.0.0.0/8', role: 'ethernet' }],
    ['a default route', { kind: 'dns-offer', server: '0.0.0.0', role: 'ethernet' }],
    ['a loopback address', { kind: 'dns-offer', server: '127.0.0.53', role: 'ethernet' }],
    ['a non-canonical address', { kind: 'dns-offer', server: '010.0.0.53', role: 'ethernet' }],
    ['another role', { kind: 'dns-offer', server: '10.0.0.53', role: 'utun0' }],
    ['no role', { kind: 'dns-offer', server: '10.0.0.53' }],
  ])('refuses %s', (_name, value) => {
    expect(RulesWindowIntent.safeParse(value).success).toBe(false);
  });
});
