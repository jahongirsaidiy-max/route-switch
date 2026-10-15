import { describe, expect, it } from 'vitest';

import { MAX_RULES_BACKUP_FILE_BYTES, RULES_BACKUP_VERSION, RulesBackupFile } from './index';

const RULE = {
  id: '6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b',
  kind: 'subnet',
  target: '10.0.0.0/8',
  iface: 'ethernet',
  enabled: true,
};

const valid = () => ({
  version: 1,
  savedAt: '2026-10-15T08:30:00.000Z',
  configRevision: 4,
  config: { version: 1, enabled: true, rules: [RULE] },
});

describe('RulesBackupFile', () => {
  it('reads a backup and drops keys it does not know', () => {
    const parsed = RulesBackupFile.parse({ ...valid(), extra: true });
    expect(parsed.version).toBe(RULES_BACKUP_VERSION);
    expect(parsed.config.rules).toHaveLength(1);
    expect(Object.hasOwn(parsed, 'extra')).toBe(false);
  });

  it.each([
    ['another version', { ...valid(), version: 2 }],
    ['a time without milliseconds', { ...valid(), savedAt: '2026-10-15T08:30:00Z' }],
    ['a time that is not one', { ...valid(), savedAt: 'yesterday' }],
    ['a negative revision', { ...valid(), configRevision: -1 }],
    ['a fractional revision', { ...valid(), configRevision: 1.5 }],
    ['a forbidden destination (ADR-001)', { ...valid(), config: { version: 1, enabled: true, rules: [{ ...RULE, target: '0.0.0.0/0' }] } }],
    ['a /33', { ...valid(), config: { version: 1, enabled: true, rules: [{ ...RULE, target: '10.0.0.0/33' }] } }],
    ['no config', { ...valid(), config: undefined }],
    ['not an object', 'backup'],
  ])('refuses %s', (_name, value) => {
    expect(RulesBackupFile.safeParse(value).success).toBe(false);
  });

  it('a backup file is at most 1 MiB', () => {
    expect(MAX_RULES_BACKUP_FILE_BYTES).toBe(1_048_576);
  });
});
