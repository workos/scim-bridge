export const MODES = ["passthrough", "dualwrite-native-first", "workos-only"] as const;
export type Mode = (typeof MODES)[number];

export const MIGRATED_ID_HEADER = "X-WorkOS-Migrated-Id";

export type ResourceType = "Users" | "Groups";

export interface Connection {
  id: string;
  name: string;
  mode: Mode;
  proxy_token: string;
  native_url: string;
  native_token: string;
  workos_url: string;
  workos_token: string;
  created_at: string;
  updated_at: string;
}

export interface IdMapping {
  connection_id: string;
  resource_type: ResourceType;
  native_id: string;
  workos_id: string;
  strategy: "migrated-id" | "fallback-post";
  created_at: string;
  updated_at: string;
}

export interface ProxyLogEntry {
  id: number;
  connection_id: string | null;
  ts: string;
  source: "idp" | "backfill";
  mode: string;
  method: string;
  path: string;
  request_body: string | null;
  native_status: number | null;
  native_ms: number | null;
  native_body: string | null;
  workos_request: string | null;
  workos_status: number | null;
  workos_ms: number | null;
  workos_body: string | null;
  response_status: number | null;
  error: string | null;
}

export interface ListenerEvent {
  id: number;
  ts: string;
  event_id: string | null;
  event_type: string;
  idp_id: string | null;
  action: "applied" | "skipped" | "ignored";
  detail: string | null;
  payload: string | null;
}

export interface BackfillSummary {
  users: { total: number; mirrored: number; failed: number };
  groups: { total: number; mirrored: number; failed: number };
  errors: string[];
}

/** Bindings shared by the proxy worker, the native app worker, and the panel. */
export interface PocEnv {
  DB: D1Database;
}
