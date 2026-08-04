// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';
import classNames from 'classnames';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { useControllableState } from 'radix-ui/internal';
import * as React from 'react';
import type { ComponentPropsWithout } from '../helpers/component-props.js';
import { extractProps } from '../helpers/extract-props.js';
import type { MarginProps } from '../props/margin.props.js';
import { marginPropDefs } from '../props/margin.props.js';
import type { GetPropDefTypes } from '../props/prop-def.js';
import { checkboxPropDefs } from './checkbox.props.js';
import { ThickCheckIcon, ThickDividerHorizontalIcon } from './icons.js';

type CheckboxElement = React.ElementRef<typeof CheckboxPrimitive.Root>;
type CheckboxOwnProps = GetPropDefTypes<typeof checkboxPropDefs>;
interface CheckboxProps
  extends
    ComponentPropsWithout<
      typeof CheckboxPrimitive.Root,
      'asChild' | 'color' | 'defaultValue' | 'children'
    >,
    MarginProps,
    CheckboxOwnProps {}
const Checkbox = React.forwardRef<CheckboxElement, CheckboxProps>(
  (props, forwardedRef) => {
    const {
      className,
      color,
      checked: checkedProp,
      defaultChecked: defaultCheckedProp,
      onCheckedChange,
      ...checkboxProps
    } = extractProps(props, checkboxPropDefs, marginPropDefs);

    const [checked, setChecked] = useControllableState({
      prop: checkedProp,
      defaultProp: defaultCheckedProp ?? false,
      onChange: onCheckedChange,
    });

    return (
      <CheckboxPrimitive.Root
        data-accent-color={color}
        {...checkboxProps}
        defaultChecked={defaultCheckedProp}
        checked={checked}
        onCheckedChange={setChecked}
        asChild={false}
        ref={forwardedRef}
        className={classNames(
          'rt-reset',
          'rt-BaseCheckboxRoot',
          'rt-CheckboxRoot',
          className,
        )}
      >
        <CheckboxPrimitive.Indicator
          asChild
          className="rt-BaseCheckboxIndicator rt-CheckboxIndicator"
        >
          {checked === 'indeterminate' ? (
            <ThickDividerHorizontalIcon />
          ) : (
            <ThickCheckIcon />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
export type { CheckboxProps };
