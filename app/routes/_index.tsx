import { redirect } from "react-router";

/** The control panel is the app; the root path sends you there. */
export function loader() {
  return redirect("/panel");
}
