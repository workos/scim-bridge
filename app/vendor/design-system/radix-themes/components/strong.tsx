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
import { strongPropDefs } from './strong.props.js';

type StrongElement = React.ElementRef<'strong'>;
type StrongOwnProps = GetPropDefTypes<typeof strongPropDefs>;
interface StrongProps
  extends ComponentPropsWithout<'strong', RemovedProps>, StrongOwnProps {}
const Strong = React.forwardRef<StrongElement, StrongProps>(
  (props, forwardedRef) => {
    const { asChild, className, ...strongProps } = extractProps(
      props,
      strongPropDefs,
    );
    const Comp = asChild ? Slot.Root : 'strong';
    return (
      <Comp
        {...strongProps}
        ref={forwardedRef}
        className={classNames('rt-Strong', className)}
      />
    );
  },
);
Strong.displayName = 'Strong';

export { Strong };
export type { StrongProps };
