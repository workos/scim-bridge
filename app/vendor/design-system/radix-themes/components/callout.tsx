// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';
import classNames from 'classnames';
import { Slot } from 'radix-ui';
import * as React from 'react';
import type {
  ComponentPropsAs,
  ComponentPropsWithout,
  RemovedProps,
} from '../helpers/component-props.js';
import { extractProps } from '../helpers/extract-props.js';
import {
  mapCalloutSizeToTextSize,
  mapResponsiveProp,
} from '../helpers/map-prop-values.js';
import type { MarginProps } from '../props/margin.props.js';
import { marginPropDefs } from '../props/margin.props.js';
import type { GetPropDefTypes } from '../props/prop-def.js';
import { calloutRootPropDefs } from './callout.props.js';
import { Text } from './text.js';

type CalloutRootOwnProps = GetPropDefTypes<typeof calloutRootPropDefs>;

type CalloutContextValue = { size?: CalloutRootOwnProps['size'] };
const CalloutContext = React.createContext<CalloutContextValue>({});

type CalloutRootElement = React.ElementRef<'div'>;
interface CalloutRootProps
  extends
    ComponentPropsWithout<'div', RemovedProps>,
    MarginProps,
    CalloutRootOwnProps {}
const CalloutRoot = React.forwardRef<CalloutRootElement, CalloutRootProps>(
  (props, forwardedRef) => {
    const { size = calloutRootPropDefs.size.default } = props;
    const { asChild, children, className, color, ...rootProps } = extractProps(
      props,
      calloutRootPropDefs,
      marginPropDefs,
    );
    const Comp = asChild ? Slot.Root : 'div';
    return (
      <Comp
        data-accent-color={color}
        {...rootProps}
        className={classNames('rt-CalloutRoot', className)}
        ref={forwardedRef}
      >
        <CalloutContext.Provider
          value={React.useMemo(() => ({ size }), [size])}
        >
          {children}
        </CalloutContext.Provider>
      </Comp>
    );
  },
);
CalloutRoot.displayName = 'Callout.Root';

type CalloutIconElement = React.ElementRef<'div'>;
interface CalloutIconProps extends ComponentPropsWithout<'div', RemovedProps> {}
const CalloutIcon = React.forwardRef<CalloutIconElement, CalloutIconProps>(
  ({ className, ...props }, forwardedRef) => (
    <div
      {...props}
      className={classNames('rt-CalloutIcon', className)}
      ref={forwardedRef}
    />
  ),
);
CalloutIcon.displayName = 'Callout.Icon';

type CalloutTextElement = React.ElementRef<'p'>;
type CalloutTextProps = ComponentPropsAs<typeof Text, 'p'>;
const CalloutText = React.forwardRef<CalloutTextElement, CalloutTextProps>(
  ({ className, ...props }, forwardedRef) => {
    const { size } = React.useContext(CalloutContext);
    return (
      <Text
        as="p"
        size={mapResponsiveProp(size, mapCalloutSizeToTextSize)}
        {...props}
        asChild={false}
        ref={forwardedRef}
        className={classNames('rt-CalloutText', className)}
      />
    );
  },
);
CalloutText.displayName = 'Callout.Text';

export { CalloutIcon as Icon, CalloutRoot as Root, CalloutText as Text };
export type {
  CalloutIconProps as IconProps,
  CalloutRootProps as RootProps,
  CalloutTextProps as TextProps,
};
