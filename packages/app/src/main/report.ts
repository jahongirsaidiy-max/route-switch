// The app has no logger yet (TASK-201 brings the helper client and its log
// stream). Until then the main process reports problems as one JSON line on
// stderr — the same shape the helper logs in — and nothing else writes there.

export type ReportLevel = 'warn' | 'error';

export type Report = (level: ReportLevel, msg: string, detail?: unknown) => void;

/** Details can carry text a web page chose (a URL it requested), so they are cut short. */
export const MAX_DETAIL_LENGTH = 300;

const describe = (detail: unknown): string => {
  const text = detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail);
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
};

export function createStderrReport(write: (line: string) => void, now: () => Date = () => new Date()): Report {
  return (level, msg, detail) => {
    const entry = { level, at: now().toISOString(), msg, ...(detail === undefined ? {} : { detail: describe(detail) }) };
    write(`${JSON.stringify(entry)}\n`);
  };
}
