// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import classNames from 'classnames';
import { Slot } from 'radix-ui';
import * as React from 'react';
import type {
  ComponentPropsWithout,
  RemovedProps,
} from '../helpers/component-props.js';
import { requireReactElement } from '../helpers/require-react-element.js';

interface ResetProps extends ComponentPropsWithout<
  typeof Slot.Root,
  RemovedProps
> {}
const Reset = React.forwardRef<HTMLElement, ResetProps>(
  ({ className, children, ...props }, forwardedRef) => (
    <Slot.Root
      {...props}
      ref={forwardedRef}
      className={classNames('rt-reset', className)}
    >
      {requireReactElement(children)}
    </Slot.Root>
  ),
);
Reset.displayName = 'Reset';

export { Reset };
export type { ResetProps };
