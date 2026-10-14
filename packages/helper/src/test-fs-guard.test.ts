import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config, PATHS } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { createLogger } from './logger';
import { createResolverFiles } from './resolver';
import { createFakeCommandRunner } from './test-utils';
import { FS_GUARD_CODE, fsGuardHits, isGuardedPath } from './test-fs-guard';

// Control tests of the vitest setup file: they aim at the real resolver directory on purpose and
// must be refused before any real file-system call. They never run as root (nothing here would
// change the machine anyway: every call below is refused).

describe('test file-system guard', () => {
  it.each([
    PATHS.resolverDir,
    '/etc/resolver/corp.local',
    '/private/etc/resolver',
    '/private/etc/resolver/x',
    '/ETC/Resolver/corp.local',
    '/etc//resolver/./x',
    '/tmp/../etc/resolver/x',
    new URL('file:///etc/resolver/x'),
    Buffer.from('/etc/resolver/x'),
  ])('guards %s', (path) => {
    expect(isGuardedPath(path)).toBe(true);
  });

  it.each(['/etc/resolverx', '/etc/hosts', '/private/etc', tmpdir(), 'resolver/x'])('leaves %s alone', (path) => {
    expect(isGuardedPath(path)).toBe(false);
  });

  it('refuses every kind of call on the real directory, promise and sync, before it is made', async () => {
    const before = fsGuardHits();
    const outside = join(tmpdir(), 'routeswitch-guard-never-created');
    const refused: unknown = expect.objectContaining({ code: FS_GUARD_CODE });

    await expect(fsPromises.readdir(PATHS.resolverDir)).rejects.toEqual(refused);
    await expect(fsPromises.lstat(PATHS.resolverDir)).rejects.toEqual(refused);
    await expect(fsPromises.open('/etc/resolver/corp.local', 'r')).rejects.toEqual(refused);
    await expect(fsPromises.unlink('/etc/resolver/corp.local')).rejects.toEqual(refused);
    await expect(fsPromises.mkdir('/private/etc/resolver', { mode: 0o755 })).rejects.toEqual(refused);
    await expect(fsPromises.chmod(PATHS.resolverDir, 0o755)).rejects.toEqual(refused);
    // Both arguments of a rename.
    await expect(fsPromises.rename(outside, '/etc/resolver/corp.local')).rejects.toEqual(refused);
    await expect(fsPromises.rename('/etc/resolver/corp.local', outside)).rejects.toEqual(refused);
    await expect(fs.promises.stat(PATHS.resolverDir)).rejects.toEqual(refused);
    expect(() => fs.readdirSync(PATHS.resolverDir)).toThrow(FS_GUARD_CODE);
    expect(() => {
      fs.writeFileSync('/etc/resolver/corp.local', 'x');
    }).toThrow(FS_GUARD_CODE);
    expect(() => {
      fs.renameSync(outside, '/etc/resolver/x');
    }).toThrow(FS_GUARD_CODE);

    expect(fsGuardHits() - before).toBe(12);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('turns the resolver module with its default file system on the real directory into `resolver-failed`', async () => {
    const before = fsGuardHits();
    const runner = createFakeCommandRunner();
    const files = createResolverFiles({ dir: PATHS.resolverDir, runner, logger: createLogger({ sinks: [] }) });
    const config = Config.parse({
      version: 1,
      rules: [{ id: '00000000-0000-4000-8000-000000000005', kind: 'domain', target: 'corp.local', iface: 'ethernet', dns: '10.30.0.53' }],
    });

    const result = await files.sync(config);
    await files.removeAll();

    expect(result.issues.get('00000000-0000-4000-8000-000000000005')).toEqual({
      reasonCode: 'resolver-failed',
      reason: `Resolver files cannot be managed: the resolver directory cannot be read (${FS_GUARD_CODE})`,
    });
    expect(fsGuardHits() - before).toBeGreaterThan(0);
    expect(runner.calls).toEqual([]);
  });
});
