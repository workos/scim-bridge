// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import type { PropDef } from './prop-def.js';

const asChildPropDef = {
  /**
   * Composes the component into its immediate child instead of rendering its own HTML element.
   * You’ll have to provide a single React Element child.
   */
  asChild: {
    type: 'boolean',
  },
} satisfies {
  asChild: PropDef<boolean>;
};

export { asChildPropDef };
