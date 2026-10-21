import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bandInfo } from "../src/api/band";
import { config } from "../src/config";
import { ACCEPTED_EXTENSIONS } from "../src/upload/validate";

const get = (url: string) => exports.default.fetch(url);
const foolhearts = config.bands.find((b) => b.slug === "foolhearts")!;

describe("GET /api/band", () => {
  it("Host share.foolhearts.com → Fool Hearts", async () => {
    const res = await get("https://share.foolhearts.com/api/band");
    expect(res.status).toBe(200);
    const body = await res.json<ReturnType<typeof bandInfo>>();
    expect(body).toMatchObject({
      band: { slug: "foolhearts", name: "Fool Hearts" },
      canonicalUrl: "https://share.foolhearts.com/",
      caps: { fileMb: 2048, dayGb: 20, monthGb: 100 },
      accept: { extensions: [...ACCEPTED_EXTENSIONS], maxFileMb: 2048 },
      paused: false,
      turnstile: { sitekey: config.turnstile!.sitekey },
    });
    expect(body.accept.extensions).toEqual(expect.arrayContaining(["jpg", "heic", "mov", "mp4"]));
    expect(body.accept.extensions).not.toContain("gif");
    expect(["capture", "recent", "none"]).toContain(body.reason);
    expect(body.recent).toContainEqual({ id: "2026-10-10-the-dakota", venue: "The Dakota Tavern", starts: "2026-10-10T21:00-04:00" });
  });

  it("localhost/shivs/api/band → The Shivs, no canonical URL, no shows", async () => {
    const res = await get("http://localhost:8787/shivs/api/band");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      band: { slug: "shivs", name: "The Shivs" },
      canonicalUrl: null,
      theme: { accent: "#1f6feb", logo: "/brand/shivs.svg", blurb: "Send us what you shot!" },
      caps: { fileMb: 2048, dayGb: 20, monthGb: 100 },
      accept: { extensions: [...ACCEPTED_EXTENSIONS], maxFileMb: 2048 },
      paused: false,
      show: null,
      reason: "none",
      recent: [],
      turnstile: { sitekey: config.turnstile!.sitekey },
    });
  });

  it("no turnstile block → turnstile: null (page treats it as off)", () => {
    expect(bandInfo(foolhearts, Date.now(), { turnstile: null }).turnstile).toBeNull();
  });

  it("the chosen show's theme override wins; without a show, the band theme", () => {
    const threeDaysOn = Date.parse("2026-10-13T12:00-04:00");
    expect(bandInfo(foolhearts, threeDaysOn)).toMatchObject({
      show: { id: "2026-10-10-the-dakota" },
      reason: "recent",
      theme: { accent: "#c8102e", blurb: "Marianne & Mark's wedding — thanks for coming!" },
    });
    const monthOn = Date.parse("2026-11-15T12:00-05:00");
    expect(bandInfo(foolhearts, monthOn)).toMatchObject({
      show: null,
      reason: "none",
      theme: foolhearts.theme,
    });
  });

  it.each([
    ["branded host + band segment", "https://share.foolhearts.com/shivs/api/band"],
    ["unknown host, no segment", "https://unknown.example.com/api/band"],
    ["unclaimed host, unknown segment", "http://localhost:8787/nobody/api/band"],
  ])("%s → 404 plain text", async (_name, url) => {
    const res = await get(url);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("unknown API path on a resolved band → 404 JSON", async () => {
    const res = await get(`https://share.foolhearts.com/api/nope-${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("/api/health stays band-less on any host", async () => {
    for (const url of ["https://unknown.example.com/api/health", "http://localhost:8787/api/health"]) {
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });
});
