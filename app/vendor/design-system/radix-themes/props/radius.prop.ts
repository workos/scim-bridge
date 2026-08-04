// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { PropDef } from './prop-def.js';

const radii = ['none', 'small', 'medium', 'large', 'full'] as const;

const radiusPropDef = {
  radius: {
    type: 'enum',
    values: radii,
    default: undefined,
  },
} satisfies {
  radius: PropDef<(typeof radii)[number]>;
};

export { radii, radiusPropDef };
