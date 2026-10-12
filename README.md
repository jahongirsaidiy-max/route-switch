# RouteSwitch

**English** · [Русский](README.ru.md)

RouteSwitch is a macOS menu bar app that sends traffic for the IPs, subnets and
domains you choose through a specific network interface — Ethernet or Wi‑Fi —
while everything else stays on the default route.

The typical setup: a Mac connected to an office network by cable and to the
internet over Wi‑Fi. Internal systems go through Ethernet, the rest goes
through Wi‑Fi, and you don't have to touch `route` by hand every time the
network changes.

> **Status: early development.** The architecture and scope are defined, the
> implementation is in progress. Nothing here is ready for daily use yet.

## What it does (MVP scope)

- **Three kinds of rules**
  - **IP** — a single host, e.g. `172.16.12.40`
  - **Subnet** — an IPv4 CIDR block, e.g. `10.0.0.0/8`
  - **Domain** — e.g. `corp.local`; its A records are resolved and applied as
    IP routes, then refreshed periodically
- **Per-rule interface** — each rule is bound to Ethernet or Wi‑Fi.
- **Scoped DNS for internal domains** — a per-domain resolver
  (`/etc/resolver/<domain>`) so internal names are resolved by the internal DNS
  server instead of the Wi‑Fi one.
- **Automatic re-apply** — rules are restored when a cable is plugged or
  unplugged, the Wi‑Fi network changes, or the Mac wakes from sleep.
- **Keeps working when the app is closed** — routing is handled by a background
  helper, so quitting the UI does not drop your routes.
- **Menu bar UI** — a compact status window, a rules manager, and an "add rule"
  form with a "test" button that shows which interface a target would use.
- **Config import / export** as JSON.

## How it works

RouteSwitch runs as two processes that talk only over a Unix domain socket:

```
┌─────────────────────────┐        JSON-lines over         ┌──────────────────────────┐
│ Electron app (user)     │  /var/run/routeswitch.sock     │ Helper daemon (root)     │
│ tray · windows · UI     │ ─────────────────────────────▶ │ config · routing engine  │
│ sends rules, shows state│ ◀───────────────────────────── │ network monitor · DNS    │
└─────────────────────────┘        state / log events      └──────────────────────────┘
                                                                        │
                                                          /sbin/route · /etc/resolver
```

- The **app** is only a UI and a client. It never runs `sudo` (apart from the
  one-time helper installation) and never writes the config file directly.
- The **helper** is the only process that touches the routing table and
  `/etc/resolver`. It stores the config, watches for network changes and keeps
  the system in sync with your rules.
- The routing engine is **declarative**: it computes the routes that should
  exist, compares them with the routes it has applied, and changes only the
  difference. The same reconcile step runs on startup, on config changes, on
  network changes and on a timer.
- Rules store an interface **role** (`ethernet` / `wifi`), not a device name
  like `en5`, so they keep working when you switch adapters.
- Only standard macOS tools are used (`route`, `networksetup`, `ipconfig`,
  `scutil`). No kernel extension and no Network Extension.

## Security model

The helper runs as root and accepts commands over a socket, so it is treated
as the most sensitive part of the project:

- **No shell.** System tools are invoked with `execFile`, absolute paths and
  argument arrays — never through a shell or string concatenation.
- **The helper re-validates everything** it receives, using the same schema as
  the app; IPs and CIDRs are parsed and normalised before use.
- **A fixed set of operations.** The protocol has no "run arbitrary command"
  method.
- **Default route protection.** `0.0.0.0/0`, `default`, loopback and multicast
  ranges are never added or removed, and the engine only deletes routes it
  added itself.
- **Resolver files are marked.** Only files carrying a `managed-by: routeswitch`
  marker are created, changed or removed; your own resolver files are left
  alone.
- **Restricted socket** (`0660`, group `staff`) and limits on the number of
  rules, IPs per domain and refresh rate.
- **Hardened Electron**: context isolation, sandboxed renderer, no remote
  content, strict CSP.
- **Clean uninstall** removes the helper, its routes and its resolver files.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, one npm-workspaces monorepo |
| App | Electron, React, Vite |
| Helper | Node.js daemon compiled to a single binary, run by `launchd` |
| IPC | Unix domain socket, JSON-lines |
| Validation | zod, shared between app and helper |
| Tests | vitest |

Planned layout:

```
packages/
  shared/   # types, zod schemas, IPC protocol, CIDR helpers
  helper/   # root daemon: engine, interface detection, routes, DNS, monitor
  app/      # Electron: main, preload, renderer (React UI)
scripts/    # helper install / uninstall
```

## Development

Requires Node.js 24 or newer and npm 11.

```bash
npm install        # install dependencies for all workspaces
npm run verify     # lint + typecheck + tests
```

The individual steps are also available as `npm run lint`,
`npm run typecheck` and `npm test`.

To run the Electron app:

```bash
npm run dev -w @routeswitch/app      # start the app with hot reload
npm run build -w @routeswitch/app    # production build into packages/app/out
npm run start -w @routeswitch/app    # build, then run the production build
```

## Not in the MVP

- Wildcard domains (`*.example.com`) — would need a DNS proxy
- IPv6 routes
- VPN (`utun`) interfaces
- Per-application routing — would need a Network Extension
- Mac App Store distribution

## Roadmap

1. **Routing core** — shared schemas, interface detection, reconcile engine
   driven from a config file.
2. **Persistent daemon** — network monitoring, domain rules and scoped DNS,
   crash-safe cleanup, socket IPC, `launchd` installation.
3. **Electron app** — tray, menu bar window, rules manager, helper install
   flow, import/export, log and settings.
4. **Polish** — error states in the UI, launch at login, `.dmg` build,
   uninstall script.

## Requirements

- macOS
- An administrator password, once, to install the helper
