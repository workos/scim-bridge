// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
'use client';

import { ExclamationCircledIcon } from '@radix-ui/react-icons';
import * as React from 'react';
import { isReactFragment } from '../helpers/is-react-fragment.js';
import { ReadOnlyProvider, useReadOnly } from '../helpers/read-only-context.js';
import * as ThemesDialog from '../radix-themes/components/dialog.js';
import type { MarginProps } from '../radix-themes/props/margin.props.js';
import { Box } from './box.js';
import { Button } from './button.js';
import { Callout } from './callout.js';
import { Flex } from './flex.js';
import { Inset } from './inset.js';
import { ButtonLike } from './internal/button-like.js';
import * as ScrollArea from './scroll-area.js';

const WIDTH_MAPPING = {
  '1': 'min(440px, calc(100vw - 2rem))',
  '2': 'min(540px, calc(100vw - 2rem))',
  '3': 'min(600px, calc(100vw - 2rem))',
  '4': 'min(680px, calc(100vw - 2rem))',
  '5': 'min(780px, calc(100vw - 2rem))',
  '6': 'min(900px, calc(100vw - 2rem))',
} as const;

type ThemesDialogContentProps = React.ComponentPropsWithoutRef<
  typeof ThemesDialog.Content
>;
interface DialogContentProps extends Omit<ThemesDialogContentProps, 'size'> {
  readOnly?: boolean;
  size?: keyof typeof WIDTH_MAPPING;
}

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof ThemesDialog.Content>,
  DialogContentProps
>(({ size = '3', readOnly = false, children, ...props }, forwardedRef) => {
  const width = WIDTH_MAPPING[size];

  return (
    <ThemesDialog.Content
      ref={forwardedRef}
      maxWidth="none"
      width={width}
      {...props}
    >
      <ReadOnlyProvider value={readOnly}>
        {readOnly ? (
          // A disabled <fieldset> neutralizes every form control in its
          // subtree, whether or not the dialog uses the standardized
          // Body/Footer layout. Dialogs that render their own action rows
          // keep them, disabled like the rest of the content.
          <fieldset className="DialogReadOnlyFieldset" disabled>
            {children}
          </fieldset>
        ) : (
          children
        )}
      </ReadOnlyProvider>
    </ThemesDialog.Content>
  );
});

DialogContent.displayName = 'Dialog.Content';

type DialogTitleProps = React.ComponentPropsWithoutRef<
  typeof ThemesDialog.Title
>;

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof ThemesDialog.Title>,
  DialogTitleProps
>((props, forwardedRef) => (
  <ThemesDialog.Title ref={forwardedRef} size="4" trim="start" {...props} />
));

DialogTitle.displayName = 'Dialog.Title';

type DialogDescriptionProps = React.ComponentPropsWithoutRef<
  typeof ThemesDialog.Description
>;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof ThemesDialog.Description>,
  DialogDescriptionProps
>((props, forwardedRef) => (
  <ThemesDialog.Description
    ref={forwardedRef}
    color="gray"
    size="2"
    trim="both"
    {...props}
  />
));

DialogDescription.displayName = 'Dialog.Description';

type DialogBodyProps = React.ComponentPropsWithoutRef<
  typeof ScrollArea.Viewport
> & {
  /**
   * Whether the body should be scrollable. If set to `false`, the body will not
   * render a scroll area, so it's important to only use this when the body
   * renders a component that handles overflow on its own. Otherwise the body
   * contents will be hidden from view.
   */
  scrollable?: boolean;
};

const DialogBody = React.forwardRef<
  React.ComponentRef<typeof ScrollArea.Viewport>,
  DialogBodyProps
>(
  (
    { children, scrollable = true, indicators = 'all', nonce, ...props },
    forwardedRef,
  ) => {
    if (scrollable) {
      return (
        <Inset className="DialogBody" side="x">
          <ScrollArea.Root>
            <ScrollArea.Viewport
              ref={forwardedRef}
              indicators={indicators}
              nonce={nonce}
              {...props}
            >
              <Box className="DialogBodyContent">{children}</Box>
            </ScrollArea.Viewport>

            <ScrollArea.Scrollbar orientation="horizontal" />
            <ScrollArea.Scrollbar orientation="vertical" />
          </ScrollArea.Root>
        </Inset>
      );
    }

    return (
      <Inset className="DialogBody" side="x">
        <Box
          className="DialogBodyContent"
          height="100%"
          ref={forwardedRef}
          {...props}
        >
          {children}
        </Box>
      </Inset>
    );
  },
);

