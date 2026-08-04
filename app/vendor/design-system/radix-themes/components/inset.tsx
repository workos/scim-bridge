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
import { insetPropDefs } from './inset.props.js';

type InsetElement = React.ElementRef<'div'>;
type InsetOwnProps = GetPropDefTypes<typeof insetPropDefs>;
interface InsetProps
  extends
    ComponentPropsWithout<'div', RemovedProps>,
    MarginProps,
    InsetOwnProps {}

const Inset = React.forwardRef<InsetElement, InsetProps>(
  (props, forwardedRef) => {
    const { asChild, className, ...insetProps } = extractProps(
      props,
      insetPropDefs,
      marginPropDefs,
    );
    const Comp = asChild ? Slot.Root : 'div';
    return (
      <Comp
        {...insetProps}
        ref={forwardedRef}
        className={classNames('rt-Inset', className)}
      />
    );
  },
);
Inset.displayName = 'Inset';

export { Inset };
export type { InsetProps };
