// The rules backup (TASK-DELTA-16), in Russian.

import { plural, ruForms } from '../plural';
import type { Messages } from '../types';

const rules = (count: number): string => `${String(count)} ${plural('ru', count, ruForms('правило', 'правила', 'правил'))}`;

export const backupRu: Messages['backup'] = {
  offerTitle: (count) => `Восстановить прежние правила (${String(count)})`,
  offerText: (time) =>
    `В helper нет правил, но в приложении есть резервная копия от ${time}. Просмотрите её — пока вы не подтвердите, ничего не изменится.`,
  review: 'Просмотреть',
  dismiss: 'Не нужно',
  openRules: 'Открыть в окне правил',
  previewFrom: (time) => `Резервная копия (${time}).`,
  restored: (count) => `Правила восстановлены из резервной копии: ${rules(count)}.`,
  restoreFailed: (why) => `Не удалось восстановить: ${why}`,
  dismissFailed: (why) => `Не удалось скрыть предложение: ${why}`,
  settings: {
    title: 'Резервная копия правил',
    hint: 'Приложение хранит последнюю копию правил, полученную от helper, в вашей папке пользователя (читать её можете только вы). Копия сохраняется и после удаления helper; восстановление — только после просмотра и подтверждения.',
    summary: (count, time) => `Копия: ${rules(count)}, ${time}`,
    none: 'Копии пока нет — она сохраняется автоматически, когда появляются правила.',
    loading: 'Чтение копии…',
    restore: 'Восстановить из копии',
    remove: 'Удалить копию',
    removeQuestion: 'Действительно удалить резервную копию? Правила в helper не затрагиваются.',
    removeConfirm: 'Да, удалить',
    cancel: 'Отмена',
    removed: 'Резервная копия удалена.',
    removeFailed: (why) => `Копия не удалена: ${why}`,
    needsHelper: 'Для восстановления helper должен быть подключён.',
  },
};
