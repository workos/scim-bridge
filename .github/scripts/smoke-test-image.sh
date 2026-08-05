#!/usr/bin/env bash
#
# Start a built image and drive the three routes that decide whether a first run
# succeeds or gets abandoned.
#
# Usage: .github/scripts/smoke-test-image.sh <image-ref>
#
#   GET /healthz          200            the container came up at all
#   GET /panel            401 → 200      panel auth rejects, then accepts
#   GET /scim/v2/Users    401            the data-plane is never open
#
# The panel and the data-plane are checked separately on purpose: they are
# guarded by different mechanisms (HTTP Basic vs the per-directory proxy token),
# and an image where one of them silently stopped guarding is exactly the kind
# of thing a build-only check publishes happily.
#
# To prove this script works, break something and watch it go red — e.g. run it
# against an image built with PANEL_AUTH_* baked to empty, and the 401 assertion
# must fail rather than the script reporting success.
set -euo pipefail

IMAGE="${1:?usage: smoke-test-image.sh <image-ref>}"
USER_NAME="smoke"
PASSWORD="smoke-$$-pw"

CID=""
cleanup() {
  if [ -n "$CID" ]; then
    docker logs "$CID" 2>&1 | tail -40 | sed 's/^/    container| /' || true
    docker rm -f "$CID" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> starting $IMAGE"
CID="$(docker run -d --rm \
  -p 127.0.0.1:0:8080 \
  -e PANEL_AUTH_USER="$USER_NAME" \
  -e PANEL_AUTH_PASSWORD="$PASSWORD" \
  "$IMAGE")"

# A container that dies on startup has no published port, and `docker port`'s
# own error for that reads like a networking problem. Say what actually happened.
if ! mapping="$(docker port "$CID" 8080/tcp 2> /dev/null)" || [ -z "$mapping" ]; then
  echo "FAIL: $IMAGE published no port — the container exited during startup" >&2
  exit 1
fi
PORT="$(echo "$mapping" | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:${PORT}"
echo "    container ${CID:0:12} on $BASE"

# Boot applies migrations and loads the React Router build, so allow a while —
# but fail on the container dying rather than waiting out the full timeout.
echo "==> waiting for /healthz"
ready=0
for _ in $(seq 1 60); do
  if ! docker inspect -f '{{.State.Running}}' "$CID" 2> /dev/null | grep -q true; then
    echo "FAIL: container exited during boot" >&2
    exit 1
  fi
  if curl -fsS -o /dev/null "$BASE/healthz" 2> /dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || {
  echo "FAIL: /healthz never became ready" >&2
  exit 1
}

fails=0
# $1 label, $2 expected status, $3.. curl args
expect() {
  local label="$1" want="$2"
  shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [ "$got" = "$want" ]; then
    printf '    ✓ %-46s %s\n' "$label" "$got"
  else
    printf '    ✗ %-46s got %s, want %s\n' "$label" "$got" "$want" >&2
    fails=$((fails + 1))
  fi
}

echo "==> routes"
expect "GET /healthz" 200 "$BASE/healthz"
expect "GET /panel                 (no credentials)" 401 "$BASE/panel"
expect "GET /panel                 (wrong password)" 401 -u "$USER_NAME:wrong" "$BASE/panel"
expect "GET /panel                 (correct)" 200 -u "$USER_NAME:$PASSWORD" "$BASE/panel"
expect "GET /scim/v2/Users         (no token)" 401 "$BASE/scim/v2/Users"
expect "GET /scim/v2/Users         (bogus token)" 401 -H "Authorization: Bearer nope" "$BASE/scim/v2/Users"

if [ "$fails" -ne 0 ]; then
  echo "FAIL: $fails route assertion(s) failed" >&2
  exit 1
fi
echo "✓ image boots and both auth boundaries hold"
