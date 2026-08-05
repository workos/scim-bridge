import * as React from "react";
import { Callout, Dialog as ThemesDialog, Flex } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

/**
 * Radix's `Dialog`, plus the `Header`/`Body`/`Footer` layout the panel's dialogs
 * are written against. `Root`, `Trigger` and `Close` are re-exported untouched —
 * Radix already hardcodes `asChild` on the trigger and close, so a `<Button>`
 * child works exactly as it did before.
 */
export const Root = ThemesDialog.Root;
export const Trigger = ThemesDialog.Trigger;
export const Close = ThemesDialog.Close;

/**
 * Careful: `size` here is a *width*, which is what the vendored component meant
 * by it and what the call sites pass (up to `"5"`). Radix's own `size` on
 * `Dialog.Content` is a padding scale capped at `"4"`, so forwarding it would be
 * both a type error and the wrong axis. Translated to `maxWidth` instead, with
 * the vendored widths preserved so no dialog changes size in this migration.
 */
const WIDTHS = {
  "1": "440px",
  "2": "540px",
  "3": "600px",
  "4": "680px",
  "5": "780px",
  "6": "900px",
} as const;

type ThemesContentProps = React.ComponentPropsWithoutRef<typeof ThemesDialog.Content>;

interface DialogContentProps extends Omit<ThemesContentProps, "size"> {
  size?: keyof typeof WIDTHS;
}

const Content = React.forwardRef<
  React.ComponentRef<typeof ThemesDialog.Content>,
  DialogContentProps
>(({ size = "3", ...props }, forwardedRef) => (
  <ThemesDialog.Content ref={forwardedRef} maxWidth={WIDTHS[size]} {...props} />
));

Content.displayName = "Dialog.Content";

interface DialogHeaderProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Rendered as a red callout under the description — form submission errors. */
  error?: React.ReactNode;
  children?: React.ReactNode;
}

const Header: React.FC<DialogHeaderProps> = ({ title, description, error, children }) => (
  <Flex direction="column" gap="3" mb="4">
    {title ? <ThemesDialog.Title mb="0">{title}</ThemesDialog.Title> : null}
    {description ? (
      <ThemesDialog.Description size="2">{description}</ThemesDialog.Description>
    ) : null}
    {error ? (
      <Callout.Root color="red" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    ) : null}
    {children}
  </Flex>
);

Header.displayName = "Dialog.Header";

/**
 * The scrolling middle of a tall dialog. The vendored version built this out of a
 * custom scroll-area with scroll-shadow indicators; a max-height plus
 * `overflow: auto` is the same affordance without the machinery.
 */
const Body: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <div style={{ maxHeight: "60vh", overflow: "auto" }}>{children}</div>
);

Body.displayName = "Dialog.Body";

const Footer: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <Flex align="center" gap="3" justify="end" mt="4">
    {children}
  </Flex>
);

Footer.displayName = "Dialog.Footer";

export { Body, Content, Footer, Header };
