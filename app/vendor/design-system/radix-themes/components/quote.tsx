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
import type { GetPropDefTypes } from '../props/prop-def.js';
import { quotePropDefs } from './quote.props.js';

type QuoteElement = React.ElementRef<'q'>;
type QuoteOwnProps = GetPropDefTypes<typeof quotePropDefs>;
interface QuoteProps
  extends ComponentPropsWithout<'q', RemovedProps>, QuoteOwnProps {}
const Quote = React.forwardRef<QuoteElement, QuoteProps>(
  (props, forwardedRef) => {
    const { asChild, className, ...quoteProps } = extractProps(
      props,
      quotePropDefs,
    );
    const Comp = asChild ? Slot.Root : 'q';
    return (
      <Comp
        {...quoteProps}
        ref={forwardedRef}
        className={classNames('rt-Quote', className)}
      />
    );
  },
);
Quote.displayName = 'Quote';

export { Quote };
export type { QuoteProps };
