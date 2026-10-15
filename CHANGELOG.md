# Changelog

All notable changes to RouteSwitch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-15

### Added

- **Three languages**: Uzbek, Russian and English. On the first launch the app
  follows the macOS language (Russian or English, otherwise Uzbek); change it
  in **Settings → Til / Язык / Language** — open windows switch at once. The
  helper's own journal entries stay in English.
- **IP wildcards**: `10.*.*.*` or `10.20.*.*` in the IP or subnet field is
  saved as the matching subnet (`10.0.0.0/8`, `10.20.0.0/16`); the form shows
  the result before saving. `*` is accepted only in the trailing octets.
- **Rules backup and restore**: the app keeps the last copy of your rules in
  your user folder (`~/Library/Application Support/RouteSwitch/rules-backup.json`,
  readable only by you). When the helper has no rules but a backup exists (for
  example after removing and reinstalling the helper), the menu bar and the
  rules window offer to restore it; nothing is applied until you review and
  confirm. Settings show the backup and can restore or delete it.
- **Diagnostics** section in the rules window: enter a host, IP or URL and see
  which rule matches and why, the route each address actually takes (interface
  and gateway) against the expected one, the DNS server and resolver file in
  use, and a short hint when something does not match. Read-only — it changes
  nothing. Names no rule covers are resolved by the app with your user rights.
- **DNS server warnings**: when an interface's DNS server (or a rule's DNS
  server) is reached through the other interface, the menu bar and the rules
  window show a warning with a one-click "add rule" suggestion that pre-fills
  the Add Rule form (saved only when you click save).
- **In-app Help** (Справка / Yordam) in all three languages: getting started,
  rule types, which rule wins, what "default" means and how to put Wi‑Fi
  first, backup, diagnostics, common problems and uninstalling.

### Changed

- The IPC protocol is now version 3. **A 0.1 helper is reported as
  incompatible**: click **Reinstall the helper** once after updating the app
  (your rules are kept — the installer leaves the helper's config in place).

### Known limitations

- The builds are signed ad hoc, **not with a Developer ID and not notarized**:
  macOS asks for confirmation on the first launch (see README → Download).
- Removing the helper deletes the rules it stores, but the app's backup stays:
  after reinstalling, RouteSwitch offers to restore them. To remove everything,
  also delete `~/Library/Application Support/RouteSwitch`.
- Not supported in 0.2: wildcard domains (`*.example.com`, planned for 0.3),
  IPv6 routes, VPN (`utun`) interfaces, per-application routing.

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

[0.2.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.2.0
[0.1.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.1.0
