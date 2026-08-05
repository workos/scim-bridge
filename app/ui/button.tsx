import * as React from "react";
import { Button as ThemesButton } from "@radix-ui/themes";

type ThemesButtonProps = React.ComponentPropsWithoutRef<typeof ThemesButton>;

/**
 * A Radix button with the two behaviours the panel relies on.
 *
 * **`type` defaults to `"button"`.** This is load-bearing, not cosmetic: a bare
 * `<button>` inside a `<form>` submits it, so every `<Button onClick={…}>` the
 * panel renders inside a form — copy buttons, mode pickers, dialog triggers —
 * would submit that form if the attribute were left to the browser. The vendored
 * component defaulted it and the call sites were written against that. Passing
 * `type={null}` opts out, which is what an `asChild` anchor needs so that no
 * `type` attribute lands on the `<a>`.
 *
 * **`ghost`** is the panel's shorthand for `variant="ghost"`, kept because eight
 * call sites use it and it reads better than the variant beside `size="1"`.
 *
 * `loading` needs no help — Radix has it natively, including the spinner and
 * force-disabling. The vendored component instead set `aria-disabled` and
 * swallowed the click, keeping disabled buttons focusable; this uses the real
 * `disabled` attribute, which is the standard behaviour and one less bespoke rule.
 */
interface ButtonProps extends Omit<ThemesButtonProps, "type"> {
  /** Render with no background or border. Shorthand for `variant="ghost"`. */
  ghost?: boolean;
  /** `null` omits the attribute entirely — for `asChild` anchors. */
  type?: "button" | "submit" | "reset" | null;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ ghost = false, color = "gray", variant, type = "button", ...props }, forwardedRef) => (
    <ThemesButton
      ref={forwardedRef}
      color={color}
      // The neutral surface button the panel was designed around, rather than
      // Radix's default heavy `solid` accent.
      variant={ghost ? "ghost" : (variant ?? "surface")}
      highContrast={!ghost && color === "gray"}
      type={type === null ? undefined : type}
      {...props}
    />
  ),
);

Button.displayName = "Button";

export { Button };
export type { ButtonProps };
