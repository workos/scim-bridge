export const MODES = ["passthrough", "dual-write", "workos-only"] as const;
export type Mode = (typeof MODES)[number];

export const MIGRATED_ID_HEADER = "X-WorkOS-Migrated-Id";

export type ResourceType = "Users" | "Groups";

export interface Directory {
  id: string;
  name: string;
  mode: Mode;
  proxy_token: string;
  native_url: string;
  native_token: string;
  workos_url: string;
  workos_token: string;
  /** The WorkOS directory id (directory_...) this row migrates, when known.
   *  DSync webhook events carry it (`event.data.directory_id`), so it is the
   *  id a customer's native app keys its status lookups on. */
  workos_directory_id: string | null;
  /** 1 = persist this directory's requests to proxy_log; 0 = don't (default). */
  log_persistence: number;
  created_at: string;
  updated_at: string;
}

export interface IdMapping {
  directory_id: string;
  resource_type: ResourceType;
  native_id: string;
  workos_id: string;
  strategy: "migrated-id" | "fallback-post";
  created_at: string;
  updated_at: string;
}

export interface ProxyLogEntry {
  id: number;
  directory_id: string | null;
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
  DB: Datastore;
}
import type { Datastore } from "./datastore";
