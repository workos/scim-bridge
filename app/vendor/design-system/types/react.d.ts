// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
// The import is needed
import "react";

declare module "react" {
  interface CSSProperties {
    [varName: `--${string}`]: string | number | undefined | null;
  }
}
