import type { Directory } from "../shared/types";
import { getDirectoryById } from "../shared/db";
import { performTick } from "./auto";
import * as store from "./store";
import type { IdpEnv } from "./types";

const MIN_INTERVAL = 1000;
const MAX_INTERVAL = 60_000;

/**
 * In-process auto-run loop for the bundled IdP simulator, one timer per
 * directory. Replaces the Cloudflare Durable Object (self-rescheduling alarm)
 * used in the Workers build — here a single Node process owns the timers, so a
 * plain `setInterval` keyed by directory id does the same job. Demo-only.
 */
class IdpScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  async start(env: IdpEnv, directoryId: string, intervalMs: number): Promise<void> {
    const interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, intervalMs));
    await this.stop(env, directoryId);
    await store.setAutoState(env.DB, directoryId, { running: true, interval_ms: interval });
    const timer = setInterval(() => {
      void this.tick(env, directoryId);
    }, interval);
    // Don't keep the process alive solely for a churn loop.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(directoryId, timer);
  }

  async stop(env: IdpEnv, directoryId: string): Promise<void> {
    const timer = this.timers.get(directoryId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(directoryId);
    }
    await store.setAutoState(env.DB, directoryId, { running: false });
  }

  private async tick(env: IdpEnv, directoryId: string): Promise<void> {
    const directory = await getDirectoryById(env.DB, directoryId);
    if (!directory) {
      await this.stop(env, directoryId);
      return;
    }
    try {
      await performTick({ env, directory: directory as Directory, origin: "auto" });
    } catch (error) {
      await store.logActivity(env.DB, {
        directory_id: directoryId,
        origin: "auto",
        action: "tick error",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    await store.setAutoState(env.DB, directoryId, { tickDelta: 1 });
  }
}

/** Process-wide singleton owning every directory's auto-run timer. */
export const idpScheduler = new IdpScheduler();
