import { getMappingByWorkosId } from "./db";
import type { Datastore } from "./datastore";
import type { ResourceType } from "./types";

/** Directory Sync ids address a different API from the SCIM ids in id_mappings. */
export function isDirectorySyncResourceId(id: string): boolean {
  return id.startsWith("directory_user_") || id.startsWith("directory_group_");
}

/**
 * Confirm an event identity against this directory's SCIM mappings. idp_id is
 * often externalId, not the migrated SCIM id: a miss is not proof of identity.
 * Legacy events that actually carry a SCIM id remain supported.
 */
export async function nativeIdForEvent(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  resource: Record<string, unknown>,
): Promise<string | null> {
  const raw = resource.raw_attributes;
  const rawExternalId =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).externalId
      : null;
  const candidates = [resource.idp_id, rawExternalId, resource.id];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const mapping = await getMappingByWorkosId(db, directoryId, kind, candidate);
    if (mapping) return mapping.native_id;
  }
  const id = resource.id;
  return typeof id === "string" && id && !isDirectorySyncResourceId(id) ? id : null;
}

/** Refuse to turn an unresolved Directory Sync id into a new native SCIM row. */
export function idForNewEventResource(
  resource: Record<string, unknown>,
  nativeId: string | null,
  fallback: string,
): string {
  if (nativeId) return nativeId;
  if (typeof resource.id === "string" && isDirectorySyncResourceId(resource.id)) {
    throw new Error(
      "Directory Sync resource has no confirmed native SCIM ID; resolve its identity or reconcile before retrying",
    );
  }
  return fallback;
}
