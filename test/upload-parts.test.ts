import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { torontoDate } from "../src/config/shows";
import { signToken, TOKEN_TTL_MS, verifyToken } from "../src/upload/token";
import { MiB } from "../src/upload/validate";
import { direct, freshBand, http, media } from "./upload-helpers";
import type { Init } from "./upload-helpers";

const SIZE_70 = 70 * MiB;

/** Deterministic, part-distinct bytes so a mixed-up part would change the object. */
function bytes(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 4096) b[i] = (i / 4096 + seed) & 0xff;
  return b;
}

/** A body that sends `sent` of `len` bytes then fails, like a phone dropping off LTE. */
function droppingBody(len: number, sent: number): ReadableStream<Uint8Array> {
  const { readable, writable } = new FixedLengthStream(len);
  const w = writable.getWriter();
  void w.write(new Uint8Array(sent)).then(() => w.abort(new Error("connection lost")), () => undefined);
  return readable;
}

describe("multipart, real 32 MiB parts", () => {
  it("70 MiB video/mp4 on show night → 3 × 32 MiB parts (part 2 dropped once, retried) → one 70 MiB object", async () => {
    const band = freshBand();
    const d = direct(band);
    const res = await d.init(media({ size: SIZE_70, credit: "Jen C" }));
    expect(res.status).toBe(201);
    const init = await res.json<Init>();
    expect(init).toMatchObject({ partSize: 32 * MiB, parts: 3 });
    expect(init.key).toMatch(new RegExp(`^${band.slug}/2026-10-10-the-dakota/20261010T2215\\d{2}__jen-c__[0-9a-f]{8}\\.mp4$`));

    const lens = [32 * MiB, 32 * MiB, 6 * MiB];
    const etags: { n: number; etag: string }[] = [];
    for (const [i, len] of lens.entries()) {
      const n = i + 1;
      if (n === 2) {
        const dropped = await d.part(init.id, n, droppingBody(len, MiB), { "content-length": String(len) });
        expect(dropped.status).toBe(502);
      }
      const put = await d.part(init.id, n, bytes(len, n));
      expect(put.status, await put.clone().text()).toBe(200);
      etags.push({ n, etag: (await put.json<{ etag: string }>()).etag });
    }

    const done = await d.complete(init.id, etags);
    expect(done.status, await done.clone().text()).toBe(200);
    const obj = await env.MEDIA.get(init.key);
    expect(obj?.size).toBe(SIZE_70);
    expect(obj?.customMetadata?.credit).toBe("Jen C");
    const body = new Uint8Array(await obj!.arrayBuffer());
    expect([body[0], body[32 * MiB], body[64 * MiB]]).toEqual([1, 2, 3]);

    // Committed: the bytes now count, none left in flight (the dropped attempt charged nothing).
    expect(await d.counters.usage(torontoDate(Date.now()))).toEqual({ day: SIZE_70, rolling: SIZE_70, inflight: 0 });
  }, 30_000);
});

