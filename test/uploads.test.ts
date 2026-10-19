import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { torontoDate } from "../src/config/shows";
import { GiB, MiB } from "../src/upload/validate";
import { direct, freshBand, http, media, SHOW_NIGHT } from "./upload-helpers";
import type { Init } from "./upload-helpers";

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

  it("empty browser type is inferred from the extension; turnstileToken is ignored", async () => {
    const { obj } = await uploadSmall({ name: "v.MOV", type: "", turnstileToken: "x" });
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
    await d.counters.commit("seed", band.caps.dayGb * GiB - MiB, torontoDate(Date.now()));
    const res = await d.init(media({ size: 10 * MiB }));
    expect(res.status).toBe(429);
    expect((await res.json<{ reason: string }>()).reason).toMatch(/daily cap/i);
    expect(d.r2Calls).toEqual([]);
    expect((await d.counters.usage(torontoDate(Date.now()))).reserved).toBe(0);
  });

  it("rolling 30 d at month_gb (spread over past days) → 429 monthly cap", async () => {
    const band = freshBand();
    const d = direct(band);
    const today = torontoDate(Date.now());
    const [y, m, dd] = today.split("-").map(Number);
    const daysAgo = (n: number) => new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
    for (let i = 1; i <= 10; i++) await d.counters.commit(`s${i}`, (band.caps.monthGb * GiB) / 10, daysAgo(i));
    const res = await d.init(media({ size: MiB }));
    expect(res.status).toBe(429);
    expect((await res.json<{ reason: string }>()).reason).toMatch(/monthly cap/i);
    expect(d.r2Calls).toEqual([]);
  });

  it("rate limit: 31st POST from one IP in a minute → 429, other IPs unaffected", async () => {
    const ip = crypto.randomUUID();
    // Invalid bodies still count: the limit sits before validation and costs no R2 calls.
    for (let i = 0; i < 30; i++) expect((await http.init({}, ip)).status).toBe(400);
    const res = await http.init({}, ip);
    expect(res.status).toBe(429);
    expect((await res.json<{ reason: string }>()).reason).toMatch(/too many/i);
    expect((await http.init({})).status).toBe(400);
  });

  it("malformed body → 400", async () => {
    const res = await http.init("not an object");
    expect(res.status).toBe(400);
  });
});
