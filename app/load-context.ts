import type { PocEnv } from "../workers/shared/types";

/**
 * The load context every route sees as `context.cloudflare`. The `cloudflare`
 * name is kept from the original Workers app so routes read `context.cloudflare.
 * env.DB` unchanged; under Node the server supplies a SQLite-backed `env` and a
 * `ctx` whose `waitUntil` tracks fire-and-forget work.
 */
declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: PocEnv;
      ctx: ExecutionContext;
      /** Whether the bundled demo simulators are enabled (DEMO_MODE). The panel
       *  only surfaces the demo tabs when this is on. */
      demoMode: boolean;
    };
  }
}
