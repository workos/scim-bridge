#!/usr/bin/env bash
#
# Assert that a built image or OCI archive carries no secrets, local state, or
# package-manager registry configuration.
#
# Usage: .github/scripts/check-image-secrets.sh <image-ref|docker-save.tar|oci-layout.tar|oci-layout-dir>
#
# It reads the image's LAYERS, not the running container filesystem. A file
# added in one layer and deleted in a later one is invisible to `docker export`
# and to `ls` inside the container, but it is still in the pushed image and
# still pullable by anyone who has the image.
#
# It also reads the image config and history, because a credential or registry
# override passed through build args or ENV ships in image metadata where a
# filesystem scan would miss it.
set -euo pipefail

TARGET="${1:?usage: check-image-secrets.sh <image-ref|archive|oci-dir>}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SOURCE="$TARGET"
if [ ! -e "$TARGET" ]; then
  SOURCE="$WORK/image.tar"
  echo "==> saving $TARGET"
  docker save "$TARGET" -o "$SOURCE"
else
  echo "==> scanning $TARGET"
fi

python3 - "$SOURCE" <<'PY'
import gzip
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

source = Path(sys.argv[1])
work = Path(tempfile.mkdtemp(prefix="image-secret-scan-"))

FORBIDDEN_PATHS = [
    re.compile(r"(^|/)\.env$"),
    re.compile(r"(^|/)\.env\.[^/]*$"),
    re.compile(r"(^|/)\.dev\.vars([^/]*)$"),
    re.compile(r"(^|/)[^/]*\.db$"),
    re.compile(r"(^|/)[^/]*\.db-(wal|shm)$"),
    re.compile(r"(^|/)\.git/"),
    re.compile(r"(^|/)[^/]*\.pem$"),
    re.compile(r"(^|/)id_(rsa|ed25519)$"),
]
ALLOW_PATHS = [re.compile(r"(^|/)\.env\.example$")]
CREDENTIAL_FILE = re.compile(
    r"(^|/)([^/]*npmrc|\.npmrc|\.netrc|credentials|bunfig\.toml|\.bunfig\.toml)$",
    re.IGNORECASE,
)
CONFIG_CONTENT = re.compile(
    rb"(_auth(Token)?\s*=|_password\s*=|password\s*=|always-auth\s*=|registry\s*=|socket-firewall\.workos\.dev|machine\s+\S+\s+login)",
    re.IGNORECASE,
)
ENV_NAME = re.compile(r"(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|CREDENTIAL|NPM_CONFIG_(REGISTRY|USERCONFIG)|BUN_CONFIG)", re.IGNORECASE)
METADATA_MARKER = re.compile(
    r"(_auth(Token)?\s*=|_password\s*=|always-auth\s*=|registry\s*=\s*https?://socket-firewall\.workos\.dev|socket-firewall\.workos\.dev|PUBLIC_SOCKET_FIREWALL_TOKEN|SOCKET_FIREWALL_TOKEN)",
    re.IGNORECASE,
)

class Store:
    def read_bytes(self, name: str) -> bytes:
        raise NotImplementedError

    def has(self, name: str) -> bool:
        raise NotImplementedError

    def spill_to_file(self, name: str) -> Path:
        dest = work / ("blob-" + str(abs(hash(name))))
        with dest.open("wb") as out:
            out.write(self.read_bytes(name))
        return dest

class TarStore(Store):
    def __init__(self, path: Path):
        self.path = path
        self.tar = tarfile.open(path, "r:*")
        self.members = {m.name: m for m in self.tar.getmembers() if m.isfile()}

    def read_bytes(self, name: str) -> bytes:
        member = self.members[name]
        f = self.tar.extractfile(member)
        if f is None:
            raise KeyError(name)
        return f.read()

    def has(self, name: str) -> bool:
        return name in self.members

    def spill_to_file(self, name: str) -> Path:
        member = self.members[name]
        dest = work / ("blob-" + str(abs(hash(name))))
        f = self.tar.extractfile(member)
        if f is None:
            raise KeyError(name)
        with dest.open("wb") as out:
            shutil.copyfileobj(f, out)
        return dest

class DirStore(Store):
    def __init__(self, path: Path):
        self.path = path

    def _path(self, name: str) -> Path:
        p = (self.path / name).resolve()
        root = self.path.resolve()
        if root not in p.parents and p != root:
            raise ValueError(f"refusing path outside OCI layout: {name}")
        return p

    def read_bytes(self, name: str) -> bytes:
        return self._path(name).read_bytes()

    def has(self, name: str) -> bool:
        return self._path(name).is_file()

    def spill_to_file(self, name: str) -> Path:
        return self._path(name)

def blob_name(desc: dict) -> str:
    digest = desc.get("digest", "")
    algo, _, value = digest.partition(":")
    if algo != "sha256" or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"unsupported descriptor digest: {digest}")
    return f"blobs/{algo}/{value}"

def read_json(store: Store, name: str) -> dict:
    return json.loads(store.read_bytes(name).decode("utf-8"))

def is_docker_save(store: Store) -> bool:
    return store.has("manifest.json")

def is_oci(store: Store) -> bool:
    return store.has("index.json") and store.has("oci-layout")

