/**
 * Supabase client and database helpers for Edge Functions.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let _client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!_client) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    _client = createClient(url, key);
  }
  return _client;
}

// ── Session operations ───────────────────────────────────────

export async function createSession(
  id: string,
  configId: string,
  configSnapshot: unknown
) {
  const { error } = await getClient()
    .from("sessions")
    .insert({
      id,
      config_id: configId,
      config_snapshot: configSnapshot,
      status: "active",
    });
  if (error) throw new Error(`Failed to create session: ${error.message}`);
}

export async function getSession(id: string) {
  const { data, error } = await getClient()
    .from("sessions")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Failed to get session: ${error.message}`);
  return data;
}

export async function updateSession(
  id: string,
  updates: Record<string, unknown>
) {
  const { error } = await getClient()
    .from("sessions")
    .update(updates)
    .eq("id", id);
  if (error) throw new Error(`Failed to update session: ${error.message}`);
}

// ── Message operations ───────────────────────────────────────

export async function getMessages(sessionId: string) {
  const { data, error } = await getClient()
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("turn_number", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to get messages: ${error.message}`);
  return data || [];
}

export async function insertMessage(msg: {
  session_id: string;
  role: string;
  content: string;
  turn_number: number;
  question_id?: string;
}) {
  const { data, error } = await getClient()
    .from("messages")
    .insert(msg)
    .select("id")
    .single();
  if (error) throw new Error(`Failed to insert message: ${error.message}`);
  return data.id;
}

// ── Theme operations ─────────────────────────────────────────

export async function insertThemes(
  sessionId: string,
  messageId: number,
  turnNumber: number,
  themes: Array<{ code: string; label?: string; confidence?: number }>
) {
  if (!themes.length) return;
  const rows = themes.map((t) => ({
    session_id: sessionId,
    message_id: messageId,
    turn_number: turnNumber,
    theme_code: t.code,
    theme_label: t.label || null,
    confidence: t.confidence || null,
  }));
  const { error } = await getClient().from("coded_themes").insert(rows);
  if (error) throw new Error(`Failed to insert themes: ${error.message}`);
}

export async function getSessionThemes(sessionId: string) {
  const { data, error } = await getClient()
    .from("coded_themes")
    .select("theme_code, turn_number")
    .eq("session_id", sessionId);
  if (error) throw new Error(`Failed to get themes: ${error.message}`);
  return data || [];
}

// ── Event operations ─────────────────────────────────────────

export async function insertEvent(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown> = {}
) {
  const { error } = await getClient()
    .from("events")
    .insert({
      session_id: sessionId,
      event_type: eventType,
      payload,
    });
  if (error) throw new Error(`Failed to insert event: ${error.message}`);
}
