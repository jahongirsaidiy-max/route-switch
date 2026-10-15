# Changelog

All notable changes to RouteSwitch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-15

### Added

- **Wildcard domain rules**: type `*.corp.local` in a Domain rule and every
  subdomain of `corp.local` (`app.corp.local`, `a.b.corp.local`, …) goes
  through the rule's interface. Only subdomains are covered — `corp.local`
  itself needs its own rule. Subdomains are not known in advance, so routes
  are added on lookup: the helper runs a small DNS proxy on the loopback
  address (`127.0.0.1`, port 954, only while a wildcard rule is enabled),
  `/etc/resolver/corp.local` points lookups for the domain at it, and
  it adds a host route for each IP of an answer before the answer reaches the
  app. With **Resolve through an internal DNS server** set, lookups are
  forwarded to that server, otherwise to the DNS servers of the rule's
  interface.
- The rules table and the menu bar show how many IPs each wildcard rule has
  learned; Diagnostics shows which wildcard rule covers a name.
- Which rule wins among names: an exact domain rule beats a wildcard, a deeper
  wildcard beats a shallower one. When one IP falls under two rules with
  different interfaces, the losing wildcard rule says so in its status.
- A new Help topic, "Wildcard domains", in all three languages.

### Changed

- The IPC protocol is now version 4. **A 0.2 helper is reported as
  incompatible**: click **Reinstall the helper** once after updating the app
  (your rules are kept — the installer leaves the helper's config in place).
- When routing is turned off, the helper is removed or it stops, resolver
  files go first, then the DNS proxy, then the routes — names under a wildcard
  domain are never sent to a proxy that is gone.

### Known limitations

- Apps that resolve names themselves bypass the proxy: with **Secure DNS**
  (DNS over HTTPS) turned on in a browser, wildcard rules do not apply to that
  browser — turn it off or add an exception for the domain.
- IPv6 answers (AAAA) are passed through unchanged and get no route; an app
  that prefers IPv6 may use the default interface.
- A learned route lives at least 15 minutes and at most a day (the answer's
  TTL within those bounds). Up to 256 IPs per wildcard rule and 4096 for all
  of them together; when full, the oldest learned IP makes room.
- An address an app cached before the proxy started is learned on its next
  lookup.
- An exact rule for a name under a wildcard (for example `www.example.com` →
  Wi‑Fi under `*.example.com` → Ethernet) applies to that name's own records.
  If the name is an alias (CNAME) of another name under the same wildcard,
  macOS looks the alias target up separately and that lookup follows the
  target's own rule. Planned fix in 0.3.1.
- The builds are still signed ad hoc, not with a Developer ID and not
  notarized (see README → Download).
- Not supported: IPv6 routes, VPN (`utun`) interfaces, per-application
  routing.

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

[0.3.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.3.0
[0.2.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.2.0
[0.1.0]: https://github.com/jahongirsaidiy-max/route-switch/releases/tag/v0.1.0
