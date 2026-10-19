import type { Show } from "./types";

/** Consent wording is Mat's; keep it verbatim. */
export function consentText(band: string): string {
  return `By uploading you agree ${band} may post this on our socials. We never publish your name without asking.`;
}

export function summaryText(sent: number, failed: number, band: string): string {
  const files = sent === 1 ? "1 file" : `${sent} files`;
  const tail = failed === 0 ? "" : ` ${failed} failed — tap to retry.`;
  return `Thanks! ${files} sent to ${band}.${tail}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "The Dakota Tavern, Sat Oct 10". The date is the show's own local calendar date (read
 * from the ISO string, not converted to the guest's zone).
 */
export function showLabel(show: Show): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(show.starts);
  if (!m) return show.venue;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${show.venue}, ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Text colour for a label sitting on `accent`: white unless it fails 4.5:1. */
export function onAccent(accent: string): "#fff" | "#000" {
  const m = /^#([0-9a-f]{6})$/i.exec(accent);
  if (!m) return "#fff";
  const hex = m[1];
  const lum = [0, 2, 4]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return 1.05 / (l + 0.05) >= 4.5 ? "#fff" : "#000";
}
