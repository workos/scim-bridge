import { useState } from "react";
import type { Mode } from "../../../workers/shared/types";
import { Flex, Text } from "@radix-ui/themes";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";

export const MODE_BADGE_COLORS = {
  passthrough: "gray",
  "dual-write": "blue",
  "workos-only": "green",
} as const satisfies Record<Mode, "gray" | "blue" | "green">;

export function ModeBadge({ mode }: { mode: Mode }) {
  return <Badge color={MODE_BADGE_COLORS[mode]}>{mode}</Badge>;
}

export function StatusCodeBadge({ status }: { status: number | null }) {
  if (status == null) {
    return (
      <Badge color="white" lowContrast>
        —
      </Badge>
    );
  }
  return <Badge color={status < 400 ? "green" : "red"}>{status}</Badge>;
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="1"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function FieldLabel({ children, htmlFor }: { children: string; htmlFor?: string }) {
  return (
    <Text as="label" htmlFor={htmlFor} size="2" weight="medium">
      {children}
    </Text>
  );
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <Flex direction="column" gap="1">
      <Text as="p" size="3" weight="medium">
        {title}
      </Text>
      {description && (
        <Text as="p" color="gray" size="2">
          {description}
        </Text>
      )}
    </Flex>
  );
}

export function formatBody(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
