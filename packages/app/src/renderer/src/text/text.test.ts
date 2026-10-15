import { RECONCILE_REASONS, RULE_REASON_CODES } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { i18nFor, LOCALES } from '../../../i18n';
import type { EngineStateView } from '../hooks/useEngineState';
import type { RsConnection } from '../rs';
import {
  configIssueText,
  helperNotice,
  INSTALL_TEXT,
  type HelperRecovery,
  HELPER_STATUS_TEXT,
  isValidationCode,
  VALIDATION_TEXT,
  RECONCILE_REASON_TEXT,
  RULE_REASON_TEXT,
  errorText,
  formatAgo,
  formatClock,
  helperStatusText,
  isActiveWarning,
  loadingNotice,
  ruleReasonText,
  UZ,
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
    expect(ruleReasonText({ reasonCode: null }, UZ)).toBeNull();
    expect(ruleReasonText({ reasonCode: 'interface-down' }, UZ)).toBe('Interfeys ulanmagan');
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
    expect(formatAgo(ago(ms), NOW, UZ)).toBe(text);
  });

  it('an unreadable time reads as just now', () => {
    expect(formatAgo('not a time', NOW, UZ)).toBe('hozirgina');
  });
});

describe('formatClock', () => {
  it('local HH:MM today, with the date before it on another day (Uzbek: DD.MM)', () => {
    expect(formatClock(new Date(2026, 9, 14, 9, 5).toISOString(), NOW, UZ)).toBe('09:05');
    expect(formatClock(new Date(2026, 9, 13, 23, 59).toISOString(), NOW, UZ)).toBe('13.10 23:59');
    expect(formatClock(new Date(2025, 9, 14, 10, 0).toISOString(), NOW, UZ)).toBe('14.10 10:00');
    expect(formatClock('nope', NOW, UZ)).toBe('—');
  });

  it('in the language it is given', () => {
    expect(formatClock(new Date(2026, 9, 13, 23, 59).toISOString(), NOW, i18nFor('ru'))).toBe('13.10 23:59');
    expect(formatAgo(ago(2 * MINUTE), NOW, i18nFor('ru'))).toBe('2 минуты назад');
    expect(formatAgo(ago(2 * MINUTE), NOW, i18nFor('en'))).toBe('2 min ago');
  });
});

describe('errorText', () => {
  it('words every failure without the English detail', () => {
    expect(errorText('not-connected', UZ)).toContain("aloqa yo'q");
    expect(errorText('timeout', UZ)).toContain("noma'lum");
    expect(errorText('disconnected', UZ)).toBe(errorText('timeout', UZ));
    expect(errorText('not-implemented', UZ)).toContain('hali bajara olmaydi');
    expect(errorText('internal', UZ)).toBe('Kutilmagan xato (internal).');
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
    expect(helperNotice(engine, UZ)).toMatchObject({ recovery, title });
  });

  it('connected: no notice', () => {
    expect(helperNotice(view({ kind: 'connected', helperVersion: '0.1.0' }), UZ)).toBeNull();
  });

  it('a broken config says that nothing is applied and how to repair it', () => {
    const text = helperNotice(view({ kind: 'config-unreadable', helperVersion: '0.1.0' }), UZ)?.text ?? '';
    expect(text).toContain("hech bir qoida qo'llanmayapti");
    expect(text).toContain('import');
    expect(text).toContain("bo'sh config");
  });

  it('the install button names what it does', () => {
    expect(INSTALL_TEXT.install).toBe("Helper'ni o'rnatish");
    expect(INSTALL_TEXT.reinstall).toBe("Helper'ni qayta o'rnatish");
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
    expect(configIssueText({ path: ['rules', 0, 'target'], code: 'loopback' }, UZ)).toBe('1-qoida, manzil: Loopback manzillari (127.0.0.0/8) route qilinmaydi.');
    expect(configIssueText({ path: ['rules', 4, 'target'], code: 'iface-conflict' }, UZ)).toBe("5-qoida, manzil: bir manzil ikki interfeysga bog'langan.");
    expect(configIssueText({ path: ['rules', 1, 'id'], code: 'duplicate-id' }, UZ)).toBe("2-qoida, id: qoida id'si takrorlangan.");
    expect(configIssueText({ path: ['rules', 0, '?'], code: 'mystery' }, UZ)).toBe("1-qoida: qiymat noto'g'ri.");
    expect(configIssueText({ path: ['rules'], code: 'too_big' }, UZ)).toBe('500 tadan ortiq qoida.');
    expect(configIssueText({ path: [], code: 'array-too-long' }, UZ)).toBe('500 tadan ortiq qoida.');
    expect(configIssueText({ path: ['version'], code: 'invalid_value' }, UZ)).toContain('versiyasi mos emas');
    expect(configIssueText({ path: ['ifaceOverrides', '?'], code: null }, UZ)).toBe("Interfeys almashtirishlari: qiymat noto'g'ri.");
    expect(configIssueText({ path: ['enabled'], code: 'invalid_type' }, UZ)).toBe("Umumiy holat: qiymat turi noto'g'ri yoki qiymat yo'q.");
    expect(configIssueText(undefined, UZ)).toBe("Fayl config ko'rinishiga mos emas.");
  });

  it('errorText words the file and import codes', () => {
    expect(errorText('file-too-large', UZ)).toContain('1 MB');
    expect(errorText('file-not-json', UZ)).toContain('JSON');
    expect(errorText('file-not-text', UZ)).toContain('UTF-8');
    expect(errorText('file-not-regular', UZ)).toContain('oddiy fayl emas');
    expect(errorText('file-unreadable', UZ)).toContain("o'qib bo'lmadi");
    expect(errorText('import-expired', UZ)).toContain('qayta tanlang');
    expect(errorText('write-failed', UZ)).toContain("yozib bo'lmadi");
  });
});

