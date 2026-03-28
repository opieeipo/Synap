/**
 * JSON File Storage Adapter
 *
 * Zero-infrastructure storage that writes everything to JSON files
 * in a configurable directory. Each session gets its own directory
 * containing session.json, messages.json, themes.json, and events.json.
 *
 * Structure:
 *   {base_dir}/
 *     {session_id}/
 *       session.json
 *       messages.json
 *       themes.json
 *       events.json
 *     _index.json          (lightweight session index for listing)
 *
 * Config:
 *   { provider: "json-file", base_dir: "./data" }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  StorageAdapter,
  StorageConfig,
  Session,
  Message,
  CodedTheme,
  SessionEvent,
} from "./interface.ts";

export class JsonFileAdapter implements StorageAdapter {
  private baseDir: string;
  private indexPath: string;
  private messageCounters = new Map<string, number>();

  constructor(config: StorageConfig) {
    this.baseDir = (config.base_dir as string) || "./data";
    this.indexPath = path.join(this.baseDir, "_index.json");
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, "[]", "utf-8");
    }
  }

  // ── Sessions ─────────────────────────────────────────────

  async createSession(session: Partial<Session> & { id: string; config_id: string; config_snapshot: Record<string, unknown> }): Promise<void> {
    const full: Session = {
      status: "active",
      turn_count: 0,
      started_at: new Date().toISOString(),
      ...session,
    };

    const dir = this.sessionDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    this.writeJson(path.join(dir, "session.json"), full);
    this.writeJson(path.join(dir, "messages.json"), []);
    this.writeJson(path.join(dir, "themes.json"), []);
    this.writeJson(path.join(dir, "events.json"), []);

    // Update index
    const index = this.readIndex();
    index.push({
      id: full.id,
      config_id: full.config_id,
      status: full.status,
      started_at: full.started_at,
      turn_count: full.turn_count,
    });
    this.writeJson(this.indexPath, index);
  }

  async getSession(id: string): Promise<Session | null> {
    const fp = path.join(this.sessionDir(id), "session.json");
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    const session = await this.getSession(id);
    if (!session) throw new Error("Session not found: " + id);

    const updated = { ...session, ...updates };
    this.writeJson(path.join(this.sessionDir(id), "session.json"), updated);

    // Update index
    const index = this.readIndex();
    const idx = index.findIndex((s: { id: string }) => s.id === id);
    if (idx >= 0) {
      index[idx] = {
        ...index[idx],
        status: updated.status,
        turn_count: updated.turn_count,
        ended_at: updated.ended_at,
      };
      this.writeJson(this.indexPath, index);
    }
  }

  async listSessions(filters?: { config_id?: string; status?: string; limit?: number }): Promise<Session[]> {
    const index = this.readIndex();
    let results = index;

    if (filters?.config_id) {
      results = results.filter((s: Session) => s.config_id === filters.config_id);
    }
    if (filters?.status) {
      results = results.filter((s: Session) => s.status === filters.status);
    }
    if (filters?.limit) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  // ── Messages ─────────────────────────────────────────────

  async insertMessage(msg: Omit<Message, "id" | "created_at">): Promise<string | number> {
    const fp = path.join(this.sessionDir(msg.session_id), "messages.json");
    const messages = this.readJsonArray(fp);

    // Generate sequential ID
    const counter = (this.messageCounters.get(msg.session_id) || messages.length) + 1;
    this.messageCounters.set(msg.session_id, counter);

    const full: Message = {
      ...msg,
      id: counter,
      created_at: new Date().toISOString(),
    };

    messages.push(full);
    this.writeJson(fp, messages);
    return counter;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const fp = path.join(this.sessionDir(sessionId), "messages.json");
    return this.readJsonArray(fp);
  }

  // ── Coded Themes ─────────────────────────────────────────

  async insertThemes(themes: Omit<CodedTheme, "id" | "created_at">[]): Promise<void> {
    if (!themes.length) return;
    const sessionId = themes[0].session_id;
    const fp = path.join(this.sessionDir(sessionId), "themes.json");
    const existing = this.readJsonArray(fp);

    const now = new Date().toISOString();
    const newThemes = themes.map((t, i) => ({
      ...t,
      id: existing.length + i + 1,
      created_at: now,
    }));

    existing.push(...newThemes);
    this.writeJson(fp, existing);
  }

  async getSessionThemes(sessionId: string): Promise<CodedTheme[]> {
    const fp = path.join(this.sessionDir(sessionId), "themes.json");
    return this.readJsonArray(fp);
  }

  // ── Events ───────────────────────────────────────────────

  async insertEvent(event: Omit<SessionEvent, "id" | "created_at">): Promise<void> {
    const fp = path.join(this.sessionDir(event.session_id), "events.json");
    const events = this.readJsonArray(fp);

    events.push({
      ...event,
      id: events.length + 1,
      created_at: new Date().toISOString(),
    });

    this.writeJson(fp, events);
  }

  async getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    const fp = path.join(this.sessionDir(sessionId), "events.json");
    return this.readJsonArray(fp);
  }

  // ── Helpers ──────────────────────────────────────────────

  private sessionDir(id: string): string {
    // Sanitize session ID for filesystem
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, safe);
  }

  private readIndex(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.indexPath)) return [];
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
  }

  private readJsonArray(fp: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(fp)) return [];
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  }

  private writeJson(fp: string, data: unknown): void {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
  }
}
