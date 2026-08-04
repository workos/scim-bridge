// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';

/**
 * This is a helper function that is used when a component supports `asChild`
 * using the `Slot` component but its implementation contains nested DOM elements.
 *
 * Using it ensures if a consumer uses the `asChild` prop, the elements are in
 * correct order in the DOM, adopting the intended consumer `children`.
 */
export function getSubtree(
  options: { asChild: boolean | undefined; children: React.ReactNode },
  content: React.ReactNode | ((children: React.ReactNode) => React.ReactNode),
) {
  const { asChild, children } = options;
  if (!asChild) {
    return typeof content === 'function' ? content(children) : content;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const firstChild = React.Children.only(children) as React.ReactElement;
  return React.cloneElement(firstChild, {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    children:
      typeof content === 'function'
        ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          content(firstChild.props.children)
        : content,
  });
}
