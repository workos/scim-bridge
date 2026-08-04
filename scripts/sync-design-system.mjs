import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESTINATION = join(ROOT, "app/vendor/design-system");
const SOURCE_ROOT_FILES = [
  "postcss-workds.cjs",
  "styles.css",
  "syntax-highlighting.css",
  "theme.css",
];
const SOURCE_SRC_FILES = [
  "breakpoints.css",
  "fonts.css",
  "overrides.css",
  "index.ts",
  "props.ts",
  "reset.css",
  "components",
  "generated",
  "helpers",
  "icons.ts",
  "recipes",
  "types",
];

const args = process.argv.slice(2);
// `--mark-only` re-applies the @ts-nocheck pass to the tree already vendored, for
// when the exclusion changes but the design system hasn't. Keeps the marking in
// one place instead of inviting a hand-edit that then drifts from the sync.
const markOnly = args.includes("--mark-only");
const source = resolve(args.find((arg) => !arg.startsWith("--")) ?? "../workos/packages/design-system");

if (markOnly) {
  const marked = excludeFromTypecheck(DESTINATION);
  console.log(`Marked ${marked} vendored file(s) @ts-nocheck (no sync)`);
  process.exit(0);
}

if (!existsSync(source)) {
  throw new Error(
    `Design system source not found at ${source}. Pass the path to workos/packages/design-system.`,
  );
}

rmSync(DESTINATION, { force: true, recursive: true });
mkdirSync(DESTINATION, { recursive: true });

for (const file of SOURCE_ROOT_FILES) {
  cpSync(join(source, file), join(DESTINATION, file), { recursive: true });
}

for (const file of SOURCE_SRC_FILES) {
  cpSync(join(source, "src", file), join(DESTINATION, file), { recursive: true });
}

rewriteStylesheetImports(join(DESTINATION, "styles.css"));
rewritePostcssWorkds(join(DESTINATION, "postcss-workds.cjs"));
const excluded = excludeFromTypecheck(DESTINATION);

console.log(`Synced WorkDS from ${source} (${excluded} file(s) marked @ts-nocheck)`);

/**
 * Mark every copied source file `@ts-nocheck`.
 *
 * This tree is generated: the sync overwrites it wholesale, so a fix made here is
 * lost on the next run. It also doesn't compile under this project's stricter
 * settings — `verbatimModuleSyntax` wants `import type`, and `checkJs` reaches the
 * `.cjs` helper — none of which is a defect in the design system. So the boundary
 * is stated where it is generated rather than maintained as a list of exceptions
 * somewhere else: we don't typecheck code we don't edit. Lint already excludes
 * this directory for the same reason.
 *
 * Errors in the panel's *use* of these components still surface, in the panel's
 * own files, which is where they belong.
 */
function excludeFromTypecheck(directory) {
  const CHECKED = new Set([".ts", ".tsx", ".cjs", ".mjs", ".js", ".jsx"]);
  const HEADER =
    "// @ts-nocheck — vendored from workos/packages/design-system by\n" +
    "// `npm run sync-design-system`, which overwrites this file. Edit it upstream.\n";
  let marked = 0;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      marked += excludeFromTypecheck(path);
      continue;
    }
    if (!CHECKED.has(extname(entry))) continue;
    const contents = readFileSync(path, "utf8");
    if (contents.startsWith("// @ts-nocheck")) continue;
    // A shebang has to stay on line one.
    const shebang = contents.startsWith("#!") ? contents.indexOf("\n") + 1 : 0;
    writeFileSync(path, contents.slice(0, shebang) + HEADER + contents.slice(shebang));
    marked += 1;
  }
  return marked;
}

function rewriteStylesheetImports(path) {
  const contents = readFileSync(path, "utf8").replaceAll("src/", "./");
  writeFileSync(path, contents);
}

function rewritePostcssWorkds(path) {
  const contents = readFileSync(path, "utf8").replace(
    "path.resolve('../design-system/src/breakpoints.css')",
    "path.resolve(__dirname, 'breakpoints.css')",
  );
  writeFileSync(path, contents);
}
