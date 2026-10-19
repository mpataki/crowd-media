# crowd-media

Guests at a gig scan a QR code and upload the photos and videos from their phones; the
files land in a Cloudflare R2 bucket and are later pulled down to the home NAS. It is a
single Cloudflare Worker (TypeScript) serving a static upload page plus a small `/api`.

## Run locally

Requires Node 22. No Cloudflare login needed:

```bash
npm ci
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

## Deploy

Hosting is the Cloudflare Worker `crowd-media` at
`https://crowd-media.matpataki.workers.dev`. Every Cloudflare resource (buckets, domains,
tokens) is Terraform in `mp-infra`; `wrangler.jsonc` only names bindings.

- **Local (the chosen path):** `task deploy` — `wrangler deploy` under `op run`, then a
  smoke check of `/api/health`. Credentials come from the 1Password Environment
  `crowd-media-deploy`, which the 1Password app mounts at `./.env` (gitignored, never a
  file with values). If `.env` is missing, mount it from 1Password → Developer →
  Environments.
- **CI:** `.github/workflows/deploy.yml`. Pull requests always run
  `wrangler deploy --dry-run`. The push-to-`main` deploy job is **off until** the repo
  variable `CF_CI_DEPLOY` is `true`; turning it on also requires the secrets
  `CLOUDFLARE_API_TOKEN` (deploy-only, Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID`
  in the `production` environment.
