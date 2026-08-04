// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';

import { composeRefs } from 'radix-ui/internal';
import * as React from 'react';
import { Chip } from '../components/chip.js';
import { Tooltip } from '../components/tooltip.js';
import { useReadOnly } from '../helpers/read-only-context.js';

type CopyChipProps = Omit<
  React.ComponentPropsWithoutRef<typeof Chip>,
  'as' | 'onClick'
> & {
  // Widened to `HTMLElement` because in read-only mode the chip renders as a
  // `<span>` rather than a `<button>`.
  onClick?: React.MouseEventHandler<HTMLElement>;
};

// The instance type is `HTMLElement` (not `HTMLButtonElement`) because in
// read-only mode the chip renders as a `<span>` rather than a `<button>`.
export const CopyChip = React.forwardRef<HTMLElement, CopyChipProps>(
  ({ children, onClick, ...props }, forwardedRef) => {
    const chipRef = React.useRef<HTMLElement>(null);

    // Inside a read-only dialog the body is wrapped in a `<fieldset disabled>`,
    // which disables descendant `<button>`s. Rendering the chip as a
    // `<span role="button">` keeps it interactive, since the disabled fieldset
    // only affects form controls.
    const readOnly = useReadOnly();

    const [state, setState] = React.useReducer(
      (prevState, newState) => {
        // Start a timeout to change the text when tooltip is closed
        if (newState.open === false) {
          newState.timeout = setTimeout(() => {
            setState({
              text: 'Click to copy',
              timeout: null,
            });
          }, 1000);
        }

        // Clear a previous timeout when tooltip state changes
        if (prevState.timeout) {
          clearTimeout(prevState.timeout);
          prevState.timeout = null;
        }

        return { ...prevState, ...newState };
      },
      {
        open: false,
        text: 'Click to copy',
        timeout: null,
      },
    );

    const copy = (originalDefaultPrevented: boolean) => {
      const text = chipRef.current?.textContent;

      if (text) {
        setState({
          open: true,
          text: 'Copied',
        });

        if (!originalDefaultPrevented) {
          void navigator.clipboard.writeText(text);
        }
      }
    };

    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      onClick?.(event);
      const originalDefaultPrevented = event.defaultPrevented;

      // Prevent tooltip closing on click
      event.preventDefault();
      copy(originalDefaultPrevented);
    };

    return (
      <Tooltip
        content={state.text}
        open={state.open}
        onOpenChange={(open) => setState({ open })}
        onPointerDownOutside={(event) => {
          // Prevent tooltip closing on click
          // Introducing lint rule banning type assertions
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          const target = event.target as HTMLElement;
          if (chipRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
      >
        {readOnly ? (
          <Chip
            {...props}
            ref={composeRefs(chipRef, forwardedRef)}
            as="span"
            role="button"
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
          >
            {children}
          </Chip>
        ) : (
          <Chip
            {...props}
            ref={composeRefs(chipRef, forwardedRef)}
            as="button"
            onClick={handleClick}
          >
            {children}
          </Chip>
        )}
      </Tooltip>
    );
  },
);

CopyChip.displayName = 'CopyChip';
