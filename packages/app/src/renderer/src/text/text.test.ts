import { RECONCILE_REASONS, RULE_REASON_CODES } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import type { EngineStateView } from '../hooks/useEngineState';
import type { RsConnection } from '../rs';
import {
  configIssueText,
  helperNotice,
  INSTALL_UNAVAILABLE,
  type HelperRecovery,
  HELPER_STATUS_TEXT,
  isValidationCode,
  VALIDATION_TEXT,
  RECONCILE_REASON_TEXT,
  RULE_REASON_TEXT,
  errorText,
  formatAgo,
  formatClock,
  isActiveWarning,
  ruleReasonText,
} from '.';

/** 2026-10-14 11:00 local time. */
const NOW = new Date(2026, 9, 14, 11, 0, 0).getTime();
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('reason texts', () => {
  it('every rule reason code and reconcile reason of the protocol has words', () => {
    for (const code of RULE_REASON_CODES) expect(RULE_REASON_TEXT[code].length).toBeGreaterThan(0);
    for (const reason of RECONCILE_REASONS) expect(RECONCILE_REASON_TEXT[reason].length).toBeGreaterThan(0);
    expect(Object.keys(RULE_REASON_TEXT).sort()).toEqual([...RULE_REASON_CODES].sort());
  });

  it('the active warnings (TASK-DELTA-07) are warnings, not errors', () => {
    for (const code of ['addresses-truncated', 'overridden-by-rule', 'dns-server-excluded'] as const) {
      expect(isActiveWarning({ status: 'active', reasonCode: code })).toBe(true);
    }
    expect(isActiveWarning({ status: 'active', reasonCode: null })).toBe(false);
    expect(isActiveWarning({ status: 'error', reasonCode: 'route-failed' })).toBe(false);
    expect(RULE_REASON_TEXT['overridden-by-rule']).toContain('boshqa qoida');
    expect(RULE_REASON_TEXT['dns-server-excluded']).toContain('DNS server');
  });

  it('ruleReasonText is null without a code', () => {
    expect(ruleReasonText({ reasonCode: null })).toBeNull();
    expect(ruleReasonText({ reasonCode: 'interface-down' })).toBe('Interfeys ulanmagan');
  });
});

describe('formatAgo', () => {
  it.each([
    [0, 'hozirgina'],
    [59_999, 'hozirgina'],
    [MINUTE, '1 daq oldin'],
    [2 * MINUTE + 5_000, '2 daq oldin'],
    [59 * MINUTE, '59 daq oldin'],
    [60 * MINUTE, '1 soat oldin'],
    [23 * 60 * MINUTE, '23 soat oldin'],
    [24 * 60 * MINUTE, '1 kun oldin'],
    [-5 * MINUTE, 'hozirgina'],
  ])('%i ms ago reads %s', (ms, text) => {
    expect(formatAgo(ago(ms), NOW)).toBe(text);
  });

  it('an unreadable time reads as just now', () => {
    expect(formatAgo('not a time', NOW)).toBe('hozirgina');
  });
});

describe('formatClock', () => {
  it('local HH:MM today, with the date before it on another day', () => {
    expect(formatClock(new Date(2026, 9, 14, 9, 5).toISOString(), NOW)).toBe('09:05');
    expect(formatClock(new Date(2026, 9, 13, 23, 59).toISOString(), NOW)).toBe('13.10 23:59');
    expect(formatClock(new Date(2025, 9, 14, 10, 0).toISOString(), NOW)).toBe('14.10 10:00');
    expect(formatClock('nope', NOW)).toBe('—');
  });
});

describe('errorText', () => {
  it('words every failure without the English detail', () => {
    expect(errorText('not-connected')).toContain("aloqa yo'q");
    expect(errorText('timeout')).toContain("noma'lum");
    expect(errorText('disconnected')).toBe(errorText('timeout'));
    expect(errorText('not-implemented')).toContain('hali bajara olmaydi');
    expect(errorText('internal')).toBe('Kutilmagan xato (internal).');
  });
});

describe('HELPER_STATUS_TEXT', () => {
  it('has words for every helper status of the UI', () => {
    for (const status of ['loading', 'connected', 'connecting', 'not-installed', 'disconnected', 'config-unreadable', 'incompatible', 'stopped', 'unavailable'] as const) {
      expect(HELPER_STATUS_TEXT[status].text.length).toBeGreaterThan(0);
    }
    expect(HELPER_STATUS_TEXT.connected).toEqual({ text: 'Helper ishlayapti', tone: 'success' });
    expect(HELPER_STATUS_TEXT['config-unreadable']).toEqual({ text: "Helper config'i buzilgan", tone: 'danger' });
  });
});

