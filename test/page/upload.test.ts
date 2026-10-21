import { describe, expect, it } from "vitest";
import type { Fetch } from "../../src/page/types";
import { BUSY, uploadFile, UploadError, type UploadDeps } from "../../src/page/upload";

const MIB = 1024 * 1024;

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/**
 * In-memory fake of the /api/uploads contract. `failPart` maps part number → how many
 * times it fails (with `failStatus`) before succeeding.
 */
function fakeApi(opts: {
  partSize: number;
  failPart?: Record<number, number>;
  failStatus?: number;
  /** Answer to every init; `inits` answers the first few in turn, then the default. */
  init?: Response;
  inits?: Response[];
}) {
  const id = `u-${crypto.randomUUID()}`;
  const calls: Call[] = [];
  const failures = { ...opts.failPart };
  const inits = [...(opts.inits ?? [])];
  const fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body });
    if (method === "POST" && url.endsWith("/uploads")) {
      const next = inits.shift() ?? opts.init;
      if (next) return next;
      const req = body as { size: number };
      const parts = Math.ceil(req.size / opts.partSize);
      return Response.json({ id, key: "k", partSize: opts.partSize, parts });
    }
    const part = /\/parts\/(\d+)$/.exec(url);
    if (method === "PUT" && part) {
      const n = Number(part[1]);
      if ((failures[n] ?? 0) > 0) {
        failures[n]--;
        if (opts.failStatus === 0) throw new TypeError("network");
        return Response.json({ reason: "boom" }, { status: opts.failStatus ?? 500 });
      }
      return Response.json({ etag: `e${n}` });
    }
    if (method === "POST" && url.endsWith("/complete")) return Response.json({ key: "k" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 404 });
  };
  return { id, calls, fetch };
}

function file(size: number, type = "video/mp4"): File {
  return new File([new Uint8Array(size)], "clip.mp4", { type, lastModified: 1_760_148_000_000 });
}

function deps(fetch: Fetch, sleeps: number[], token?: string): UploadDeps {
  return { fetch, base: "/shivs/api", sleep: async (ms) => void sleeps.push(ms), token: async () => token };
}