describe('every text in the three languages (TASK-DELTA-11)', () => {
  it.each(LOCALES)('%s: rule and reconcile reasons come from that language', (locale) => {
    const i18n = i18nFor(locale);
    for (const code of RULE_REASON_CODES) expect(ruleReasonText({ reasonCode: code }, i18n)).toBe(i18n.t.ruleReason[code]);
    expect(Object.keys(i18n.t.ruleReason).sort()).toEqual([...RULE_REASON_CODES].sort());
    expect(Object.keys(i18n.t.reconcileReason).sort()).toEqual([...RECONCILE_REASONS].sort());
  });

  it('errorText and helper texts follow the language; tones do not', () => {
    expect(errorText('not-connected', i18nFor('ru'))).toBe('Нет связи с helper — ничего не отправлено.');
    expect(errorText('not-connected', i18nFor('en'))).toBe('No connection to the helper — nothing was sent.');
    expect(errorText('internal', i18nFor('en'))).toBe('Unexpected error (internal).');
    expect(helperStatusText('connected', i18nFor('ru'))).toEqual({ text: 'Helper работает', tone: 'success' });
    expect(helperStatusText('disconnected', i18nFor('en'))).toEqual({ text: 'Helper is not running', tone: 'danger' });
    expect(loadingNotice(i18nFor('en')).title).toBe('Reading the status…');
  });

  it('a code from a newer main process still gets words', () => {
    expect(errorText('brand-new' as never, UZ)).toBe('Kutilmagan xato (brand-new).');
    expect(errorText('brand-new' as never, i18nFor('ru'))).toBe('Непредвиденная ошибка (brand-new).');
  });

  it('helperNotice speaks the language it is given', () => {
    const engine: EngineStateView = {
      helper: 'incompatible',
      connection: { kind: 'incompatible', helperVersion: '0.0.9', protocolVersion: 1, expectedProtocolVersion: 2 },
      state: null,
      error: null,
    };
    expect(helperNotice(engine, i18nFor('ru'))).toEqual({
      title: 'Версия helper не подходит',
      text: 'Helper v0.0.9 использует другой протокол (1, нужен: 2). Переустановите helper.',
      tone: 'danger',
      recovery: 'reinstall',
    });
    const lost: EngineStateView = { helper: 'disconnected', connection: { kind: 'disconnected', reason: 'timeout' }, state: null, error: null };
    expect(helperNotice(lost, i18nFor('en'))?.text).toBe('The helper did not answer — reconnecting. Routes already applied stay with the helper.');
  });

  it('configIssueText speaks the language it is given', () => {
    expect(configIssueText({ path: ['rules', 0, 'target'], code: 'loopback' }, i18nFor('ru'))).toBe(
      'Правило 1, адрес: Loopback-адреса (127.0.0.0/8) не маршрутизируются.',
    );
    expect(configIssueText({ path: ['rules', 2], code: 'duplicate-id' }, i18nFor('en'))).toBe('Rule 3: a rule id is repeated.');
    expect(configIssueText({ path: ['rules', 0, 'target'], code: 'invalid-wildcard' }, UZ)).toContain('10.*.*.*');
    expect(configIssueText({ path: ['enabled'], code: 'toString' }, i18nFor('en'))).toBe('Overall state: the value is invalid.');
    expect(configIssueText(undefined, i18nFor('ru'))).toBe('Файл не похож на конфигурацию.');
  });
});
