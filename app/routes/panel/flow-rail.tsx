import type { Mode } from "../../../workers/shared/types";
import { Badge, Box, Flex, Text } from "@radix-ui/themes";

/**
 * The native app is drawn as three parts, not one box, because the migration is
 * a handoff *between* two of them and a single box hides it: the SCIM endpoint
 * the proxy writes, the DSync listener WorkOS drives, and the one database they
 * both land in. Which of the two is writing is the whole difference between the
 * rungs — and a gap where neither is writing is a real defect class (ENT-6778),
 * so the diagram has to be able to show each of them off independently.
 */

/** How a connection is behaving. `ignored` is an edge that carries traffic the
 *  far end deliberately drops — visible, because "nothing is drawn" and
 *  "delivered and discarded" are different things to debug. */
type LegState = "live" | "mirror" | "ignored" | "off";

/** Whether a component of the native app is doing anything. */
type PartState = "writing" | "inert";

interface FlowSpec {
  /** Proxy → the native app's SCIM endpoint. */
  toNativeScim: LegState;
  /** Proxy → WorkOS. */
  toWorkos: LegState;
  /** WorkOS → the native app's DSync listener. */
  workosToListener: LegState;
  scimEndpoint: PartState;
  listener: PartState;
  /** Whose response the IdP is answered from. */
  answeredBy: "native" | "workos" | "both";
}

const FLOW: Record<Mode, FlowSpec> = {
  // Nothing reaches WorkOS, so there are no events for the listener to even
  // ignore — its edge is absent rather than dropped.
  passthrough: {
    toNativeScim: "live",
    toWorkos: "off",
    workosToListener: "off",
    scimEndpoint: "writing",
    listener: "inert",
    answeredBy: "native",
  },
  // WorkOS is now written, so it starts emitting events. The listener must stay
  // inert: the proxy is already writing the native app directly, and applying
  // them too would write every change twice.
  "dual-write": {
    toNativeScim: "live",
    toWorkos: "mirror",
    workosToListener: "ignored",
    scimEndpoint: "writing",
    listener: "inert",
    answeredBy: "native",
  },
  // Both legs live and the listener still inert, which is the rung people get
  // wrong: WorkOS is authoritative *and* the proxy keeps writing native, so a
  // listener keyed on "who is authoritative" applies everything a second time.
  "workos-primary": {
    toNativeScim: "live",
    toWorkos: "live",
    workosToListener: "ignored",
    scimEndpoint: "writing",
    listener: "inert",
    answeredBy: "both",
  },
  // The handoff: the proxy stops writing the endpoint in the same instant the
  // listener takes over. Both edges into the database change at once.
  "workos-only": {
    toNativeScim: "off",
    toWorkos: "live",
    workosToListener: "live",
    scimEndpoint: "inert",
    listener: "writing",
    answeredBy: "workos",
  },
};

const FLOW_CAPTION: Record<Mode, string> = {
  passthrough:
    "Writes go to the native app's SCIM endpoint only. WorkOS is untouched — the safe place to land a rollback.",
  "dual-write":
    "Writes hit the native SCIM endpoint first, then mirror into WorkOS under the migrated-id contract. WorkOS emits DSync events, and the listener ignores every one of them: the proxy is already writing the app directly.",
  "workos-primary":
    "WorkOS answers the IdP, and the proxy still writes the native SCIM endpoint directly — both at once, and the request fails if either side does. The listener stays inert for the same reason as dual-write, so native stays current without depending on event delivery and rolling back is only a mode change.",
  "workos-only":
    "Cutover: the proxy stops writing the SCIM endpoint and the DSync listener starts applying events. Both edges into the native database change hands at the same moment.",
};

const ANSWERED_BY: Record<FlowSpec["answeredBy"], string> = {
  native: "IdP is answered from the native app",
  workos: "IdP is answered from WorkOS",
  both: "IdP is answered from WorkOS, once native has also succeeded",
};

export const MODE_LABEL: Record<Mode, string> = {
  passthrough: "Passthrough",
  "dual-write": "Dual-write",
  "workos-primary": "WorkOS-primary",
  "workos-only": "WorkOS-only",
};

function usersLabel(n: number | null | undefined): string {
  return `${n ?? "—"} users`;
}

