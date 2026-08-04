// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';

import * as React from 'react';

/**
 * Tracks whether the surrounding surface (e.g. a read-only `Dialog`) has placed
 * its descendants in a non-editable state. Defaults to `false` so components
 * that consume it work normally when rendered outside of a read-only surface.
 *
 * Read-only dialogs wrap their body in a `<fieldset disabled>`, which natively
 * disables descendant form controls. Interactive elements that should keep
 * working (such as copy buttons) read this context and render as non-form
 * elements so the disabled fieldset leaves them alone.
 */
const ReadOnlyContext = React.createContext(false);

export const ReadOnlyProvider = ReadOnlyContext.Provider;

export const useReadOnly = (): boolean => React.useContext(ReadOnlyContext);
