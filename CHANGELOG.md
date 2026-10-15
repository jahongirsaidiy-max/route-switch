# Changelog

All notable changes to RouteSwitch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-15

The first public release.

### Added

- **Routing rules** of three kinds, each bound to Ethernet or Wi‑Fi:
  - IP — a single IPv4 host (e.g. `10.20.30.40`);
  - subnet — an IPv4 CIDR block (e.g. `10.0.0.0/8`);
  - domain — e.g. `corp.local`: its A records are resolved and applied as host
    routes, then refreshed on a per-rule interval (60 s – 24 h, 10 min by default).
- **Scoped DNS** for internal domains: an optional DNS server per domain rule,
  written as `/etc/resolver/<domain>` (only files marked `managed-by: routeswitch`
  are ever touched).
- **Automatic re-apply** when a cable is plugged or unplugged, the Wi‑Fi network
  changes or the Mac wakes from sleep, plus a periodic check.
- **Root helper daemon** run by `launchd`: the only process that touches the
  routing table and `/etc/resolver`. It keeps working when the app is closed.
  Installed once from the app with the administrator password.
- **Declarative engine**: computes the routes that should exist, compares them
  with the ones it applied and changes only the difference; deletes only routes
  it added itself; never touches the default route, loopback, link-local or
  multicast ranges.
- **Menu bar window**: interfaces with their address and gateway, which one is
  the default, active rules, on/off switch and "apply again".
- **Rules window**: search and filter, enable/disable, edit, delete, overlap
  warnings, and an "add rule" form that validates the input and can test which
  interface a target would use right now.
- **Config import / export** as JSON, with a preview before an import replaces
  the rules.
- **Journal** of helper and app events, and **settings**: launch at login, a
  manual choice of the Ethernet adapter, the Wi‑Fi service order (with the command to
  put Wi‑Fi first), helper reinstall and removal.
- **Packaging**: one `.dmg` per architecture (Apple silicon and Intel), app and
  helper of the same architecture, Electron fuses and a command-line argument
  guard in the packaged app.

### Known limitations

- The builds are signed ad hoc, **not with a Developer ID and not notarized**:
  macOS asks for confirmation on the first launch (see README → Download).
- **Removing the helper also deletes your rules** (its `config.json`).
  Export the config first if you want to keep them.
- Not supported in 0.1: wildcard domains (`*.example.com`), IPv6 routes, VPN
  (`utun`) interfaces, per-application routing.
- The user interface is in Uzbek only.

[0.1.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.1.0
