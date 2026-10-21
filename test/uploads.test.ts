import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { torontoDate } from "../src/config/shows";
import { GiB, MiB } from "../src/upload/validate";
import { direct, freshBand, http, media, SHOW_NIGHT } from "./upload-helpers";
import type { Init } from "./upload-helpers";
import { DUMMY_TOKEN } from "./fakes/siteverify";

/** Committed bytes on `day`, as one finished upload would leave them. */
async function seed(c: ReturnType<typeof direct>["counters"], bytes: number, day: string) {
  const u = crypto.randomUUID();
  await c.charge(u, bytes, day);
  await c.finish(u);
}

const KEY_TAIL = /^(\d{8}T\d{6}|unknown)__([a-z0-9-]+)__([0-9a-f]{8})\.([a-z0-9]+)$/;

async function initOk(body: Record<string, unknown>): Promise<Init> {
  const res = await http.init(media(body));
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json<Init>();
}

/** One-part upload through the router; returns the stored object. */
async function uploadSmall(body: Record<string, unknown>) {
  const init = await initOk(body);
  const size = (body.size as number | undefined) ?? 10;
  const put = await http.part(init.id, 1, new Uint8Array(size));
  expect(put.status).toBe(200);
  const { etag } = await put.json<{ etag: string }>();
  const done = await http.complete(init.id, [{ n: 1, etag }]);
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ key: init.key });
  return { init, obj: (await env.MEDIA.head(init.key))! };
}

