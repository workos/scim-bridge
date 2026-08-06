# The directory status endpoint (for your DSync listener)

During the migration your app receives WorkOS Directory Sync events, but it must
only **apply** them once the proxy has stopped writing your app directly —
before that, applying an echo would fight that write path or duplicate it. The
proxy exposes a per-directory status endpoint that tells your listener, per
event, whether to apply it:

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
  "apply_dsync_events": false,
  "updated_at": "2026-07-31 14:00:00"
}
```

## Which field to key on

**`apply_dsync_events` is the one your listener reads.** `true` means apply the
event; `false` means acknowledge it and drop it. That is the whole contract —
you do not need to know why.

`native_authoritative` answers a *different* question: who owns the directory's
data right now. It is useful for a status display or an operator report. Do not
derive your handle-vs-ignore decision from it, and do not derive it from `mode`
either.

They look interchangeable, and that is the trap. On three of the four modes they
are exact opposites — and on the fourth they are not:

| `mode` | `native_authoritative` | `apply_dsync_events` |
| --- | --- | --- |
| `passthrough` | `true` | `false` |
| `dual-write` | `true` | `false` |
| `workos-primary` | `false` | `false` |
| `workos-only` | `false` | `true` |

`workos-primary` is the row that breaks the symmetry: WorkOS owns the data, and
the proxy still writes your app directly, so your listener must stay inert —
applying the events *as well* would process every change twice. A listener that
inferred "not authoritative ⇒ apply" double-applies every change in exactly the
mode meant to make a migration safer. `apply_dsync_events` is how we tell you, so
you never have to track which modes mean what.

**If the field is missing**, you are talking to a bridge older than this
contract. Fall back to `mode === "workos-only"`, which is what those bridges
meant, and treat any mode you do not recognise as "do not apply".

The response carries an `ETag` and `Cache-Control: private, max-age=5`, so a
listener that asks once per event can revalidate cheaply with `If-None-Match`
(a `304` means nothing changed). The `ETag` covers `apply_dsync_events`
explicitly, so a `304` can never withhold a change to the instruction. Keep the
cache short-lived anyway: a stale instruction delays your app noticing a cutover
or rollback.

## Handle-vs-ignore in your listener

```ts
const statusCache = new Map<string, { apply: boolean; expires: number }>();

/** True when this app should apply DSync events for the directory. */
async function shouldApplyDsyncEvents(directoryId: string): Promise<boolean> {
  const cached = statusCache.get(directoryId);
  if (cached && cached.expires > Date.now()) return cached.apply;

  // You already store the proxy token per directory to configure your IdP;
  // key it by the WorkOS directory id when you set that id in the panel.
  const response = await fetch(
    `${PROXY_PUBLIC_URL}/status/directories/${encodeURIComponent(directoryId)}`,
    { headers: { Authorization: `Bearer ${proxyTokenFor(directoryId)}` } },
  );
  if (!response.ok) throw new Error(`status endpoint answered ${response.status}`);
  const status = (await response.json()) as {
    mode: string;
    apply_dsync_events?: boolean;
  };
  // Obey the instruction when it is there; an older bridge that doesn't send
  // one meant `workos-only`. Never re-derive it from `native_authoritative`.
  const apply = status.apply_dsync_events ?? status.mode === "workos-only";
  statusCache.set(directoryId, { apply, expires: Date.now() + 5_000 });
  return apply;
}

app.post("/webhooks/dsync", async (req, res) => {
  const event = req.body;
  if (!(await shouldApplyDsyncEvents(event.data.directory_id))) {
    // The proxy is writing this app directly; applying the WorkOS echo would
    // fight it, or double-apply it. Acknowledge and drop.
    return res.json({ received: true });
  }
  await applyDsyncEvent(event); // WorkOS is the source of truth for this app
  res.json({ received: true });
});
```

On an error from the endpoint, fail toward **not applying** the event and let
the webhook retry — guessing "apply" while the proxy is still writing your app
can clobber newer native state or duplicate a change.

The bundled reference listener (`workers/native/listener.ts`) consumes this
endpoint the same way via `workers/native/status-client.ts` — it reads
`apply_dsync_events` and never re-derives it — falling back to its shared
database only when the endpoint isn't mounted (`npm run dev`), and to
`mode === "workos-only"` when the bridge is old enough not to send the field.
