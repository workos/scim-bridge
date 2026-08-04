// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import { asChildPropDef } from '../props/as-child.prop.js';

const tabsRootPropDefs = {
  ...asChildPropDef,
};

const tabsContentPropDefs = {
  ...asChildPropDef,
};

export { baseTabListPropDefs as tabsListPropDefs } from './_internal/base-tab-list.props.js';
export { tabsContentPropDefs, tabsRootPropDefs };
