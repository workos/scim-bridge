// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';

import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import * as React from 'react';
import { IconButton } from '../components/icon-button.js';
import { Tooltip } from '../components/tooltip.js';
import { useReadOnly } from '../helpers/read-only-context.js';

interface CopyButtonProps extends Omit<
  React.ComponentPropsWithoutRef<typeof IconButton>,
  'children'
> {
  copyLabel?: string;
  height?: number;
  width?: number;
}

export const CopyButton = ({
  onClick,
  copyLabel = 'Copy',
  height = 16,
  width = 16,
  ...props
}: CopyButtonProps) => {
  const [copyTimeout, setCopyTimeout] =
    React.useState<ReturnType<typeof setTimeout>>();
  const [isTooltipForcedOpen, setTooltipForcedOpen] = React.useState<
    true | undefined
  >(undefined);

  // Inside a read-only dialog the body is wrapped in a `<fieldset disabled>`,
  // which disables every descendant `<button>`. Rendering the copy control as a
  // non-form element (a `<span role="button">` via `asChild`) keeps it
  // interactive, since the disabled fieldset only affects form controls.
  const readOnly = useReadOnly();

  const icon = copyTimeout ? (
    <CheckIcon height={height} width={width} />
  ) : (
    <CopyIcon height={height} width={width} />
  );

  return (
    <Tooltip
      content={copyTimeout ? 'Copied' : copyLabel}
      open={isTooltipForcedOpen}
    >
      <IconButton
        asChild={readOnly}
        onClick={(event) => {
          onClick?.(event);

          if (event.defaultPrevented) {
            return;
          }

          if (copyTimeout) {
            clearTimeout(copyTimeout);
          }

          setCopyTimeout(setTimeout(() => setCopyTimeout(undefined), 2000));
          setTooltipForcedOpen(true);
        }}
        onMouseEnter={() => {
          if (copyTimeout) {
            clearTimeout(copyTimeout);
            setCopyTimeout(undefined);
          }
        }}
        onMouseLeave={() => {
          if (isTooltipForcedOpen) {
            setTooltipForcedOpen(undefined);
          }
        }}
        {...props}
      >
        {readOnly ? (
          <span
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
          >
            {icon}
          </span>
        ) : (
          icon
        )}
      </IconButton>
    </Tooltip>
  );
};
