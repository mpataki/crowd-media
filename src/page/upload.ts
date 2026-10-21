import { planParts } from "./plan";
import { retryDelay } from "./retry";
import type { Fetch, InitResponse, UploadSource } from "./types";

/** An API failure; `message` is what the guest sees (the server's reason verbatim). */
export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds the server asked us to wait before one retry (rate limit only). */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export interface UploadDeps {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  /** From apiBase(): "/api" or "/<band>/api". */
  base: string;
  /** One fresh Turnstile token per init, or undefined when Turnstile is off. */
  token: () => Promise<string | undefined>;
}

export interface UploadMeta {
  credit?: string;
  /** Only when the guest overrode the show; absent lets the server attribute by capture time. */
  showId?: string;
}

const NETWORK = "Connection lost — check your signal.";
export const BUSY = "Busy — retrying in a minute…";

/**
 * init → sequential parts (each retried with backoff) → complete. `onProgress` gets the
 * bytes the server has acknowledged. A rate-limited init (429 with `retryAfter`) waits
 * and retries once, telling `onWait`; no other init failure is retried. Any failure
 * after init aborts the multipart with DELETE (best effort) and rethrows an UploadError.
 */
export async function uploadFile(
  file: UploadSource,
  meta: UploadMeta,
  deps: UploadDeps,
  onProgress: (acked: number) => void,
  onWait: (message: string) => void = () => {},
): Promise<{ key: string }> {
  let init: InitResponse;
  try {
    init = await startUpload(file, meta, deps);
  } catch (err) {
    if (!(err instanceof UploadError && err.status === 429 && err.retryAfter !== undefined)) throw err;
    onWait(BUSY);
    await deps.sleep(err.retryAfter * 1000);
    init = await startUpload(file, meta, deps);
  }

  const upload = `${deps.base}/uploads/${encodeURIComponent(init.id)}`;
  try {
    const plan = planParts(file.size, init.partSize);
    if (plan.length !== init.parts) {
      throw new UploadError(0, `Server planned ${init.parts} parts, page planned ${plan.length}.`);
    }
    const done: { n: number; etag: string }[] = [];
    let acked = 0;
    onProgress(0);
    for (const part of plan) {
      const { etag } = await withRetry(deps, () =>
        call<{ etag: string }>(deps, `${upload}/parts/${part.n}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(part.start, part.end),
        }),
      );
      done.push({ n: part.n, etag });
      acked += part.end - part.start;
      onProgress(acked);
    }
    return await withRetry(deps, () =>
      call<{ key: string }>(deps, `${upload}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: done }),
      }),
    );
  } catch (err) {
    await deps.fetch(upload, { method: "DELETE" }).catch(() => undefined);
    throw err;
  }
}

/** POST init with a fresh Turnstile token (tokens are single-use). */
async function startUpload(file: UploadSource, meta: UploadMeta, deps: UploadDeps): Promise<InitResponse> {
  const turnstileToken = await deps.token();
  return call<InitResponse>(deps, `${deps.base}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      ...(meta.credit ? { credit: meta.credit } : {}),
      ...(meta.showId ? { showId: meta.showId } : {}),
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
}

async function withRetry<T>(deps: UploadDeps, attempt: () => Promise<T>): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await attempt();
    } catch (err) {
      const status = err instanceof UploadError ? err.status : 0;
      const delay = retryDelay(failures, status);
      if (delay === null) throw err;
      await deps.sleep(delay);
    }
  }
}

async function call<T>(deps: UploadDeps, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetch(url, init);
  } catch {
    throw new UploadError(0, NETWORK);
  }
  if (!res.ok) {
    const { reason, retryAfter } = await errorOf(res);
    throw new UploadError(res.status, reason, retryAfter);
  }
  return (await res.json()) as T;
}

/** The server's `{ reason }` verbatim; a generic line only when it sent none. */
export async function reasonOf(res: Response): Promise<string> {
  return (await errorOf(res)).reason;
}

async function errorOf(res: Response): Promise<{ reason: string; retryAfter?: number }> {
  let reason = `Upload failed (HTTP ${res.status}).`;
  let retryAfter: number | undefined;
  try {
    const body = (await res.json()) as { reason?: unknown; retryAfter?: unknown };
    if (typeof body.reason === "string" && body.reason !== "") reason = body.reason;
    if (typeof body.retryAfter === "number" && body.retryAfter >= 0) retryAfter = body.retryAfter;
  } catch {
    // not JSON; keep the generic line
  }
  return { reason, retryAfter };
}
