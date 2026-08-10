import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The WorkDS type-export shim that used to live here went with the vendored
// design system: ~60 lines of source rewriting, because several
// vendored components value-imported type-only names from modules that only
// re-export @radix-ui/themes JS at runtime, which Vite dev's strict ESM
// rejected. The published @radix-ui/themes package does not have that problem.
export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
});
