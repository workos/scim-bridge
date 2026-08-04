// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import classNames from 'classnames';
import { Slot } from 'radix-ui';
import * as React from 'react';
import type {
  ComponentPropsWithout,
  RemovedProps,
} from '../helpers/component-props.js';
import { extractProps } from '../helpers/extract-props.js';
import type { MarginProps } from '../props/margin.props.js';
import { marginPropDefs } from '../props/margin.props.js';
import type { GetPropDefTypes } from '../props/prop-def.js';
import { badgePropDefs } from './badge.props.js';

type BadgeElement = React.ElementRef<'span'>;
type BadgeOwnProps = GetPropDefTypes<typeof badgePropDefs>;
interface BadgeProps
  extends
    ComponentPropsWithout<'span', RemovedProps>,
    MarginProps,
    BadgeOwnProps {}
const Badge = React.forwardRef<BadgeElement, BadgeProps>(
  (props, forwardedRef) => {
    const { asChild, className, color, radius, ...badgeProps } = extractProps(
      props,
      badgePropDefs,
      marginPropDefs,
    );
    const Comp = asChild ? Slot.Root : 'span';
    return (
      <Comp
        data-accent-color={color}
        data-radius={radius}
        {...badgeProps}
        ref={forwardedRef}
        className={classNames('rt-reset', 'rt-Badge', className)}
      />
    );
  },
);
Badge.displayName = 'Badge';

export { Badge };
export type { BadgeProps };
