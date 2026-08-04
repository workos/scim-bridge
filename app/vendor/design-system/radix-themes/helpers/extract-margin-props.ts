// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { MarginProps } from '../props/margin.props.js';

export function extractMarginProps<T extends MarginProps>(props: T) {
  const { m, mx, my, mt, mr, mb, ml, ...rest } = props;
  return { m, mx, my, mt, mr, mb, ml, rest };
}
