// GET /api/band — what the upload page renders before any file is chosen. Contract
// shared with the page; keep field names stable.
import { config } from "../config";
import type { Band, Config } from "../config";
import { pickShow, recentShows, themeFor } from "../config/shows";
import { ACCEPTED_EXTENSIONS } from "../upload/validate";

const RECENT_LIMIT = 5;

export function bandInfo(band: Band, nowMs: number, cfg: Pick<Config, "turnstile"> = config) {
  const pick = pickShow(band, null, nowMs);
  const brief = (s: { id: string; venue: string; starts: string }) => ({ id: s.id, venue: s.venue, starts: s.starts });
  return {
    band: { slug: band.slug, name: band.name },
    canonicalUrl: band.hosts[0] ? `https://${band.hosts[0]}/` : null,
    theme: themeFor(band, pick.show),
    caps: band.caps,
    // The server's own allow-list, so the page refuses exactly what init would.
    accept: { extensions: ACCEPTED_EXTENSIONS, maxFileMb: band.caps.fileMb },
    paused: band.paused,
    show: pick.show ? brief(pick.show) : null,
    reason: pick.reason,
    recent: recentShows(band, nowMs, RECENT_LIMIT).map(brief),
    // null = Turnstile off (no block in bands.yaml): the page loads no widget.
    turnstile: cfg.turnstile,
  };
}
