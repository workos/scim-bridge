import type { Mode } from "../../../workers/shared/types";
import { Box } from "../../vendor/design-system/components/box";
import { Flex } from "../../vendor/design-system/components/flex";
import { Text } from "../../vendor/design-system/components/text";

/** Per-mode edge state: which legs are live/mirroring/off and whether the DSync
 *  listener feeds native. Shared by the Live state tab and the directory page. */
const FLOW: Record<
  Mode,
  { toNative: "live" | "mirror" | "off"; toWorkos: "live" | "mirror" | "off"; listener: boolean }
> = {
  passthrough: { toNative: "live", toWorkos: "off", listener: false },
  "dualwrite-native-first": { toNative: "live", toWorkos: "mirror", listener: false },
  "workos-only": { toNative: "off", toWorkos: "live", listener: true },
};

const FLOW_CAPTION: Record<Mode, string> = {
  passthrough:
    "Writes go to the native app only. WorkOS is untouched — the safe place to land a rollback.",
  "dualwrite-native-first":
    "Writes hit the native app first, then mirror into WorkOS under the migrated-id contract. Native stays the source of truth.",
  "workos-only":
    "Cutover: writes go to WorkOS only. The native app stays current through its DSync event listener, not the proxy.",
};

export const MODE_LABEL: Record<Mode, string> = {
  passthrough: "Passthrough",
  "dualwrite-native-first": "Dual-write",
  "workos-only": "WorkOS-only",
};

function usersLabel(n: number | null | undefined): string {
  return `${n ?? "—"} users`;
}

/**
 * The IdP → Proxy → {Native, WorkOS} topology diagram. `counts.idp` is optional:
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
      <Flex align="center" gap="3" wrap="wrap">
        {counts.idp !== undefined && (
          <>
            <Node label="IdP (source)" value={usersLabel(counts.idp)} tone="idp" />
            <Leg state="live" label="SCIM" />
          </>
        )}
        <Node label="Proxy" value={MODE_LABEL[mode]} tone="proxy" />
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <Leg state={flow.toNative} label="native" />
            <Node label="Native app" value={usersLabel(counts.native)} tone="target" />
          </Flex>
          <Flex align="center" gap="2">
            <Leg state={flow.toWorkos} label={flow.toWorkos === "mirror" ? "mirror" : "workos"} />
            <Node label="WorkOS" value={usersLabel(counts.workos)} tone="target" />
          </Flex>
        </Flex>
      </Flex>
      {flow.listener && (
        <Text size="1" style={{ color: "var(--purple-11)" }}>
          ⤺ WorkOS → native app via the DSync event listener
        </Text>
      )}
      <Text color="gray" size="2">
        {FLOW_CAPTION[mode]}
      </Text>
    </Flex>
  );
}

function Node({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "idp" | "proxy" | "target";
}) {
  const ring =
    tone === "idp"
      ? "border-[var(--purple-7)] bg-[var(--purple-2)]"
      : tone === "proxy"
        ? "border-[var(--gray-7)] bg-[var(--gray-2)]"
        : "border-[var(--gray-6)] bg-[var(--color-panel-solid)]";
  return (
    <Box className={`rounded-[var(--radius-3)] border px-3 py-2 ${ring}`}>
      <Flex direction="column" gap="1" align="center">
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

function Leg({ state, label }: { state: "live" | "mirror" | "off"; label: string }) {
  const color =
    state === "live" ? "var(--green-9)" : state === "mirror" ? "var(--blue-9)" : "var(--gray-6)";
  return (
    <Flex direction="column" align="center" gap="1" className="min-w-[76px]">
      <Text size="1" style={{ color }} weight="medium">
        {label}
      </Text>
      <Box
        className="h-0 w-full border-t-2"
        style={{ borderColor: color, borderStyle: state === "mirror" ? "dashed" : "solid" }}
      />
    </Flex>
  );
}
