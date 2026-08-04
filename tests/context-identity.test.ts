import { describe, expect, it, vi } from "vitest";

/**
 * The panel's React Router contexts must survive being loaded twice.
 *
 * `server/index.ts` imports app/context.ts from source under tsx; Vite inlines a
 * second copy of it into build/server/index.js. `RouterContextProvider` resolves
 * values by the identity of the token `createContext()` returned, so if the two
 * copies mint their own tokens the server sets one and every loader reads
 * another — "No value found for context", a 500 on every panel route, with `tsc`
 * and the build both silent because the types match on either side.
 *
 * app/context.ts defends against that by minting through a `Symbol.for`
 * registry. This asserts the property that defence exists for, rather than the
 * mechanism: reload the module and require the tokens to come back identical.
 */
describe("panel router contexts", () => {
  it("mints the same tokens for a second copy of the module", async () => {
    const first = await import("../app/context");
    vi.resetModules();
    const second = await import("../app/context");

    // Without a real second evaluation the assertions below are trivially true,
    // so prove the reload happened before trusting them.
    expect(second).not.toBe(first);

    expect(second.datastoreContext).toBe(first.datastoreContext);
    expect(second.demoModeContext).toBe(first.demoModeContext);
  });
});
