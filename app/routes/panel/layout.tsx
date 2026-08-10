import type { Route } from "./+types/layout";
import type { MetaFunction } from "react-router";
import { Link, Outlet, redirect, useLoaderData, useLocation } from "react-router";
import { demoModeContext } from "../../context";
import { Box, Flex, Heading, TabNav, Text } from "@radix-ui/themes";
import { Badge } from "../../ui/badge";

export const meta: MetaFunction = () => [
  { title: "SCIM Bridge" },
  {
    name: "description",
    content: "Control panel for the reversible SCIM migration proxy",
  },
];

const DEMO_PATHS = ["/panel/live", "/panel/native", "/panel/listener", "/panel/idp"];

/**
 * The wordmark: the name between two chevrons.
 *
 * The chevrons take the theme's accent rather than WorkOS's brand indigo,
 * deliberately — see the note in app/root.tsx. A customer self-hosts this, so
 * it should read as their tool, not as WorkOS's admin UI, and hardcoding the
 * brand colour here would undo that one element at a time.
 *
 * They are set lighter than the name and spaced off it: at a nav's 17px a
 * chevron at the same weight closes up against the S and reads as part of the
 * letter. Tracking is tightened to match, because the guillemets add optical
 * width the name does not.
 */
function Logotype() {
  return (
    <span style={{ letterSpacing: "-0.03em", whiteSpace: "nowrap" }}>
      <span
        aria-hidden="true"
        style={{ color: "var(--accent-9)", fontWeight: 400, marginInlineEnd: "0.14em" }}
      >
        &#8249;
      </span>
      SCIM Bridge
      <span
        aria-hidden="true"
        style={{ color: "var(--accent-9)", fontWeight: 400, marginInlineStart: "0.14em" }}
      >
        &#8250;
      </span>
    </span>
  );
}

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
            <Logotype />
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
