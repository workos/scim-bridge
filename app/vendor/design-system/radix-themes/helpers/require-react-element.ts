// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';
import { isLazy, isMemo } from 'react-is';

const REACT_LAZY_TYPE = Symbol.for('react.lazy');

/**
 * Detects a raw lazy chunk produced by React Server Components' Flight encoder
 * for an unresolved Client Reference: `{ $$typeof: react.lazy, _payload, _init }`.
 *
 * `react-is`'s `isLazy()` does not recognise this shape: it only matches lazy
 * types when they appear as the `.type` field of a `react.element`. The raw
 * chunk shape is produced by `react-server-dom-webpack`'s `createLazyChunkWrapper`
 * and flows into design-system trigger components when a `'use client'`
 * boundary is crossed from a Server Component.
 */
const isRawLazyChunk = (
  value: unknown,
): value is {
  $$typeof: symbol;
  _payload: { _status: number; _result: unknown };
  _init: (payload: { _status: number; _result: unknown }) => unknown;
} => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('$$typeof' in value) || value.$$typeof !== REACT_LAZY_TYPE) {
    return false;
  }
  if (!('_payload' in value) || !('_init' in value)) {
    return false;
  }
  return typeof value._init === 'function';
};

/** A function that throws an error when a value isn't a valid React Element, otherwise returns the value */
export const requireReactElement = (
  children: React.ReactNode,
): React.ReactNode => {
  if (React.isValidElement(children)) {
    return children;
  }

  // React 19's RSC Flight encoder serialises an unresolved Client Reference
  // as a raw lazy chunk wrapping the underlying element. `React.isValidElement`
  // returns false on this shape, and `react-is`'s `isLazy` / `isMemo` do not
  // match it either. Attempt to unwrap via `_init`; if the chunk is fulfilled
  // the underlying element is returned and we re-validate, so the consuming
  // Radix primitive (which calls `React.Children.only` / `Slot.Root`) sees a
  // single valid element instead of throwing.
  if (isRawLazyChunk(children)) {
    try {
      const resolved = children._init(children._payload);
      if (React.isValidElement(resolved)) {
        return resolved;
      }
    } catch (err) {
      // For a pending Flight chunk, `_init` throws a thenable as React's
      // Suspense suspend signal. Re-throw it so Suspense can resume rendering
      // once the chunk resolves; only swallow synchronous Error instances
      // (rejected chunks, malformed payloads) and fall through to the
      // existing error path.
      if (!(err instanceof Error)) {
        throw err;
      }
    }
  }

  // React lazy elements (produced by React.lazy() and resolved by Suspense)
  // and memo elements use different internal symbols that React.isValidElement
  // does not recognise, but they resolve correctly during rendering.
  if (isLazy(children) || isMemo(children)) {
    return children;
  }

  throw Error(
    `Expected a single React Element child, but got: ${React.Children.toArray(
      children,
    )
      .map((child) =>
        typeof child === 'object' &&
        'type' in child &&
        typeof child.type === 'string'
          ? child.type
          : typeof child,
      )
      .join(', ')}`,
  );
};
