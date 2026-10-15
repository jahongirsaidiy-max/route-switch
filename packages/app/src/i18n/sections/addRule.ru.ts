// Russian words of the add / edit rule dialog. Typed by the Uzbek section: a
// key missing or added fails `tsc`.

import { LIMITS } from '@routeswitch/shared';

import { plural, ruForms } from '../plural';
import type { Shape } from '../types';
import type { addRuleUz } from './addRule.uz';

const every = (count: number, unit: readonly [string, string, string]): string =>
  `${plural('ru', count, ruForms('каждую', 'каждые', 'каждые'))} ${String(count)} ${plural('ru', count, ruForms(...unit))}`;
const waiting = 'правило будет «Ожидает» и применится после подключения.';

export const addRuleRu: Shape<typeof addRuleUz> = {
  titles: { add: 'Новое правило', edit: 'Изменение правила' },
  subtitle: 'Укажите адрес и канал, через который он пойдёт.',
  kindLabel: 'Тип',
  kinds: { ip: 'IP', subnet: 'Подсеть', domain: 'Домен' },
  targetField: {
    ip: { label: 'IP-адрес', hint: 'Добавляется маршрут для одного хоста. Можно и шаблон: 10.*.*.* → 10.0.0.0/8 (подсеть).' },
    subnet: { label: 'Подсеть (CIDR)', hint: 'Самый надёжный вариант для всей внутренней сети. Можно и шаблон: 10.*.*.* → 10.0.0.0/8.' },
    domain: { label: 'Домен', hint: 'Домен разрешается в IP, и для каждого IP добавляется маршрут. Для поддоменов: *.corp.local.' },
  },
  normalised: (target) => `Сохранится как ${target}.`,
  wildcardResult: (cidr) => `→ ${cidr} (подсеть)`,
  wildcardHint: (base) => `Только поддомены (например, app.${base}) — для самого ${base} добавьте отдельное правило.`,
  wildcardLimits: 'Браузер с включённым «Secure DNS» (DNS over HTTPS) обходит это правило. Маршруты для IPv6-адресов не добавляются.',
  sameAs: (target) => `Этот адрес уже есть в правиле «${target}» (тот же интерфейс) — второе правило лишнее.`,
  useDns: 'Разрешать через внутренний DNS-сервер',
  dnsAddress: 'Адрес DNS-сервера',
  refreshLabel: 'Интервал обновления IP (секунды)',
  resolverFile: (domain) => `Будет создан файл /etc/resolver/${domain}. `,
  refreshMinutes: (minutes) => `IP обновляются ${every(minutes, ['минуту', 'минуты', 'минут'])}.`,
  refreshSeconds: (seconds) => `IP обновляются ${every(seconds, ['секунду', 'секунды', 'секунд'])}.`,
  ifaceLabel: 'Интерфейс',
  noteLabel: 'Заметка',
  notePlaceholder: 'Например: бухгалтерская система',

  errors: {
    upperCase: 'Введите домен строчными буквами, например corp.local.',
    refresh: `Введите целое число секунд от ${String(LIMITS.refreshSecMin)} до ${String(LIMITS.refreshSecMax)}.`,
    note: `Заметка — не длиннее ${String(LIMITS.noteMaxLength)} символов.`,
    targetEmpty: 'Введите адрес.',
    targetLong: `Адрес — не длиннее ${String(LIMITS.targetMaxLength)} символов.`,
    dnsEmpty: 'Введите адрес DNS-сервера (или снимите отметку).',
    invalidRule: 'Правило недопустимо.',
    ifaceConflict: (target, role) =>
      `Этот адрес уже направлен через ${role} в правиле «${target}» — один адрес нельзя привязать к двум интерфейсам.`,
    tooManyRules: `Нельзя добавить больше ${String(LIMITS.maxRules)} правил.`,
  },

  previewLabel: 'Команда, которую выполнит helper — только для показа, приложение её не запускает',
  previewNoHelper: 'Команда появится, когда helper подключится (шлюз берётся из него).',
  previewNoAdapter: (role) => `Адаптер ${role} не найден — ${waiting}`,
  previewNoGateway: (role) => `У ${role} нет шлюза — ${waiting}`,
  previewDown: (role) => `${role} не подключён — ${waiting}`,
  previewEachIp: 'Для каждого разрешённого IP.',
  previewEachIpDns: 'Для каждого разрешённого IP; для DNS-сервера — если он не в своей сети.',
  previewWildcard: 'Маршруты не добавляются заранее: при запросе поддомена маршрут добавляется для каждого IP ответа.',
  previewWildcardDns: 'Маршруты поддоменов добавляются по запросу; маршрут к DNS-серверу — сразу.',

  test: 'Проверить',
  testOff: (reason) => `Проверить — ${reason}`,
  testAddress: (address) => `Проверить адрес ${address}`,
  testIdle: (address) => `Проверит, через какой интерфейс сейчас идёт ${address} (route -n get).`,
  testRunning: (address) => `Проверяется ${address}…`,
  testNoHelper: 'Нет связи с helper.',
  testEnterValid: 'Сначала введите правильный адрес.',
  testSubnetUntestable: 'Адрес в этой подсети проверить нельзя.',
  testDomainSaveFirst: 'IP домена проверяются после того, как helper его разрешит — сначала сохраните.',
  testDomainNotResolved: 'Домен ещё не разрешён или маршрут не добавлен.',
  testNoRoute: 'Маршрут для этого адреса не найден.',
  testFailed: (why) => `Проверить не удалось: ${why}`,
  testMatch: 'Совпадает',
  testMismatch: 'Не совпадает',
  testDirect: 'напрямую',
  testGateway: (gateway) => `шлюз ${gateway}`,
  testByThisRule: (role) => `Идёт через ${role} по этому правилу.`,
  testGoesVia: (role) => `Сейчас идёт через ${role}.`,
  testOtherNow: 'Сейчас идёт через другой интерфейс',
  testRoleNow: (role) => `Сейчас идёт через ${role}`,
  testNotRole: (now, role) => `${now}, а не через ${role}.`,
  testAfterSave: (now, role) => `${now} — после сохранения пойдёт через ${role}.`,

  helperDown: (status) => `${status} — правило сохранить нельзя.`,
  loadingRule: 'Правило читается…',
  missingRule: 'Этого правила больше нет — возможно, его удалили в другом окне.',
  readFailed: (why) => `Не удалось прочитать правило: ${why}`,
  readNoHelper: 'Нет связи с helper — правило прочитать нельзя.',
  cancel: 'Отмена',
  save: 'Сохранить и применить',
  saveRefused: 'Правило не сохранено: helper его не принял (адрес или число правил не прошли ограничения).',
  saveFailed: (why) => `Правило не сохранено: ${why}`,
};
