// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { PropDef } from './prop-def.js';

const weights = ['light', 'regular', 'medium', 'bold'] as const;

const weightPropDef = {
  weight: {
    type: 'enum',
    className: 'rt-r-weight',
    values: weights,
    responsive: true,
  },
} satisfies {
  weight: PropDef<(typeof weights)[number]>;
};

export { weightPropDef };
