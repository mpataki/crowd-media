import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const get = (url: string) => exports.default.fetch(url);
// The index page as ASSETS serves it, whatever the page lane has put in it.
const indexHtml = async () => (await env.ASSETS.fetch("http://assets.local/")).text();

describe("page routing", () => {
  it.each(["http://localhost:8787/shivs/", "http://localhost:8787/shivs", "https://share.foolhearts.com/"])(
    "%s → the index page",
    async (url) => {
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await res.text()).toBe(await indexHtml());
    },
  );

  it("unclaimed host root → 404 plain text (no default band)", async () => {
    const res = await get("http://localhost:8787/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it.each(["http://localhost:8787", "https://share.foolhearts.com"])("%s static paths pass through to ASSETS", async (origin) => {
    for (const path of ["/app.js", "/brand/shivs.svg"]) {
      const res = await get(origin + path);
      const direct = await env.ASSETS.fetch(`http://assets.local${path}`);
      expect(res.status).toBe(direct.status);
      expect(await res.text()).toBe(await direct.text());
    }
    // Present on this branch, so the pass-through is checked against a real asset too.
    expect((await get(`${origin}/brand/shivs.svg`)).status).toBe(200);
  });
});
