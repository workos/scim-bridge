// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
// Userland implementation of React's `useEffectEvent`
// https://react.dev/reference/react/useEffectEvent
// https://react.dev/learn/separating-events-from-effects
// https://react.dev/learn/separating-events-from-effects#declaring-an-effect-event
import * as React from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEffectEvent<T extends (...args: any[]) => void>(
  callback: T,
) {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const savedCallback = React.useRef<T>((() => {
    throw new Error('Do not call an effect event while rendering.');
  }) as unknown as T);

  React.useInsertionEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return React.useCallback(
    (...args: Parameters<T>) => savedCallback.current(...args),
    [],
  ) as T;
}
