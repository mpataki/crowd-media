#!/usr/bin/env bash
# `wrangler deploy` with the required secrets (wrangler.jsonc secrets.required) riding
# along via --secrets-file: wrangler refuses to create the Worker while they're unset,
# and `wrangler secret put` can't run before the Worker exists.
#
# Run by `task deploy` inside `op run --env-file=.env` (which resolves
# CLOUDFLARE_API_TOKEN). secrets.op.env holds only op:// references; `op inject`
# resolves them into a shell variable and a FIFO hands them to wrangler, so no secret
# value is ever written to disk. A FIFO, not <(…): npx and wrangler's own launcher
# spawn child processes that don't inherit the /dev/fd/N descriptor (EBADF).
#
# Usage: scripts/deploy.sh [extra wrangler deploy args, e.g. --dry-run]
# SECRETS_INJECT overrides the resolver (default `op inject -i`); only for probing the
# plumbing with a template of fake literal values, e.g.
#   SECRETS_TEMPLATE=fake.env SECRETS_INJECT=cat scripts/deploy.sh --dry-run
set -euo pipefail

template=${SECRETS_TEMPLATE:-secrets.op.env}
read -r -a inject <<<"${SECRETS_INJECT:-op inject -i}"

# Resolve first: a failed inject stops here, before anything is deployed.
secrets=$("${inject[@]}" "$template")
[[ $secrets != *"op://"* ]] || { echo "deploy: unresolved op:// reference in $template" >&2; exit 1; }

dir=$(mktemp -d "${TMPDIR:-/tmp}/crowd-media-secrets.XXXXXX")
chmod 700 "$dir"
fifo=$dir/secrets.env
writer=
cleanup() {
  # A writer still blocked in open() means wrangler never read the FIFO.
  [[ -n $writer ]] && kill "$writer" 2>/dev/null || true
  rm -f -- "$fifo"
  rmdir -- "$dir"
}
trap cleanup EXIT
mkfifo -m 600 "$fifo"

# printf is a builtin: the values never appear in a process's argv.
printf '%s\n' "$secrets" >"$fifo" &
writer=$!
unset secrets

npx wrangler deploy --secrets-file "$fifo" "$@"
wait "$writer"
writer=
