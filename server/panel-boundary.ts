import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type AppConfig, decidePanelAuth, panelAuthExempt } from "./config";

/**
 * Refuse to be framed. The panel renders live upstream tokens into editable
 * forms, and a form submitted from inside a cross-origin frame is same-origin to
 * the CSRF guard, so a page that frames the panel can redress an operator's
 * clicks into a repointed endpoint. Nothing the bridge serves is meant to be
 * embedded, so every response carries both the modern and the legacy control.
 */
export function antiFramingHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Frame-Options", "DENY");
  };
}

export interface PanelAuthThrottleOptions {
  /** Failed guesses one source may make per window. */
  perSource: number;
  windowMs: number;
  now?: () => number;
}

const DEFAULT_THROTTLE: PanelAuthThrottleOptions = {
  perSource: 10,
  windowMs: 15 * 60 * 1000,
};

/**
 * Counts failed Basic-auth guesses per source in fixed windows. There is no
 * cap across sources: one would let anyone who can reach the panel lock the
 * operator out, so an attacker rotating addresses is bounded by the password
 * itself. Expired windows are dropped as new failures arrive.
 */
export class PanelAuthThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly options: Required<PanelAuthThrottleOptions>;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: Partial<PanelAuthThrottleOptions> = {}) {
    this.options = { now: Date.now, ...DEFAULT_THROTTLE, ...options };
  }

  /** Seconds until `source` may guess again, or null when it may guess now. */
  retryAfter(source: string): number | null {
    const now = this.options.now();
    const entry = this.failures.get(source);
    if (!entry || entry.resetAt <= now || entry.count < this.options.perSource) return null;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  /**
   * Runs `check` after every earlier one has settled. Checking a password is
   * asynchronous, so without this a burst of guesses could all pass
   * `retryAfter` before any of their failures was counted.
   */
  exclusive<T>(check: () => Promise<T>): Promise<T> {
    const result = this.tail.then(check);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  recordFailure(source: string): void {
    const now = this.options.now();
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(key);
    }
    const entry = this.failures.get(source);
    if (entry) entry.count += 1;
    else this.failures.set(source, { count: 1, resetAt: now + this.options.windowMs });
  }
}

/** The connecting peer. Forwarded-for headers are caller-controlled, so not them. */
function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Guard the control panel with HTTP Basic auth, throttling failed guesses.
 * What is deliberately not gated, and why, is `panelAuthExempt`. A request
 * without credentials is the browser asking for the prompt, not a guess, so
 * only a wrong pair counts against the source.
 */
export function panelAuthGuard(
  config: Pick<AppConfig, "panelAuthUser" | "panelAuthPassword" | "demoMode">,
  throttle: PanelAuthThrottle = new PanelAuthThrottle(),
  sourceOf: (c: Context) => string = peerAddress,
): MiddlewareHandler {
  return async (c, next) => {
    if (panelAuthExempt(new URL(c.req.url).pathname, config)) return next();

    const source = sourceOf(c);
    const authorization = c.req.header("Authorization") ?? null;
    const outcome = await throttle.exclusive(async () => {
      const retryAfter = throttle.retryAfter(source);
      if (retryAfter !== null) return retryAfter;
      const decision = await decidePanelAuth(config, authorization);
      if (decision === "denied" && authorization !== null) throttle.recordFailure(source);
      return decision;
    });

    if (typeof outcome === "number") {
      return c.body("Too many failed sign-in attempts. Try again later.", 429, {
        "Retry-After": String(outcome),
      });
    }
    if (outcome !== "denied") return next();
    return c.body("Authentication required.", 401, {
      "WWW-Authenticate": 'Basic realm="scim-bridge", charset="UTF-8"',
    });
  };
}