def add(offenders: list[str], item: str) -> None:
    if item not in offenders:
        offenders.append(item)

def path_forbidden(name: str) -> bool:
    norm = name.lstrip("./")
    if any(p.search(norm) for p in ALLOW_PATHS):
        return False
    return any(p.search(norm) for p in FORBIDDEN_PATHS)

def scan_config(config: dict, label: str, offenders: list[str]) -> None:
    env = config.get("config", {}).get("Env") or config.get("Config", {}).get("Env") or []
    for entry in env:
        name, _, value = str(entry).partition("=")
        if value and ENV_NAME.search(name):
            add(offenders, f"{label}: config ENV sets credential/config-shaped variable {name}")
    for idx, hist in enumerate(config.get("history", []) or []):
        created_by = str(hist.get("created_by", ""))
        if METADATA_MARKER.search(created_by):
            add(offenders, f"{label}: image history entry {idx} contains credential/config-shaped material")

def scan_layer_file(path: Path, label: str, offenders: list[str]) -> tuple[int, int]:
    paths = 0
    try:
        tf = tarfile.open(path, "r:*")
    except tarfile.TarError as exc:
        raise RuntimeError(f"{label}: layer is not a readable tar archive: {exc}") from exc
    with tf:
        for member in tf:
            paths += 1
            name = member.name
            if path_forbidden(name):
                add(offenders, f"{label}: layer path {name}")
            if member.isfile() and CREDENTIAL_FILE.search(name.lstrip("./")):
                f = tf.extractfile(member)
                data = f.read(2_000_001) if f is not None else b""
                if CONFIG_CONTENT.search(data):
                    size = member.size
                    add(offenders, f"{label}: credential/config file {name} ({size} bytes)")
    return 1, paths

def scan_layer(store: Store, name: str, label: str, offenders: list[str]) -> tuple[int, int]:
    path = store.spill_to_file(name)
    return scan_layer_file(path, label, offenders)

def scan_docker_save(store: Store, offenders: list[str]) -> tuple[int, int, int]:
    manifests = json.loads(store.read_bytes("manifest.json").decode("utf-8"))
    image_count = len(manifests)
    layers = 0
    paths = 0
    for idx, manifest in enumerate(manifests):
        config_name = manifest.get("Config")
        if config_name:
            scan_config(read_json(store, config_name), f"docker-save image {idx}", offenders)
        for layer_idx, layer in enumerate(manifest.get("Layers", [])):
            l, p = scan_layer(store, layer, f"docker-save image {idx} layer {layer_idx}", offenders)
            layers += l
            paths += p
    return image_count, layers, paths

def scan_oci_descriptor(store: Store, desc: dict, label: str, offenders: list[str]) -> tuple[int, int, int]:
    media = desc.get("mediaType", "")
    obj = read_json(store, blob_name(desc))
    if media.endswith("image.index.v1+json") or media.endswith("manifest.list.v2+json") or "image.index" in media:
        images = layers = paths = 0
        for idx, child in enumerate(obj.get("manifests", []) or []):
            i, l, p = scan_oci_descriptor(store, child, f"{label} manifest {idx}", offenders)
            images += i
            layers += l
            paths += p
        return images, layers, paths
    if media.endswith("image.manifest.v1+json") or "image.manifest" in media:
        config = obj.get("config")
        if config and config.get("digest"):
            scan_config(json.loads(store.read_bytes(blob_name(config)).decode("utf-8")), label, offenders)
        layers = paths = 0
        for idx, layer in enumerate(obj.get("layers", []) or []):
            l, p = scan_layer(store, blob_name(layer), f"{label} layer {idx}", offenders)
            layers += l
            paths += p
        return 1, layers, paths
    return 0, 0, 0

def scan_oci(store: Store, offenders: list[str]) -> tuple[int, int, int]:
    index = read_json(store, "index.json")
    images = layers = paths = 0
    for idx, desc in enumerate(index.get("manifests", []) or []):
        i, l, p = scan_oci_descriptor(store, desc, f"oci image {idx}", offenders)
        images += i
        layers += l
        paths += p
    return images, layers, paths

def main() -> int:
    store: Store = DirStore(source) if source.is_dir() else TarStore(source)
    offenders: list[str] = []
    if is_docker_save(store):
        kind = "docker-save"
        images, layers, paths = scan_docker_save(store, offenders)
    elif is_oci(store):
        kind = "oci"
        images, layers, paths = scan_oci(store, offenders)
    else:
        raise SystemExit("FAIL: input is neither docker-save nor OCI layout")

    print(f"==> scanned {kind}: {images} image(s), {layers} layer(s), {paths} path(s)")
    if layers == 0:
        print("FAIL: no layers found — the scan proved nothing.", file=sys.stderr)
        return 1
    if offenders:
        print("FAIL: image layers/config contain files or metadata that must never be published:", file=sys.stderr)
        for item in sorted(offenders):
            print(f"  {item}", file=sys.stderr)
        return 1
    print("✓ no secrets, databases, git history, or package-manager config in image layers/config")
    return 0

try:
    raise SystemExit(main())
finally:
    shutil.rmtree(work, ignore_errors=True)
PY
