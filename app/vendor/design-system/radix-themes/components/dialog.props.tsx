// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import { asChildPropDef } from '../props/as-child.prop.js';
import { heightPropDefs } from '../props/height.props.js';
import type { GetPropDefTypes, PropDef } from '../props/prop-def.js';
import { widthPropDefs } from '../props/width.props.js';

const alignValues = ['start', 'center'] as const;
const contentSizes = ['1', '2', '3', '4'] as const;

const dialogContentPropDefs = {
  ...asChildPropDef,
  align: {
    type: 'enum',
    className: 'rt-r-align',
    values: ['start', 'center'],
    default: 'center',
  },
  size: {
    type: 'enum',
    className: 'rt-r-size',
    values: contentSizes,
    default: '3',
    responsive: true,
  },
  width: widthPropDefs.width,
  minWidth: widthPropDefs.minWidth,
  maxWidth: { ...widthPropDefs.maxWidth, default: '600px' },
  ...heightPropDefs,
} satisfies {
  align: PropDef<(typeof alignValues)[number]>;
  size: PropDef<(typeof contentSizes)[number]>;
  width: PropDef<string>;
  minWidth: PropDef<string>;
  maxWidth: PropDef<string>;
};

type DialogContentOwnProps = GetPropDefTypes<
  typeof dialogContentPropDefs & typeof asChildPropDef & typeof widthPropDefs
>;

export { dialogContentPropDefs };
export type { DialogContentOwnProps };
