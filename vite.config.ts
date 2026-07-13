import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Several vendored WorkDS components value-import type-only names from
// modules that only re-export @radix-ui/themes JS at runtime (e.g.
// `import { MarginProps } from "../props.js"`). tsc and production builds
// erase these, but Vite dev's strict ESM rejects the missing named exports.
// Appending no-op runtime bindings keeps the vendored sources unedited.
const WORKDS_TYPE_SHIMS: Record<string, string[]> = {
  "vendor/design-system/props.ts": ["MarginProps", "GetPropDefTypes", "PropDef"],
  "vendor/design-system/helpers/themes.ts": ["ComponentPropsWithout", "RemovedProps"],
  "vendor/design-system/helpers/as.ts": ["As"],
  "vendor/design-system/helpers/date-picker-helpers.ts": ["ComposedDate"],
};

// Same problem, other direction: vendored files that value-import type-only
// names straight from third-party or pre-bundled dist modules, where the
// export can't be shimmed in (and the barrel `index.ts` drags these in even
// for unused recipes like the CodeEditor). Strip the type-only names from
// those import clauses; if a clause empties out, drop the whole statement.
const WORKDS_TYPE_NAME_STRIPS: Record<string, string[]> = {
  "vendor/design-system/components/list-cell.tsx": ["FlexProps"],
  "vendor/design-system/recipes/CodeEditor/code-editor-context.tsx": [
    "Diagnostic",
    "BasicSetupOptions",
    "Extension",
    "UseCodeMirror",
  ],
  "vendor/design-system/recipes/CodeEditor/css-autocomplete.tsx": ["Completion", "Extension"],
  "vendor/design-system/helpers/code-editor-theme.ts": ["Extension"],
};

const IMPORT_CLAUSE = /import\s*\{([\s\S]*?)\}\s*from\s*(["'][^"']+["'])\s*;?/g;

function stripImportNames(code: string, names: string[]): string {
  const drop = new Set(names);
  return code.replace(IMPORT_CLAUSE, (match, clause: string, source: string) => {
    const kept = clause
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !drop.has(part.split(/\s+as\s+/)[0].trim()));
    if (kept.length === clause.split(",").filter((p) => p.trim() !== "").length) return match;
    return kept.length === 0 ? "" : `import { ${kept.join(", ")} } from ${source};`;
  });
}

function workdsTypeExportShim(): Plugin {
  return {
    name: "workds-type-export-shim",
    transform(code, id) {
      const path = id.split("?")[0];
      for (const [suffix, names] of Object.entries(WORKDS_TYPE_SHIMS)) {
        if (path.endsWith(suffix)) {
          return `${code}\n${names.map((n) => `export var ${n} = undefined;`).join("\n")}\n`;
        }
      }
      for (const [suffix, names] of Object.entries(WORKDS_TYPE_NAME_STRIPS)) {
        if (path.endsWith(suffix)) {
          return stripImportNames(code, names);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), workdsTypeExportShim()],
});
