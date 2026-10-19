// GET /api/band — what the upload page renders before any file is chosen. Contract
// shared with the page; keep field names stable.
import { config } from "../config";
import type { Band } from "../config";
import { pickShow, recentShows, themeFor } from "../config/shows";

const RECENT_LIMIT = 5;

export function bandInfo(band: Band, nowMs: number) {
  const pick = pickShow(band, null, nowMs);
  const brief = (s: { id: string; venue: string; starts: string }) => ({ id: s.id, venue: s.venue, starts: s.starts });
  return {
    band: { slug: band.slug, name: band.name },
    canonicalUrl: band.hosts[0] ? `https://${band.hosts[0]}/` : null,
    theme: themeFor(band, pick.show),
    caps: band.caps,
    paused: band.paused,
    show: pick.show ? brief(pick.show) : null,
    reason: pick.reason,
    recent: recentShows(band, nowMs, RECENT_LIMIT).map(brief),
    turnstile: { sitekey: config.turnstile.sitekey },
  };
}
