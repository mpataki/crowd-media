#!/usr/bin/env bash
# Post-deploy smoke: the given URL returns 200.
# Retries because a fresh deploy can take seconds to reach every edge (a transient
# non-200 against workers.dev was observed in fool_hearts right after a deploy).
# Usage: scripts/smoke-deployed.sh <url> [attempts] [delay-seconds]
set -euo pipefail

url=${1:?usage: smoke-deployed.sh <url> [attempts] [delay-seconds]}
attempts=${2:-3}
delay=${3:-10}

for ((i = 1; i <= attempts; i++)); do
  echo "smoke attempt $i/$attempts against $url"
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" || true)
  if [[ $status == 200 ]]; then
    echo "ok: $url -> 200"
    exit 0
  fi
  echo "got $status" >&2
  if ((i < attempts)); then
    sleep "$delay"
  fi
done
echo "smoke check failed after $attempts attempts" >&2
exit 1
