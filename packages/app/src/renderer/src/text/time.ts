// Times as the UI writes them: local clock time and "N daq oldin".

const MINUTE = 60_000;

/** "hozirgina", "2 daq oldin", "3 soat oldin", "4 kun oldin". A time in the future reads as "hozirgina". */
export function formatAgo(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return 'hozirgina';
  const minutes = Math.floor(elapsed / MINUTE);
  if (minutes < 60) return `${String(minutes)} daq oldin`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} soat oldin`;
  return `${String(Math.floor(hours / 24))} kun oldin`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local `HH:MM`, with `DD.MM` in front when it is not today. */
export function formatClock(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const today = new Date(now);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock : `${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${clock}`;
}
