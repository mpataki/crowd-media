// Chunked uploads into R2 multipart. Paths arrive band-stripped from the router:
//   POST   /api/uploads                 init → { id, key, partSize, parts }
//   PUT    /api/uploads/:id/parts/:n    raw part body → { etag }
//   POST   /api/uploads/:id/complete    { parts: [{ n, etag }] } → { key }
//   DELETE /api/uploads/:id             abort + release the cap reservation
// `id` is a signed token (src/upload/token.ts): no per-upload state outside R2's own
// multipart. Errors are `{ reason }`, one sentence the page shows verbatim.
import type { Band } from "../config";
import { objectPrefix, pickShow, torontoDate } from "../config/shows";
import type { ShowPick } from "../config/shows";
import { creditSlug, objectKey } from "../upload/keys";
import { signToken, verifyToken } from "../upload/token";
import type { UploadToken } from "../upload/token";
import { GiB, MiB, checkInit } from "../upload/validate";

/** R2 needs every non-last part the same size and ≥ 5 MiB; Workers bodies cap at 100 MB. */
export const PART_SIZE = 32 * MiB;
const MAX_PARTS = 10_000;
const CREDIT_META_MAX = 100;

const fail = (status: number, reason: string, extra?: Record<string, unknown>) =>
  Response.json({ reason, ...extra }, { status });

export async function uploads(request: Request, env: Env, band: Band, path: string): Promise<Response> {
  const m = /^\/api\/uploads(?:\/([^/]+)(\/complete|\/parts\/([^/]+))?)?$/.exec(path);
  if (!m) return Response.json({ error: "not_found" }, { status: 404 });
  const [, rawId, tail, n] = m;
  const method = request.method;

  if (!env.UPLOAD_SIGNING_KEY) {
    console.error("UPLOAD_SIGNING_KEY is not set: `wrangler secret put UPLOAD_SIGNING_KEY` (locally: .dev.vars)");
    return fail(500, "Uploads aren't set up yet.");
  }
  if (!rawId) return method === "POST" ? init(request, env, band) : notAllowed();

  const token = await verifyToken(decodeURIComponent(rawId), env.UPLOAD_SIGNING_KEY);
  // A token from another band is as invalid here as a forged one.
  if (!token || token.band !== band.slug) return fail(401, "This upload link isn't valid; start the upload again.");

  if (tail === "/complete") return method === "POST" ? complete(request, env, token) : notAllowed();
  if (tail) return method === "PUT" ? putPart(request, env, token, n) : notAllowed();
  return method === "DELETE" ? abort(env, token) : notAllowed();
}

const notAllowed = () => fail(405, "That method isn't supported here.");

const counters = (env: Env, band: string) => env.COUNTERS.get(env.COUNTERS.idFromName(band));

async function init(request: Request, env: Env, band: Band): Promise<Response> {
  if (band.paused) return fail(503, `${band.name} isn't taking uploads right now.`);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.UPLOAD_RL.limit({ key: ip })).success) {
    return fail(429, "Too many uploads at once; wait a minute and try again.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Upload details are missing.");
  }
  const checked = checkInit(body, band);
  if (!checked.ok) return fail(checked.status, checked.reason);
  const req = checked.value;

  const now = Date.now();
  const pick: ShowPick = req.show
    ? { show: req.show, reason: "capture", date: torontoDate(req.lastModified ?? now) }
    : pickShow(band, req.lastModified, now);
  const credit = creditSlug(req.credit);
  const key = objectKey(objectPrefix(band, pick), req.lastModified, credit, req.ext);
  const parts = Math.ceil(req.size / PART_SIZE);
  if (parts > MAX_PARTS) return fail(413, "That file is too big to upload.");

  // Reserve before creating anything in R2: a capped band leaves no multipart behind.
  const reservation = crypto.randomUUID();
  const held = await counters(env, band.slug).reserve(reservation, req.size, torontoDate(now), {
    dayBytes: band.caps.dayGb * GiB,
    rollingBytes: band.caps.monthGb * GiB,
  });
  if (!held.ok) {
    return held.cap === "day"
      ? fail(429, "Daily cap reached for today's uploads; try again tomorrow.")
      : fail(429, "Monthly cap reached for uploads; try again in a few days.");
  }

  let uploadId: string;
  try {
    const mpu = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: req.contentType },
      customMetadata: {
        // The guest's own spelling (the key carries the slug): `@Fool.Hearts` stays taggable.
        credit: req.credit?.trim().slice(0, CREDIT_META_MAX) || credit,
        originalName: req.name,
        lastModified: req.lastModified === null ? "" : String(req.lastModified),
      },
    });
    uploadId = mpu.uploadId;
  } catch (err) {
    await counters(env, band.slug).release(reservation);
    console.error("createMultipartUpload failed", key, err);
    return fail(502, "Storage is unavailable; try again shortly.");
  }

  const t: UploadToken = { band: band.slug, key, uploadId, reservation, partSize: PART_SIZE, parts, size: req.size };
  return Response.json({ id: await signToken(t, env.UPLOAD_SIGNING_KEY), key, partSize: PART_SIZE, parts }, { status: 201 });
}

