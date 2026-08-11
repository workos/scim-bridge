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

## Revalidate before you ignore

**A cache — any cache, of any length — must not be what decides to drop an
event.** Ignoring is the one decision your listener cannot take back: you
acknowledge the delivery with a `200`, so WorkOS never sends it again. Applying
is recoverable by construction, because every DSync event is idempotent and a
replay costs nothing.

That asymmetry matters at exactly one moment, and it is the least reversible
moment in the migration. A cutover to `workos-only` is instantaneous on the
proxy side — it stops writing your app the same instant — and only as fast as
your cache on the listener side. An event produced in that gap finds a proxy
that has already stopped writing and a listener that still believes it must stay
inert, so **nobody writes your app** and the divergence is permanent. A real
cutover lost two group memberships this way.

Shortening the TTL does not fix it; any window at all is a window. What fixes it
is confirming the answer before acting on the irreversible half:

- getting `apply === true` from cache → **apply it**, no request;
- getting `apply === false` from cache → **ask the endpoint again before
  ignoring**, ignoring the freshness of what you hold, and act on that answer.

Send `If-None-Match` on that confirmation, so the common answer is a `304` and
you pay one conditional request, not a payload. Anchor it to the event: an entry
the endpoint confirmed at or after the event arrived already answers the
question and needs no second request, which keeps a cold cache at one request
rather than two.

If the confirmation cannot be made at all — endpoint down, or you are backing
off from a failure — do **not** hammer it once per event; a cutover arrives as a
burst, and a burst of connection timeouts is its own outage. Fall back to the
last answer you hold and ignore on that: it is the conservative direction, and
the reconcile below repairs whatever it costs you.

The reverse flip, `workos-only` → `workos-primary`, has the mirror-image window:
your listener keeps applying for a cache's length after the proxy has resumed
writing your app, so those changes land twice. That one is benign — the handlers
are idempotent — and it does not need a second revalidation.

## Handle-vs-ignore in your listener

```ts
const TTL_MS = 5_000;

interface CachedStatus {
  apply: boolean;
  etag: string | null;
  /** When the endpoint last confirmed this entry — a 200 or a 304. */
  validatedAt: number;
}

const statusCache = new Map<string, CachedStatus>();

/**
 * True when this app should apply DSync events for the directory.
 *
 * `validatedSince` (epoch ms) refuses a cached answer the endpoint confirmed
 * before that instant, however fresh the TTL still considers it. Pass it when
 * the answer is about to be used to ignore an event; omit it otherwise.
 */
async function shouldApplyDsyncEvents(directoryId: string, validatedSince = 0): Promise<boolean> {
  const cached = statusCache.get(directoryId);
  if (cached && Date.now() - cached.validatedAt < TTL_MS && cached.validatedAt >= validatedSince) {
    return cached.apply;
  }

  // You already store the proxy token per directory to configure your IdP;
  // key it by the WorkOS directory id when you set that id in the panel.
  const response = await fetch(
    `${PROXY_PUBLIC_URL}/status/directories/${encodeURIComponent(directoryId)}`,
    {
      headers: {
        Authorization: `Bearer ${proxyTokenFor(directoryId)}`,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
    },
  );
  if (response.status === 304 && cached) {
    // The endpoint just confirmed what we hold, which is what a confirmation
    // asked for — so this counts as a validation, not a cache hit.
    cached.validatedAt = Date.now();
    return cached.apply;
  }
  if (!response.ok) {
    // Unreachable. Prefer the last answer the endpoint gave over asking again
    // per event; only with nothing at all do we fail the delivery.
    if (cached) return cached.apply;
    throw new Error(`status endpoint answered ${response.status}`);
  }
  const status = (await response.json()) as {
    mode: string;
    apply_dsync_events?: boolean;
  };
  // Obey the instruction when it is there; an older bridge that doesn't send
  // one meant `workos-only`. Never re-derive it from `native_authoritative`.
  const apply = status.apply_dsync_events ?? status.mode === "workos-only";
  statusCache.set(directoryId, {
    apply,
    etag: response.headers.get("ETag"),
    validatedAt: Date.now(),
  });
  return apply;
}

app.post("/webhooks/dsync", async (req, res) => {
  const event = req.body;
  const arrivedAt = Date.now();
  const directoryId = event.data.directory_id;

  // Applying is idempotent, so the cached answer is good enough for it.
  // Ignoring is not: confirm it against a status no older than this event.
  const apply =
    (await shouldApplyDsyncEvents(directoryId)) ||
    (await shouldApplyDsyncEvents(directoryId, arrivedAt));
  if (!apply) {
    // The proxy is writing this app directly; applying the WorkOS echo would
    // fight it, or double-apply it. Acknowledge and drop.
    return res.json({ received: true });
  }
  await applyDsyncEvent(event); // WorkOS is the source of truth for this app
  res.json({ received: true });
});
```

With no answer at all from the endpoint — nothing cached, and the request
failed — fail toward **not applying** the event and let the webhook retry;
guessing "apply" while the proxy is still writing your app can clobber newer
native state or duplicate a change.

The bundled reference listener (`workers/native/listener.ts`) consumes this
endpoint the same way via `workers/native/status-client.ts` — it reads
`apply_dsync_events` and never re-derives it, and it confirms every `ignore`
against the endpoint before committing to it — falling back to its shared
database only when the endpoint isn't mounted (`npm run dev`), and to
`mode === "workos-only"` when the bridge is old enough not to send the field.

## Applying events

What each event means on a directory provisioned for migration (an **imported**
directory — see the [migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)),
and the two mistakes that silently lose data:

- **`dsync.user.created` / `dsync.user.updated`** — upsert the user. A payload
  with an inactive `state` is an **offboard**: revoke access, keep the row.
  Imported directories run with suspension soft-delete, so this — not
  `user.deleted` — is how a deactivation (Okta unassign, Entra soft delete)
  arrives.
- **`dsync.user.deleted`** — the user is actually gone from the directory.
  Deprovision, and only then consider removing data — actual purging is a
  retention-policy decision, not something to do on webhook receipt.
- **`dsync.group.user_added` / `user_removed`** — membership edges. WorkOS
  emits them only when a membership *changes*: state your app dropped on its
  own is never re-announced.

**The rehire trap.** A listener that deletes its row on any deactivation signal
loses the user's id and group memberships the moment that user is reactivated:
WorkOS kept both, considers nothing changed, and emits no event that would
rebuild them — the drift is permanent until a **Reconcile from WorkOS** repairs
it. This is why offboard must keep the row, and why a directory whose
environment lacks suspension soft-delete must not cut over until WorkOS confirms
it is enabled.

**Keep resource ids stable.** Locate an existing user by identity attributes —
`idp_id` first, then `userName` — and only when nothing matches create the row
**adopting the event's `data.id`**. On an imported directory that value is the
shared migrated id — the same id WorkOS, the bridge's mappings, reconcile, and
rollback all address — which is exactly why the reference listener
(`workers/native/listener.ts`) adopts it rather than minting its own or using
`idp_id`. The lookup-first order is what keeps a rehire landing on the existing
row instead of creating a duplicate.

> **Diagnostic:** if the `data.id` on your user events looks like
> `directory_user_…`, the directory was **not** provisioned as imported
> (migration guide, Step A) — that is WorkOS's internal id, adopting it produces
> rows the bridge's reconcile cannot attribute, and the migration contract this
> document assumes is not in effect. Stop and get the directory provisioned
> correctly before cutover.
