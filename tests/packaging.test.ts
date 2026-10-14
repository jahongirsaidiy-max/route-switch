// Packaging of the .dmg (TASK-301): electron-builder.yml, the packaged entry and its command-line
// guard, the staging script. The build itself (`npm run dist`) is checked by hand (tasks/notes);
// these tests keep the configuration in step with the code it packages.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LAUNCHD_LABEL } from '@routeswitch/shared';
import { describe, expect, it } from 'vitest';

import { forbiddenArguments } from '../packaging/argv-guard.mjs';
import { HELPER_PACKAGE_FILES, HELPER_RESOURCES_DIR, INSTALL_SCRIPT, UNINSTALL_SCRIPT } from '../packages/app/src/main/installer';

const REPO = join(import.meta.dirname, '..');
const CONFIG = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8');
const STAGE_SCRIPT = join(REPO, 'scripts', 'stage-app.sh');
const ENTRY = readFileSync(join(REPO, 'packaging', 'entry.mjs'), 'utf8');

/** `- from: X` / `to: Y` pairs of the extraResources block. */
const extraResources = (): { from: string; to: string }[] => {
  const block = CONFIG.split('\nextraResources:\n')[1]?.split(/\n\S/)[0] ?? '';
  const pairs: { from: string; to: string }[] = [];
  for (const match of block.matchAll(/- from: (\S+)\n\s+to: (\S+)/g)) pairs.push({ from: match[1] ?? '', to: match[2] ?? '' });
  return pairs;
};

describe('packaged entry: command-line switches', () => {
  it('lets a launch without arguments through', () => {
    expect(forbiddenArguments(['/Applications/RouteSwitch.app/Contents/MacOS/RouteSwitch'])).toEqual([]);
  });

  it.each([
    ['--remote-debugging-port=9222', '--remote-debugging-port'],
    ['--remote-debugging-pipe', '--remote-debugging-pipe'],
    ['--inspect=9229', '--inspect'],
    ['--inspect-brk', '--inspect-brk'],
    ['--log-net-log=/tmp/net.json', '--log-net-log'],
    ['--proxy-server=127.0.0.1:8080', '--proxy-server'],
    ['--host-resolver-rules=MAP * 127.0.0.1', '--host-resolver-rules'],
    ['--user-data-dir=/tmp/x', '--user-data-dir'],
    ['--js-flags=--allow-natives-syntax', '--js-flags'],
    ['-v=1', '-v'],
    ['-NSDocumentRevisionsDebugMode', '-NSDocumentRevisionsDebugMode'],
    ['-psn_0_1x', '-psn_0_1x'],
    ['-psn_', '-psn_'],
    ['-psn_0_1=--x', '-psn_0_1'],
  ])('refuses %s, naming the switch but never its value', (arg, name) => {
    const found = forbiddenArguments(['/x/RouteSwitch', arg]);
    expect(found).toEqual([name]);
    expect(found.join(' ')).not.toContain('=');
  });

  it('lets the process serial number LaunchServices adds through (first Open of a quarantined app)', () => {
    expect(forbiddenArguments(['/x/RouteSwitch', '-psn_0_12345'])).toEqual([]);
  });

  it.each(['https://example.com', '/etc/hosts', 'routeswitch://anything', ''])('refuses the positional argument %j without repeating it', (arg) => {
    expect(forbiddenArguments(['/x/RouteSwitch', arg])).toEqual(['<argument>']);
  });

  it('looks at every argument, not only the first', () => {
    expect(forbiddenArguments(['/x/RouteSwitch', '-psn_0_1', 'positional', '--proxy-server=a', '--log-net-log=b'])).toEqual([
      '<argument>',
      '--proxy-server',
      '--log-net-log',
    ]);
  });

  it('checks before anything of the app is loaded, and exits instead of starting', () => {
    const check = ENTRY.indexOf('forbiddenArguments(process.argv)');
    const start = ENTRY.indexOf("await import('./main/index.js')");
    expect(check).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(check);
    const refuse = ENTRY.indexOf('app.exit(2);');
    expect(refuse).toBeGreaterThan(check);
    expect(refuse).toBeLessThan(start);
    expect(ENTRY.slice(refuse, start)).toMatch(/^app\.exit\(2\);\s*\} else \{\s*$/);
    // No other import of app code before the check.
    expect(ENTRY.split('\n').filter((line) => line.startsWith('import '))).toEqual([
      "import process from 'node:process';",
      "import { app } from 'electron';",
      "import { forbiddenArguments } from './argv-guard.mjs';",
    ]);
  });
});

