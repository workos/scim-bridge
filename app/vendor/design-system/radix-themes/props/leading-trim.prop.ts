// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { PropDef } from './prop-def.js';

const leadingTrimValues = ['normal', 'start', 'end', 'both'] as const;

const leadingTrimPropDef = {
  trim: {
    type: 'enum',
    className: 'rt-r-lt',
    values: leadingTrimValues,
    responsive: true,
  },
} satisfies {
  trim: PropDef<(typeof leadingTrimValues)[number]>;
};

export { leadingTrimPropDef };