/**
 * The IdP → Proxy → {native app, WorkOS} topology. `counts.idp` is optional:
 * omit it (as the per-directory view does, where there's no IdP simulator) and
 * the diagram starts at the proxy. Counts may be null when an endpoint hasn't
 * reported yet or is unreachable.
 */
export function FlowRail({
  mode,
  counts,
}: {
  mode: Mode;
  counts: { idp?: number | null; native: number | null; workos: number | null };
}) {
  const flow = FLOW[mode];
  return (
    <Flex direction="column" gap="3">
      {/* Horizontal scroll for narrow viewports. `overflow-x` computes
          `overflow-y: auto` too, so anything drawn above the row — the native
          app's border-straddling label — is clipped unless the row itself
          reserves the headroom. Hence the padding here rather than a margin on
          the enclosure, which would drop it out of line with its own edges. */}
      <Box className="overflow-x-auto">
        <Flex align="center" gap="2" className="min-w-max pt-3 pb-1">
          {counts.idp !== undefined && (
            <>
              <Node label="IdP (source)" value={usersLabel(counts.idp)} tone="idp" />
              <Leg state="live" label="SCIM" />
            </>
          )}
          {/* Spans both rows: it is the fan-out point, so both branches have to
              meet its edge rather than float off a box shorter than they are. */}
          <Node label="Proxy" value={MODE_LABEL[mode]} tone="proxy" stretch />

          {/* The two paths out of the proxy, on the same two-row geometry the
              native app's writers use (ROW_H + gap-4), so the direct write
              arrives level with the SCIM endpoint and the event path level with
              the listener. Alignment is the whole point of the diagram: an edge
              that lands between two boxes says nothing about which one it
              feeds. */}
          <Flex direction="column" gap="4">
            <Flex align="center" className={`min-w-[200px] ${ROW_H}`}>
              <Leg state={flow.toNativeScim} label="native" grow />
            </Flex>
            <Flex align="center" gap="2" className={ROW_H}>
              <Leg state={flow.toWorkos} label={flow.toWorkos === "mirror" ? "mirror" : "workos"} />
              <Node label="WorkOS" value={usersLabel(counts.workos)} tone="target" />
              <Leg state={flow.workosToListener} label="dsync" />
            </Flex>
          </Flex>

          <NativeApp flow={flow} databaseValue={usersLabel(counts.native)} />
        </Flex>
      </Box>

      <Flex align="center" gap="2" wrap="wrap">
        <Badge color={flow.answeredBy === "native" ? "gray" : "green"} variant="soft">
          {ANSWERED_BY[flow.answeredBy]}
        </Badge>
      </Flex>

      <Text color="gray" size="2">
        {FLOW_CAPTION[mode]}
      </Text>
    </Flex>
  );
}

/**
 * The customer's application: two independent writers and the store they share.
 * Drawn as one enclosure so it still reads as a single deployment, with the
 * writers on the left edge where their incoming edges land.
 *
 * The label sits *on* the border rather than above the content, fieldset-style,
 * so the enclosure adds no vertical offset and the writers stay level with the
 * edges that feed them.
 */
function NativeApp({ flow, databaseValue }: { flow: FlowSpec; databaseValue: string }) {
  return (
    <Box className="relative rounded-[var(--radius-4)] border border-dashed border-[var(--gray-7)] bg-[var(--gray-2)] px-3 py-3">
      <Text
        size="1"
        color="gray"
        weight="bold"
        className="absolute -top-2 left-3 bg-[var(--gray-2)] px-1 uppercase tracking-wide"
      >
        Native app
      </Text>
      <Flex align="center" gap="2">
        <Flex direction="column" gap="4">
          <Part
            label="SCIM endpoint"
            state={flow.scimEndpoint}
            activeHint="accepting writes"
            inertHint="not written"
          />
          <Part
            label="DSync listener"
            state={flow.listener}
            activeHint="applying events"
            inertHint="ignoring events"
          />
        </Flex>
        {/* Both writers land in the one store; each edge is live only while its
            writer is. At cutover they swap in the same instant, which is what
            makes a moment where neither is live a bug rather than a lull. */}
        <Flex direction="column" gap="4">
          <Flex align="center" className={ROW_H}>
            <Leg state={flow.scimEndpoint === "writing" ? "live" : "off"} label="" short />
          </Flex>
          <Flex align="center" className={ROW_H}>
            <Leg state={flow.listener === "writing" ? "live" : "off"} label="" short />
          </Flex>
        </Flex>
        <Node label="Database" value={databaseValue} tone="store" stretch />
      </Flex>
    </Box>
  );
}

