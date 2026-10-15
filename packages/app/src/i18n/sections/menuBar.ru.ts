// The menu bar window, in Russian (shape: `menuBar.uz.ts`).

import { plural, ruForms } from '../plural';
import type { Shape } from '../types';
import type { menuBarUz } from './menuBar.uz';

const n = (count: number, one: string, few: string, many: string): string =>
  `${String(count)} ${plural('ru', count, ruForms(one, few, many))}`;

export const menuBarRu: Shape<typeof menuBarUz> = {
  on: 'Вкл.',
  off: 'Выкл.',
  toggleLabel: 'Маршрутизация (все правила)',
  interfaces: 'Интерфейсы',
  activeRules: 'Активные правила',
  ruleCount: (rules, routes) => `${n(rules, 'правило', 'правила', 'правил')} · ${n(routes, 'маршрут', 'маршрута', 'маршрутов')}`,
  rulesUnreadable: 'Не удалось прочитать правила.',
  reload: 'Прочитать снова',
  rulesLoading: 'Правила загружаются…',
  noRules: 'Нет включённых правил. Добавьте их кнопкой «Открыть правила».',
  moreRules: (count) => `Ещё ${n(count, 'правило', 'правила', 'правил')}`,
  warning: (text) => `Предупреждение: ${text}`,
  dnsServer: (server) => `DNS: ${server}`,
  resolved: (count, ago) => `${String(count)} IP · ${ago}`,
  routingOff: 'Маршрутизация выключена — правила не применяются',
  notAppliedYet: 'Правила ещё не применялись',
  lastApply: (time) => `Последнее применение: ${time}`,
  rulesFailing: (count) => `Ошибка в ${String(count)} ${plural('ru', count, ruForms('правиле', 'правилах', 'правилах'))}`,
  reapply: 'Применить снова',
  manageRules: 'Открыть правила',
  rulesWindowFailed: (reason) => `Окно правил не открылось. ${reason}`,
};
