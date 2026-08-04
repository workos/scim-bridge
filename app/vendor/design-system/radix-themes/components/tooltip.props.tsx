// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { GetPropDefTypes, PropDef } from '../props/prop-def.js';
import { widthPropDefs } from '../props/width.props.js';

const tooltipPropDefs = {
  content: { type: 'ReactNode', required: true },
  width: widthPropDefs.width,
  minWidth: widthPropDefs.minWidth,
  maxWidth: { ...widthPropDefs.maxWidth, default: '360px' },
} satisfies {
  width: PropDef<string>;
  minWidth: PropDef<string>;
  maxWidth: PropDef<string>;
  content: PropDef<React.ReactNode>;
};

type TooltipOwnProps = GetPropDefTypes<
  typeof tooltipPropDefs & typeof widthPropDefs
>;

export { tooltipPropDefs };
export type { TooltipOwnProps };
