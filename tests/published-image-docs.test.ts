import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Whether `ghcr.io/workos/scim-bridge` can be pulled is stated in two places:
 * the README, which tells readers how to run the published image, and the
 * going-public checklist in docs/releasing.md, which records the steps that made
 * it pullable. A test cannot ask the registry, but it can hold each document to
 * itself. A README that says the pull fails sends readers to build from source
 * for no reason, and a checklist with a ticked step under an unticked blocker
 * describes an order of events that cannot have happened.
 */
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The body of one `### ` section of the README, up to the next heading. */
function readmeSection(heading: string): string {
  const marker = `### ${heading}\n`;
  const readme = read("README.md");
  const start = readme.indexOf(marker);
  if (start === -1) throw new Error(`README has no "${heading}" section`);
  const body = readme.slice(start + marker.length);
  const end = body.search(/^#{1,3} /m);
  return end === -1 ? body : body.slice(0, end);
}

/** The going-public checklist as ordered steps, each with its ticked state. */
function goingPublicSteps(): { done: boolean; text: string }[] {
  const checklist = read("docs/releasing.md")
    .split(/^## /m)
    .find((part) => part.startsWith("Human steps: going public"));
  if (checklist === undefined) throw new Error("releasing.md has no going-public checklist");
  return checklist
    .split(/^- \[/m)
    .slice(1)
    .map((step) => ({ done: step.startsWith("x]"), text: step.slice(3).replace(/\s+/g, " ") }));
}

describe("published-image docs", () => {
  it("does not tell readers the published image cannot be pulled", () => {
    const instructions = readmeSection("Running a published image instead of building");

    expect(instructions).toContain("ghcr.io/workos/scim-bridge");
    expect(instructions).not.toMatch(
      /not yet|unauthorized|not been published|nothing has been pushed/i,
    );
  });

  it("ticks a step that blocks the rest of the checklist before any step below it", () => {
    const steps = goingPublicSteps();
    const blockers = steps.filter((step) => step.text.includes("blocks everything below"));
    expect(blockers.length).toBeGreaterThan(0);

    const tickedUnderAnOpenBlocker = steps.flatMap((step, index) =>
      step.done || !blockers.includes(step)
        ? []
        : steps
            .slice(index + 1)
            .filter((below) => below.done)
            .map((below) => below.text.slice(0, 48)),
    );
    expect(tickedUnderAnOpenBlocker).toEqual([]);
  });
});
