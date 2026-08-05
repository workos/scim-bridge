import * as React from "react";
import { Flex, Text } from "@radix-ui/themes";

/**
 * The "nothing here yet" block inside a card or table. Radix has no equivalent.
 *
 * The vendored component also took `icon`, `action`, `size` and `minHeight`; the
 * panel's thirteen call sites pass only `title` and `subtitle`, so that is all
 * this takes. Exported as a namespace (`EmptyState.Root`) purely to match how the
 * call sites already read.
 */
interface EmptyStateRootProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
}

const Root: React.FC<EmptyStateRootProps> = ({ title, subtitle }) => (
  <Flex align="center" direction="column" gap="1" py="7">
    <Text align="center" size="3" weight="medium">
      {title}
    </Text>
    {subtitle ? (
      <Text align="center" color="gray" size="2">
        {subtitle}
      </Text>
    ) : null}
  </Flex>
);

Root.displayName = "EmptyState.Root";

export { Root };
export type { EmptyStateRootProps };
