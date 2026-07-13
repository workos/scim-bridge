import type { LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { getConnectionById } from "../../../workers/shared/db";
import { Flex } from "../../vendor/design-system/components/flex";
import { Heading } from "../../vendor/design-system/components/heading";
import { Link as DsLink } from "../../vendor/design-system/components/link";
import { TabNav } from "../../vendor/design-system/components/tab-nav";
import { ModeBadge } from "./ui";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const connection = await getConnectionById(context.cloudflare.env.DB, params.id ?? "");
  if (!connection) {
    throw new Response("Connection not found", { status: 404 });
  }
  return { connection };
}

export default function ConnectionLayout() {
  const { connection } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const base = `/panel/connections/${connection.id}`;

  return (
    <Flex direction="column" gap="4">
      <Flex direction="column" gap="2">
        <DsLink asChild size="2">
          <Link to="/panel">← All connections</Link>
        </DsLink>
        <Flex align="center" gap="3">
          <Heading as="h2" size="5">
            {connection.name}
          </Heading>
          <ModeBadge mode={connection.mode} />
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
