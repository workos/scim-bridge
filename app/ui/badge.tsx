import * as React from "react";
import { Badge as ThemesBadge } from "@radix-ui/themes";

type ThemesBadgeProps = React.ComponentPropsWithoutRef<typeof ThemesBadge>;

/**
 * A Radix badge with the panel's two extra affordances.
 *
 * `color="white"` is not a Radix colour: it is the neutral, outlined badge the
 * panel uses for "no strong signal" (an id, a status code it has no opinion
 * about). It renders as `gray` + `variant="surface"`, which is what the vendored
 * component did. `lowContrast` dims that neutral badge further.
 *
 * Every other colour is a real Radix accent and passes straight through, as does
 * `variant` — the vendored component `Omit`ted `variant` while its call sites
 * passed it anyway, which is where most of the panel's 32 pre-existing type
 * errors came from (ENT-6755).
 */
interface BadgeProps extends Omit<ThemesBadgeProps, "color"> {
  color?: "white" | ThemesBadgeProps["color"];
  /** Dim the neutral badge. Only meaningful with `color="white"`. */
  lowContrast?: boolean;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ color = "white", lowContrast = false, variant, ...props }, forwardedRef) => (
    <ThemesBadge
      ref={forwardedRef}
      color={color === "white" ? "gray" : color}
      highContrast={color === "white" && !lowContrast}
      radius="full"
      variant={variant ?? (color === "white" ? "surface" : "soft")}
      {...props}
    />
  ),
);

Badge.displayName = "Badge";

export { Badge };
export type { BadgeProps };
