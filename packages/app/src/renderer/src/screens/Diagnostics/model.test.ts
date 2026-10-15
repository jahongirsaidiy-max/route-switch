import { DIAGNOSE_DNS_OUTCOMES, DIAGNOSE_MATCH_VIA, DIAGNOSE_NOTES, DIAGNOSE_PRECEDENCE_CODES } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { i18nFor, LOCALES } from '../../../../i18n';
import type { RsDiagnosis } from '../../rs';
import { address, COVERED_DOMAIN, MISMATCH, NOT_COVERED, result, RULE, RULES } from './fixtures';
import { actualRoute, diagnosisView, rowStatus, ruleLabel } from './model';

const UZ = i18nFor('uz');
const EN = i18nFor('en');

describe('the words cover every code of the protocol', () => {
  it.each(LOCALES)('%s', (locale) => {
    const words = i18nFor(locale).t.diagnostics;
    expect(Object.keys(words.notes).sort()).toEqual([...DIAGNOSE_NOTES].sort());
    expect(Object.keys(words.via).sort()).toEqual([...DIAGNOSE_MATCH_VIA].sort());
    expect(Object.keys(words.precedence).sort()).toEqual([...DIAGNOSE_PRECEDENCE_CODES].sort());
    expect(Object.keys(words.dnsOutcome).sort()).toEqual([...DIAGNOSE_DNS_OUTCOMES].sort());
  });
});

describe('pieces', () => {
  it('ruleLabel: the rule as the table shows it, or a placeholder while the rules are not read', () => {
    expect(ruleLabel(RULE.domain, RULES)).toBe('corp.local → Ethernet');
    expect(ruleLabel(RULE.domain, null)).toContain("o'qilmagan");
    expect(ruleLabel('33333333-3333-4333-8333-333333333333', RULES)).toContain("o'qilmagan");
  });

  it('rowStatus', () => {
    expect(rowStatus({ matchesExpected: true, expectedRole: 'ethernet' })).toBe('ok');
    expect(rowStatus({ matchesExpected: false, expectedRole: 'ethernet' })).toBe('mismatch');
    expect(rowStatus({ matchesExpected: null, expectedRole: null })).toBe('default');
    expect(rowStatus({ matchesExpected: null, expectedRole: 'wifi' })).toBe('unknown');
  });

  it('actualRoute: device · role · gateway; no route; no role; directly connected', () => {
    expect(actualRoute({ device: 'en5', gateway: '10.20.4.1', role: 'ethernet' })).toBe('en5 · Ethernet · gateway 10.20.4.1');
    expect(actualRoute(null)).toBe("route yo'q");
    expect(actualRoute({ device: 'utun3', gateway: null, role: null }, EN)).toBe('utun3 · interface without a role · directly connected');
  });
});

