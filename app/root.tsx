import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { LinksFunction, MetaFunction } from "react-router";
import { Theme } from "@radix-ui/themes";

import "./app.css";
import "./theme.css";

export const meta: MetaFunction = () => [
  { title: "SCIM migration panel" },
  {
    name: "description",
    content: "Control panel for the reversible SCIM migration proxy",
  },
];

export const links: LinksFunction = () => [{ rel: "icon", href: "/favicon.ico" }];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {/*
         * Deliberately neutral. The vendored Theme defaulted to WorkOS's brand
         * accent (purple) and gray ramp; this is a tool a customer self-hosts, so
         * it should not look like WorkOS's admin UI. `indigo`/`slate` are Radix's
         * own defaults. `radius` is carried over because the panel's cards,
         * inputs and badges were laid out against it.
         */}
        <Theme accentColor="indigo" grayColor="slate" radius="medium" hasBackground={false}>
          <Outlet />
        </Theme>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
