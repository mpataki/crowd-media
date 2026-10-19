// Object key protocol — the filename is the record of who shot what, when (no database):
//   <prefix>/<capture>__<credit>__<uuid8>.<ext>
// prefix from objectPrefix(): `<band>/<show-id>` or `<band>/unsorted/<YYYY-MM-DD>`.
// `__` separates fields; no field can contain it (credit is single-dash slug, capture
// and uuid8 are alphanumeric), so a key splits back into its fields unambiguously.

export const CREDIT_MAX = 40;
export const ANON = "anon";

/**
 * Guest name or handle → `[a-z0-9-]`, ≤ 40, `anon` when nothing survives. A leading `@`
 * becomes `ig-` so Instagram handles stay recognisable: `@Fool.Hearts!` → `ig-fool-hearts`.
 */
export function creditSlug(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  const handle = trimmed.startsWith("@");
  const body = slugify(handle ? trimmed.slice(1) : trimmed);
  if (!body) return ANON;
  const slug = (handle ? `ig-${body}` : body).slice(0, CREDIT_MAX).replace(/-+$/, "");
  return slug || ANON;
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: José → jose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const torontoClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `YYYYMMDDTHHMMSS`, Toronto wall clock (no rollover: this is the shutter time), or `unknown`. */
export function captureStamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const p: Record<string, string> = {};
  for (const { type, value } of torontoClock.formatToParts(ms)) p[type] = value;
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

export function objectKey(prefix: string, captureMs: number | null, credit: string, ext: string): string {
  const uuid8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}/${captureStamp(captureMs)}__${credit}__${uuid8}.${ext}`;
}
