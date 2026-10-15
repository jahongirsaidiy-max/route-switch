// The shared components and the helper install flow (TASK-DELTA-14), in Russian.

import type { Messages } from '../types';

export const componentsRu: Messages['components'] = {
  ruleStatus: {
    active: 'Активно',
    pending: 'Ожидает',
    error: 'Ошибка',
    disabled: 'Выключено',
  },
  iface: {
    adapterMissing: 'Адаптер не найден',
    notConnected: 'Не подключён',
    noGateway: 'Нет шлюза',
    connected: 'Подключён',
    deviceDown: (device) => `${device} · не подключён`,
    deviceNoGateway: (device, ip) => `${device} · ${ip} · нет шлюза`,
    optionNoGateway: (device) => `${device} · нет шлюза`,
    defaultTag: 'ОСНОВНОЙ',
  },
  recovery: {
    reconnect: 'Переподключиться',
    recheck: 'Проверить снова',
    removedOverSocket: 'Helper удалён: его маршруты и файлы resolver удалены. Маршрутизация остановлена.',
  },
};