describe('electron-builder.yml', () => {
  it('builds RouteSwitch.app as a menu bar utility in a .dmg', () => {
    expect(CONFIG).toMatch(/^appId: uz\.routeswitch\.app$/m);
    expect(CONFIG).toMatch(/^productName: RouteSwitch$/m);
    expect(CONFIG).toMatch(/^ {2}category: public\.app-category\.utilities$/m);
    expect(CONFIG).toMatch(/^ {2}extendInfo:\n {4}LSUIElement: true$/m);
    expect(CONFIG).toMatch(/^ {4}- target: dmg$/m);
    expect(CONFIG).toMatch(/^ {2}main: \.\/out\/entry\.mjs$/m);
  });

  it('names the app RouteSwitch at run time, so its userData is not the dev app\'s (@routeswitch/app)', () => {
    const metadata = CONFIG.split('\nextraMetadata:\n')[1]?.split(/\n\S/)[0] ?? '';
    expect(metadata).toMatch(/^ {2}productName: RouteSwitch$/m);
  });

  it('puts the helper package where installer.ts looks for it, with every file it checks', () => {
    const resources = extraResources();
    expect(resources.map((entry) => entry.to).sort()).toEqual(
      [INSTALL_SCRIPT, UNINSTALL_SCRIPT, ...HELPER_PACKAGE_FILES].map((name) => `${HELPER_RESOURCES_DIR}/${name}`).sort(),
    );
    expect(resources.find((entry) => entry.to.endsWith(`/${LAUNCHD_LABEL}`))?.from).toBe(`../../build/helper/\${arch}/${LAUNCHD_LABEL}`);
    // The sources outside the build output exist in the repository (paths are relative to build/app-stage).
    for (const { from } of resources.filter((entry) => !entry.from.includes('${arch}'))) {
      expect(existsSync(join(REPO, 'build', 'app-stage', from))).toBe(true);
    }
  });

  it('flips the fuses the security review asked for', () => {
    for (const [fuse, value] of [
      ['runAsNode', 'false'],
      ['enableNodeOptionsEnvironmentVariable', 'false'],
      ['enableNodeCliInspectArguments', 'false'],
      ['onlyLoadAppFromAsar', 'true'],
      ['enableEmbeddedAsarIntegrityValidation', 'true'],
      ['grantFileProtocolExtraPrivileges', 'false'],
    ] as const) {
      expect(CONFIG).toMatch(new RegExp(`^ {2}${fuse}: ${value}$`, 'm'));
    }
    expect(CONFIG).toMatch(/^asar: true$/m);
  });

  it('packages exactly the Electron the app is developed and tested with', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages', 'app', 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const packaged = /^electronVersion: (\d+\.\d+\.\d+)$/m.exec(CONFIG)?.[1];
    expect(packaged).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packaged).toBe(manifest.devDependencies['electron']);
  });

  it('holds no signing secret: identity is ad hoc, certificates come from the environment only', () => {
    expect(CONFIG).toMatch(/^ {2}identity: '-'$/m);
    expect(CONFIG).not.toMatch(/CSC_LINK:|CSC_KEY_PASSWORD:|APPLE_(ID|APP_SPECIFIC_PASSWORD|TEAM_ID):|\.p12|certificateFile|certificatePassword/);
    expect(CONFIG).toMatch(/^publish: null$/m);
  });

  it('leaves the helper\'s own signature alone', () => {
    expect(CONFIG).toContain("signIgnore:\n    - 'helper/com\\.routeswitch\\.helper$'");
    expect(new RegExp('helper/com\\.routeswitch\\.helper$').test(`${HELPER_RESOURCES_DIR}/${LAUNCHD_LABEL}`)).toBe(true);
  });
});

describe('scripts/stage-app.sh', () => {
  it('is strict bash, executable, valid syntax, and only ever replaces its own scratch directory', async () => {
    const text = readFileSync(STAGE_SCRIPT, 'utf8');
    expect(text.startsWith('#!/bin/bash\n')).toBe(true);
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(statSync(STAGE_SCRIPT).mode & 0o111).toBe(0o111);
    const syntax = await new Promise<number>((resolve) => {
      execFile('/bin/bash', ['-n', STAGE_SCRIPT], (error) => {
        resolve(error === null ? 0 : 1);
      });
    });
    expect(syntax).toBe(0);
    expect(text).toMatch(/^readonly STAGE='build\/app-stage'$/m);
    expect(text.match(/rm -rf/g)).toHaveLength(1);
    expect(text).toContain('rm -rf -- "${STAGE}"');
    // Never the live build the dev app runs from (comments aside).
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/packages\/app\/out\b|\$\{APP\}\/out\b/);
    expect(text).toContain('cp -- packaging/entry.mjs packaging/argv-guard.mjs "${STAGE}/out/"');
  });
});
