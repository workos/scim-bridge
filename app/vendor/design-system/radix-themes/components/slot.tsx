// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import { Slot as SlotPrimitive } from 'radix-ui';
import * as React from 'react';

interface SlottableComponent extends React.FC<{
  children: React.ReactNode;
}> {
  __radixId: symbol;
}

export const Root = SlotPrimitive.Root;
export const Slot = SlotPrimitive.Slot;
export const Slottable: SlottableComponent = SlotPrimitive.Slottable;
