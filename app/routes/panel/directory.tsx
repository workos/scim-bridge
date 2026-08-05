import type { Route } from "./+types/directory";

import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { datastoreContext } from "../../context";
import { getDirectoryById } from "../../../workers/shared/db";
import { Flex, Heading, Link as DsLink, TabNav } from "@radix-ui/themes";
import { ModeBadge } from "./ui";

export async function loader({ context, params }: Route.LoaderArgs) {
  const directory = await getDirectoryById(context.get(datastoreContext), params.id ?? "");
  if (!directory) {
    throw new Response("Directory not found", { status: 404 });
  }
  return { directory };
}

export default function DirectoryLayout() {
  const { directory } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const base = `/panel/directories/${directory.id}`;

  return (
    <Flex direction="column" gap="4">
      <Flex direction="column" gap="2">
        <DsLink asChild size="2">
          <Link to="/panel">← All directories</Link>
        </DsLink>
        <Flex align="center" gap="3">
          <Heading as="h2" size="5">
            {directory.name}
          </Heading>
          <ModeBadge mode={directory.mode} />
        </Flex>
      </Flex>

      <TabNav.Root>
        <TabNav.Link asChild active={pathname === base}>
          <Link to={base}>Overview</Link>
        </TabNav.Link>
        <TabNav.Link asChild active={pathname === `${base}/activity`}>
          <Link to={`${base}/activity`}>Activity</Link>
        </TabNav.Link>
        <TabNav.Link asChild active={pathname === `${base}/mappings`}>
          <Link to={`${base}/mappings`}>Mappings</Link>
        </TabNav.Link>
      </TabNav.Root>

      <Outlet />
    </Flex>
  );
}
