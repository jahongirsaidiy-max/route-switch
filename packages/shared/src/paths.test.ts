import { describe, expect, it } from 'vitest';

import { LAUNCHD_LABEL, LAUNCHD_SERVICE_TARGET, PATHS, RESOLVER_MARKER } from './paths';

describe('paths', () => {
  it('matches the file locations of the design document', () => {
    expect(PATHS).toEqual({
      helperBinary: '/Library/PrivilegedHelperTools/com.routeswitch.helper',
      launchDaemonPlist: '/Library/LaunchDaemons/com.routeswitch.helper.plist',
      supportDir: '/Library/Application Support/RouteSwitch',
      config: '/Library/Application Support/RouteSwitch/config.json',
      state: '/Library/Application Support/RouteSwitch/state.json',
      socket: '/var/run/routeswitch.sock',
      logDir: '/Library/Logs/RouteSwitch',
      log: '/Library/Logs/RouteSwitch/helper.log',
      resolverDir: '/etc/resolver',
      newsyslogConf: '/etc/newsyslog.d/com.routeswitch.helper.conf',
    });
  });

  it('keeps the state file next to the config and the log inside its directory', () => {
    expect(PATHS.config.startsWith(`${PATHS.supportDir}/`)).toBe(true);
    expect(PATHS.state.startsWith(`${PATHS.supportDir}/`)).toBe(true);
    expect(PATHS.log.startsWith(`${PATHS.logDir}/`)).toBe(true);
  });

  it('uses absolute, normalised paths only', () => {
    for (const path of Object.values(PATHS)) {
      expect(path.startsWith('/')).toBe(true);
      expect(path.endsWith('/')).toBe(false);
      expect(path).not.toMatch(/\/\.{1,2}(\/|$)|\/\//);
    }
  });

  it('exposes the launchd label and the resolver marker', () => {
    expect(LAUNCHD_LABEL).toBe('com.routeswitch.helper');
    expect(LAUNCHD_SERVICE_TARGET).toBe('system/com.routeswitch.helper');
    expect(RESOLVER_MARKER).toBe('# managed-by: routeswitch');
    expect(RESOLVER_MARKER).not.toContain('\n');
  });
});
