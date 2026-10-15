// What the main process says, in Russian (shape: `shell.uz.ts`).

import { plural, ruForms } from '../plural';
import type { Shape } from '../types';
import type { shellUz } from './shell.uz';

export const shellRu: Shape<typeof shellUz> = {
  tray: {
    connecting: 'RouteSwitch — подключение…',
    notInstalled: 'RouteSwitch — helper не установлен',
    disconnected: 'RouteSwitch — нет связи с helper',
    incompatible: 'RouteSwitch — версия helper не подходит',
    configUnreadable: 'RouteSwitch — конфигурация helper повреждена, правила не применяются',
    off: 'RouteSwitch — выключено',
    active: 'RouteSwitch — активно',
    failing: (count) => `RouteSwitch — ошибка в ${String(count)} ${plural('ru', count, ruForms('правиле', 'правилах', 'правилах'))}`,
    rulesWaiting: (count) =>
      `${String(count)} ${plural('ru', count, ruForms('правило ждёт', 'правила ждут', 'правил ждут'))} интерфейс`,
    sameSubnet: 'Ethernet и Wi‑Fi в одной сети',
    dnsWarnings: (count) =>
      `${String(count)} ${plural('ru', count, ruForms('DNS-сервер идёт', 'DNS-сервера идут', 'DNS-серверов идут'))} через другой интерфейс`,
    manageRules: 'Открыть правила',
    quit: 'Выйти из RouteSwitch',
  },

  dialogs: {
    importTitle: 'Импорт конфигурации',
    exportTitle: 'Экспорт конфигурации',
  },

  journal: {
    connected: (helperVersion) => `Связь с helper установлена (v${helperVersion})`,
    notInstalled: 'Helper не установлен — правила не применяются',
    disconnected: (why) => `Нет связи с helper: ${why}`,
    disconnectedWhy: {
      'not-running': 'helper не работает (сокет есть, ответа нет)',
      'permission-denied': 'нет доступа к сокету helper',
      'connection-lost': 'связь прервалась',
      'protocol-error': 'helper ответил непонятно',
      timeout: 'helper не ответил',
      error: 'не удалось подключиться к helper',
    },
    configUnreadable:
      'Helper не смог прочитать сохранённую конфигурацию — ни одно правило не применяется. Восстановите её импортом или пустой конфигурацией',
    incompatible: (helperVersion, protocolVersion, expected) =>
      `Версия helper не подходит: v${helperVersion}, протокол ${String(protocolVersion)} (нужен: ${String(expected)})`,
    flapping: 'Связь с helper часто меняется — следующие изменения не записываются в журнал до 10 минут',
  },
};
