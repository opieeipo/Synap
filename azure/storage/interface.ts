/**
 * Pluggable Storage Adapter Interface
 *
 * All storage backends (Supabase, Cosmos DB, Azure SQL, SharePoint, JSON file)
 * implement this interface. The orchestration layer never knows which backend
 * is in use — it only speaks to these methods.
 */

// ── Types ────────────────────────────────────────────────────

export interface Session {
  id: string;
  config_id: string;
  config_snapshot: Record<string, unknown>;
  participant_token?: string;
  participant_profile?: Record<string, unknown>;
  status: "active" | "completed" | "abandoned";
  started_at: string;
  ended_at?: string;
  end_reason?: string;
  turn_count: number;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id?: number | string;
  session_id: string;
  role: "ai" | "user";
  content: string;
  turn_number: number;
  question_id?: string;
  created_at?: string;
}

export interface CodedTheme {
  id?: number | string;
  session_id: string;
  message_id?: number | string;
  turn_number: number;
  theme_code: string;
  theme_label?: string;
  confidence?: number;
  created_at?: string;
}

export interface SessionEvent {
  id?: number | string;
  session_id: string;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

// ── Storage Adapter Interface ────────────────────────────────

export interface StorageAdapter {
  /** Initialize the adapter (connect, create tables/containers if needed) */
  init(): Promise<void>;

  // Sessions
  createSession(session: Omit<Session, "status" | "turn_count" | "started_at"> & Partial<Session>): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, updates: Partial<Session>): Promise<void>;
  listSessions(filters?: { config_id?: string; status?: string; limit?: number }): Promise<Session[]>;

  // Messages
  insertMessage(msg: Omit<Message, "id" | "created_at">): Promise<string | number>;
  getMessages(sessionId: string): Promise<Message[]>;

  // Coded Themes
  insertThemes(themes: Omit<CodedTheme, "id" | "created_at">[]): Promise<void>;
  getSessionThemes(sessionId: string): Promise<CodedTheme[]>;

  // Events
  insertEvent(event: Omit<SessionEvent, "id" | "created_at">): Promise<void>;
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>;
}

// ── Factory ──────────────────────────────────────────────────

export type StorageProviderType = "supabase" | "cosmosdb" | "azuresql" | "sharepoint" | "json-file";

export interface StorageConfig {
  provider: StorageProviderType;
  /** Provider-specific connection settings */
  [key: string]: unknown;
}
