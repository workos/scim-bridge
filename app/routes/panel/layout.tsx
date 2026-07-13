import type { MetaFunction } from "react-router";
import { Link, Outlet, useLocation } from "react-router";
import { Box } from "../../vendor/design-system/components/box";
import { Flex } from "../../vendor/design-system/components/flex";
import { Heading } from "../../vendor/design-system/components/heading";
import { TabNav } from "../../vendor/design-system/components/tab-nav";
import { Text } from "../../vendor/design-system/components/text";

export const meta: MetaFunction = () => [
  { title: "SCIM migration panel" },
  {
    name: "description",
    content: "Control panel for the reversible SCIM cutover proof of concept",
  },
];

export default function PanelLayout() {
  const { pathname } = useLocation();
  const connectionsActive = pathname === "/panel" || pathname.startsWith("/panel/connections");

  return (
    <Box className="min-h-screen">
      <Flex direction="column" gap="5" maxWidth="1040px" mx="auto" px="6" py="7">
        <Flex direction="column" gap="1">
          <Heading as="h1" size="7">
            SCIM migration
          </Heading>
          <Text color="gray" size="2">
            Reversible cutover — proxy connections, dual-write, backfill, and the customer's native
            app, side by side.
          </Text>
        </Flex>

        <TabNav.Root>
          <TabNav.Link asChild active={connectionsActive}>
            <Link to="/panel">Connections</Link>
          </TabNav.Link>
          <TabNav.Link asChild active={pathname === "/panel/live"}>
            <Link to="/panel/live">Live state</Link>
          </TabNav.Link>
          <TabNav.Link asChild active={pathname === "/panel/native"}>
            <Link to="/panel/native">Native app</Link>
          </TabNav.Link>
          <TabNav.Link asChild active={pathname === "/panel/listener"}>
            <Link to="/panel/listener">DSync listener</Link>
          </TabNav.Link>
          <TabNav.Link asChild active={pathname === "/panel/idp"}>
            <Link to="/panel/idp">IdP simulator</Link>
          </TabNav.Link>
        </TabNav.Root>

        <Outlet />
      </Flex>
    </Box>
  );
}
