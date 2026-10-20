// In-memory Turnstile siteverify, keyed by Cloudflare's published test secrets
// (developers.cloudflare.com/turnstile/troubleshooting/testing). Behaviour mirrors the
// real endpoint as probed 2026-10-19: test secrets ignore the token's value (the
// always-pass secret accepts any non-empty token), an unknown secret is HTTP 400.
// Pure: vitest.config.ts serves it as the Worker's outbound fetch (Node side); unit tests
// wrap it as an injected fetcher.

export const TEST_SECRET = {
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
  spent: "3x0000000000000000000000000000000AA",
} as const;
/** Sent only by the one real-network test: vitest.config.ts forwards it to Cloudflare. */
export const NETWORK_HEADER = "x-test-network";
/** What a test sitekey's widget hands the page. */
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export type FakeReply = { status: number; json: { success: boolean; "error-codes": string[] } };

const no = (status: number, code: string): FakeReply => ({ status, json: { success: false, "error-codes": [code] } });

export function siteverifyFake(body: unknown): FakeReply {
  const b = (typeof body === "object" && body !== null ? body : {}) as { secret?: unknown; response?: unknown };
  if (typeof b.secret !== "string" || b.secret === "") return no(400, "missing-input-secret");
  if (!Object.values<string>(TEST_SECRET).includes(b.secret)) return no(400, "invalid-input-secret");
  if (typeof b.response !== "string" || b.response === "") return no(200, "missing-input-response");
  if (b.secret === TEST_SECRET.fail) return no(200, "invalid-input-response");
  if (b.secret === TEST_SECRET.spent) return no(200, "timeout-or-duplicate");
  return { status: 200, json: { success: true, "error-codes": [] } };
}
