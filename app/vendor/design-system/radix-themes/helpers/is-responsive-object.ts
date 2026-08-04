// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { Breakpoint, Responsive } from '../props/prop-def.js';
import { breakpoints } from '../props/prop-def.js';

export function isResponsiveObject<Value extends string>(
  obj: Responsive<Value | Omit<string, Value>> | undefined,
): obj is Record<Breakpoint, string> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    Object.keys(obj).some((key) => breakpoints.has(key as Breakpoint))
  );
}
