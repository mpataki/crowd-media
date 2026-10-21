# crowd-media

Guests at a gig scan a QR code and upload the photos and videos from their phones; the
files land in a Cloudflare R2 bucket and are later pulled down to the home NAS. It is a
single Cloudflare Worker (TypeScript) serving a static upload page plus a small `/api`.

## Run locally

Requires Node 22. No Cloudflare login needed:

```bash
npm ci
cp .dev.vars.example .dev.vars   # signing key + Turnstile test secret for local dev (gitignored)
task dev   # http://localhost:8787 — GET /api/health → {"ok":true}
```

## Test

```bash
task check   # tsc --noEmit
task test    # vitest, running inside the Workers runtime
```

## Adding a show / a band

1. Edit `bands.yaml` (a show: `id`, `venue`, `starts` with offset like `2026-10-10T21:00-04:00`).
2. `task check` — validates, regenerates `src/config/generated.json`; commit both.
3. `task deploy`.

## Turnstile locally

`POST /api/uploads` needs a Turnstile token whenever `TURNSTILE_SECRET` is set, and
answers 503 "Uploads aren't set up yet (Turnstile secret missing)." when it isn't
(`/api/band` and the page keep working). `.dev.vars.example` carries Cloudflare's
always-pass **test** secret; to upload through `task dev`, give the page the matching
test sitekey for the session only:

1. In `bands.yaml` set `turnstile.sitekey: "1x00000000000000000000AA"` (always passes;
   `2x00000000000000000000AB` always fails, `3x00000000000000000000FF` forces the
   interactive challenge).
2. `task dev`, upload from http://localhost:8787/foolhearts/.
3. Put `sitekey` back as it was and rerun `task config` before committing — never
   commit a test sitekey.

Without a `turnstile` block (`/api/band` answers `turnstile: null`) the page loads no
widget and sends no token, so while `TURNSTILE_SECRET` is set every init gets 403
"Verification failed — reload the page and try again." An empty `sitekey` fails
`task config`. Tests never call Cloudflare except one check
of the always-pass secret; `CI=1` or `TURNSTILE_OFFLINE=1` skips it.

## Upload page against a mock API

`task page:mock` serves `public/` plus an in-memory `/api/band` and `/api/uploads*` at
http://127.0.0.1:8788/ (band-prefix form: `/shivs/`). Scenarios ride on the page URL:
`?fail=part2` (part 2 fails once), `?status=429` (second file's init refused),
`?show=none`, `?paused=1`. `/__mock/log` lists every init body and part event.

Two-file check: select a 1 MB jpg and a 70 MB mp4, tap Upload → both bars reach 100 %,
"Thanks! 2 files sent to Mock Band." With `?fail=part2` the same, and the log shows
`part-fail:2` then `part:2`. With `?status=429` the jpg completes and the mp4 shows the
server's reason plus "Failed — tap to retry"; tapping it completes. "Not this one?" →
pick another show → that `showId` appears in the log's init bodies.

## Deploy

Hosting is the Cloudflare Worker `crowd-media` at
`https://crowd-media.matpataki.workers.dev`. Every Cloudflare resource (buckets, domains,
tokens) is Terraform in `mp-infra`; `wrangler.jsonc` only names bindings.

- **Local (the chosen path):** `task deploy` — `wrangler deploy` under `op run`, then a
  smoke check of `/api/health`. Credentials come from the 1Password Environment
  `crowd-media-deploy`, which the 1Password app mounts at `./.env` (gitignored, never a
  file with values). If `.env` is missing, mount it from 1Password → Developer →
  Environments.
- **Upload signing key (once per account):** uploads answer 500 "Uploads aren't set up
  yet." until the Worker has `UPLOAD_SIGNING_KEY`:
  `openssl rand -base64 32 | op run --env-file=.env -- npx wrangler secret put UPLOAD_SIGNING_KEY`.
  Rotating it invalidates in-flight uploads only (guests restart them).
- **Turnstile secret (once per account, before the first deploy that requires it):**
  `wrangler deploy` refuses while a `secrets.required` name is unset on the Worker, so
  set `TURNSTILE_SECRET` (the widget's secret from mp-infra, kept in 1Password) with
  `op run --env-file=.env -- npx wrangler secret put TURNSTILE_SECRET` first. Without
  it, upload init answers 503 naming the missing secret.
- **CI:** `.github/workflows/deploy.yml`. Pull requests always run
  `wrangler deploy --dry-run`. The push-to-`main` deploy job is **off until** the repo
  variable `CF_CI_DEPLOY` is `true`; turning it on also requires the secrets
  `CLOUDFLARE_API_TOKEN` (deploy-only, Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID`
  in the `production` environment.
