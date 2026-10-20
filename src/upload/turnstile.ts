// Cloudflare Turnstile siteverify for upload init. Tokens are single-use and live 300 s,
// so every init spends one (the page fetches a fresh token per init). `fetcher` is
// injected so tests verify against a fake, never the network.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's documented maximum token length; longer is refused without a call. */
const TOKEN_MAX = 2048;
const TIMEOUT_MS = 5000;
/** Our misconfiguration, not a bot: reported as unavailable so it reads as an outage. */
const SECRET_CODES = new Set(["missing-input-secret", "invalid-input-secret"]);

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type Verdict =
  | { ok: true }
  /** Turnstile said no (or there was no token to ask about): the caller is not let in. */
  | { ok: false; kind: "rejected"; codes: string[] }
  /** siteverify failed (network, 5xx, non-JSON) or refused our secret: not the guest's fault. */
  | { ok: false; kind: "unavailable"; detail: string };

export async function verifyTurnstile(
  fetcher: Fetcher,
  secret: string,
  token: unknown,
  remoteip: string | null,
): Promise<Verdict> {
  if (typeof token !== "string" || token === "") return { ok: false, kind: "rejected", codes: ["missing-input-response"] };
  if (token.length > TOKEN_MAX) return { ok: false, kind: "rejected", codes: ["invalid-input-response"] };

  let res: Response;
  try {
    res = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(remoteip ? { remoteip } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: String(err) };
  }

  // A bad secret comes back HTTP 400 with error-codes, so read the body whatever the status.
  let body: { success?: unknown; "error-codes"?: unknown };
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "unavailable", detail: `siteverify HTTP ${res.status}, non-JSON body` };
  }
  const codes = Array.isArray(body["error-codes"]) ? body["error-codes"].filter((c) => typeof c === "string") : [];
  if (codes.some((c) => SECRET_CODES.has(c))) {
    return { ok: false, kind: "unavailable", detail: `siteverify refused TURNSTILE_SECRET: ${codes.join(", ")}` };
  }
  if (!res.ok) return { ok: false, kind: "unavailable", detail: `siteverify HTTP ${res.status}: ${codes.join(", ")}` };
  if (body.success === true) return { ok: true };
  return { ok: false, kind: "rejected", codes };
}
