# Runbook

Operating a scim-bridge deployment: deploy, import directories, run the
migration, and roll back. For install/config basics see the [README](../README.md);
for the migration's design see [architecture.md](./architecture.md).

## Deploy

```bash
cp .env.example .env    # set PUBLIC_URL (externally reachable), a persistent DATABASE_PATH volume
docker compose up -d --build
```

Health: `GET /healthz` → `{"ok":true}`. Migrations apply on boot. Put the panel
behind auth (`PANEL_AUTH_USER`/`PANEL_AUTH_PASSWORD`, or your own reverse proxy)
and set `APP_ENCRYPTION_KEY` so per-directory tokens are encrypted at rest.

## Import directories

Open `/panel`.

- **One directory** → *Import directory*: name, your native SCIM base URL + token,
  and the WorkOS directory endpoint + token (from the WorkOS dashboard).
- **Many** → *Bulk import*: paste CSV `name,native_url,native_token,workos_url,workos_token`
  (header optional). See [workos-directory-provisioning.md](./workos-directory-provisioning.md)
  for producing the WorkOS side in bulk.

Then copy the directory's **SCIM base URL + proxy token** into your IdP's SCIM
config. It starts in `passthrough`, so repointing the IdP changes no behavior —
every request still reaches your native app.

## Run the migration

Advance the directory's mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at each step:

1. **passthrough** → confirm requests flow through to native unchanged.
2. **dual-write (native-first)** → new writes now also mirror to WorkOS.
3. **Run backfill** → copies existing native state into WorkOS (idempotent;
   safe to re-run). Requires dual-write on.
4. Verify parity (Mappings shows a WorkOS id per resource).
5. **Cut over to workos-only** → confirm the AlertDialog. WorkOS is now
   authoritative; provision your app from WorkOS Directory Sync events (the
   listener in `workers/native/listener.ts` is a reference implementation).

**Rollback:** before cutover, move the mode back toward passthrough — the native
system stayed current, so no data is lost.

## Self-contained demo

`DEMO_MODE=true` mounts a simulated IdP + native app and seeds a pre-wired "Demo
directory", so you can drive the whole loop with no real IdP or WorkOS account.
Use the panel's **Live state** and **IdP simulator** tabs to seed and churn the
directory and watch it converge.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Proxy returns 401 | The IdP's bearer token must equal the directory's `proxy_token`. |
| Proxy returns 502 | The native (passthrough/dual-write) or WorkOS (workos-only) endpoint is unreachable — verify the URL/token with the directory page's test buttons. |
| Mappings show `fallback-post` | The migrated-id contract wasn't active for that WorkOS directory (flag/`migrated`/`created_at` prerequisites) — ids aren't shared. |
| Tokens look like `enc:v1:…` in the DB | Expected — they're encrypted at rest. Never change `APP_ENCRYPTION_KEY` after writing, or they become unreadable. |
| Panel 500s after setting a key | The key changed since tokens were written; restore the original `APP_ENCRYPTION_KEY`. |
