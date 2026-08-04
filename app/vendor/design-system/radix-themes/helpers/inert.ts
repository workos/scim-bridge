// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';

// "inert" works differently between React versions
// https://github.com/facebook/react/pull/24730
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const inert = (Number.parseFloat(React.version) >= 19 ||
  '') as React.HTMLAttributes<unknown>['inert'];
