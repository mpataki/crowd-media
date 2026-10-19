import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// UPLOAD_SIGNING_KEY is a required secret (wrangler.jsonc `secrets.required`). The plugin
// reads required secrets from process.env (or .dev.vars); tests always use this fixed key,
// whatever the shell or .dev.vars holds.
process.env.UPLOAD_SIGNING_KEY = "test-signing-key-not-a-secret";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
