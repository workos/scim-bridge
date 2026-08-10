# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------------
FROM node:26-bookworm-slim AS builder
WORKDIR /app

# Toolchain for better-sqlite3's native addon (used only if no prebuilt binary
# matches the platform; the built .node artifact is carried into the runtime).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Every dependency must resolve from the public registry. This runs inside the
# build, not only in CI, because the image is the thing we publish: a lockfile
# pointing at WorkOS's Socket proxy builds fine on a WorkOS machine and E401s for
# everyone else (#45/#50), and "only WorkOS can rebuild it" defeats publishing it.
COPY scripts/check-public-registry.mjs scripts/
RUN node scripts/check-public-registry.mjs

# `npm ci` only — no `|| npm install` fallback. The fallback turned an
# unresolvable or stale lockfile into a green build against a *different*
# dependency tree, which is the one failure the lockfile exists to prevent.
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/scim-bridge.db
WORKDIR /app

# tini reaps zombies and forwards signals so the container stops cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data

COPY --from=builder /app ./

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
