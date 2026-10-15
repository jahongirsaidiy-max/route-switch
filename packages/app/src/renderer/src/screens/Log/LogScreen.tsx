// "Jurnal": the last 500 lines — the helper's, and the app's own about the
// helper connection (tagged "Ilova") — newest first, with a level
// filter. The design has no journal screen (GAP-01): it follows the rules
// window — page header, toolbar, bordered table, status footer.

import type { EventLogLevel } from '@routeswitch/shared';
import { useState, type ReactElement } from 'react';

import { Segment, type SegmentOption } from '../../components';
import type { RsApi, RsLogEntry } from '../../rs';
import styles from './LogScreen.module.css';
import { LOG_VIEW_LIMIT, useLog, type LogView } from './useLog';

export type LogFilter = 'all' | EventLogLevel;

export const LEVEL_LABELS: Readonly<Record<EventLogLevel, string>> = {
  info: "Ma'lumot",
  warn: 'Ogohlantirish',
  error: 'Xato',
};

const FILTER_ORDER: readonly LogFilter[] = ['all', 'info', 'warn', 'error'];

/** The entries the filter lets through, newest first. */
export function visibleEntries(entries: readonly RsLogEntry[], filter: LogFilter): RsLogEntry[] {
  const kept = filter === 'all' ? [...entries] : entries.filter((entry) => entry.level === filter);
  return kept.reverse();
}

export function filterOptions(entries: readonly RsLogEntry[]): SegmentOption<LogFilter>[] {
  const counts: Record<LogFilter, number> = { all: entries.length, info: 0, warn: 0, error: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return FILTER_ORDER.map((filter) => ({
    value: filter,
    label: `${filter === 'all' ? 'Hammasi' : LEVEL_LABELS[filter]} (${String(counts[filter])})`,
  }));
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Local time of an entry: `HH:MM:SS` on the day of `now`, `DD.MM HH:MM:SS`
 * otherwise. A value that is not a date is shown as it came.
 */
export function formatLogTime(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? time : `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${time}`;
}

function LevelBadge({ level }: { readonly level: EventLogLevel }): ReactElement {
  return (
    <span className={styles['level']} data-level={level}>
      {LEVEL_LABELS[level]}
    </span>
  );
}

export interface LogPanelProps {
  readonly view: LogView;
  readonly filter: LogFilter;
  readonly onFilterChange: (filter: LogFilter) => void;
  /** The current time, for the date part of older entries. */
  readonly now?: Date;
}

/** The journal for a given state of the log; `LogScreen` supplies the live one. */
export function LogPanel({ view, filter, onFilterChange, now }: LogPanelProps): ReactElement {
  const rows = visibleEntries(view.entries, filter);
  const options = filterOptions(view.entries);

  let notice: ReactElement | null = null;
  if (view.phase === 'loading') {
    notice = (
      <div className={styles['notice']} role="status">
        Jurnal yuklanmoqda…
      </div>
    );
  } else if (view.entries.length === 0) {
    notice = (
      <div className={styles['notice']} role="status">
        <div className={styles['noticeTitle']}>Jurnal hozircha bo'sh</div>
        <div>Helper yozgan xabarlar (qo'llash, xatolar, tarmoq o'zgarishi) shu yerda paydo bo'ladi.</div>
      </div>
    );
  } else if (rows.length === 0) {
    notice = (
      <div className={styles['notice']} role="status">
        Bu darajada yozuv yo'q.
      </div>
    );
  }

  return (
    <section className={styles['screen']} aria-labelledby="log-title">
      <header className={styles['header']}>
        <h1 id="log-title" className={styles['title']}>
          Jurnal
        </h1>
        <p className={styles['subtitle']}>
          Helper'ning oxirgi {LOG_VIEW_LIMIT} ta xabari va ilovaning helper bilan aloqa haqidagi yozuvlari. Ilova ishga tushgandan
          beri kelganlari saqlanadi.
        </p>
      </header>

      <div className={styles['toolbar']}>
        <div className={styles['filter']}>
          <Segment options={options} value={filter} onChange={onFilterChange} label="Daraja" />
        </div>
      </div>

      {view.phase === 'failed' ? (
        <div className={styles['alert']} role="alert">
          Jurnal tarixini o'qib bo'lmadi. Yangi xabarlar kelishi bilan ko'rinadi.
        </div>
      ) : null}

      <div className={styles['table']}>
        <div className={styles['head']} aria-hidden="true">
          <span>Vaqt</span>
          <span>Daraja</span>
          <span>Xabar</span>
        </div>
        {notice ?? (
          <ol className={styles['rows']} aria-label="Jurnal yozuvlari">
            {rows.map((entry) => (
              <li key={entry.seq} className={styles['row']} data-level={entry.level}>
                <time className={styles['time']} dateTime={entry.at} title={entry.at}>
                  {formatLogTime(entry.at, now)}
                </time>
                <span>
                  <LevelBadge level={entry.level} />
                </span>
                <span className={styles['message']}>
                  {entry.source === 'app' ? (
                    <span className={styles['source']} title="Ilovaning o'z yozuvi (helper emas)">
                      Ilova
                    </span>
                  ) : null}
                  {entry.msg}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className={styles['footer']}>
        <span>
          {view.entries.length} ta yozuv · eng yangisi tepada
        </span>
        <span>Oxirgi {LOG_VIEW_LIMIT} tasi saqlanadi</span>
      </footer>
    </section>
  );
}

export interface LogScreenProps {
  /** The preload API; `window.rs` in the app. */
  readonly rs?: Pick<RsApi, 'getLog' | 'onLog'>;
}

/** The journal screen of the rules window. */
export function LogScreen({ rs }: LogScreenProps): ReactElement {
  const view = useLog(rs ?? window.rs);
  const [filter, setFilter] = useState<LogFilter>('all');
  return <LogPanel view={view} filter={filter} onFilterChange={setFilter} />;
}
