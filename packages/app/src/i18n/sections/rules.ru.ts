// Russian words of the rules window. Typed by the Uzbek section: a key
// missing or added fails `tsc`.

import { plural, ruForms } from '../plural';
import type { Shape } from '../types';
import type { rulesUz } from './rules.uz';

const rules = (count: number): string => `${String(count)} ${plural('ru', count, ruForms('правило', 'правила', 'правил'))}`;

export const rulesRu: Shape<typeof rulesUz> = {
  sections: { rules: 'Правила', log: 'Журнал', diagnostics: 'Диагностика', settings: 'Настройки', help: 'Справка' },
  sectionsNav: 'Разделы',
  helperDaemon: (version) => `root daemon · v${version}`,

  title: 'Правила',
  subtitle: 'Укажите, через какой интерфейс идёт каждый адрес. Остальной трафик идёт по каналу по умолчанию.',
  addRule: 'Добавить правило',
  addRuleOff: (reason) => `Добавить правило — ${reason}`,
  configUnreadableReason: 'Конфигурация helper повреждена — сначала импортируйте её или начните с пустой конфигурации',
  addRuleUnavailable: 'Окно добавления правила ещё не готово',

  search: 'Поиск',
  searchPlaceholder: 'Поиск по IP, подсети, домену или заметке',
  filterLabel: 'Показать',
  filters: { all: 'Все', problems: 'С проблемами', off: 'Выключенные' },
  import: 'Импорт',
  importLabel: 'Импорт конфигурации (из JSON-файла)',
  export: 'Экспорт',
  exportLabel: 'Экспорт конфигурации (в JSON-файл)',
  exportOff: (reason) => `Экспорт конфигурации — ${reason}`,

  columns: { status: 'Статус', target: 'Адрес', kind: 'Тип', iface: 'Интерфейс', note: 'Заметка' },
  kinds: { ip: 'IP', subnet: 'Подсеть', domain: 'Домен', domainDns: 'Домен + DNS', wildcard: 'Wildcard', wildcardDns: 'Wildcard + DNS' },
  detailDns: (dns) => `DNS: ${dns}`,
  detailEvery: (minutes) => `${plural('ru', minutes, ruForms('каждую', 'каждые', 'каждые'))} ${String(minutes)} мин`,
  detailCount: (count, every) => `${String(count)} IP · ${every}`,
  detailLearned: (count) => `${String(count)} ${plural('ru', count, ruForms('найденный IP', 'найденных IP', 'найденных IP'))}`,
  warningMark: 'Предупреждение',
  toggleLabel: (target) => `Правило ${target}`,
  editLabel: (target) => `Изменить правило ${target}`,
  editOff: (reason) => `Изменить — ${reason}`,
  deleteLabel: (target) => `Удалить правило ${target}`,

  emptyTitle: 'Правил пока нет',
  emptyText: 'Добавленное правило появится здесь, и адрес будет направляться через выбранный интерфейс.',
  noMatchTitle: 'Ничего не найдено',
  noMatchText: (query, filter) =>
    `Нет подходящих правил${query === null ? '' : ` по запросу «${query}»`}${filter === null ? '' : ` среди «${filter}»`}.`,

  readFailedTitle: 'Не удалось прочитать правила',
  reload: 'Прочитать снова',
  reading: 'Правила читаются…',

  overlapsLabel: 'Пересекающиеся адреса',
  overlapsTitle: 'Пересекающиеся адреса — побеждает более точный (с длинным префиксом):',
  overlapInside: (narrower, wider) => `${narrower} → внутри ${wider}`,
  overlapOtherIface: ' · другой интерфейс',
  overlapMore: (count) => `ещё ${String(count)}`,

  activeRules: (count) =>
    `${String(count)} ${plural('ru', count, ruForms('правило активно', 'правила активны', 'правил активны'))} · применяются автоматически при смене сети`,
  routingOff: 'Маршрутизация включается общим переключателем в окне строки меню',

  replace: 'Заменить',
  cancel: 'Отмена',
  remove: 'Удалить',
  deleteQuestion: (target) => `Удалить правило «${target}»? Его маршруты будут убраны.`,

  enableFailed: 'Правило не включено',
  disableFailed: 'Правило не выключено',
  deleteFailed: 'Правило не удалено',
  ruleGone: 'правила больше нет (возможно, его удалили в другом окне).',
  failed: (what, why) => `${what}: ${why}`,

  importFailed: (why) => `Импорт не выполнен: ${why}`,
  imported: (count) => `Конфигурация импортирована: ${rules(count)}.`,
  replaceFailed: (why) => `Конфигурация не заменена: ${why}`,
  exportFailed: (why) => `Экспорт не выполнен: ${why}`,
  exported: (count) => `Конфигурация сохранена в файл: ${rules(count)}.`,
  importReplaces: (count, current) =>
    `Импорт полностью заменит текущую конфигурацию: ${rules(count)}${current === null ? '' : ` (сейчас ${String(current)})`}.`,
  importCounts: (added, removed, changed, unchanged) =>
    `Добавится: ${String(added)}, удалится: ${String(removed)}, изменится: ${String(changed)}, без изменений: ${String(unchanged)}.`,
  importRoutingOff: 'Маршрутизация будет выключена.',
  importRoutingOn: 'Маршрутизация будет включена.',
  importOverrides: 'Замены интерфейсов тоже заменятся.',

  importConfig: 'Импортировать конфигурацию',
  startEmpty: 'Начать с пустой конфигурации',
  resetQuestion: (path) =>
    `Заменить сохранённую (нечитаемую) конфигурацию пустой? Её правила не вернутся — если хотите восстановить их вручную, сначала скопируйте ${path}.`,
  resetDone: 'Пустая конфигурация сохранена — helper снова работает. Теперь можно добавить правила или импортировать конфигурацию.',
};
