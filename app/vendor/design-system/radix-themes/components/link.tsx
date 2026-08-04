// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import classNames from 'classnames';
import * as React from 'react';
import type {
  ComponentPropsWithout,
  RemovedProps,
} from '../helpers/component-props.js';
import { extractProps } from '../helpers/extract-props.js';
import type { MarginProps } from '../props/margin.props.js';
import type { GetPropDefTypes } from '../props/prop-def.js';
import { linkPropDefs } from './link.props.js';
import { Text } from './text.js';

type LinkElement = React.ElementRef<'a'>;
type LinkOwnProps = GetPropDefTypes<typeof linkPropDefs>;
interface LinkProps
  extends ComponentPropsWithout<'a', RemovedProps>, MarginProps, LinkOwnProps {}
const Link = React.forwardRef<LinkElement, LinkProps>((props, forwardedRef) => {
  const { children, className, color, asChild, ...linkProps } = extractProps(
    props,
    linkPropDefs,
  );
  return (
    <Text
      {...linkProps}
      data-accent-color={color}
      ref={forwardedRef}
      asChild
      className={classNames('rt-reset', 'rt-Link', className)}
    >
      {asChild ? children : <a>{children}</a>}
    </Text>
  );
});
Link.displayName = 'Link';

export { Link };
export type { LinkProps };