DialogBody.displayName = 'Dialog.Body';

interface DialogFooterProps extends MarginProps {
  children?: React.ReactNode;
}

const DialogFooter = React.forwardRef<
  React.ComponentRef<typeof Flex>,
  DialogFooterProps
>(({ children, ...props }, forwardedRef) => {
  const readOnly = useReadOnly();

  return (
    <Flex
      ref={forwardedRef}
      align="center"
      className="DialogFooter"
      gap="3"
      justify="end"
      {...props}
    >
      {readOnly ? (
        // The footer sits inside Content's disabled fieldset, which would
        // disable a native <button>. ButtonLike renders an accessible
        // <span role="button"> instead — like copy buttons, it isn't a form
        // control, so the fieldset leaves it interactive.
        <ThemesDialog.Close>
          <Button asChild type={null}>
            <ButtonLike>Close</ButtonLike>
          </Button>
        </ThemesDialog.Close>
      ) : (
        children
      )}
    </Flex>
  );
});

DialogFooter.displayName = 'Dialog.Footer';

interface DialogHeaderProps extends MarginProps {
  children?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
}

const DialogHeader = React.forwardRef<
  React.ComponentRef<typeof Flex>,
  DialogHeaderProps
>(({ children, title, description, error, ...props }, forwardedRef) => (
  <Flex
    ref={forwardedRef}
    className="DialogHeader"
    direction="column"
    gap="5"
    {...props}
  >
    {title && (
      <ThemesDialog.Title mb="0" size="4" trim="start">
        {title}
      </ThemesDialog.Title>
    )}
    {(() => {
      if (!description) {
        return null;
      }

      if (typeof description === 'string' || isReactFragment(description)) {
        return <DialogDescription mt="-3">{description}</DialogDescription>;
      }

      return (
        <Flex direction="column" gap="4" mt="-3">
          {description}
        </Flex>
      );
    })()}

    {error && (
      <Callout.Root color="red">
        <Callout.Icon>
          <ExclamationCircledIcon />
        </Callout.Icon>
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    )}

    {children}
  </Flex>
));

DialogHeader.displayName = 'Dialog.Header';

type DialogCloseProps = React.ComponentPropsWithoutRef<
  typeof ThemesDialog.Close
>;

const DialogClose = React.forwardRef<
  React.ComponentRef<typeof ThemesDialog.Close>,
  DialogCloseProps
>(({ children, ...props }, forwardedRef) => {
  const readOnly = useReadOnly();

  // In a read-only dialog everything sits inside Content's disabled fieldset,
  // which would disable close/cancel buttons too — but dismissing must stay
  // possible. Re-render the wrapped button as an accessible span (ButtonLike),
  // which isn't a form control, so the fieldset leaves it interactive.
  if (
    readOnly &&
    React.isValidElement<{
      asChild?: boolean;
      type?: 'button' | 'submit' | 'reset' | null;
      children?: React.ReactNode;
    }>(children)
  ) {
    return (
      <ThemesDialog.Close {...props} ref={forwardedRef}>
        {React.cloneElement(
          children,
          { asChild: true, type: null },
          <ButtonLike>{children.props.children}</ButtonLike>,
        )}
      </ThemesDialog.Close>
    );
  }

  return (
    <ThemesDialog.Close {...props} ref={forwardedRef}>
      {children}
    </ThemesDialog.Close>
  );
});

DialogClose.displayName = 'Dialog.Close';

export const Root = ThemesDialog.Root;
export const Trigger = ThemesDialog.Trigger;
export const Close = DialogClose;
export {
  DialogBody as Body,
  DialogContent as Content,
  DialogDescription as Description,
  DialogFooter as Footer,
  DialogHeader as Header,
  DialogTitle as Title,
};