describe("uploadFile", () => {
  it("init → sequential parts → complete, reporting acked bytes", async () => {
    const api = fakeApi({ partSize: 2 * MIB });
    const progress: number[] = [];
    const res = await uploadFile(file(5 * MIB), { credit: "@me", showId: "s1" }, deps(api.fetch, []), (b) =>
      progress.push(b),
    );
    expect(res).toEqual({ key: "k" });
    expect(api.calls[0]).toEqual({
      method: "POST",
      url: "/shivs/api/uploads",
      body: { name: "clip.mp4", size: 5 * MIB, type: "video/mp4", lastModified: 1_760_148_000_000, credit: "@me", showId: "s1" },
    });
    expect(api.calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(
      [1, 2, 3].map((n) => `/shivs/api/uploads/${api.id}/parts/${n}`),
    );
    expect(api.calls.at(-1)?.body).toEqual({ parts: [1, 2, 3].map((n) => ({ n, etag: `e${n}` })) });
    expect(progress).toEqual([0, 2 * MIB, 4 * MIB, 5 * MIB]);
  });

  it("omits credit, showId and token when absent; sends the token when given", async () => {
    const a = fakeApi({ partSize: MIB });
    await uploadFile(file(10), {}, deps(a.fetch, []), () => {});
    expect(Object.keys(a.calls[0].body as object).sort()).toEqual(["lastModified", "name", "size", "type"]);
    const b = fakeApi({ partSize: MIB });
    await uploadFile(file(10), {}, deps(b.fetch, [], "tok"), () => {});
    expect((b.calls[0].body as { turnstileToken: string }).turnstileToken).toBe("tok");
  });

  it.each([500, 0])("retries a part that fails once (status %i) and completes", async (failStatus) => {
    const api = fakeApi({ partSize: MIB, failPart: { 2: 1 }, failStatus });
    const sleeps: number[] = [];
    await expect(uploadFile(file(3 * MIB), {}, deps(api.fetch, sleeps), () => {})).resolves.toEqual({ key: "k" });
    expect(api.calls.filter((c) => c.url.endsWith("/parts/2"))).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("gives up after 3 retries, then DELETEs the upload", async () => {
    const api = fakeApi({ partSize: MIB, failPart: { 1: 99 } });
    const sleeps: number[] = [];
    await expect(uploadFile(file(MIB), {}, deps(api.fetch, sleeps), () => {})).rejects.toThrow("boom");
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(api.calls.at(-1)).toMatchObject({ method: "DELETE", url: `/shivs/api/uploads/${api.id}` });
  });

  it("does not retry a 4xx part; aborts at once", async () => {
    const api = fakeApi({ partSize: MIB, failPart: { 1: 1 }, failStatus: 400 });
    await expect(uploadFile(file(MIB), {}, deps(api.fetch, []), () => {})).rejects.toBeInstanceOf(UploadError);
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "PUT", "DELETE"]);
  });

  it("one fresh token per init: a 403 shows the reason, the retry sends a new token", async () => {
    const reason = "Verification failed — reload the page and try again.";
    const refused = fakeApi({ partSize: MIB, init: Response.json({ reason }, { status: 403 }) });
    const ok = fakeApi({ partSize: MIB });
    let n = 0;
    const tokens: UploadDeps["token"] = async () => `tok-${++n}`;
    const withTokens = (fetch: Fetch): UploadDeps => ({ ...deps(fetch, []), token: tokens });

    const err = await uploadFile(file(10), {}, withTokens(refused.fetch), () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, message: reason });
    expect(refused.calls).toHaveLength(1);
    await uploadFile(file(10), {}, withTokens(ok.fetch), () => {});
    const sent = [refused.calls[0], ok.calls[0]].map((c) => (c.body as { turnstileToken: string }).turnstileToken);
    expect(sent).toEqual(["tok-1", "tok-2"]);
    expect(n).toBe(2);
  });

  it("init rejection (a cap 429: no retryAfter) surfaces the server's reason verbatim, no retry, nothing to DELETE", async () => {
    const reason = `Slow down — ${crypto.randomUUID()}`;
    const api = fakeApi({ partSize: MIB, init: Response.json({ reason }, { status: 429 }) });
    const err = await uploadFile(file(10), {}, deps(api.fetch, []), () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).message).toBe(reason);
    expect((err as UploadError).status).toBe(429);
    expect(api.calls).toHaveLength(1);
  });

  const busy = () =>
    Response.json({ reason: "Too many uploads at once; wait a minute and try again.", retryAfter: 60 }, { status: 429 });

  it("rate-limited init (429 + retryAfter) shows the wait, sleeps retryAfter, retries once with a fresh token", async () => {
    const api = fakeApi({ partSize: MIB, inits: [busy()] });
    const sleeps: number[] = [];
    const waits: string[] = [];
    let n = 0;
    const d: UploadDeps = { ...deps(api.fetch, sleeps), token: async () => `tok-${++n}` };
    await expect(uploadFile(file(10), {}, d, () => {}, (m) => waits.push(m))).resolves.toEqual({ key: "k" });
    expect(waits).toEqual([BUSY]);
    expect(BUSY).toBe("Busy — retrying in a minute…");
    expect(sleeps).toEqual([60_000]);
    const posts = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/uploads"));
    expect(posts.map((c) => (c.body as { turnstileToken: string }).turnstileToken)).toEqual(["tok-1", "tok-2"]);
  });

  it("a second rate-limited init gives up with the server's reason", async () => {
    const api = fakeApi({ partSize: MIB, inits: [busy(), busy()] });
    const sleeps: number[] = [];
    const err = await uploadFile(file(10), {}, deps(api.fetch, sleeps), () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, message: "Too many uploads at once; wait a minute and try again." });
    expect(api.calls).toHaveLength(2);
    expect(sleeps).toEqual([60_000]);
  });

  it.each([403, 413, 415, 503])("init %i is not retried", async (status) => {
    const api = fakeApi({ partSize: MIB, init: Response.json({ reason: "no", retryAfter: 60 }, { status }) });
    const sleeps: number[] = [];
    await expect(uploadFile(file(10), {}, deps(api.fetch, sleeps), () => {})).rejects.toMatchObject({ status });
    expect(api.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
