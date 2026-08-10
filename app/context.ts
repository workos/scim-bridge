import { createContext } from "react-router";
import type { RouterContext } from "react-router";
import type { Datastore } from "../workers/shared/datastore";

/**
 * What the Node server hands every panel loader and action.
 *
 * React Router 8 replaced the augmentable `AppLoadContext` interface with typed
 * contexts: `server/index.ts` populates a `RouterContextProvider` with the two
 * below, and routes read them back with `context.get(...)`.
 *
 * Until then this was a single `cloudflare: { env, ctx, demoMode }` key, kept
 * from the original Workers app so routes could read `context.cloudflare.env.DB`
 * unchanged. Nothing runs on Workers now — the bridge is a Node container whose
 * datastore may be SQLite or Postgres — and no panel route ever
 * touched `ctx.waitUntil`, so the name and both wrapper layers are gone with it.
 */

/**
 * Why the registry, and not two bare `createContext()` calls.
 *
 * This file is loaded twice. `server/index.ts` imports it from source under tsx;
 * Vite *inlines* it into build/server/index.js, so the bundled panel gets a second
 * copy — the same module-graph split that makes the encryption key ride on the
 * shared DB handle in server/index.ts. `createContext()` mints a fresh token per
 * call and `RouterContextProvider` looks values up by that token's identity, so
 * two copies means the server sets one token and the loaders read another: every
 * `context.get(...)` throws "No value found for context" and the panel 500s on
 * every route. Neither `tsc` nor the build says a word — the types are identical
 * on both sides, which is the whole reason the panel gets smoke-booted.
 *
 * The old `cloudflare` object literal was immune because a string key is
 * structural. Minting through a `Symbol.for` registry restores that property:
 * the symbol is global to the process, so whichever copy loads first creates the
 * tokens and the other reuses them.
 *
 * tests/context-identity.test.ts asserts this by loading the module twice.
 */
interface ContextRegistry {
  datastore: RouterContext<Datastore>;
  demoMode: RouterContext<boolean>;
}

const REGISTRY = Symbol.for("scim-bridge.router-contexts");
const host = globalThis as unknown as Record<symbol, ContextRegistry | undefined>;

/** Neither context carries a default value: an unpopulated provider throws on
 *  `get` rather than handing a loader a silently absent database. */
const registry: ContextRegistry = (host[REGISTRY] ??= {
  datastore: createContext<Datastore>(),
  demoMode: createContext<boolean>(),
});

/** The configured datastore driver — what every loader and action reads through. */
export const datastoreContext = registry.datastore;

/** Whether the bundled demo simulators are enabled (DEMO_MODE). The panel only
 *  surfaces the demo tabs when this is on. */
export const demoModeContext = registry.demoMode;
