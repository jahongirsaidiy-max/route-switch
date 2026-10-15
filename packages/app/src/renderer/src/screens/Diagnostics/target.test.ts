import { describe, expect, it } from 'vitest';

import { MAX_DIAGNOSTIC_INPUT, parseDiagnosticTarget } from './target';

describe('parseDiagnosticTarget: host, IPv4 or URL → what `diagnose` takes', () => {
  it.each<[string, string, 'ip' | 'domain']>([
    ['corp.local', 'corp.local', 'domain'],
    ['  corp.local  ', 'corp.local', 'domain'],
    ['Corp.Local', 'corp.local', 'domain'],
    ['corp.local.', 'corp.local', 'domain'],
    ['10.20.4.37', '10.20.4.37', 'ip'],
    ['https://a.example.com:8443/x?y', 'a.example.com', 'domain'],
    ['http://example.com', 'example.com', 'domain'],
    ['HTTPS://EXAMPLE.COM/', 'example.com', 'domain'],
    ['example.com/path/to#frag', 'example.com', 'domain'],
    ['example.com:443', 'example.com', 'domain'],
    ['example.com?q=1', 'example.com', 'domain'],
    ['ssh://user:secret@git.corp.local:22/repo', 'git.corp.local', 'domain'],
    ['user@corp.local', 'corp.local', 'domain'],
    ['http://10.1.2.3:8080/admin', '10.1.2.3', 'ip'],
    ['ftp://172.16.12.40', '172.16.12.40', 'ip'],
    ['xn--e1afmkfd.xn--p1ai', 'xn--e1afmkfd.xn--p1ai', 'domain'],
    ['пример.рф', 'xn--e1afmkfd.xn--p1ai', 'domain'],
    ['https://Пример.РФ/путь', 'xn--e1afmkfd.xn--p1ai', 'domain'],
    ['bücher.example', 'xn--bcher-kva.example', 'domain'],
  ])('%j → %s (%s)', (input, target, kind) => {
    expect(parseDiagnosticTarget(input)).toEqual({ ok: true, target, kind });
  });

  it.each<[string, string]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['[::1]:443', 'ipv6'],
    ['http://[2001:db8::1]/', 'ipv6'],
    ['fe80::1', 'ipv6'],
    ['::1', 'ipv6'],
    ['*.corp.local', 'wildcard'],
    ['https://*.example.com', 'wildcard'],
    ['10.*.*.*', 'wildcard'],
    ['10.0.0.0/8', 'invalid-host'],
    ['10.0.0.0/', 'invalid-host'],
    ['http://', 'invalid-host'],
    ['https:///path', 'invalid-host'],
    ['corp local', 'invalid-host'],
    ['corp\tlocal', 'invalid-host'],
    ['corp\u0000local', 'invalid-host'],
    ['example.com:abc', 'invalid-host'],
    ['under_score.example', 'invalid-host'],
    ['-bad.example', 'invalid-host'],
    ['../etc', 'invalid-host'],
    ['a..b', 'invalid-host'],
    ['１０.０.０.１', 'invalid-host'],
    ['127.0.0.1', 'loopback'],
    ['http://127.0.0.1:8080/', 'loopback'],
    ['0.0.0.0', 'default-route'],
    ['169.254.1.1', 'link-local'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['010.1.2.3', 'invalid-ipv4'],
    ['1.2.3', 'invalid-ipv4'],
    ['1.2.3.4.5', 'invalid-ipv4'],
    ['300.1.1.1', 'invalid-ipv4'],
  ])('%j is refused (%s), never rewritten', (input, code) => {
    expect(parseDiagnosticTarget(input)).toEqual({ ok: false, code });
  });

  it('an input longer than the limit is refused before parsing', () => {
    expect(parseDiagnosticTarget(`https://example.com/${'a'.repeat(MAX_DIAGNOSTIC_INPUT)}`)).toEqual({ ok: false, code: 'too-long' });
    const label = 'a'.repeat(63);
    // A name over 253 characters is not a domain.
    expect(parseDiagnosticTarget([label, label, label, label, 'com'].join('.'))).toEqual({ ok: false, code: 'invalid-host' });
  });
});
