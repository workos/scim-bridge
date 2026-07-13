import type { Connection } from "../shared/types";
import { getConnectionById } from "../shared/db";
import { performTick } from "./auto";
import * as store from "./store";
import type { IdpEnv } from "./types";

const MIN_INTERVAL = 1000;
const MAX_INTERVAL = 60_000;

/**
 * In-process auto-run loop for the bundled IdP simulator, one timer per
 * connection. Replaces the Cloudflare Durable Object (self-rescheduling alarm)
 * used in the Workers build — here a single Node process owns the timers, so a
 * plain `setInterval` keyed by connection id does the same job. Demo-only.
 */
class IdpScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  async start(env: IdpEnv, connectionId: string, intervalMs: number): Promise<void> {
    const interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, intervalMs));
    await this.stop(env, connectionId);
    await store.setAutoState(env.DB, connectionId, { running: true, interval_ms: interval });
    const timer = setInterval(() => {
      void this.tick(env, connectionId);
    }, interval);
    // Don't keep the process alive solely for a churn loop.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(connectionId, timer);
  }

  async stop(env: IdpEnv, connectionId: string): Promise<void> {
    const timer = this.timers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(connectionId);
    }
    await store.setAutoState(env.DB, connectionId, { running: false });
  }

  private async tick(env: IdpEnv, connectionId: string): Promise<void> {
    const connection = await getConnectionById(env.DB, connectionId);
    if (!connection) {
      await this.stop(env, connectionId);
      return;
    }
    try {
      await performTick({ env, connection: connection as Connection, origin: "auto" });
    } catch (error) {
      await store.logActivity(env.DB, {
        connection_id: connectionId,
        origin: "auto",
        action: "tick error",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    await store.setAutoState(env.DB, connectionId, { tickDelta: 1 });
  }
}

/** Process-wide singleton owning every connection's auto-run timer. */
export const idpScheduler = new IdpScheduler();
