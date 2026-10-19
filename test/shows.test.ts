import { describe, expect, it } from "vitest";
import type { Band, Show } from "../src/config";
import { objectPrefix, pickShow, themeFor, torontoDate } from "../src/config/shows";

const t = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

const show = (id: string, starts: string, ends: string, theme?: Show["theme"]): Show => ({
  id,
  venue: `Venue ${id}`,
  starts,
  ends,
  ...(theme ? { theme } : {}),
});

const band = (shows: Show[]): Band => ({
  slug: `band-${crypto.randomUUID().slice(0, 8)}`,
  name: "Test Band",
  hosts: [],
  theme: { accent: "#123456", logo: "/brand/x.svg", blurb: "band blurb" },
  caps: { fileMb: 1, dayGb: 1, monthGb: 1 },
  paused: false,
  shows,
});

const friday = show("fri", "2026-10-09T21:00-04:00", "2026-10-10T02:00-04:00");
const saturday = show("sat", "2026-10-10T21:00-04:00", "2026-10-11T02:00-04:00");
const longAfter = t("2026-12-01T12:00-05:00");

describe("pickShow", () => {
  it("capture inside the window → that show", () => {
    const p = pickShow(band([saturday]), t("2026-10-10T23:15-04:00"), longAfter);
    expect(p).toMatchObject({ show: { id: "sat" }, reason: "capture" });
  });

  it("capture the morning after, within 6 h of ends → same show; past it → not", () => {
    const b = band([saturday]);
    expect(pickShow(b, t("2026-10-11T07:59-04:00"), longAfter)).toMatchObject({ show: { id: "sat" }, reason: "capture" });
    expect(pickShow(b, t("2026-10-11T08:01-04:00"), longAfter)).toMatchObject({ show: null, reason: "none" });
  });

  it("two shows on consecutive nights → the one the capture time belongs to", () => {
    const b = band([friday, saturday]);
    const now = t("2026-10-11T12:00-04:00");
    expect(pickShow(b, t("2026-10-09T22:30-04:00"), now).show?.id).toBe("fri");
    expect(pickShow(b, t("2026-10-10T01:30-04:00"), now).show?.id).toBe("fri");
    expect(pickShow(b, t("2026-10-10T20:45-04:00"), now).show?.id).toBe("sat");
    expect(pickShow(b, t("2026-10-11T00:30-04:00"), now).show?.id).toBe("sat");
  });

  it("capture in two overlapping windows → the show whose start is closest", () => {
    const matinee = show("matinee", "2026-10-10T14:00-04:00", "2026-10-10T17:00-04:00");
    const evening = show("evening", "2026-10-10T20:00-04:00", "2026-10-10T23:00-04:00");
    const p = pickShow(band([matinee, evening]), t("2026-10-10T18:30-04:00"), longAfter);
    expect(p).toMatchObject({ show: { id: "evening" }, reason: "capture" });
  });

  it("no capture time, show 3 days ago → recent", () => {
    const now = t(saturday.starts) + 3 * DAY;
    expect(pickShow(band([friday, saturday]), null, now)).toMatchObject({ show: { id: "sat" }, reason: "recent" });
  });

  it("capture outside every window falls back to recent", () => {
    const now = t(saturday.starts) + 2 * DAY;
    const p = pickShow(band([saturday]), t("2026-09-01T12:00-04:00"), now);
    expect(p).toMatchObject({ show: { id: "sat" }, reason: "recent" });
  });

  it("nothing started in the last 14 days → none, unsorted by Toronto date", () => {
    const upcoming = show("later", "2026-12-31T21:00-05:00", "2027-01-01T01:00-05:00");
    const b = band([saturday, upcoming]);
    const now = t(saturday.starts) + 14 * DAY + 60_000;
    const p = pickShow(b, null, now);
    expect(p).toMatchObject({ show: null, reason: "none", date: "2026-10-24" });
    expect(objectPrefix(b, p)).toBe(`${b.slug}/unsorted/2026-10-24`);
  });

  it("unsorted date follows the capture time when there is one", () => {
    const b = band([]);
    const p = pickShow(b, t("2026-10-11T01:30-04:00"), longAfter);
    expect(p.date).toBe("2026-10-10");
  });
});

describe("objectPrefix and themeFor", () => {
  it("prefixes with band and show id", () => {
    const b = band([saturday]);
    expect(objectPrefix(b, pickShow(b, t("2026-10-10T22:00-04:00"), longAfter))).toBe(`${b.slug}/sat`);
  });

  it("lays a show's theme override over the band theme, field by field", () => {
    const b = band([]);
    const wedding = show("w", saturday.starts, saturday.ends, { blurb: "wedding!" });
    expect(themeFor(b, wedding)).toEqual({ accent: "#123456", logo: "/brand/x.svg", blurb: "wedding!" });
    expect(themeFor(b, null)).toEqual(b.theme);
  });
});

describe("torontoDate (06:00 rollover)", () => {
  it.each([
    ["2026-07-15T05:59-04:00", "2026-07-14"], // EDT
    ["2026-07-15T06:01-04:00", "2026-07-15"],
    ["2026-01-15T05:59-05:00", "2026-01-14"], // EST
    ["2026-01-15T06:01-05:00", "2026-01-15"],
    ["2026-03-08T06:30-04:00", "2026-03-08"], // DST starts that morning: wall-clock, not instant − 6 h
    ["2026-11-01T03:00-05:00", "2026-10-31"], // DST ends that morning; month boundary
    ["2027-01-01T01:00-05:00", "2026-12-31"], // year boundary
  ])("%s → %s", (iso, date) => {
    expect(torontoDate(t(iso))).toBe(date);
  });
});
