// Shared fixtures for the upload suites. Stateless: every helper builds fresh objects.
import { env, exports } from "cloudflare:workers";
import { uploads } from "../src/api/uploads";
import { config } from "../src/config";
import type { Band } from "../src/config";

export const foolhearts = config.bands.find((b) => b.slug === "foolhearts")!;
export const HOST = "https://share.foolhearts.com";
/** 22:15 Toronto on the 2026-10-10 show night. */
export const SHOW_NIGHT = Date.parse("2026-10-10T22:15:00-04:00");

/** Fool Hearts under a random slug: its own counters DO, its own key prefix. */
export function freshBand(over: Partial<Band> = {}): Band {
  return { ...foolhearts, slug: `t-${crypto.randomUUID().slice(0, 8)}`, ...over };
}

export type InitBody = Record<string, unknown>;
export const media = (over: InitBody = {}): InitBody => ({
  name: "clip.mp4",
  size: 10,
  type: "video/mp4",
  lastModified: SHOW_NIGHT,
  ...over,
});

const json = (body: unknown, ip = crypto.randomUUID()) => ({
  headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
  body: JSON.stringify(body),
});

/** Through the real router: `exports.default.fetch` on the branded host. */
export const http = {
  init: (body: unknown, ip?: string) => exports.default.fetch(`${HOST}/api/uploads`, { method: "POST", ...json(body, ip) }),
  part: (id: string, n: number | string, body: BodyInit, headers: HeadersInit = {}) =>
    exports.default.fetch(`${HOST}/api/uploads/${id}/parts/${n}`, { method: "PUT", body, headers }),
  complete: (id: string, parts: unknown) =>
    exports.default.fetch(`${HOST}/api/uploads/${id}/complete`, { method: "POST", ...json({ parts }) }),
  abort: (id: string) => exports.default.fetch(`${HOST}/api/uploads/${id}`, { method: "DELETE" }),
};

/**
 * The uploads handler called directly with a test band (paused, custom slug) and an env
 * whose MEDIA records which R2 methods ran — the handler is the production code path the
 * router dispatches to.
 */
export function direct(band: Band) {
  const r2Calls: string[] = [];
  // Records the R2 methods the handler uses, delegating to the real Miniflare bucket.
  const MEDIA = {
    createMultipartUpload: (...a: Parameters<R2Bucket["createMultipartUpload"]>) => {
      r2Calls.push("createMultipartUpload");
      return env.MEDIA.createMultipartUpload(...a);
    },
    resumeMultipartUpload: (...a: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
      r2Calls.push("resumeMultipartUpload");
      return env.MEDIA.resumeMultipartUpload(...a);
    },
    head: (...a: Parameters<R2Bucket["head"]>) => {
      r2Calls.push("head");
      return env.MEDIA.head(...a);
    },
  } as Pick<R2Bucket, "createMultipartUpload" | "resumeMultipartUpload" | "head"> as R2Bucket;
  const testEnv = { ...env, MEDIA } as Env;
  const call = (method: string, path: string, init: RequestInit = {}) =>
    uploads(new Request(`${HOST}${path}`, { method, ...init }), testEnv, band, path);
  return {
    r2Calls,
    counters: env.COUNTERS.get(env.COUNTERS.idFromName(band.slug)),
    init: (body: unknown) => call("POST", "/api/uploads", json(body)),
    // A constructed Request has no Content-Length (the network sets it); add it like a browser would.
    part: (id: string, n: number, body: Uint8Array | ReadableStream, headers: Record<string, string> = {}) =>
      call("PUT", `/api/uploads/${id}/parts/${n}`, {
        body,
        headers: body instanceof Uint8Array ? { "content-length": String(body.byteLength), ...headers } : headers,
      }),
    complete: (id: string, parts: unknown) => call("POST", `/api/uploads/${id}/complete`, json({ parts })),
    abort: (id: string) => call("DELETE", `/api/uploads/${id}`),
  };
}

export type Init = { id: string; key: string; partSize: number; parts: number };
