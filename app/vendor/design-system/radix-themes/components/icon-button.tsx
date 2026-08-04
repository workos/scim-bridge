// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import classNames from 'classnames';
import * as React from 'react';
import { BaseButton } from './_internal/base-button.js';

type IconButtonElement = React.ElementRef<typeof BaseButton>;
interface IconButtonProps extends React.ComponentPropsWithoutRef<
  typeof BaseButton
> {}
const IconButton = React.forwardRef<IconButtonElement, IconButtonProps>(
  ({ className, ...props }, forwardedRef) => (
    <BaseButton
      {...props}
      ref={forwardedRef}
      className={classNames('rt-IconButton', className)}
    />
  ),
);
IconButton.displayName = 'IconButton';

export { IconButton };
export type { IconButtonProps };