describe("POST /api/uploads → key protocol", () => {
  it("credit @Fool.Hearts! → ig-fool-hearts in the key; guest's spelling in customMetadata", async () => {
    const { init, obj } = await uploadSmall({ credit: "@Fool.Hearts!" });
    expect(init.key).toMatch(/^foolhearts\/2026-10-10-the-dakota\/20261010T221500__ig-fool-hearts__[0-9a-f]{8}\.mp4$/);
    expect(obj.customMetadata).toEqual({ credit: "@Fool.Hearts!", originalName: "clip.mp4", lastModified: String(SHOW_NIGHT) });
    expect(obj.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("no credit → anon", async () => {
    const { init, obj } = await uploadSmall({});
    expect(KEY_TAIL.exec(init.key.split("/").pop()!)?.[2]).toBe("anon");
    expect(obj.customMetadata?.credit).toBe("anon");
  });

  it("band with no shows → <band>/unsorted/<capture date>; ext lowercased", async () => {
    const band = freshBand({ shows: [] });
    const res = await direct(band).init(media({ name: "IMG_1.HEIC", type: "image/heic", lastModified: Date.parse("2025-01-05T01:30:00-05:00") }));
    const init = await res.json<Init>();
    // Capture 01:30 → the previous night's date (06:00 rollover); the stamp is wall clock.
    expect(init.key).toMatch(new RegExp(`^${band.slug}/unsorted/2025-01-04/20250105T013000__anon__[0-9a-f]{8}\\.heic$`));
  });

  it("no lastModified → capture `unknown`", async () => {
    const init = await initOk({ lastModified: undefined, showId: "2026-10-10-the-dakota" });
    expect(init.key).toMatch(/^foolhearts\/2026-10-10-the-dakota\/unknown__anon__[0-9a-f]{8}\.mp4$/);
  });

  it("showId overrides capture-time attribution; unknown showId → 400", async () => {
    const init = await initOk({ lastModified: Date.parse("2025-01-05T12:00:00-05:00"), showId: "2026-10-10-the-dakota" });
    expect(init.key.startsWith("foolhearts/2026-10-10-the-dakota/20250105T120000__")).toBe(true);
    const bad = await http.init(media({ showId: "nope" }));
    expect(bad.status).toBe(400);
  });

  it("empty browser type is inferred from the extension", async () => {
    const { obj } = await uploadSmall({ name: "v.MOV", type: "" });
    expect(obj.httpMetadata?.contentType).toBe("video/quicktime");
  });

  it("returns partSize 32 MiB and the part count", async () => {
    const init = await initOk({ size: 70 * MiB });
    expect(init).toMatchObject({ partSize: 32 * MiB, parts: 3 });
    await http.abort(init.id);
  });

  it("reached via /<band>/api/uploads on an unclaimed host", async () => {
    const res = await fetchUnclaimed();
    expect(res.status).toBe(201);
    expect((await res.json<Init>()).key.startsWith("shivs/unsorted/")).toBe(true);
  });
});

function fetchUnclaimed() {
  return exports.default.fetch("http://localhost:8787/shivs/api/uploads", {
    method: "POST",
    headers: { "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify(media()),
  });
}

describe("init refusals", () => {
  it.each([
    ["application/pdf type", { name: "doc.pdf", type: "application/pdf" }],
    ["pdf type on a video name", { type: "application/pdf" }],
    ["video type on an image ext", { name: "a.jpg", type: "video/mp4" }],
    ["unlisted ext", { name: "a.gif", type: "image/gif" }],
  ])("%s → 415 with a one-line reason", async (_n, over) => {
    const res = await http.init(media(over));
    expect(res.status).toBe(415);
    const { reason } = await res.json<{ reason: string }>();
    expect(reason).toMatch(/^[^\n]+\.$/);
  });

  it("size over caps.fileMb → 413", async () => {
    const res = await http.init(media({ size: 2048 * MiB + 1 }));
    expect(res.status).toBe(413);
    expect((await res.json<{ reason: string }>()).reason).toContain("2048 MB");
  });

  it("band paused → 503 naming the band, nothing in R2", async () => {
    const d = direct(freshBand({ paused: true }));
    const res = await d.init(media());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: "Fool Hearts isn't taking uploads right now." });
    expect(d.r2Calls).toEqual([]);
  });

  it("day counter at day_gb − 1 MiB, 10 MiB init → 429 daily cap, nothing created in R2", async () => {
    const band = freshBand();
    const d = direct(band);
    await seed(d.counters, band.caps.dayGb * GiB - MiB, torontoDate(Date.now()));
    const res = await d.init(media({ size: 10 * MiB }));
    expect(res.status).toBe(429);
    expect((await res.json<{ reason: string }>()).reason).toMatch(/daily cap/i);
    expect(d.r2Calls).toEqual([]);
    expect((await d.counters.usage(torontoDate(Date.now()))).inflight).toBe(0);
  });

  it("10 inits of 2 GiB with no parts sent hold no cap: a 5 MiB upload still succeeds", async () => {
    const band = freshBand();
    const d = direct(band);
    const day = torontoDate(Date.now());
    const squatters: Init[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await d.init(media({ size: 2048 * MiB }));
      expect(res.status).toBe(201);
      squatters.push(await res.json<Init>());
    }
    expect(await d.counters.usage(day)).toEqual({ day: 0, rolling: 0, inflight: 0 });

    const res = await d.init(media({ size: 5 * MiB }));
    expect(res.status, await res.clone().text()).toBe(201);
    const init = await res.json<Init>();
    const put = await d.part(init.id, 1, new Uint8Array(5 * MiB));
    expect(put.status).toBe(200);
    expect((await d.counters.usage(day)).inflight).toBe(5 * MiB);
    const { etag } = await put.json<{ etag: string }>();
    expect((await d.complete(init.id, [{ n: 1, etag }])).status).toBe(200);
    expect(await d.counters.usage(day)).toEqual({ day: 5 * MiB, rolling: 5 * MiB, inflight: 0 });
    for (const s of squatters) await d.abort(s.id);
  });

  it("rolling 30 d at month_gb (spread over past days) → 429 monthly cap", async () => {
    const band = freshBand();
    const d = direct(band);
    const today = torontoDate(Date.now());
    const [y, m, dd] = today.split("-").map(Number);
    const daysAgo = (n: number) => new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
    for (let i = 1; i <= 10; i++) await seed(d.counters, (band.caps.monthGb * GiB) / 10, daysAgo(i));
    const res = await d.init(media({ size: MiB }));
    expect(res.status).toBe(429);
    expect((await res.json<{ reason: string }>()).reason).toMatch(/monthly cap/i);
    expect(d.r2Calls).toEqual([]);
  });

  it("rate limit: 40 real inits from one IP in a minute all succeed", async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 40; i++) {
      const res = await http.init(media(), ip);
      expect(res.status, await res.clone().text()).toBe(201);
      await http.abort((await res.json<Init>()).id);
    }
  });

  it("rate limit: 121st POST from one IP → 429 with retryAfter; other IPs and other bands unaffected", async () => {
    const ip = crypto.randomUUID();
    // Invalid bodies still count: the limit sits before Turnstile and validation.
    const invalid = { turnstileToken: DUMMY_TOKEN };
    for (let i = 0; i < 120; i++) expect((await http.init(invalid, ip)).status).toBe(400);
    const res = await http.init(invalid, ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "Too many uploads at once; wait a minute and try again.", retryAfter: 60 });
    expect((await http.init(invalid)).status).toBe(400);
    const otherBand = await exports.default.fetch("http://localhost:8787/shivs/api/uploads", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
      body: JSON.stringify(invalid),
    });
    expect(otherBand.status).toBe(400);
  });

  it("a cap 429 carries no retryAfter", async () => {
    const band = freshBand();
    const d = direct(band);
    await seed(d.counters, band.caps.dayGb * GiB, torontoDate(Date.now()));
    const res = await d.init(media());
    expect(res.status).toBe(429);
    expect(await res.json()).not.toHaveProperty("retryAfter");
  });

  it("verified token but no file details → 400", async () => {
    const res = await http.init({ turnstileToken: DUMMY_TOKEN });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "The file needs a name." });
  });
});
