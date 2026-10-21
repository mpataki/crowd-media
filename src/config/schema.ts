// Schema for bands.yaml. Runs at build time (scripts/build-config.ts, under Node) and in
// tests — never in the Worker: src/config/index.ts imports only the *types* from here,
// so valibot stays out of the bundle. Keep this file free of TS-only runtime syntax
// (enums, namespaces, parameter properties): Node runs it via type stripping.
import * as v from "valibot";

const HOUR_MS = 3_600_000;
const DEFAULT_SHOW_HOURS = 5;

// ISO-8601 with an explicit offset, minutes required, seconds optional. A bare local
// time would be read in whatever zone the build machine is in — reject it.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isoWithOffset = v.pipe(
  v.string(),
  v.regex(ISO_WITH_OFFSET, "must be ISO-8601 with an offset, e.g. 2026-10-10T21:00-04:00"),
  v.check((s) => !Number.isNaN(Date.parse(s)), "is not a real date/time"),
);

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slug = v.pipe(v.string(), v.regex(SLUG, "must be lowercase letters, digits and single dashes"));
// Hostname only: no scheme, port or path. Lowercase so Host matching is a plain compare.
const hostname = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "must be a lowercase hostname (no scheme, port or path)"),
);
const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1, "must not be empty"));
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const themeFields = {
  accent: v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i, 'must be a hex colour like "#c8102e" (quote it in YAML)')),
  logo: v.pipe(v.string(), v.startsWith("/", "must be a site path like /brand/x.svg")),
  blurb: nonEmpty,
};
const BandTheme = v.strictObject(themeFields);
const ShowTheme = v.strictObject({
  accent: v.optional(themeFields.accent),
  logo: v.optional(themeFields.logo),
  blurb: v.optional(themeFields.blurb),
});

const Show = v.pipe(
  v.strictObject({
    id: slug,
    venue: nonEmpty,
    starts: isoWithOffset,
    ends: v.optional(isoWithOffset),
    theme: v.optional(ShowTheme),
  }),
  v.transform((s) => ({
    ...s,
    ends: s.ends ?? new Date(Date.parse(s.starts) + DEFAULT_SHOW_HOURS * HOUR_MS).toISOString(),
  })),
  v.forward(
    v.check((s) => Date.parse(s.ends) > Date.parse(s.starts), "must be after starts"),
    ["ends"],
  ),
);

const Band = v.pipe(
  v.strictObject({
    name: nonEmpty,
    // May be empty: a band without a domain is reached by path on an unclaimed host.
    hosts: v.array(hostname),
    theme: BandTheme,
    caps: v.strictObject({ file_mb: positiveInt, day_gb: positiveInt, month_gb: positiveInt }),
    paused: v.optional(v.boolean(), false),
    shows: v.optional(v.array(Show), []),
  }),
  v.forward(
    v.check((b) => new Set(b.shows.map((s) => s.id)).size === b.shows.length, "show ids must be unique within a band"),
    ["shows"],
  ),
);

const Config = v.pipe(
  v.strictObject({
    // Absent = no widget (the page sends no token). Present means a real sitekey.
    turnstile: v.optional(v.strictObject({ sitekey: nonEmpty })),
    bands: v.pipe(
      v.record(
        // "api" would make /api/... ambiguous on unclaimed hosts.
        v.pipe(slug, v.check((s) => s !== "api", 'band slug "api" is reserved')),
        Band,
      ),
      v.check((r) => Object.keys(r).length > 0, "at least one band is required"),
    ),
  }),
  v.forward(
    v.check((c) => {
      const all = Object.values(c.bands).flatMap((b) => b.hosts);
      return new Set(all).size === all.length;
    }, "a host may belong to only one band"),
    ["bands"],
  ),
  v.transform((c) => ({
    turnstile: c.turnstile ?? null,
    bands: Object.entries(c.bands).map(([slug, b]) => ({
      slug,
      name: b.name,
      hosts: b.hosts,
      theme: b.theme,
      caps: { fileMb: b.caps.file_mb, dayGb: b.caps.day_gb, monthGb: b.caps.month_gb },
      paused: b.paused,
      shows: b.shows,
    })),
  })),
);

export type Config = v.InferOutput<typeof Config>;
export type Band = Config["bands"][number];
export type Show = Band["shows"][number];
export type Theme = Band["theme"];

export type ConfigIssue = { path: (string | number)[]; message: string };
export type ValidateResult = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

export function validateConfig(data: unknown): ValidateResult {
  const res = v.safeParse(Config, data, { abortEarly: false });
  if (res.success) return { ok: true, config: res.output };
  return {
    ok: false,
    issues: res.issues.map((i) => ({
      path: (i.path ?? []).map((p) => p.key as string | number),
      message: i.message,
    })),
  };
}

/** `bands.foolhearts.shows[0].starts` — the YAML path a human edits. */
export function formatPath(path: (string | number)[]): string {
  let out = "";
  for (const k of path) out += typeof k === "number" ? `[${k}]` : out ? `.${k}` : k;
  return out || "(root)";
}
