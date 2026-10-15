// The settings screen (TASK-DELTA-14), in Russian.

import type { Messages } from '../types';

export const settingsRu: Messages['settings'] = {
  title: 'Настройки',
  subtitle: 'Настройки приложения и helper. Правила хранятся в helper.',
  login: {
    title: 'Запуск при входе',
    hint: 'При входе в систему RouteSwitch открывается в строке меню. Маршруты работают и без приложения — их держит helper.',
    on: 'RouteSwitch будет запускаться при входе.',
    off: 'Запуск при входе выключен.',
    refused: 'macOS не приняла настройку (Системные настройки → Объекты входа).',
  },
  ethernet: {
    title: 'Адаптер Ethernet',
    hint: (detected) =>
      `Обычно берётся первый адаптер с IP-адресом, который не Wi‑Fi${detected === null ? '' : ` (сейчас: ${detected})`}. Если адаптеров несколько, выберите нужный.`,
    fieldLabel: 'Адаптер для роли Ethernet',
    auto: 'Автоматически',
    noIp: 'Нет IP',
    notConnected: (device) => `${device} · не подключён`,
    needsHelper: 'Выбрать можно, когда helper подключён.',
    savedAuto: 'Адаптер Ethernet определяется автоматически.',
    saved: (device) => `Роль Ethernet теперь у ${device}.`,
  },
  wifi: {
    title: 'Wi‑Fi по умолчанию',
    hint: 'Трафик, не попавший под правила, уходит через первую подключённую сеть в порядке служб. Чтобы изменить этот порядок, нужны права администратора, поэтому RouteSwitch только показывает команду — её вы выполняете сами в Терминале.',
    loading: 'Чтение порядка служб…',
    failed: 'Не удалось прочитать порядок служб.',
    notFound: 'Служба Wi‑Fi не найдена.',
    alreadyFirst: (service) => `${service} уже первая — канал по умолчанию Wi‑Fi.`,
    currentFirst: (service) => `Сейчас первая: ${service}.`,
    commandLabel: 'Команда, которая ставит Wi‑Fi первой',
    copy: 'Копировать',
    refresh: 'Обновить',
    copied: 'Команда скопирована — вставьте её в Терминал.',
  },
  helper: {
    title: 'Helper',
    hint: 'Удаление запросит пароль администратора: все маршруты и файлы resolver, добавленные helper, будут удалены, root-демон остановится, а его файлы — конфигурация (правила) и журнал — тоже удалятся. Если правила нужны, сначала сделайте экспорт.',
    uninstall: 'Удалить helper',
    question: 'Действительно удалить helper?',
    confirm: 'Да, удалить',
    cancel: 'Отмена',
  },
};
