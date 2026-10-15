// "DNS server boshqa interfeysda" (TASK-DELTA-21), in Russian. Typed by the
// Uzbek section: a key missing or added fails `tsc`.

import type { Shape } from '../types';
import type { dnsWarningsUz } from './dnsWarnings.uz';

export const dnsWarningsRu: Shape<typeof dnsWarningsUz> = {
  titleInterface: (role, server, other) => `DNS-сервер ${role} (${server}) идёт через ${other}`,
  titleRule: (target, server, other) => `DNS-сервер правила «${target}» (${server}) идёт через ${other}`,
  titleRuleUnknown: (server, other) => `DNS-сервер правила (${server}) идёт через ${other}`,
  textSubnet: (server, role, other) =>
    `${server} находится в сети ${other}: запросы к нему уходят через ${other}, а не через ${role}, и ответа может не быть (внутренние имена не разрешаются). Решение — IP-правило для ${server} через ${role}.`,
  textRouted: (server, role, other) =>
    `Таблица маршрутов отправляет ${server} через ${other}, а не через ${role} — внутренние имена могут не разрешаться. Решение — IP-правило для ${server} через ${role}.`,
  addRule: (server, role) => `Добавить правило ${server} → ${role}`,
  ruleNote: 'DNS-сервер',
  blockedGateway: (server, role) => `Правило не предлагается: ${server} — шлюз ${role}, маршрут к нему добавить нельзя.`,
  blockedOwnAddress: (server, role) => `Правило не предлагается: ${server} — собственный адрес интерфейса ${role}.`,
  blockedNoGateway: (role) => `Правило не предлагается: ${role} не подключён или у него нет шлюза.`,
  blockedInvalid: (reason) => `Правило не предлагается: ${reason}`,
  blockedExists: (target, role) => `Правило ${target} → ${role} уже есть — проверьте в списке правил, что оно включено, и его состояние.`,
  blockedUnavailable: (reason) => `Нельзя добавить правило: ${reason}`,
};
