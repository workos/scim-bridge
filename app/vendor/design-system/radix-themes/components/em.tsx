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
import { emPropDefs } from './em.props.js';

type EmElement = React.ElementRef<'em'>;
type EmOwnProps = GetPropDefTypes<typeof emPropDefs>;
interface EmProps
  extends ComponentPropsWithout<'em', RemovedProps>, EmOwnProps {}
const Em = React.forwardRef<EmElement, EmProps>((props, forwardedRef) => {
  const { asChild, className, ...emProps } = extractProps(props, emPropDefs);
  const Comp = asChild ? Slot.Root : 'em';
  return (
    <Comp
      {...emProps}
      ref={forwardedRef}
      className={classNames('rt-Em', className)}
    />
  );
});
Em.displayName = 'Em';

export { Em };
export type { EmProps };
