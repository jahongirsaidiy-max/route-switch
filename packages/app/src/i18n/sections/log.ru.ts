// The journal screen (TASK-DELTA-14), in Russian.

import { plural, ruForms } from '../plural';
import type { Messages } from '../types';

const entries = (count: number): string => plural('ru', count, ruForms('запись', 'записи', 'записей'));
const messages = (count: number): string => plural('ru', count, ruForms('сообщение', 'сообщения', 'сообщений'));

export const logRu: Messages['log'] = {
  title: 'Журнал',
  subtitle: (limit) =>
    `Последние ${String(limit)} ${messages(limit)} helper и записи приложения о связи с helper. Хранится всё, что пришло с запуска приложения.`,
  levels: {
    info: 'Информация',
    warn: 'Предупреждение',
    error: 'Ошибка',
  },
  all: 'Все',
  filterLabel: 'Уровень',
  loading: 'Журнал загружается…',
  emptyTitle: 'Журнал пока пуст',
  emptyText: 'Здесь появятся сообщения helper (применение правил, ошибки, изменения сети).',
  noneAtLevel: 'Записей этого уровня нет.',
  historyFailed: 'Не удалось прочитать историю журнала. Новые сообщения появятся по мере поступления.',
  columns: { time: 'Время', level: 'Уровень', message: 'Сообщение' },
  entriesLabel: 'Записи журнала',
  appTag: 'Приложение',
  appTagTitle: 'Собственная запись приложения (не helper)',
  count: (count) => `${String(count)} ${entries(count)} · новые сверху`,
  kept: (limit) => `Хранятся последние ${String(limit)} ${entries(limit)}`,
};
