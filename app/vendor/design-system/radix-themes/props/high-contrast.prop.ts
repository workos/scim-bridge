// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { PropDef } from './prop-def.js';

const highContrastPropDef = {
  highContrast: {
    type: 'boolean',
    className: 'rt-high-contrast',
    default: undefined,
  },
} satisfies {
  highContrast: PropDef<boolean>;
};

export { highContrastPropDef };
