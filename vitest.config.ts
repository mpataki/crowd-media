import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { Response as MfResponse, type Request as MfRequest } from "miniflare";
import { defineConfig } from "vitest/config";
import { NETWORK_HEADER, siteverifyFake, TEST_SECRET } from "./test/fakes/siteverify";
import { SITEVERIFY_URL } from "./src/upload/turnstile";

// Required secrets (wrangler.jsonc `secrets.required`) come from process.env (or
// .dev.vars); tests always use these, whatever the shell or .dev.vars holds.
process.env.UPLOAD_SIGNING_KEY = "test-signing-key-not-a-secret";
// Cloudflare's always-pass test secret; never the real one.
process.env.TURNSTILE_SECRET = TEST_SECRET.pass;

/**
 * Every fetch the Worker (and test code) makes lands here: siteverify is answered by the
 * fake, a request carrying NETWORK_HEADER goes to the real endpoint, anything else fails
 * loudly so no test silently depends on the network.
 */
async function outbound(request: MfRequest): Promise<MfResponse> {
  if (request.url !== SITEVERIFY_URL) {
    return new MfResponse(`unexpected outbound fetch in tests: ${request.url}`, { status: 599 });
  }
  if (request.headers.get(NETWORK_HEADER)) {
    const real = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      body: await request.text(),
    });
    return new MfResponse(await real.text(), { status: real.status, headers: { "content-type": "application/json" } });
  }
  const reply = siteverifyFake(await request.json().catch(() => null));
  return MfResponse.json(reply.json, { status: reply.status });
}

// The real-network test runs unless CI or TURNSTILE_OFFLINE=1 says there's no network.
const siteverifyNetwork = !process.env.CI && process.env.TURNSTILE_OFFLINE !== "1";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { outboundService: outbound },
    }),
  ],
  test: { provide: { siteverifyNetwork } },
});
