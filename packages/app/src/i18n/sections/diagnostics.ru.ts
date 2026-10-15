// Russian words of the "Diagnostika" section. Typed by the Uzbek section: a
// key missing or added fails `tsc`.

import { plural, ruForms } from '../plural';
import type { Shape } from '../types';
import type { diagnosticsUz } from './diagnostics.uz';

const addresses = (count: number): string =>
  `${String(count)} ${plural('ru', count, ruForms('IPv4-адрес', 'IPv4-адреса', 'IPv4-адресов'))}`;

export const diagnosticsRu: Shape<typeof diagnosticsUz> = {
  title: 'Диагностика',
  subtitle: 'Проверьте, через какой интерфейс уходит адрес и почему: правило, фактический маршрут и DNS.',
  inputLabel: 'Хост, IP или URL',
  placeholder: 'corp.local, 10.20.4.37 или https://example.com/страница',
  hint: 'Из URL берётся только хост (схема, порт и путь отбрасываются). Ничего не меняется.',
  run: 'Проверить',
  runOff: (reason) => `Проверить — ${reason}`,
  needsHelper: 'helper не подключён',
  running: 'Проверяем… разрешение имени может занять несколько секунд.',
  inputErrors: {
    empty: 'Введите хост, IP-адрес или URL.',
    'too-long': 'Слишком длинно — введите один хост, IP или URL.',
    ipv6: 'IPv6-адреса не поддерживаются — введите IPv4-адрес или имя хоста.',
    wildcard: '«*» нельзя: диагностика — для одного конкретного имени или адреса.',
    'invalid-host': 'Это не имя хоста. Например: corp.local, 10.20.4.37 или https://example.com.',
  },
  failed: (reason) => `Не удалось проверить: ${reason}`,

  emptyTitle: 'Проверок ещё не было',
  emptyText: 'Введите хост, IP или URL — в результате будут подходящее правило, фактический интерфейс каждого адреса и DNS-сервер.',

  resultLabel: (target) => `Результат для ${target}`,
  verdict: {
    ok: 'Всё как ожидается',
    okVia: (role) => `Всё как ожидается — через ${role}`,
    mismatch: 'Трафик уходит не через ожидаемый интерфейс',
    noRule: 'Правила нет — трафик идёт по каналу по умолчанию',
    noAddresses: 'Адреса не найдены',
    dnsDown: 'DNS-сервер не отвечает',
    partial: 'Часть адресов не проверена',
  },
  advice: {
    noRule: 'Если он должен идти через другой интерфейс — добавьте правило в разделе «Правила».',
    ruleDisabled: 'Подходящее правило выключено — включите его в разделе «Правила».',
    globallyDisabled: 'Маршрутизация полностью выключена — включите её в окне menu bar.',
    interfaceDown: 'Интерфейс правила не подключён — проверьте кабель или Wi‑Fi; при подключении правило применится само.',
    notApplied: 'Маршрута правила нет в таблице — посмотрите состояние правила в разделе «Правила» или нажмите «Применить снова» в окне menu bar.',
    mismatch: 'Побеждает другой маршрут (например, VPN или более точный маршрут) — посмотрите состояние правила в разделе «Правила».',
    dnsDown: 'Внутренние имена могут не разрешаться — проверьте, через какой интерфейс идёт путь к DNS-серверу.',
    partial: 'Попробуйте проверить ещё раз через минуту.',
    noAddresses: 'Проверьте, что имя написано верно и DNS работает.',
  },

  matchTitle: 'Подходящее правило',
  matchRule: (target, role) => `${target} → ${role}`,
  unknownRule: 'правило (список правил ещё не прочитан)',
  noMatch: 'Ни одно включённое правило не подходит — трафик идёт по каналу по умолчанию.',
  via: {
    ip: 'правило IP',
    subnet: 'правило подсети',
    domain: 'правило домена',
    wildcard: 'правило wildcard-домена',
    'dns-server': 'DNS-сервер правила',
  },
  precedence: {
    'only-match': 'других подходящих правил нет',
    'host-route': 'правило точного адреса (/32) важнее всех',
    'domain-address': 'адрес из ответа домена важнее более широкой подсети',
    'longest-prefix': 'побеждает самая узкая подсеть (самый длинный префикс)',
    'exact-domain': 'точный домен важнее wildcard',
    'deeper-wildcard': 'побеждает самый глубокий wildcard',
    'config-order': 'при равенстве — правило, стоящее выше в списке',
  },
  addressRule: (via, rule) => `${via}: ${rule}`,

  addressesTitle: 'Адреса',
  columns: { address: 'Адрес', actual: 'Фактический маршрут', expected: 'Ожидается', status: 'Итог' },
  sources: {
    'rule-cache': 'из кэша правила',
    query: 'запрос helper',
    system: 'системный резолвер',
  },
  noRoute: 'маршрута нет',
  gateway: (gateway) => `шлюз ${gateway}`,
  direct: 'напрямую',
  noRole: 'интерфейс без роли',
  defaultRoute: 'канал по умолчанию',
  status: {
    ok: '✓ совпадает',
    mismatch: '✗ не совпадает',
    default: '— без правила',
    unknown: '? неизвестно',
    failed: 'не проверен',
  },
  rowFailed: (reason) => `Не проверен: ${reason}`,
  noAddressRows: 'Нет адресов для проверки.',

  dnsTitle: 'DNS',
  dnsServer: (server) => `Сервер: ${server}`,
  dnsVia: (role) => `через ${role}`,
  dnsOutcome: {
    ok: 'ответил',
    timeout: 'не ответил (3 с)',
    refused: 'отклонил запрос',
    error: 'запрос завершился ошибкой',
    'not-queried': 'не опрашивался',
  },
  dnsMs: (ms) => `${String(ms)} мс`,
  resolverFile: (path) => `Файл резолвера: ${path}`,
  noResolverFile: 'Файла резолвера нет — используется системный DNS.',
  noDns: 'У правила нет отдельного DNS-сервера — используется системный DNS.',

  notesTitle: 'Примечания',
  notes: {
    'name-not-covered':
      'Это имя не покрыто ни одним правилом домена — helper его не разрешает; приложение разрешило его системным резолвером с обычными правами.',
    'no-matching-rule': 'Ни одно включённое правило не подходит — используется канал по умолчанию.',
    'rule-disabled': 'Подходящее правило есть, но оно выключено.',
    'globally-disabled': 'Маршрутизация полностью выключена — ни одно правило не применяется.',
    'interface-down': 'Интерфейс правила не подключён.',
    'no-gateway': 'У интерфейса правила нет шлюза.',
    'not-applied': 'Маршрута правила нет в таблице маршрутизации.',
    'route-mismatch': 'Система отправляет адрес через другой интерфейс, а не через интерфейс правила.',
    'connected-network': 'Адрес в напрямую подключённой сети (или это шлюз/собственный адрес интерфейса) — он не маршрутизируется.',
    'dns-server-excluded': 'Адрес — DNS-сервер, он никогда не маршрутизируется.',
    'no-addresses': 'У имени нет A-записей (IPv4-адресов).',
    'resolve-failed': 'Не удалось разрешить имя.',
    'addresses-truncated': 'Адресов много — показана только часть.',
  },

  lookup: {
    ok: (count) => `Системный резолвер вернул ${addresses(count)}.`,
    truncated: (max) => `Системный резолвер вернул больше ${String(max)} IPv4-адресов — проверены только первые ${String(max)}.`,
    excluded: (count) =>
      `${String(count)} ${plural('ru', count, ruForms('адрес', 'адреса', 'адресов'))} (loopback, link-local и т. п.) не маршрутизируются — не проверялись.`,
    outcomes: {
      'not-found': 'Имя не найдено: системный резолвер не вернул IPv4-адреса.',
      timeout: 'Системный резолвер не ответил за 3 секунды.',
      failed: 'Не удалось разрешить имя системным резолвером.',
    },
  },
};
