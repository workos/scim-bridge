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
import { inert } from '../helpers/inert.js';
import type { MarginProps } from '../props/margin.props.js';
import { marginPropDefs } from '../props/margin.props.js';
import type { GetPropDefTypes } from '../props/prop-def.js';
import { skeletonPropDefs } from './skeleton.props.js';

type SkeletonElement = React.ElementRef<'span'>;
type SkeletonOwnProps = GetPropDefTypes<typeof skeletonPropDefs>;
interface SkeletonProps
  extends
    ComponentPropsWithout<'span', RemovedProps>,
    MarginProps,
    SkeletonOwnProps {}
const Skeleton = React.forwardRef<SkeletonElement, SkeletonProps>(
  (props, forwardedRef) => {
    const { children, className, loading, ...skeletonProps } = extractProps(
      props,
      skeletonPropDefs,
      marginPropDefs,
    );

    if (!loading) {
      return children;
    }

    const Tag = React.isValidElement(children) ? Slot.Root : 'span';

    return (
      <Tag
        ref={forwardedRef}
        aria-hidden
        className={classNames('rt-Skeleton', className)}
        data-inline-skeleton={React.isValidElement(children) ? undefined : true}
        tabIndex={-1}
        inert={inert}
        {...skeletonProps}
      >
        {children}
      </Tag>
    );
  },
);
Skeleton.displayName = 'Skeleton';

export { Skeleton };
export type { SkeletonProps };
