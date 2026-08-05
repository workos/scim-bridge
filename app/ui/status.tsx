import * as React from "react";
import { Text } from "@radix-ui/themes";

/**
 * A coloured dot beside a label — "reachable", "listening", "stopped". Radix has
 * no equivalent, and a `Badge` reads too loudly for something that sits inline in
 * a sentence, which is why the vendored design system carried its own.
 *
 * The dot is the only coloured element: the label keeps the default text colour so
 * it stays legible at small sizes, which is what the vendored component did by
 * default too (it coloured the text only when asked).
 */
interface StatusProps extends Omit<React.ComponentPropsWithoutRef<"span">, "color"> {
  color: "gray" | "green" | "yellow" | "red";
}

const Status = React.forwardRef<HTMLSpanElement, StatusProps>(
  ({ color, children, style, ...props }, forwardedRef) => (
    <span
      ref={forwardedRef}
      style={{ alignItems: "center", display: "inline-flex", gap: 8, ...style }}
      {...props}
    >
      <span
        aria-hidden
        style={{
          background: `var(--${color}-9)`,
          borderRadius: "50%",
          flex: "none",
          height: 8,
          width: 8,
        }}
      />
      <Text size="2">{children}</Text>
    </span>
  ),
);

Status.displayName = "Status";

export { Status };
export type { StatusProps };
