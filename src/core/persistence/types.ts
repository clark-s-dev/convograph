/**
 * Row types as they come back from the database (snake_case).
 *
 * The PersistenceAdapter's methods accept and return these directly.
 * Callers higher up in convograph translate to camelCase domain types.
 */

export interface ThreadRow {
  id: string;
  external_user_id: string;
  external_org_id: string | null;
  current_topic: string | null;
  current_instance_id: string | null;
  created_at: Date;
  last_active_at: Date;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  role: "user" | "agent" | "system";
  content: unknown; // JSONB
  parent_uuid: string | null;
  created_at: Date;
}

export interface DraftRow {
  id: string;
  thread_id: string;
  topic: string;
  slots: Record<string, unknown>;
  msg_bucket: string[]; // array of message ids
  is_parked: boolean;
  created_at: Date;
  last_touched_at: Date;
}

export interface CompletedTaskRow {
  id: string;
  thread_id: string;
  topic: string;
  slots_snapshot: Record<string, unknown>;
  action_result: Record<string, unknown>;
  parent_instance_id: string | null;
  completed_at: Date;
}

export interface UserPreferenceRow {
  external_user_id: string;
  key: string;
  value: unknown;
  updated_at: Date;
}
