#!/usr/bin/env bash
#
# Prove the image secret scanner fails on a credential/config file that was added
# in one layer and deleted in a later layer. The canary is deliberately fake and
# is never printed.
set -euo pipefail

BASE_IMAGE="${1:?usage: test-image-secret-scanner.sh <already-built-image-ref>}"
TAG_SUFFIX="${GITHUB_RUN_ID:-local}-$$"
LEAK_IMAGE="scim-bridge-secret-scan-leak:${TAG_SUFFIX}"
CLEAN_IMAGE="scim-bridge-secret-scan-clean:${TAG_SUFFIX}"
WORK="$(mktemp -d)"

cleanup() {
  docker rmi "$LEAK_IMAGE" "$CLEAN_IMAGE" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/Dockerfile.clean" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN printf 'clean scanner fixture\n' > /tmp/scanner-clean-fixture && rm -f /tmp/scanner-clean-fixture
DOCKERFILE

cat > "$WORK/Dockerfile.leak" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN printf '//registry.example.invalid/:_authToken=deleted-layer-canary\n' > /tmp/.npmrc
RUN rm -f /tmp/.npmrc
DOCKERFILE

docker build --quiet --build-arg "BASE_IMAGE=$BASE_IMAGE" -f "$WORK/Dockerfile.clean" -t "$CLEAN_IMAGE" "$WORK" > /dev/null
.github/scripts/check-image-secrets.sh "$CLEAN_IMAGE"

docker build --quiet --build-arg "BASE_IMAGE=$BASE_IMAGE" -f "$WORK/Dockerfile.leak" -t "$LEAK_IMAGE" "$WORK" > /dev/null
if .github/scripts/check-image-secrets.sh "$LEAK_IMAGE" > "$WORK/leak.out" 2>&1; then
  echo "FAIL: scanner accepted a deleted-layer credential/config canary" >&2
  exit 1
fi
if ! grep -Eq 'credential/config file|image history entry' "$WORK/leak.out"; then
  echo "FAIL: scanner rejected the leak but did not report a layer/config finding" >&2
  exit 1
fi

echo "✓ image secret scanner rejects deleted-layer credential/config leaks"
