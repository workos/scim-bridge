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

UNKNOWN_OCI="$WORK/oci-unknown-descriptor"
python3 - "$UNKNOWN_OCI" <<'PY'
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

root = Path(sys.argv[1])
blobs = root / "blobs" / "sha256"
blobs.mkdir(parents=True)
(root / "oci-layout").write_text(json.dumps({"imageLayoutVersion": "1.0.0"}))


def put_blob(data):
    if isinstance(data, (dict, list)):
        data = json.dumps(data, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    (blobs / digest).write_bytes(data)
    return {"digest": f"sha256:{digest}", "size": len(data)}


layer_io = io.BytesIO()
with tarfile.open(fileobj=layer_io, mode="w") as tf:
    payload = b"clean fixture\n"
    info = tarfile.TarInfo("app/clean.txt")
    info.size = len(payload)
    tf.addfile(info, io.BytesIO(payload))

layer = put_blob(layer_io.getvalue())
layer["mediaType"] = "application/vnd.oci.image.layer.v1.tar"
config = put_blob({"architecture": "amd64", "os": "linux", "config": {}, "rootfs": {"type": "layers", "diff_ids": []}, "history": []})
config["mediaType"] = "application/vnd.oci.image.config.v1+json"
manifest = put_blob({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": config, "layers": [layer]})
manifest["mediaType"] = "application/vnd.oci.image.manifest.v1+json"
unknown = put_blob({"schemaVersion": 1, "note": "clean but unsupported descriptor"})
unknown["mediaType"] = "application/vnd.workos.example.uninspected.v1+json"
nested_index = put_blob({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [unknown]})
nested_index["mediaType"] = "application/vnd.oci.image.index.v1+json"
(root / "index.json").write_text(json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [manifest, nested_index]}, separators=(",", ":")))
PY

if .github/scripts/check-image-secrets.sh "$UNKNOWN_OCI" > "$WORK/unknown-oci.out" 2>&1; then
  echo "FAIL: scanner accepted an unknown nested OCI descriptor beside a valid image" >&2
  exit 1
fi
if ! grep -q 'unsupported OCI descriptor media type' "$WORK/unknown-oci.out"; then
  echo "FAIL: scanner rejected the unknown nested OCI descriptor without a fail-closed diagnostic" >&2
  exit 1
fi

echo "✓ image secret scanner rejects unknown nested OCI descriptors"

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
