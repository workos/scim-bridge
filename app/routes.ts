import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  ...prefix("panel", [
    layout("routes/panel/layout.tsx", [
      index("routes/panel/home.tsx"),
      route("live", "routes/panel/live.tsx"),
      route("native", "routes/panel/native.tsx"),
      route("listener", "routes/panel/listener.tsx"),
      route("idp", "routes/panel/idp.tsx"),
      route("directories/:id", "routes/panel/directory.tsx", [
        index("routes/panel/directory-overview.tsx"),
        route("activity", "routes/panel/directory-activity.tsx"),
        route("mappings", "routes/panel/directory-mappings.tsx"),
      ]),
    ]),
  ]),
] satisfies RouteConfig;
