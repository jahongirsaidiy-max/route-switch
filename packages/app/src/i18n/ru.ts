// Russian. Typed as `Messages`: a key missing from or added to `uz.ts` fails `tsc`.

import { LIMITS, MIN_SUBNET_PREFIX } from '@routeswitch/shared';

import { plural, ruForms } from './plural';
import { addRuleRu } from './sections/addRule.ru';
import { rulesRu } from './sections/rules.ru';
import { menuBarRu } from './sections/menuBar.ru';
import { shellRu } from './sections/shell.ru';
import type { Messages } from './types';
import { componentsRu } from './sections/components.ru';
import { logRu } from './sections/log.ru';
import { settingsRu } from './sections/settings.ru';
import { backupRu } from './sections/backup.ru';

const unexpected = (code: string): string => `Непредвиденная ошибка (${code}).`;

const rules = (count: number): string => plural('ru', count, ruForms('правило', 'правила', 'правил'));
const minutes = (count: number): string => plural('ru', count, ruForms('минуту', 'минуты', 'минут'));
const hours = (count: number): string => plural('ru', count, ruForms('час', 'часа', 'часов'));
const days = (count: number): string => plural('ru', count, ruForms('день', 'дня', 'дней'));

export const ru: Messages = {
  unknownWindow: 'Неизвестное окно. Откройте приложение заново значком в строке меню.',

  unexpectedError: unexpected,

  menuBar: menuBarRu,
  ...shellRu,

  errors: {
    'not-connected': 'Нет связи с helper — ничего не отправлено.',
    disconnected: 'Ответ не пришёл: результат неизвестен. Состояние обновится, когда helper снова подключится.',
    timeout: 'Ответ не пришёл: результат неизвестен. Состояние обновится, когда helper снова подключится.',
    busy: 'Helper занят — попробуйте чуть позже.',
    'not-implemented': 'Установленный helper пока не умеет выполнять это действие.',
    'invalid-config': 'Значение не принято.',
    'invalid-input': 'Значение не принято.',
    'operation-failed': 'Действие не выполнено.',
    forbidden: 'Из этого окна действие запрещено.',
    'file-unreadable': 'Не удалось прочитать файл.',
    'file-not-regular': 'Выбранный объект — не обычный файл.',
    'file-too-large': 'Файл слишком большой (больше 1 МБ) — это не файл конфигурации.',
    'file-not-text': 'Файл не является текстом в UTF-8.',
    'file-not-json': 'Файл не в формате JSON или повреждён.',
    'import-expired': 'Срок выбора файла истёк — выберите файл ещё раз.',
    'write-failed': 'Не удалось записать файл — выберите другое место.',
    'no-backup': 'В приложении нет резервной копии правил.',
    'install-unavailable':
      'Пакет helper в приложении не найден или ненадёжен (символическая ссылка или его может изменить другой пользователь) — переустановите приложение.',
    'install-cancelled': 'Окно ввода пароля закрыто — ничего не изменилось. Можно попробовать ещё раз.',
    'install-denied': 'Пароль администратора не принят — ничего не изменилось. Попробуйте ещё раз.',
    'install-failed': 'Скрипт завершился с ошибкой. Подробности: /Library/Logs/RouteSwitch/helper.log. Можно попробовать ещё раз.',
    'invalid-json': unexpected('invalid-json'),
    'line-too-long': unexpected('line-too-long'),
    'invalid-request': unexpected('invalid-request'),
    'unknown-method': unexpected('unknown-method'),
    internal: unexpected('internal'),
    'invalid-response': unexpected('invalid-response'),
    unspecified: unexpected('unspecified'),
    'rule-not-found': unexpected('rule-not-found'),
  },

  helperStatus: {
    loading: 'Проверка…',
    connected: 'Helper работает',
    connecting: 'Подключение к helper…',
    'not-installed': 'Helper не установлен',
    disconnected: 'Helper не работает',
    'config-unreadable': 'Конфигурация helper повреждена',
    incompatible: 'Версия helper не подходит',
    stopped: 'Приложение завершается',
    unavailable: 'Не удалось прочитать состояние',
  },

  install: {
    install: 'Установить helper',
    reinstall: 'Переустановить helper',
    waiting: 'Будет запрошен пароль администратора (окно macOS). Установка может занять до минуты.',
    installed: 'Helper установлен — подключение…',
    removed: 'Helper полностью удалён: маршруты, файлы resolver, демон, конфигурация и журнал удалены.',
  },

  notice: {
    loadingTitle: 'Чтение состояния…',
    connectingTitle: 'Подключение к helper…',
    notInstalledTitle: 'Helper не установлен',
    notInstalledText:
      'Для маршрутизации helper устанавливается один раз с паролем администратора. Пока ни одно правило не применяется.',
    disconnectedTitle: 'Нет связи с helper',
    routesStay: 'Применённые маршруты остаются в helper.',
    disconnected: {
      'not-running': 'Helper не работает. launchd перезапустит его; если нет — переустановите.',
      'permission-denied': 'Нет доступа к сокету helper (пользователь не входит в группу staff).',
      'connection-lost': 'Связь прервалась — переподключение.',
      'protocol-error': 'Helper ответил непонятно — переподключение.',
      timeout: 'Helper не ответил — переподключение.',
      error: 'Не удалось подключиться к helper — новая попытка.',
    },
    configUnreadableTitle: 'Конфигурация helper повреждена',
    configUnreadableText:
      'Helper работает, но не смог прочитать сохранённую конфигурацию — ни одно правило не применяется. В разделе «Правила» импортируйте конфигурацию или начните с пустой.',
    incompatibleTitle: 'Версия helper не подходит',
    incompatibleText: (helperVersion, protocolVersion, expected) =>
      `Helper v${helperVersion} использует другой протокол (${String(protocolVersion)}, нужен: ${String(expected)}). Переустановите helper.`,
    reinstall: 'Переустановите helper.',
    stoppedTitle: 'Приложение завершается',
    unavailableTitle: 'Не удалось прочитать состояние',
  },

  ruleReason: {
    'rule-disabled': 'Правило выключено',
    'globally-disabled': 'Маршрутизация выключена',
    'interface-down': 'Интерфейс не подключён',
    'no-gateway': 'У интерфейса нет шлюза',
    resolving: 'Домен разрешается',
    'resolve-failed': 'DNS-запрос не выполнен',
    'no-addresses': 'У домена нет IPv4-адреса (A-записи)',
    'forbidden-destination': 'Запрещённый адрес — защита маршрута по умолчанию не направляет его',
    'connected-network': 'Адрес пересекается с собственной сетью или шлюзом интерфейса — маршрут не добавлен',
    'route-failed': 'Маршрут не добавлен',
    'resolver-conflict': 'В /etc/resolver есть чужой файл для этого домена',
    'resolver-failed': 'Файл resolver не записан',
    internal: 'Внутренняя ошибка helper',
    'addresses-truncated': 'Слишком много адресов — направлена только часть',
    'overridden-by-rule': 'Часть адресов направлена другим правилом через другой интерфейс',
    'dns-server-excluded': 'Часть адресов — DNS-серверы, они не направляются',
  },

  reconcileReason: {
    startup: 'при запуске helper',
    'config-change': 'при изменении правил',
    'enabled-change': 'при включении или выключении маршрутизации',
    manual: 'вручную',
    'network-change': 'при изменении сети',
    'dns-refresh': 'при обновлении DNS',
    'drift-check': 'при плановой проверке',
  },

  validation: {
    'invalid-ipv4': 'Введите IPv4-адрес, например 172.16.12.40.',
    'invalid-cidr': 'Введите подсеть в формате CIDR, например 10.0.0.0/8.',
    'invalid-prefix': `Префикс должен быть от ${String(MIN_SUBNET_PREFIX)} до 32.`,
    'prefix-too-wide': `Подсеть слишком широкая: префикс должен быть не меньше /${String(MIN_SUBNET_PREFIX)}.`,
    'invalid-domain': 'Домен может состоять только из строчных латинских букв, цифр, «-» и «.», например corp.local.',
    'invalid-wildcard': '«*» допускается только в последних октетах, например 10.*.*.* или 192.168.5.*.',
    'invalid-destination': 'Введите IPv4-адрес или подсеть в формате CIDR.',
    'default-route': 'Маршрут по умолчанию (0.0.0.0/0) никогда не изменяется.',
    'this-network': 'Адреса 0.0.0.0/8 не маршрутизируются.',
    loopback: 'Loopback-адреса (127.0.0.0/8) не маршрутизируются.',
    'link-local': 'Link-local-адреса (169.254.0.0/16) не маршрутизируются.',
    multicast: 'Multicast-адреса (224.0.0.0/4) не маршрутизируются.',
    broadcast: 'Адрес 255.255.255.255 не маршрутизируется.',
  },

  configFile: {
    fields: {
      id: 'id',
      kind: 'тип',
      target: 'адрес',
      iface: 'интерфейс',
      dns: 'DNS-сервер',
      refreshSec: 'интервал обновления',
      note: 'заметка',
      enabled: 'состояние',
    },
    issues: {
      'iface-conflict': 'один адрес привязан к двум интерфейсам.',
      'duplicate-id': 'id правила повторяется.',
      'too-many-values': 'файл слишком большой или слишком глубокий.',
      'array-too-long': `больше ${String(LIMITS.maxRules)} правил.`,
      'too-deep': 'файл слишком большой или слишком глубокий.',
      'string-too-long': 'слишком длинный текст.',
      invalid_type: 'неверный тип значения или значение отсутствует.',
      invalid_value: 'неверное значение.',
      too_small: 'значение слишком маленькое или короткое.',
      too_big: 'значение слишком большое или длинное.',
      invalid_format: 'неверный формат значения.',
    },
    invalidValue: 'неверное значение.',
    notAConfig: 'Файл не похож на конфигурацию.',
    wrongVersion: 'Версия конфигурации не подходит (ожидается 1) — файл от другой версии.',
    tooManyRules: `Больше ${String(LIMITS.maxRules)} правил.`,
    ruleAt: (index, field) => `Правило ${String(index)}${field === null ? '' : `, ${field}`}: `,
    ifaceOverridesAt: 'Замена интерфейсов: ',
    enabledAt: 'Общее состояние: ',
  },

  network: {
    adapterMissing: (role) => `Адаптер ${role} не найден`,
    noGateway: (role) => `У ${role} нет шлюза`,
    notConnected: (role) => `${role} не подключён`,
    rulesWaiting: (count) =>
      `${String(count)} ${rules(count)} ${plural('ru', count, ruForms('ждёт', 'ждут', 'ждут'))} — применятся автоматически, когда интерфейс подключится.`,
    rulesWaitingUncounted: 'Связанные с ним правила ждут — применятся автоматически, когда интерфейс подключится.',
    sameSubnetTitle: 'Ethernet и Wi‑Fi в одной сети',
    sameSubnetText: (gateway) =>
      `У обоих шлюз ${gateway}: маршрут через шлюз ненадёжен — через какой интерфейс уйдёт трафик, решает система. Подключите один из интерфейсов к другой сети.`,
    lastKnownNone: 'Последних известных IP нет — домен сейчас не направляется.',
    lastKnown: (addresses, when) => `Последние известные IP (ещё направляются): ${addresses}${when}`,
  },

  time: {
    justNow: 'только что',
    minutesAgo: (count) => `${String(count)} ${minutes(count)} назад`,
    hoursAgo: (count) => `${String(count)} ${hours(count)} назад`,
    daysAgo: (count) => `${String(count)} ${days(count)} назад`,
  },

  settingsLanguage: {
    hint: 'Тексты приложения показываются на этом языке. Записи журнала helper остаются на английском.',
    saved: 'Язык изменён.',
  },

  /** The journal, settings and shared components (TASK-DELTA-14): `sections/*.ts`. */
  log: logRu,
  settings: settingsRu,
  /** The rules backup and its restore offer (TASK-DELTA-16): `sections/backup.*`. */
  backup: backupRu,
  components: componentsRu,

  /** The rules window and the add-rule dialog (TASK-DELTA-13): `sections/rules.*`, `sections/addRule.*`. */
  rules: rulesRu,
  addRule: addRuleRu,
};
