// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';
import type { MarginProps } from '../props.js';
import { Badge as ThemesBadge } from '../radix-themes/components/badge.js';

type ThemesBadgeProps = React.ComponentPropsWithoutRef<typeof ThemesBadge>;

interface BadgeCommonProps {
  size?: ThemesBadgeProps['size'];
}

interface BadgeLowContrastProps {
  color?: 'white';
  lowContrast: true;
}

interface BadgeColoredProps {
  color?: 'white' | 'gray' | 'purple' | 'blue' | 'green' | 'yellow' | 'red';
  lowContrast?: false;
}

type BadgeOwnProps = BadgeCommonProps &
  (BadgeLowContrastProps | BadgeColoredProps);

type BadgeProps = Omit<
  ThemesBadgeProps,
  'color' | 'highContrast' | 'radius' | 'variant'
> &
  BadgeOwnProps &
  MarginProps;

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ color = 'white', lowContrast = false, ...props }, forwardedRef) => (
    <ThemesBadge
      ref={forwardedRef}
      color={color === 'white' ? 'gray' : color}
      data-low-contrast={lowContrast || undefined}
      radius="full"
      variant={color === 'white' ? 'surface' : 'soft'}
      {...props}
    />
  ),
);

Badge.displayName = 'Badge';

export { Badge };
export type { BadgeProps };
