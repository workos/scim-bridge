# The directory status endpoint (for your DSync listener)

During the migration your app receives WorkOS Directory Sync events, but it
must only **apply** them once WorkOS is authoritative for that directory —
before cutover the proxy still writes your app directly, and applying an echo
would fight that write path. The proxy exposes a per-directory status endpoint
your listener polls to make that call:

```
GET {PUBLIC_URL}/status/directories/{directory_id}
Authorization: Bearer {proxy_token}
```

- `{directory_id}` — the **WorkOS directory id** (`directory_...`) the event
  carries in `event.data.directory_id`, once you set it on the directory in the
  panel; the bridge's own directory id (`dir_...`) also works.
- `{proxy_token}` — the same per-directory bearer token your IdP presents to
  the `/scim/v2` data-plane. A token can only read its own directory's status.

Response:

```json
{
  "directory_id": "dir_1a2b3c4d5e6f7a8b",
  "workos_directory_id": "directory_01HXYZ...",
  "mode": "dual-write",
  "native_authoritative": true,
  "updated_at": "2026-07-31 14:00:00"
}
```

`native_authoritative` is derived from the mode — `true` for `passthrough` and
`dual-write` (your app still owns the directory; **ignore** DSync events),
`false` for `workos-only` (WorkOS owns it; **handle** them). A rollback flips
it back to `true`.

The response carries an `ETag` and `Cache-Control: private, max-age=5`, so a
listener that asks once per event can revalidate cheaply with `If-None-Match`
(a `304` means nothing changed). Keep the cache short-lived: a stale
`native_authoritative` delays your app noticing a cutover or rollback.

## Handle-vs-ignore in your listener

```ts
const statusCache = new Map<string, { authoritative: boolean; expires: number }>();

/** True when this app (not WorkOS) still owns the directory. */
async function nativeAuthoritative(directoryId: string): Promise<boolean> {
  const cached = statusCache.get(directoryId);
  if (cached && cached.expires > Date.now()) return cached.authoritative;

  // You already store the proxy token per directory to configure your IdP;
  // key it by the WorkOS directory id when you set that id in the panel.
  const response = await fetch(
    `${PROXY_PUBLIC_URL}/status/directories/${encodeURIComponent(directoryId)}`,
    { headers: { Authorization: `Bearer ${proxyTokenFor(directoryId)}` } },
  );
  if (!response.ok) throw new Error(`status endpoint answered ${response.status}`);
  const status = (await response.json()) as { native_authoritative: boolean };
  statusCache.set(directoryId, {
    authoritative: status.native_authoritative,
    expires: Date.now() + 5_000,
  });
  return status.native_authoritative;
}

app.post("/webhooks/dsync", async (req, res) => {
  const event = req.body;
  if (await nativeAuthoritative(event.data.directory_id)) {
    // Pre-cutover: the proxy writes this app directly; applying the WorkOS
    // echo would fight it. Acknowledge and drop.
    return res.json({ received: true });
  }
  await applyDsyncEvent(event); // workos-only: WorkOS is the source of truth
  res.json({ received: true });
});
```

On an error from the endpoint, fail toward **not applying** the event and let
the webhook retry — guessing "handle" while your app is still authoritative can
clobber newer native state.

The bundled reference listener (`workers/native/listener.ts`) consumes this
endpoint the same way via `workers/native/status-client.ts`, falling back to
its shared database only when the endpoint isn't mounted (`npm run dev`).
