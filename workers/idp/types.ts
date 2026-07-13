export interface IdpEnv {
  DB: D1Database;
}

export interface IdpUser {
  id: string;
  connection_id: string;
  user_name: string;
  external_id: string;
  given_name: string | null;
  family_name: string | null;
  active: number;
  scim_id: string | null;
  last_status: number | null;
  created_at: string;
  updated_at: string;
}

export interface IdpGroup {
  id: string;
  connection_id: string;
  display_name: string;
  external_id: string;
  scim_id: string | null;
  last_status: number | null;
  created_at: string;
  updated_at: string;
}

export interface IdpActivity {
  id: number;
  connection_id: string;
  ts: string;
  origin: "manual" | "auto" | "seed";
  action: string;
  subject: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  ok: number;
  detail: string | null;
}

export interface IdpAutoState {
  connection_id: string;
  running: number;
  interval_ms: number;
  tick_count: number;
  updated_at: string;
}

export type Origin = IdpActivity["origin"];