describe('diagnosisView', () => {
  it('a covered domain: verdict ok through Ethernet, the rule and why, a row per address, DNS answering', () => {
    const view = diagnosisView(COVERED_DOMAIN, RULES);
    expect(view.verdict).toEqual({ tone: 'ok', title: 'Hammasi kutilganidek — Ethernet orqali', advice: null });
    expect(view.match).toEqual({ rule: 'domen qoidasi: corp.local → Ethernet', why: "boshqa mos qoida yo'q" });
    expect(view.noMatch).toBeNull();
    expect(view.rows.map((row) => [row.address, row.source, row.expected, row.status, row.statusLabel])).toEqual([
      ['10.20.4.37', 'qoida keshidan', 'Ethernet', 'ok', '✓ mos'],
      ['10.20.4.38', 'qoida keshidan', 'Ethernet', 'ok', '✓ mos'],
    ]);
    expect(view.dns).toEqual({
      server: 'Server: 10.20.0.10',
      via: 'Ethernet orqali',
      outcome: 'javob berdi · 24 ms',
      tone: 'ok',
      resolverFile: 'Resolver fayli: /etc/resolver/corp.local',
    });
    expect(view.lookup).toEqual([]);
    expect(view.notes).toEqual([]);
  });

  it('a mismatch: danger with the advice for the note, ✗ on the row', () => {
    const view = diagnosisView(MISMATCH, RULES);
    expect(view.verdict.tone).toBe('danger');
    expect(view.verdict.title).toBe("Trafik kutilgan interfeysdan ketmayapti");
    expect(view.verdict.advice).toContain('VPN');
    expect(view.rows[0]).toMatchObject({ status: 'mismatch', statusLabel: '✗ mos emas', actual: 'en0 · Wi‑Fi · gateway 192.168.1.1', expected: 'Ethernet' });
    expect(view.match?.rule).toBe('subnet qoidasi: 10.0.0.0/8 → Ethernet');
    expect(view.notes).toEqual(['Tizim manzilni qoida interfeysidan boshqa interfeys orqali yuboryapti.']);
  });

  it('the interface is down: no route for an expected role is danger with the interface advice', () => {
    const down: RsDiagnosis = {
      result: result('10.1.2.3', {
        match: { ruleId: RULE.subnet, via: 'subnet', precedence: 'only-match' },
        addresses: [address('10.1.2.3', { route: null, matchesExpected: null })],
        notes: ['interface-down', 'not-applied'],
      }),
      lookup: null,
    };
    const view = diagnosisView(down, RULES);
    expect(view.verdict.tone).toBe('danger');
    expect(view.verdict.advice).toContain('kabel');
    expect(view.rows[0]).toMatchObject({ actual: "route yo'q", status: 'unknown' });
    const notApplied = diagnosisView({ ...down, result: { ...down.result, notes: ['not-applied'] } }, RULES);
    expect(notApplied.verdict.advice).toContain("Qayta qo'llash");
  });

  it('no rule: neutral "default kanal" with a short advice; a disabled rule or the global switch say so instead', () => {
    const none: RsDiagnosis = {
      result: result('172.16.12.40', {
        addresses: [address('172.16.12.40', { route: { device: 'en0', gateway: '192.168.1.1', role: 'wifi' }, expectedRole: null, matchesExpected: null })],
        notes: ['no-matching-rule'],
      }),
      lookup: null,
    };
    const view = diagnosisView(none, RULES);
    expect(view.verdict).toEqual({
      tone: 'neutral',
      title: "Qoida yo'q — default kanaldan ketadi",
      advice: "Boshqa interfeysdan ketishi kerak bo'lsa — Qoidalar bo'limida qoida qo'shing.",
    });
    expect(view.noMatch).toContain('default');
    expect(view.rows[0]).toMatchObject({ expected: 'default kanal', status: 'default' });
    const disabled = diagnosisView({ ...none, result: { ...none.result, notes: ['no-matching-rule', 'rule-disabled'] } }, RULES);
    expect(disabled.verdict.advice).toContain("o'chirilgan");
    const off = diagnosisView({ ...none, result: { ...none.result, notes: ['globally-disabled', 'rule-disabled'] } }, RULES);
    expect(off.verdict.advice).toContain('menu bar');
  });

  it('DNS not answering is a warning; a DNS timeout shows no ms', () => {
    const dnsDown: RsDiagnosis = {
      ...COVERED_DOMAIN,
      result: { ...COVERED_DOMAIN.result, dns: { server: '10.20.0.10', role: 'ethernet', resolverFile: null, outcome: 'timeout', ms: 3000 } },
    };
    const view = diagnosisView(dnsDown, RULES);
    expect(view.verdict).toMatchObject({ tone: 'warning', title: 'DNS server javob bermayapti' });
    expect(view.dns).toMatchObject({ outcome: 'javob bermadi (3 s)', tone: 'danger', resolverFile: "Resolver fayli yo'q — tizim DNS'i ishlatiladi." });
    const notQueried = diagnosisView({ ...dnsDown, result: { ...dnsDown.result, dns: { server: '10.20.0.10', role: null, resolverFile: null, outcome: 'not-queried', ms: null } } }, RULES);
    expect(notQueried.dns).toMatchObject({ outcome: "so'ralmadi", tone: 'neutral', via: null });
    expect(notQueried.verdict.tone).toBe('ok');
  });

  it('a covered domain rule without a DNS server of its own says the system DNS is used', () => {
    const view = diagnosisView({ ...COVERED_DOMAIN, result: { ...COVERED_DOMAIN.result, dns: null } }, RULES);
    expect(view.dns).toBeNull();
    expect(view.dnsNote).toContain("tizim DNS'i");
    expect(diagnosisView(MISMATCH, RULES).dnsNote).toBeNull();
  });

  it('no addresses: a warning; the notes say why', () => {
    const empty: RsDiagnosis = { result: result('corp.local', { match: { ruleId: RULE.domain, via: 'domain', precedence: 'only-match' }, notes: ['no-addresses'] }), lookup: null };
    const view = diagnosisView(empty, RULES);
    expect(view.verdict).toMatchObject({ tone: 'warning', title: 'Manzil topilmadi' });
    expect(view.notes).toEqual(["Nomning A-yozuvi (IPv4 manzili) yo'q."]);
  });

  describe('a name no rule covers (the app resolved it)', () => {
    it('each address is a row from the system resolver; a failed one is "tekshirilmadi" with the reason', () => {
      const view = diagnosisView(NOT_COVERED, RULES);
      expect(view.rows.map((row) => [row.address, row.source, row.status])).toEqual([
        ['203.0.113.7', 'tizim resolveri', 'default'],
        ['198.51.100.2', 'tizim resolveri', 'failed'],
      ]);
      expect(view.rows[1]?.failure).toBe('Tekshirilmadi: Amal bajarilmadi.');
      expect(view.verdict).toMatchObject({ tone: 'warning', title: 'Ayrim manzillar tekshirilmadi' });
      expect(view.lookup).toEqual([
        'Tizim resolveri 2 ta IPv4 manzil berdi.',
        "1 ta manzil (loopback, link-local va h.k.) route qilinmaydi — tekshirilmadi.",
      ]);
      expect(view.notes[0]).toContain('helper uni yechmaydi');
      expect(view.noMatch).not.toBeNull();
    });

    it('an address under a rule carries that rule; the verdict follows the rows', () => {
      const covered: RsDiagnosis = {
        result: NOT_COVERED.result,
        lookup: {
          outcome: 'ok',
          truncated: true,
          excluded: 0,
          addresses: [
            {
              address: '10.1.2.3',
              ok: true,
              result: result('10.1.2.3', { match: { ruleId: RULE.subnet, via: 'subnet', precedence: 'longest-prefix' }, addresses: [address('10.1.2.3')] }),
            },
          ],
        },
      };
      const view = diagnosisView(covered, RULES);
      expect(view.rows[0]).toMatchObject({ rule: 'subnet qoidasi: 10.0.0.0/8 → Ethernet', status: 'ok' });
      expect(view.verdict).toMatchObject({ tone: 'ok', title: 'Hammasi kutilganidek — Ethernet orqali' });
      expect(view.noMatch).toBeNull();
      expect(view.lookup).toEqual(["Tizim resolveri 1 tadan ko'p IPv4 manzil berdi — faqat birinchi 1 tasi tekshirildi."]);
    });

    // DELTA-20 QA follow-up (TASK-DELTA-21): `localhost` — every address excluded.
    it('only excluded addresses (localhost): one line that says so, no "0 addresses", a neutral verdict', () => {
      const local: RsDiagnosis = { result: result('localhost', { notes: ['name-not-covered'] }), lookup: { outcome: 'ok', addresses: [], truncated: false, excluded: 1 } };
      const view = diagnosisView(local, RULES);
      expect(view.lookup).toEqual(["Tizim resolveri faqat route qilinmaydigan manzil berdi (1 ta: loopback, link-local va h.k.) — tekshiradigan manzil yo'q."]);
      expect(view.lookup.join(' ')).not.toContain('0 ta');
      expect(view.verdict).toMatchObject({ tone: 'neutral', title: 'Nom route qilinmaydigan manzilga yechiladi' });
      expect(view.verdict.advice).toContain('localhost');
      for (const [locale, zero] of [
        ['ru', 'вернул 0'],
        ['en', 'gave 0'],
      ] as const) {
        const own = diagnosisView(local, RULES, i18nFor(locale));
        expect(own.lookup).toHaveLength(1);
        expect(own.lookup[0]).not.toContain(zero);
        expect(own.verdict.title).not.toBe(view.verdict.title);
      }
      // No address at all and nothing excluded is still "not found".
      const none = diagnosisView({ ...local, lookup: { outcome: 'ok', addresses: [], truncated: false, excluded: 0 } }, RULES);
      expect(none.verdict.title).toBe('Manzil topilmadi');
    });

    it('the excluded count agrees with its verb in Russian and English (1 vs many)', () => {
      const ru = i18nFor('ru').t.diagnostics.lookup;
      expect(ru.excluded(1)).toBe('1 адрес (loopback, link-local и т. п.) не маршрутизируется — не проверялся.');
      expect(ru.excluded(2)).toBe('2 адреса (loopback, link-local и т. п.) не маршрутизируются — не проверялись.');
      expect(ru.excluded(5)).toBe('5 адресов (loopback, link-local и т. п.) не маршрутизируются — не проверялись.');
      expect(ru.excluded(21)).toBe('21 адрес (loopback, link-local и т. п.) не маршрутизируется — не проверялся.');
      const en = i18nFor('en').t.diagnostics.lookup;
      expect(en.excluded(1)).toBe('1 address (loopback, link-local, …) is never routed and was not checked.');
      expect(en.excluded(3)).toBe('3 addresses (loopback, link-local, …) are never routed and were not checked.');
    });

    it.each([
      ['not-found', 'Nom topilmadi'],
      ['timeout', '3 soniya'],
      ['failed', "yechib bo'lmadi"],
    ] as const)('lookup %s: danger, the reason as the title', (outcome, words) => {
      const view = diagnosisView({ result: NOT_COVERED.result, lookup: { outcome, addresses: [], truncated: false, excluded: 0 } }, RULES);
      expect(view.verdict.tone).toBe('danger');
      expect(view.verdict.title).toContain(words);
      expect(view.lookup).toEqual([]);
      expect(view.rows).toEqual([]);
    });
  });

  it('in English, nothing Uzbek is left', () => {
    const texts = JSON.stringify([diagnosisView(COVERED_DOMAIN, RULES, EN), diagnosisView(MISMATCH, RULES, EN), diagnosisView(NOT_COVERED, RULES, EN)]);
    for (const word of ['qoida', 'orqali', 'Tekshirilmadi', 'tizim resolveri', 'mos']) expect(texts).not.toContain(word);
    expect(texts).toContain('Everything as expected — through Ethernet');
    expect(UZ.locale).toBe('uz');
  });
});
