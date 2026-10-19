import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("GET /api/health returns ok", async () => {
  const res = await exports.default.fetch("https://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
