// The Help in English (shape: `HelpDoc`; the topics are those of `uz.ts`).
// UI names come from the dictionary (`MESSAGES.en`).

import { MESSAGES } from '../../../i18n';
import { code, list, note, p, steps, sub, terminal, toSection, toTopic, ui, type HelpDoc } from './types';

const m = MESSAGES.en;
const section = m.rules.sections;

export const helpEn: HelpDoc = {
  title: 'Help',
  subtitle: 'How RouteSwitch works, and what to do when something does not.',
  contents: 'Contents',
  topics: {
    start: {
      title: 'Getting started',
      blocks: [
        p(
          'RouteSwitch sends the traffic for the addresses you choose (an IP, a subnet or a domain) through one interface — Ethernet or Wi‑Fi. ',
          'All other traffic goes as before, through the default route. The usual case: internal systems over Ethernet, the internet over Wi‑Fi.',
        ),
        steps(
          [
            'Click the RouteSwitch icon in the menu bar. If it says “',
            m.notice.notInstalledTitle,
            '”, click ',
            ui(m.install.install),
            ' and enter the administrator password once.',
          ],
          [ui(m.menuBar.manageRules), ' → ', toSection('rules', section.rules), ' → ', ui(m.rules.addRule), '.'],
          [
            'Type ',
            ui(m.addRule.kinds.subnet),
            ', address ',
            code('10.0.0.0/8'),
            ', interface ',
            ui('Ethernet'),
            '. ',
            ui(m.addRule.test),
            ' shows which interface the address uses right now; then ',
            ui(m.addRule.save),
            '.',
          ],
        ),
        p(
          'The helper — the only process that touches routing — runs as root under launchd. Your routes stay in place even when the app is closed.',
        ),
        p('To check it in Terminal (this only reads, it changes nothing):'),
        terminal('Check a route', 'route -n get 10.1.2.3'),
        p(
          'The ',
          code('interface'),
          ' line of the answer should name the Ethernet device. Rules are applied again automatically when the cable or the Wi‑Fi network changes, and when the Mac wakes from sleep.',
        ),
      ],
    },

    'rule-types': {
      title: 'Kinds of rules',
      blocks: [
        list(
          [ui(m.addRule.kinds.ip), ' — a single host, e.g. ', code('10.20.30.40'), '.'],
          [
            ui(m.addRule.kinds.subnet),
            ' — a network in CIDR form, e.g. ',
            code('10.0.0.0/8'),
            '. The most reliable choice for a whole internal network.',
          ],
          [
            'IP wildcard — ',
            code('10.*.*.*'),
            ' or ',
            code('10.20.*.*'),
            '. A “*” may only stand for the last octets; the rule is saved as a subnet: ',
            code('10.*.*.*'),
            ' → ',
            code('10.0.0.0/8'),
            ', ',
            code('10.20.*.*'),
            ' → ',
            code('10.20.0.0/16'),
            '.',
          ],
          [
            ui(m.addRule.kinds.domain),
            ' — e.g. ',
            code('corp.local'),
            '. The domain’s A records (IPv4) are resolved and a route is added for each IP; the IPs are refreshed from time to time. ',
            'Exact names only: ',
            code('app.corp.local'),
            ' needs a rule of its own, and ',
            code('*.corp.local'),
            ' is not supported.',
          ],
        ),
        p(
          ui(m.addRule.useDns),
          ' (on a domain rule) — when only the office DNS server knows the internal names, enter its address, e.g. ',
          code('10.0.0.53'),
          '. A ',
          code('/etc/resolver/corp.local'),
          ' file is then created: macOS asks that server for corp.local names, and the server itself gets a route through the rule’s interface.',
        ),
        note(
          'Some addresses are never routed: the default route (',
          code('0.0.0.0/0'),
          '), subnets that are too wide, loopback, link-local and multicast.',
        ),
      ],
    },

    precedence: {
      title: 'Precedence: which rule wins',
      blocks: [
        p('When several rules cover the same address:'),
        steps(
          [
            'An address you name beats one that comes from resolving a name: an IP rule (or a ',
            code('/32'),
            ', or a rule’s DNS server) takes that IP from the domain’s answer. The domain rule then shows “',
            m.ruleReason['overridden-by-rule'],
            '”.',
          ],
          [
            'The most specific route (the longest prefix) wins — that is how macOS picks. For example, ',
            code('10.0.0.0/8'),
            ' can go through Ethernet while ',
            code('10.20.0.0/16'),
            ' goes through Wi‑Fi; each IP of a domain is a host route (',
            code('/32'),
            '), so it beats a wider subnet.',
          ],
          ['On a tie, the rule higher in the list.'],
        ),
        p(
          'One address cannot be bound to two interfaces — the form does not save such a rule. ',
          toSection('diagnostics', section.diagnostics),
          ' shows exactly which rule is in effect.',
        ),
      ],
    },

    'default-route': {
      title: 'What “default” means, and making Wi‑Fi first',
      blocks: [
        p(
          'Traffic that no rule covers goes through the default route. macOS takes it from the network service order: the first connected service in the list. ',
          'The DEFAULT tag on an interface card in the menu bar shows which one it is.',
        ),
        p(
          'If Ethernet is above Wi‑Fi in that list, the internet goes over the cable too. RouteSwitch never touches the default route, and changing the order needs administrator rights, so the ',
          toSection('settings', section.settings),
          ' → ',
          ui(m.settings.wifi.title),
          ' card shows the exact command for your services — copy it and run it in Terminal yourself. It looks like this:',
        ),
        terminal('Command that puts Wi‑Fi first (example)', 'sudo networksetup -ordernetworkservices "Wi-Fi" "USB 10/100/1000 LAN"'),
        p('To see the current order and default route (read-only):'),
        terminal('Service order and default route', 'networksetup -listnetworkserviceorder', 'route -n get default'),
      ],
    },

    backup: {
      title: 'Backup, restore and export',
      blocks: [
        p(
          'Your rules are stored by the helper. The app also keeps a copy of the last rules it got from the helper, in your user folder (only you can read it).',
        ),
        list(
          [
            'When the helper is reinstalled and has no rules while the backup does, the app offers to restore them. Nothing is restored until you have reviewed and confirmed it.',
          ],
          [
            toSection('settings', section.settings),
            ' → ',
            ui(m.backup.settings.title),
            ': ',
            ui(m.backup.settings.restore),
            ', or delete the backup.',
          ],
          [
            toSection('rules', section.rules),
            ' → ',
            ui(m.rules.export),
            ' saves the rules to a JSON file and ',
            ui(m.rules.import),
            ' loads them from one (it replaces all current rules, after you review them). This is how rules move to another Mac.',
          ],
        ),
        note(
          'Before removing the helper, use ',
          ui(m.rules.export),
          ': removing it deletes the helper’s rules too. The app’s backup stays, but a file is the copy you can rely on.',
        ),
      ],
    },

    diagnostics: {
      title: 'Diagnostics',
      blocks: [
        p(
          'In ',
          toSection('diagnostics', section.diagnostics),
          ', enter a host, an IP or a URL (e.g. ',
          code('corp.local'),
          ', ',
          code('10.20.30.40'),
          ' or ',
          code('https://example.com/page'),
          ' — only the host of a URL is used) and click ',
          ui(m.diagnostics.run),
          '. You see:',
        ),
        list(
          ['which rule matches, and why (precedence);'],
          ['the actual route of each address: interface, gateway, and whether it is the expected one;'],
          ['which DNS server and resolver file are used, and whether the server answers.'],
        ),
        p(
          'Diagnostics change nothing. A name that no rule covers is resolved by the app with the system resolver, as a normal user.',
        ),
      ],
    },

    problems: {
      title: 'Common problems',
      blocks: [
        sub('A DNS server goes through the other interface'),
        p(
          'For example, the DNS server Ethernet hands out lies inside the Wi‑Fi network — queries leave through Wi‑Fi and get no answer. RouteSwitch shows a warning in the menu bar and in ',
          toSection('rules', section.rules),
          '; its ',
          ui(m.dnsWarnings.addRule('10.0.0.53', 'Ethernet')),
          ' button opens the form filled in — you confirm the save.',
        ),
        sub('An internal name does not open in the browser but works in Terminal'),
        p(
          'Secure DNS (DNS over HTTPS) in the browser bypasses the system resolver, and so ',
          code('/etc/resolver/corp.local'),
          ' as well. Turn Secure DNS off in the browser’s settings, or add an exception for the internal domain. IP and subnet rules are not affected.',
        ),
        sub(`Rules stay “${m.components.ruleStatus.pending}”`),
        p(
          'The rule’s interface is not connected (for example, the Ethernet cable is unplugged) or has no gateway. Meanwhile those addresses use the default route; once the interface is back, the rules are applied automatically.',
        ),
        sub('“Too many checks”'),
        p(
          'The helper runs up to 10 diagnostic requests a minute (each address of a name no rule covers is a request of its own). Wait a minute and try again.',
        ),
        p(
          'For other errors, ',
          toSection('log', section.log),
          ' shows the reason; check the address with ',
          toTopic('diagnostics', 'Diagnostics'),
          ' if needed.',
        ),
      ],
    },

    uninstall: {
      title: 'Uninstall',
      blocks: [
        steps(
          ['If you want to keep your rules, use ', ui(m.rules.export), ' first (', toTopic('backup', 'backup and export'), ').'],
          [
            toSection('settings', section.settings),
            ' → ',
            ui(m.settings.helper.uninstall),
            ' (administrator password): every route and resolver file the helper added, the daemon, its config (your rules) and its log are removed.',
          ],
          ['Quit RouteSwitch and move it from Applications to the Trash.'],
        ),
        p('The app’s rules backup is not deleted by this — use the backup card in Settings for that.'),
      ],
    },
  },
};
