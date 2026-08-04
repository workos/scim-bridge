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
import { cardPropDefs } from './card.props.js';

type CardElement = React.ElementRef<'div'>;
type CardOwnProps = GetPropDefTypes<typeof cardPropDefs>;
interface CardProps
  extends
    ComponentPropsWithout<'div', RemovedProps>,
    MarginProps,
    CardOwnProps {}
const Card = React.forwardRef<CardElement, CardProps>((props, forwardedRef) => {
  const { asChild, className, ...cardProps } = extractProps(
    props,
    cardPropDefs,
    marginPropDefs,
  );
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      ref={forwardedRef}
      {...cardProps}
      className={classNames('rt-reset', 'rt-BaseCard', 'rt-Card', className)}
    />
  );
});
Card.displayName = 'Card';

export { Card };
export type { CardProps };
