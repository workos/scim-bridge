import type { Route } from "./+types/layout";
import type { MetaFunction } from "react-router";
import { Link, Outlet, redirect, useLoaderData, useLocation } from "react-router";
import { demoModeContext } from "../../context";
import { Badge } from "../../vendor/design-system/components/badge";
import { Box } from "../../vendor/design-system/components/box";
import { Flex } from "../../vendor/design-system/components/flex";
import { Heading } from "../../vendor/design-system/components/heading";
import { TabNav } from "../../vendor/design-system/components/tab-nav";
import { Text } from "../../vendor/design-system/components/text";

export const meta: MetaFunction = () => [
  { title: "SCIM migration panel" },
  {
    name: "description",
    content: "Control panel for the reversible SCIM migration proxy",
  },
];

const DEMO_PATHS = ["/panel/live", "/panel/native", "/panel/listener", "/panel/idp"];

export function loader({ context, request }: Route.LoaderArgs) {
  const demoMode = context.get(demoModeContext);
  if (!demoMode) {
    const { pathname } = new URL(request.url);
    if (DEMO_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      throw redirect("/panel");
    }
  }
  return { demoMode };
}

export default function PanelLayout() {
  const { demoMode } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const directoriesActive = pathname === "/panel" || pathname.startsWith("/panel/directories");

  return (
    <Box className="min-h-screen">
      <Flex direction="column" gap="5" maxWidth="1040px" mx="auto" px="6" py="7">
        <Flex direction="column" gap="1">
          <Heading as="h1" size="7">
            SCIM migration
          </Heading>
          <Text color="gray" size="2">
            Reversible cutover — proxy your directories through passthrough, dual-write, backfill,
            and cut over to WorkOS with lossless rollback.
          </Text>
        </Flex>

        <TabNav.Root>
          <TabNav.Link asChild active={directoriesActive}>
            <Link to="/panel">Directories</Link>
          </TabNav.Link>
        </TabNav.Root>

        {demoMode && (
          <Flex align="center" gap="3" wrap="wrap">
            <Badge color="gray" variant="soft">
              Demo
            </Badge>
            <TabNav.Root>
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
          </Flex>
        )}

        <Outlet />
      </Flex>
    </Box>
  );
}