describe('helperNotice — the way out of each helper status (TASK-300)', () => {
  const view = (connection: RsConnection | null, helper: EngineStateView['helper'] = connection?.kind ?? 'loading'): EngineStateView => ({
    helper,
    connection,
    state: null,
    error: helper === 'unavailable' ? { code: 'forbidden', message: 'x' } : null,
  });

  it.each<[string, EngineStateView, HelperRecovery | null, string]>([
    ['disconnected', view({ kind: 'disconnected', reason: 'connection-lost' }), 'reconnect', "Helper bilan aloqa yo'q"],
    ['not-installed', view({ kind: 'not-installed' }), 'install', "Helper o'rnatilmagan"],
    ['incompatible', view({ kind: 'incompatible', helperVersion: '0.0.9', protocolVersion: 1, expectedProtocolVersion: 2 }), 'reinstall', 'Helper versiyasi mos emas'],
    ['config-unreadable', view({ kind: 'config-unreadable', helperVersion: '0.1.0' }), 'repair-config', "Helper config'i buzilgan"],
    ['connecting', view({ kind: 'connecting' }), null, 'Helper bilan ulanmoqda…'],
    ['stopped', view({ kind: 'stopped' }), null, "Ilova to'xtamoqda"],
    ['loading', view(null), null, "Holat o'qilmoqda…"],
    ['unavailable', view(null, 'unavailable'), null, "Holatni o'qib bo'lmadi"],
  ])('%s → %s', (_name, engine, recovery, title) => {
    expect(helperNotice(engine)).toMatchObject({ recovery, title });
  });

  it('connected: no notice', () => {
    expect(helperNotice(view({ kind: 'connected', helperVersion: '0.1.0' }))).toBeNull();
  });

  it('a broken config says that nothing is applied and how to repair it', () => {
    const text = helperNotice(view({ kind: 'config-unreadable', helperVersion: '0.1.0' }))?.text ?? '';
    expect(text).toContain("hech bir qoida qo'llanmayapti");
    expect(text).toContain('import');
    expect(text).toContain("bo'sh config");
  });

  it('the install button says why it is disabled', () => {
    expect(INSTALL_UNAVAILABLE).toBe("Ilova ichidan o'rnatish hali qo'shilmagan");
  });
});

describe('validation and config-file texts', () => {
  it('every shared validation code has words; isValidationCode knows them and nothing else', () => {
    for (const text of Object.values(VALIDATION_TEXT)) expect(text.length).toBeGreaterThan(5);
    expect(isValidationCode('loopback')).toBe(true);
    expect(isValidationCode('toString')).toBe(false);
    expect(isValidationCode(null)).toBe(false);
  });

  it('configIssueText names the rule and field, then the reason', () => {
    expect(configIssueText({ path: ['rules', 0, 'target'], code: 'loopback' })).toBe('1-qoida, manzil: Loopback manzillari (127.0.0.0/8) route qilinmaydi.');
    expect(configIssueText({ path: ['rules', 4, 'target'], code: 'iface-conflict' })).toBe("5-qoida, manzil: bir manzil ikki interfeysga bog'langan.");
    expect(configIssueText({ path: ['rules', 1, 'id'], code: 'duplicate-id' })).toBe("2-qoida, id: qoida id'si takrorlangan.");
    expect(configIssueText({ path: ['rules', 0, '?'], code: 'mystery' })).toBe("1-qoida: qiymat noto'g'ri.");
    expect(configIssueText({ path: ['rules'], code: 'too_big' })).toBe('500 tadan ortiq qoida.');
    expect(configIssueText({ path: [], code: 'array-too-long' })).toBe('500 tadan ortiq qoida.');
    expect(configIssueText({ path: ['version'], code: 'invalid_value' })).toContain('versiyasi mos emas');
    expect(configIssueText({ path: ['ifaceOverrides', '?'], code: null })).toBe("Interfeys almashtirishlari: qiymat noto'g'ri.");
    expect(configIssueText({ path: ['enabled'], code: 'invalid_type' })).toBe("Umumiy holat: qiymat turi noto'g'ri yoki qiymat yo'q.");
    expect(configIssueText(undefined)).toBe("Fayl config ko'rinishiga mos emas.");
  });

  it('errorText words the file and import codes', () => {
    expect(errorText('file-too-large')).toContain('1 MB');
    expect(errorText('file-not-json')).toContain('JSON');
    expect(errorText('file-not-text')).toContain('UTF-8');
    expect(errorText('file-not-regular')).toContain('oddiy fayl emas');
    expect(errorText('file-unreadable')).toContain("o'qib bo'lmadi");
    expect(errorText('import-expired')).toContain('qayta tanlang');
    expect(errorText('write-failed')).toContain("yozib bo'lmadi");
  });
});