/** The height every row of the diagram is pinned to, so the two branches out of
 *  the proxy land level with the two writers they feed. */
const ROW_H = "h-[62px]";

function Part({
  label,
  state,
  activeHint,
  inertHint,
}: {
  label: string;
  state: PartState;
  activeHint: string;
  inertHint: string;
}) {
  const active = state === "writing";
  return (
    <Box
      className={`flex flex-col justify-center rounded-[var(--radius-3)] border px-3 py-2 ${ROW_H}`}
      style={{
        borderColor: active ? "var(--green-7)" : "var(--gray-6)",
        background: active ? "var(--green-2)" : "var(--gray-3)",
        opacity: active ? 1 : 0.75,
      }}
    >
      <Flex direction="column" gap="1">
        <Text size="1" weight="bold">
          {label}
        </Text>
        <Text size="1" style={{ color: active ? "var(--green-11)" : "var(--gray-10)" }}>
          {active ? activeHint : inertHint}
        </Text>
      </Flex>
    </Box>
  );
}

function Node({
  label,
  value,
  tone,
  stretch,
}: {
  label: string;
  value: string;
  tone: "idp" | "proxy" | "target" | "store";
  /** Span both writer rows, so the two edges into the database visibly land on
   *  the same box rather than on two separate things. */
  stretch?: boolean;
}) {
  const ring =
    tone === "idp"
      ? "border-[var(--accent-7)] bg-[var(--accent-2)]"
      : tone === "proxy"
        ? "border-[var(--gray-7)] bg-[var(--gray-2)]"
        : tone === "store"
          ? "border-[var(--gray-8)] bg-[var(--color-panel-solid)]"
          : "border-[var(--gray-6)] bg-[var(--color-panel-solid)]";
  return (
    <Box
      className={`rounded-[var(--radius-3)] border px-3 py-2 ${ring} ${stretch ? "self-stretch" : ""}`}
    >
      <Flex direction="column" gap="1" align="center" justify="center" className="h-full">
        <Text size="1" color="gray" weight="medium">
          {label}
        </Text>
        <Text size={tone === "proxy" ? "2" : "4"} weight="bold">
          {value}
        </Text>
      </Flex>
    </Box>
  );
}

const LEG_COLOR: Record<LegState, string> = {
  live: "var(--green-9)",
  mirror: "var(--blue-9)",
  ignored: "var(--amber-9)",
  off: "var(--gray-6)",
};

const LEG_TITLE: Record<LegState, string> = {
  live: "carrying writes",
  mirror: "mirroring writes",
  ignored: "delivered, then ignored by the listener",
  off: "nothing flows on this edge in this mode",
};

/**
 * One edge. Traffic-carrying edges march in the direction of flow so a still
 * screenshot still shows which way data moves; `ignored` marches too, because
 * the events really are being delivered — they are dropped at the far end, and
 * an edge drawn as dead would send someone looking for a delivery problem.
 */
function Leg({
  state,
  label,
  grow,
  short,
}: {
  state: LegState;
  label: string;
  grow?: boolean;
  short?: boolean;
}) {
  const color = LEG_COLOR[state];
  const moving = state !== "off";
  return (
    <Flex
      direction="column"
      align="center"
      gap="1"
      className={grow ? "grow" : short ? "min-w-[40px]" : "min-w-[76px]"}
      title={LEG_TITLE[state]}
    >
      {label !== "" && (
        <Text size="1" style={{ color }} weight="medium">
          {label}
        </Text>
      )}
      <Box
        className={`h-[2px] w-full ${moving ? "flow-leg" : ""}`}
        style={
          moving
            ? ({
                "--flow-color": color,
                "--flow-gap": state === "live" ? "transparent" : "var(--gray-4)",
              } as React.CSSProperties)
            : { background: color }
        }
      />
    </Flex>
  );
}