describe("parts (one-part uploads through the router)", () => {
  async function init(size = 10): Promise<Init> {
    return (await http.init(media({ size }))).json<Init>();
  }

  it("re-uploading a part is idempotent: complete uses the last etag", async () => {
    const i = await init(4);
    await http.part(i.id, 1, new Uint8Array([9, 9, 9, 9]));
    const second = await (await http.part(i.id, 1, new Uint8Array([1, 2, 3, 4]))).json<{ etag: string }>();
    expect((await http.complete(i.id, [{ n: 1, etag: second.etag }])).status).toBe(200);
    expect(new Uint8Array(await (await env.MEDIA.get(i.key))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("a retried complete (first response lost) still answers { key }", async () => {
    const i = await init();
    const { etag } = await (await http.part(i.id, 1, new Uint8Array(10))).json<{ etag: string }>();
    expect((await http.complete(i.id, [{ n: 1, etag }])).status).toBe(200);
    const again = await http.complete(i.id, [{ n: 1, etag }]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ key: i.key });
  });

  it("a part charges its bytes; DELETE aborts the multipart and refunds them", async () => {
    const d = direct(freshBand());
    const i = await (await d.init(media({ size: 10 }))).json<Init>();
    const day = torontoDate(Date.now());
    expect((await d.counters.usage(day)).inflight).toBe(0);
    expect((await d.part(i.id, 1, new Uint8Array(10))).status).toBe(200);
    expect((await d.counters.usage(day)).inflight).toBe(10);

    const del = await d.abort(i.id);
    expect(del.status).toBe(200);
    expect((await d.counters.usage(day)).inflight).toBe(0);
    // Aborted in R2: the upload no longer takes parts.
    const put = await d.part(i.id, 1, new Uint8Array(10));
    expect(put.status).toBe(410);
    expect(await env.MEDIA.head(i.key)).toBeNull();
  });

  it("tampered id → 401, before R2", async () => {
    const d = direct(freshBand());
    const i = await (await d.init(media())).json<Init>();
    d.r2Calls.length = 0;
    const [body, sig] = i.id.split(".");
    const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    forged.size = 999;
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const id of [`${forgedBody}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, "garbage", `${body}`]) {
      const res = await d.part(id, 1, new Uint8Array(10));
      expect(res.status).toBe(401);
      expect((await res.json<{ reason: string }>()).reason).toMatch(/isn't valid/);
    }
    expect(d.r2Calls).toEqual([]);
  });

  it("a token past exp → 410 for part and complete, before R2; a fresh one carries exp = init + 24 h", async () => {
    const d = direct(freshBand());
    const before = Date.now();
    const i = await (await d.init(media())).json<Init>();
    const t = (await verifyToken(i.id, env.UPLOAD_SIGNING_KEY))!;
    expect(t.exp - before).toBeGreaterThanOrEqual(TOKEN_TTL_MS);
    expect(t.exp - Date.now()).toBeLessThanOrEqual(TOKEN_TTL_MS);
    const expired = await signToken({ ...t, exp: Date.now() - 1 }, env.UPLOAD_SIGNING_KEY);
    d.r2Calls.length = 0;
    for (const res of [await d.part(expired, 1, new Uint8Array(10)), await d.complete(expired, [{ n: 1, etag: "e" }])]) {
      expect(res.status).toBe(410);
      expect((await res.json<{ reason: string }>()).reason).toMatch(/expired/);
    }
    expect(d.r2Calls).toEqual([]);
    expect((await d.abort(expired)).status).toBe(200);
  });

  it("malformed %-encoding in the id → 401, not 500", async () => {
    for (const id of ["%E0%A4%A", "%", "abc%zz.def"]) {
      const res = await http.part(id, 1, new Uint8Array(10));
      expect(res.status).toBe(401);
    }
  });

  it("a token from another band → 401", async () => {
    const i = await init();
    const res = await direct(freshBand()).part(i.id, 1, new Uint8Array(10));
    expect(res.status).toBe(401);
  });

  it.each([
    ["short", 9],
    ["long", 11],
  ])("part of the wrong size (%s) → 400 before any R2 call", async (_n, len) => {
    const d = direct(freshBand());
    const i = await (await d.init(media({ size: 10 }))).json<Init>();
    d.r2Calls.length = 0;
    const res = await d.part(i.id, 1, new Uint8Array(len));
    expect(res.status).toBe(400);
    expect((await res.json<{ reason: string }>()).reason).toBe("Part 1 must be exactly 10 bytes.");
    expect(d.r2Calls).toEqual([]);
  });

  it("non-last part must be exactly partSize", async () => {
    const d = direct(freshBand());
    const i = await (await d.init(media({ size: 40 * MiB }))).json<Init>();
    d.r2Calls.length = 0;
    const res = await d.part(i.id, 1, new Uint8Array(8 * MiB));
    expect(res.status).toBe(400);
    expect((await res.json<{ reason: string }>()).reason).toBe(`Part 1 must be exactly ${32 * MiB} bytes.`);
    expect(d.r2Calls).toEqual([]);
    await d.abort(i.id);
  });

  it.each(["0", "2", "x"])("part number %s out of range → 400", async (n) => {
    const i = await init();
    expect((await http.part(i.id, n, new Uint8Array(10))).status).toBe(400);
  });

  it("complete without every part exactly once → 400", async () => {
    const i = await init();
    const { etag } = await (await http.part(i.id, 1, new Uint8Array(10))).json<{ etag: string }>();
    for (const parts of [[], [{ n: 1, etag }, { n: 1, etag }], [{ n: 2, etag }], "x"]) {
      expect((await http.complete(i.id, parts)).status).toBe(400);
    }
  });

  it("complete with a wrong etag → 409 with only the guest-facing reason (R2's error is logged)", async () => {
    const i = await init();
    await http.part(i.id, 1, new Uint8Array(10));
    const res = await http.complete(i.id, [{ n: 1, etag: "nope" }]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "The upload couldn't be finished; start it again." });
  });
});
