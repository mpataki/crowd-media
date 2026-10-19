// Show attribution: which show an upload belongs to, and where it lands in R2.
// Pure functions; times are epoch ms so callers own the clock.
import type { Band, Show, Theme } from "./schema";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Capture times this far either side of a show's window still count as that show. */
export const WINDOW_SLACK_MS = 6 * HOUR_MS;
/** Without a capture match, a show started up to this long ago is still "current". */
export const RECENT_GRACE_MS = 14 * DAY_MS;
/** Local hour before which a Toronto calendar day still belongs to the previous night. */
const ROLLOVER_HOUR = 6;

export type ShowPick = {
  show: Show | null;
  reason: "capture" | "recent" | "none";
  /** Toronto date (06:00 rollover) of the capture time, else of now; names `unsorted/`. */
  date: string;
};

export function pickShow(band: Band, captureMs: number | null, nowMs: number): ShowPick {
  const date = torontoDate(captureMs ?? nowMs);

  if (captureMs !== null) {
    let best: Show | null = null;
    let bestDist = Infinity;
    for (const s of band.shows) {
      const starts = Date.parse(s.starts);
      const ends = Date.parse(s.ends);
      if (captureMs < starts - WINDOW_SLACK_MS || captureMs > ends + WINDOW_SLACK_MS) continue;
      const dist = Math.abs(captureMs - starts);
      if (dist < bestDist) [best, bestDist] = [s, dist];
    }
    if (best) return { show: best, reason: "capture", date };
  }

  const latest = recentShows(band, nowMs, 1)[0];
  if (latest && nowMs - Date.parse(latest.starts) <= RECENT_GRACE_MS) {
    return { show: latest, reason: "recent", date };
  }
  return { show: null, reason: "none", date };
}

/** Shows that have started by `nowMs`, newest first. */
export function recentShows(band: Band, nowMs: number, limit: number): Show[] {
  return band.shows
    .filter((s) => Date.parse(s.starts) <= nowMs)
    .sort((a, b) => Date.parse(b.starts) - Date.parse(a.starts))
    .slice(0, limit);
}

/** Band theme with the show's per-night fields laid over it (shallow). */
export function themeFor(band: Band, show: Show | null): Theme {
  return { ...band.theme, ...show?.theme };
}

const torontoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * The Toronto calendar date of an instant with a 06:00 rollover: a 01:30 Saturday
 * upload is Friday night's. Done on wall-clock fields (hour < 6 → previous day), not
 * by subtracting 6 h from the instant, which would be an hour off on DST change days.
 */
export function torontoDate(ms: number): string {
  const p: Record<string, number> = {};
  for (const { type, value } of torontoParts.formatToParts(ms)) p[type] = Number(value);
  const day = p.hour < ROLLOVER_HOUR ? p.day - 1 : p.day;
  // Date.UTC normalises day 0 to the last day of the previous month.
  return new Date(Date.UTC(p.year, p.month - 1, day)).toISOString().slice(0, 10);
}

/** R2 key prefix: `<band>/<show-id>` or `<band>/unsorted/<YYYY-MM-DD>`. */
export function objectPrefix(band: Band, pick: ShowPick): string {
  return pick.show ? `${band.slug}/${pick.show.id}` : `${band.slug}/unsorted/${pick.date}`;
}
