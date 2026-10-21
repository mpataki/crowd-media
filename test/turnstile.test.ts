import { env, exports } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { torontoDate } from "../src/config/shows";
import { SITEVERIFY_URL, verifyTurnstile } from "../src/upload/turnstile";
import type { Fetcher } from "../src/upload/turnstile";
import worker from "../src/worker";
import { DUMMY_TOKEN, NETWORK_HEADER, siteverifyFake, TEST_SECRET } from "./fakes/siteverify";
import { direct, freshBand, HOST, http, media } from "./upload-helpers";

declare module "vitest" {
  interface ProvidedContext {
    siteverifyNetwork: boolean;
  }
}

const VERIFY_FAILED = { reason: "Verification failed — reload the page and try again." };

/** The fake as an injected fetcher, recording what was sent. */
function fakeFetcher() {
  const sent: { url: string; body: unknown }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = JSON.parse(init.body as string);
    sent.push({ url, body });
    const reply = siteverifyFake(body);
    return Response.json(reply.json, { status: reply.status });
  };
  return { sent, fetcher };
}

describe("verifyTurnstile", () => {
  it("POSTs secret, response and remoteip as JSON to siteverify; always-pass → ok", async () => {
    const { sent, fetcher } = fakeFetcher();
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    expect(await verifyTurnstile(fetcher, TEST_SECRET.pass, DUMMY_TOKEN, ip)).toEqual({ ok: true });
    expect(sent).toEqual([{ url: SITEVERIFY_URL, body: { secret: TEST_SECRET.pass, response: DUMMY_TOKEN, remoteip: ip } }]);
  });

  it("no client IP → remoteip omitted", async () => {
    const { sent, fetcher } = fakeFetcher();
    await verifyTurnstile(fetcher, TEST_SECRET.pass, DUMMY_TOKEN, null);
    expect(Object.keys(sent[0].body as object).sort()).toEqual(["response", "secret"]);
  });

  it.each([
    ["always-fail", TEST_SECRET.fail, "invalid-input-response"],
    ["token already spent", TEST_SECRET.spent, "timeout-or-duplicate"],
  ])("%s secret → rejected with Cloudflare's error code", async (_n, secret, code) => {
    const { fetcher } = fakeFetcher();
    expect(await verifyTurnstile(fetcher, secret, DUMMY_TOKEN, null)).toEqual({ ok: false, kind: "rejected", codes: [code] });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a string", 42],
    ["over 2048 chars", "x".repeat(2049)],
  ])("token %s → rejected without calling siteverify", async (_n, token) => {
    const { sent, fetcher } = fakeFetcher();
    expect((await verifyTurnstile(fetcher, TEST_SECRET.pass, token, null)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("a secret siteverify refuses (HTTP 400) → unavailable naming TURNSTILE_SECRET, not the guest's fault", async () => {
    const { fetcher } = fakeFetcher();
    const v = await verifyTurnstile(fetcher, `bogus-${crypto.randomUUID()}`, DUMMY_TOKEN, null);
    expect(v).toMatchObject({ ok: false, kind: "unavailable" });
    expect(v.ok === false && v.kind === "unavailable" && v.detail).toContain("TURNSTILE_SECRET");
  });

  it.each([
    ["network error", async () => Promise.reject(new TypeError("network down"))],
    ["HTTP 500 non-JSON", async () => new Response("oops", { status: 500 })],
  ])("%s → unavailable", async (_n, fetcher: Fetcher) => {
    expect(await verifyTurnstile(fetcher, TEST_SECRET.pass, DUMMY_TOKEN, null)).toMatchObject({ ok: false, kind: "unavailable" });
  });

  // One check against the real endpoint (Cloudflare's always-pass test secret), so the
  // fake can't drift unnoticed. Skipped under CI or TURNSTILE_OFFLINE=1.
  it.runIf(inject("siteverifyNetwork"))("real siteverify: always-pass test secret → ok", async () => {
    const network: Fetcher = (url, init) =>
      fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), [NETWORK_HEADER]: "1" } });
    expect(await verifyTurnstile(network, TEST_SECRET.pass, DUMMY_TOKEN, null)).toEqual({ ok: true });
  });
});

describe("POST /api/uploads → Turnstile", () => {
  it("valid token (always-pass secret) → 201", async () => {
    const res = await http.init(media());
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it.each([
    ["always-fail", TEST_SECRET.fail],
    ["reused token (siteverify: timeout-or-duplicate)", TEST_SECRET.spent],
  ])("%s → 403, nothing charged, nothing in R2", async (_n, secret) => {
    const d = direct(freshBand(), { TURNSTILE_SECRET: secret });
    const res = await d.init(media());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(VERIFY_FAILED);
    expect(d.r2Calls).toEqual([]);
    expect((await d.counters.usage(torontoDate(Date.now()))).inflight).toBe(0);
  });

  it.each([
    ["no token", JSON.stringify(media({ turnstileToken: undefined }))],
    ["no file details either", "{}"],
    ["not JSON", "{nope"],
  ])("%s → 403 before validation", async (_n, body) => {
    const res = await exports.default.fetch(`${HOST}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
      body,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(VERIFY_FAILED);
  });

  it("siteverify refuses our secret → 503 (an outage, not the guest)", async () => {
    const d = direct(freshBand(), { TURNSTILE_SECRET: `bogus-${crypto.randomUUID()}` });
    const res = await d.init(media());
    expect(res.status).toBe(503);
    expect(d.r2Calls).toEqual([]);
  });
});

describe("TURNSTILE_SECRET unset (inert until configured)", () => {
  const unset = { ...env, TURNSTILE_SECRET: "" } as Env;
  const viaRouter = (path: string, init?: RequestInit) =>
    // The production router with a different env (exports.default always gets the suite's).
    worker.fetch(new Request(`${HOST}${path}`, init) as Parameters<typeof worker.fetch>[0], unset);

  it("POST /api/uploads → 503 naming the secret; GET /api/band → 200", async () => {
    const res = await viaRouter("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
      body: JSON.stringify(media()),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: "Uploads aren't set up yet (Turnstile secret missing)." });
    expect((await viaRouter("/api/band")).status).toBe(200);
  });

  it("refuses before R2 is touched", async () => {
    const d = direct(freshBand(), { TURNSTILE_SECRET: "" });
    expect((await d.init(media())).status).toBe(503);
    expect(d.r2Calls).toEqual([]);
  });
});
