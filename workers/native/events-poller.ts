import { getConfig, setConfig } from "../shared/db";
import type { Datastore } from "../shared/datastore";
import { processDsyncEvent } from "./listener";

/**
 * The Events API polling transport: the ordered alternative to webhooks.
 *
 * WorkOS webhooks carry no ordering guarantee, and the listener's timestamp
 * ledger can only order events whose `created_at` differ — a stale
 * `dsync.user.deleted` delivered 31s late once destroyed state a newer event
 * had established. `GET /events` returns the same envelopes **in order** behind
 * a cursor, so applying them in returned order needs no timestamps at all.
 *
 * Every event still flows through `processDsyncEvent` — the same
 * handle-vs-ignore instruction, replay guards, dedup and event log as a webhook
 * delivery — so running both transports at once only costs "skipped duplicate"
 * rows, never a double apply.
 *
 * The API key that authenticates this endpoint is environment-wide — a broader
 * credential than anything else the listener holds — which is why it is read
 * from the environment only (WORKOS_API_KEY) and never stored in the database.
 */

/** Where the cursor survives a restart: the id of the last event whose
 *  processing completed, so a new process resumes without gaps or replays. */
export const EVENTS_CURSOR_KEY = "native.events_cursor";

const DEFAULT_EVENTS_URL = "https://api.workos.com";
const DEFAULT_LIMIT = 100;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** The dsync.* events the listener has handlers (or deliberate no-ops) for —
 *  the `events` filter keeps everything else out of the response. */
export const DSYNC_EVENT_TYPES = [
  "dsync.activated",
  "dsync.deleted",
  "dsync.user.created",
  "dsync.user.updated",
  "dsync.user.deleted",
  "dsync.group.created",
  "dsync.group.updated",
  "dsync.group.deleted",
  "dsync.group.user_added",
  "dsync.group.user_removed",
] as const;

export interface EventsPollerOptions {
  /** The environment's API key, from WORKOS_API_KEY. */
  apiKey: string;
  /** Base URL of the Events API; the demo points this at the bundled mock. */
  baseUrl?: string;
  /** Page size per request. */
  limit?: number;
}

interface EventsPage {
  data?: unknown[];
  list_metadata?: { after?: string | null };
}

/**
 * Fetch and apply every event newer than the persisted cursor, strictly in
 * returned order, paging until the API reports no more. Returns how many events
 * were processed. Throws on a fetch or API failure — the loop in
 * `startEventsPoller` turns that into a logged retry.
 */
export async function pollDsyncEventsOnce(
  db: Datastore,
  options: EventsPollerOptions,
): Promise<{ processed: number }> {
  const base = (options.baseUrl ?? DEFAULT_EVENTS_URL).replace(/\/+$/, "");
  const limit = options.limit ?? DEFAULT_LIMIT;
  let cursor = await getConfig(db, EVENTS_CURSOR_KEY);
  let processed = 0;

  for (;;) {
    const url = new URL(`${base}/events`);
    for (const type of DSYNC_EVENT_TYPES) url.searchParams.append("events[]", type);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`events API answered ${response.status} for GET ${base}/events`);
    }
    const page = (await response.json()) as EventsPage;
    const events = Array.isArray(page.data) ? page.data : [];

    // Ordering is the whole point of this transport: each event is fully
    // applied before the next is looked at, and the page is walked front to
    // back exactly as the API returned it.
    let lastProcessedId: string | null = null;
    for (const event of events) {
      const envelope =
        event && typeof event === "object" && !Array.isArray(event)
          ? (event as Record<string, unknown>)
          : null;
      const outcome = await processDsyncEvent(db, envelope);
      if (outcome.handlerError) {
        // The failed event stays ahead of the cursor so the next poll re-reads
        // and retries it; everything already processed moves behind it. The
        // replays that re-read causes are absorbed by the event-id dedup.
        if (lastProcessedId) await setConfig(db, EVENTS_CURSOR_KEY, lastProcessedId);
        return { processed };
      }
      processed += 1;
      const id = typeof envelope?.id === "string" && envelope.id ? envelope.id : null;
      if (id) lastProcessedId = id;
    }
    if (lastProcessedId) {
      await setConfig(db, EVENTS_CURSOR_KEY, lastProcessedId);
      cursor = lastProcessedId;
    }

    // A null `after` is how the API says the log is exhausted.
    if (!page.list_metadata?.after || events.length === 0) return { processed };
  }
}

export interface EventsPoller {
  stop(): void;
}

/**
 * Poll on an interval, forever. One poll in flight at a time — a slow page must
 * not be overtaken by the next tick, or events would apply out of order — and a
 * failed poll is logged and retried next tick rather than allowed to bring the
 * process down with it.
 */
export function startEventsPoller(
  db: Datastore,
  options: EventsPollerOptions & { intervalMs?: number },
): EventsPoller {
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pollDsyncEventsOnce(db, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`events poller: ${message}; retrying next tick`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  // Never the reason the process can't exit (Node timers hold the loop open).
  timer.unref?.();
  void tick();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
