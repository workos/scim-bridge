import * as React from "react";
import { AlertDialog as ThemesAlertDialog, Flex } from "@radix-ui/themes";

/**
 * Radix's `AlertDialog`, plus the `Header`/`Footer` layout the panel's confirm
 * dialogs are written against. `Root`, `Trigger`, `Action` and `Cancel` are
 * re-exported untouched: Radix hardcodes `asChild` on all three of the
 * interactive ones, so the `<Button>` children at the call sites keep working.
 */
export const Root = ThemesAlertDialog.Root;
export const Trigger = ThemesAlertDialog.Trigger;
export const Action = ThemesAlertDialog.Action;
export const Cancel = ThemesAlertDialog.Cancel;

/** Widths, not Radix's padding scale — see the note in ./dialog.tsx. */
const WIDTHS = {
  "1": "440px",
  "2": "540px",
  "3": "600px",
  "4": "680px",
} as const;

type ThemesContentProps = React.ComponentPropsWithoutRef<typeof ThemesAlertDialog.Content>;

interface AlertDialogContentProps extends Omit<ThemesContentProps, "size"> {
  size?: keyof typeof WIDTHS;
}

const Content = React.forwardRef<
  React.ComponentRef<typeof ThemesAlertDialog.Content>,
  AlertDialogContentProps
>(({ size = "2", ...props }, forwardedRef) => (
  <ThemesAlertDialog.Content ref={forwardedRef} maxWidth={WIDTHS[size]} {...props} />
));

Content.displayName = "AlertDialog.Content";

interface AlertDialogHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}

const Header: React.FC<AlertDialogHeaderProps> = ({ title, description, children }) => (
  <Flex direction="column" gap="3" mb="4">
    <ThemesAlertDialog.Title mb="0">{title}</ThemesAlertDialog.Title>
    {description ? (
      <ThemesAlertDialog.Description size="2">{description}</ThemesAlertDialog.Description>
    ) : null}
    {children}
  </Flex>
);

Header.displayName = "AlertDialog.Header";

const Footer: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <Flex align="center" gap="3" justify="end" mt="4">
    {children}
  </Flex>
);

Footer.displayName = "AlertDialog.Footer";

export { Content, Footer, Header };
