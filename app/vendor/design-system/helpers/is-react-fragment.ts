// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';

export const isReactFragment = (
  element: React.ReactNode,
): element is React.ReactElement<
  { children?: React.ReactNode },
  typeof React.Fragment
> => React.isValidElement(element) && element.type === React.Fragment;
