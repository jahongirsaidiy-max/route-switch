// "Jurnal": the last 500 lines — the helper's, and the app's own about the
// helper connection (tagged "Ilova") — newest first, with a level
// filter. The design has no journal screen (GAP-01): it follows the rules
// window — page header, toolbar, bordered table, status footer. The screen's
// words are in the UI language (`t.log`, TASK-DELTA-14); the entries' own
// messages (`msg`) are shown as they came — the helper writes English.

import type { EventLogLevel } from '@routeswitch/shared';
import { useState, type ReactElement } from 'react';

import { formatClock, type I18n } from '../../../../i18n';
import { Segment, type SegmentOption } from '../../components';
import { useI18n } from '../../hooks/useI18n';
import type { RsApi, RsLogEntry } from '../../rs';
import { UZ } from '../../text';
import styles from './LogScreen.module.css';
import { LOG_VIEW_LIMIT, useLog, type LogView } from './useLog';

export type LogFilter = 'all' | EventLogLevel;

/** The level names in Uzbek; `i18n.t.log.levels` in a screen's language. */
export const LEVEL_LABELS: Readonly<Record<EventLogLevel, string>> = UZ.t.log.levels;

const FILTER_ORDER: readonly LogFilter[] = ['all', 'info', 'warn', 'error'];

/** The entries the filter lets through, newest first. */
export function visibleEntries(entries: readonly RsLogEntry[], filter: LogFilter): RsLogEntry[] {
  const kept = filter === 'all' ? [...entries] : entries.filter((entry) => entry.level === filter);
  return kept.reverse();
}

export function filterOptions(entries: readonly RsLogEntry[], i18n: I18n = UZ): SegmentOption<LogFilter>[] {
  const words = i18n.t.log;
  const counts: Record<LogFilter, number> = { all: entries.length, info: 0, warn: 0, error: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return FILTER_ORDER.map((filter) => ({
    value: filter,
    label: `${filter === 'all' ? words.all : words.levels[filter]} (${String(counts[filter])})`,
  }));
}

/**
 * Local time of an entry through `Intl` (`formatClock`, 24-hour): `HH:MM:SS`
 * on the day of `now`; another day has its day and month in front — `13.10`
 * in Uzbek and Russian, `10/13` in English. A value that is not a date is
 * shown as it came.
 */
export function formatLogTime(at: string, now: Date = new Date(), i18n: I18n = UZ): string {
  if (Number.isNaN(new Date(at).getTime())) return at;
  return formatClock(i18n.locale, at, now.getTime(), { seconds: true });
}

function LevelBadge({ level, label }: { readonly level: EventLogLevel; readonly label: string }): ReactElement {
  return (
    <span className={styles['level']} data-level={level}>
      {label}
    </span>
  );
}

export interface LogPanelProps {
  readonly view: LogView;
  readonly filter: LogFilter;
  readonly onFilterChange: (filter: LogFilter) => void;
  /** The current time, for the date part of older entries. */
  readonly now?: Date;
  /** The UI language (`useI18n()`); Uzbek when not given. */
  readonly i18n?: I18n;
}

/** The journal for a given state of the log; `LogScreen` supplies the live one. */
export function LogPanel({ view, filter, onFilterChange, now, i18n = UZ }: LogPanelProps): ReactElement {
  const words = i18n.t.log;
  const rows = visibleEntries(view.entries, filter);
  const options = filterOptions(view.entries, i18n);

  let notice: ReactElement | null = null;
  if (view.phase === 'loading') {
    notice = (
      <div className={styles['notice']} role="status">
        {words.loading}
      </div>
    );
  } else if (view.entries.length === 0) {
    notice = (
      <div className={styles['notice']} role="status">
        <div className={styles['noticeTitle']}>{words.emptyTitle}</div>
        <div>{words.emptyText}</div>
      </div>
    );
  } else if (rows.length === 0) {
    notice = (
      <div className={styles['notice']} role="status">
        {words.noneAtLevel}
      </div>
    );
  }

  return (
    <section className={styles['screen']} aria-labelledby="log-title">
      <header className={styles['header']}>
        <h1 id="log-title" className={styles['title']}>
          {words.title}
        </h1>
        <p className={styles['subtitle']}>{words.subtitle(LOG_VIEW_LIMIT)}</p>
      </header>

      <div className={styles['toolbar']}>
        <div className={styles['filter']}>
          <Segment options={options} value={filter} onChange={onFilterChange} label={words.filterLabel} />
        </div>
      </div>

      {view.phase === 'failed' ? (
        <div className={styles['alert']} role="alert">
          {words.historyFailed}
        </div>
      ) : null}

      <div className={styles['table']}>
        <div className={styles['head']} aria-hidden="true">
          <span>{words.columns.time}</span>
          <span>{words.columns.level}</span>
          <span>{words.columns.message}</span>
        </div>
        {notice ?? (
          <ol className={styles['rows']} aria-label={words.entriesLabel}>
            {rows.map((entry) => (
              <li key={entry.seq} className={styles['row']} data-level={entry.level}>
                <time className={styles['time']} dateTime={entry.at} title={entry.at}>
                  {formatLogTime(entry.at, now, i18n)}
                </time>
                <span>
                  <LevelBadge level={entry.level} label={words.levels[entry.level]} />
                </span>
                <span className={styles['message']}>
                  {entry.source === 'app' ? (
                    <span className={styles['source']} title={words.appTagTitle}>
                      {words.appTag}
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
        <span>{words.count(view.entries.length)}</span>
        <span>{words.kept(LOG_VIEW_LIMIT)}</span>
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
  const i18n = useI18n();
  const view = useLog(rs ?? window.rs);
  const [filter, setFilter] = useState<LogFilter>('all');
  return <LogPanel view={view} filter={filter} onFilterChange={setFilter} i18n={i18n} />;
}