/** Exact byte length part `n` must have: partSize, except the last carries the rest. */
export const expectedPartLength = (t: UploadToken, n: number) =>
  n < t.parts ? t.partSize : t.size - (t.parts - 1) * t.partSize;

async function putPart(request: Request, env: Env, t: UploadToken, rawN: string): Promise<Response> {
  const n = /^\d+$/.test(rawN) ? Number(rawN) : NaN;
  if (!(n >= 1 && n <= t.parts)) return fail(400, `Part ${rawN} doesn't exist; this upload has ${t.parts} parts.`);
  // Checked before R2 is touched: R2 rejects uneven non-last parts only at complete.
  const want = expectedPartLength(t, n);
  const got = request.headers.get("content-length");
  if (got === null || Number(got) !== want || !request.body) {
    return fail(400, `Part ${n} must be exactly ${want} bytes.`);
  }

  try {
    const part = await env.MEDIA.resumeMultipartUpload(t.key, t.uploadId).uploadPart(n, request.body);
    return Response.json({ etag: part.etag });
  } catch (err) {
    if (isNoSuchUpload(err)) return fail(410, "This upload was cancelled or expired; start it again.");
    console.error("uploadPart failed", t.key, n, err);
    return fail(502, `Part ${n} didn't make it; retrying should fix it.`);
  }
}

async function complete(request: Request, env: Env, t: UploadToken): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const list = (body as { parts?: unknown } | null)?.parts;
  const parts = Array.isArray(list) ? list.filter(isPartRef) : [];
  const seen = new Set(parts.map((p) => p.n));
  const everyPartOnce =
    Array.isArray(list) &&
    parts.length === list.length &&
    parts.length === t.parts &&
    seen.size === t.parts &&
    parts.every((p) => p.n >= 1 && p.n <= t.parts);
  if (!everyPartOnce) return fail(400, `Finishing needs each of the ${t.parts} parts exactly once.`);

  let obj: R2Object;
  try {
    obj = await env.MEDIA.resumeMultipartUpload(t.key, t.uploadId).complete(
      parts.map((p) => ({ partNumber: p.n, etag: p.etag })),
    );
  } catch (err) {
    // A retried complete whose first response was lost: the object is already there
    // (and was counted then), so report success instead of a confusing failure.
    const existing = await env.MEDIA.head(t.key);
    if (existing && existing.size === t.size) return Response.json({ key: t.key });
    console.error("complete failed", t.key, err);
    return fail(409, "The upload couldn't be finished; start it again.", { detail: String(err) });
  }
  try {
    await counters(env, t.band).commit(t.reservation, obj.size, torontoDate(Date.now()));
  } catch (err) {
    // The object is safe; only the cap undercounts (the alarm drops the hold in 24 h).
    console.error("commit failed; bytes uncounted", t.band, t.key, obj.size, err);
  }
  return Response.json({ key: t.key });
}

async function abort(env: Env, t: UploadToken): Promise<Response> {
  try {
    await env.MEDIA.resumeMultipartUpload(t.key, t.uploadId).abort();
  } catch (err) {
    // Already aborted, expired or completed: nothing left to cancel.
    if (!isNoSuchUpload(err)) console.error("abort failed", t.key, err);
  }
  await counters(env, t.band).release(t.reservation);
  return Response.json({ aborted: true });
}

function isPartRef(p: unknown): p is { n: number; etag: string } {
  const r = p as { n?: unknown; etag?: unknown } | null;
  return typeof r === "object" && r !== null && Number.isInteger(r.n) && typeof r.etag === "string" && r.etag !== "";
}

/** R2 error 10024 NoSuchUpload: aborted, completed or expired (7 d). */
function isNoSuchUpload(err: unknown): boolean {
  return /10024|NoSuchUpload|upload does not exist/i.test(String(err));
}
