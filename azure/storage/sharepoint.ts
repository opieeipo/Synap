/**
 * SharePoint Lists Storage Adapter
 *
 * Uses Microsoft Graph API to read/write SharePoint Lists.
 * Creates four lists: SynapSessions, SynapMessages, SynapThemes, SynapEvents.
 *
 * Config:
 *   {
 *     provider: "sharepoint",
 *     sharepoint_site_id: "your-site-id",
 *     sharepoint_tenant_id: "your-tenant-id",
 *     sharepoint_client_id: "your-app-client-id",
 *     sharepoint_client_secret: "your-app-client-secret"
 *   }
 *
 * Or via env vars: SP_SITE_ID, SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET
 *
 * Requires an Azure AD app registration with Sites.ReadWrite.All permission.
 */

import type {
  StorageAdapter,
  StorageConfig,
  Session,
  Message,
  CodedTheme,
  SessionEvent,
} from "./interface.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class SharePointAdapter implements StorageAdapter {
  private siteId: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken = "";
  private tokenExpiry = 0;

  // List IDs cached after init
  private listIds: Record<string, string> = {};

  constructor(config: StorageConfig) {
    this.siteId = (config.sharepoint_site_id as string) || process.env.SP_SITE_ID || "";
    this.tenantId = (config.sharepoint_tenant_id as string) || process.env.SP_TENANT_ID || "";
    this.clientId = (config.sharepoint_client_id as string) || process.env.SP_CLIENT_ID || "";
    this.clientSecret = (config.sharepoint_client_secret as string) || process.env.SP_CLIENT_SECRET || "";

    if (!this.siteId || !this.tenantId || !this.clientId || !this.clientSecret) {
      throw new Error("SharePoint adapter requires site_id, tenant_id, client_id, and client_secret");
    }
  }

  async init(): Promise<void> {
    await this.ensureToken();

    // Ensure lists exist
    const lists = [
      { name: "SynapSessions", columns: [
        { name: "SessionId", text: {} },
        { name: "ConfigId", text: {} },
        { name: "ConfigSnapshot", text: { allowMultipleLines: true } },
        { name: "ParticipantProfile", text: { allowMultipleLines: true } },
        { name: "Status", text: {} },
        { name: "StartedAt", text: {} },
        { name: "EndedAt", text: {} },
        { name: "EndReason", text: {} },
        { name: "TurnCount", number: {} },
      ]},
      { name: "SynapMessages", columns: [
        { name: "SessionId", text: {} },
        { name: "Role", text: {} },
        { name: "Content", text: { allowMultipleLines: true } },
        { name: "TurnNumber", number: {} },
        { name: "QuestionId", text: {} },
      ]},
      { name: "SynapThemes", columns: [
        { name: "SessionId", text: {} },
        { name: "MessageId", text: {} },
        { name: "TurnNumber", number: {} },
        { name: "ThemeCode", text: {} },
        { name: "ThemeLabel", text: {} },
        { name: "Confidence", number: {} },
      ]},
      { name: "SynapEvents", columns: [
        { name: "SessionId", text: {} },
        { name: "EventType", text: {} },
        { name: "Payload", text: { allowMultipleLines: true } },
      ]},
    ];

    for (const list of lists) {
      this.listIds[list.name] = await this.ensureList(list.name, list.columns);
    }
  }

  // ── Sessions ─────────────────────────────────────────────

  async createSession(session: Partial<Session> & { id: string; config_id: string; config_snapshot: Record<string, unknown> }): Promise<void> {
    await this.createListItem("SynapSessions", {
      fields: {
        Title: session.id,
        SessionId: session.id,
        ConfigId: session.config_id,
        ConfigSnapshot: JSON.stringify(session.config_snapshot),
        ParticipantProfile: session.participant_profile ? JSON.stringify(session.participant_profile) : "",
        Status: "active",
        StartedAt: new Date().toISOString(),
        TurnCount: 0,
      },
    });
  }

  async getSession(id: string): Promise<Session | null> {
    const items = await this.queryList(
      "SynapSessions",
      `fields/SessionId eq '${this.escFilter(id)}'`
    );
    if (items.length === 0) return null;
    return this.itemToSession(items[0]);
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    const items = await this.queryList(
      "SynapSessions",
      `fields/SessionId eq '${this.escFilter(id)}'`
    );
    if (items.length === 0) throw new Error("Session not found: " + id);

    const itemId = items[0].id;
    const fields: Record<string, unknown> = {};
    if (updates.status !== undefined) fields.Status = updates.status;
    if (updates.turn_count !== undefined) fields.TurnCount = updates.turn_count;
    if (updates.ended_at !== undefined) fields.EndedAt = updates.ended_at;
    if (updates.end_reason !== undefined) fields.EndReason = updates.end_reason;

    await this.updateListItem("SynapSessions", itemId, { fields });
  }

  async listSessions(filters?: { config_id?: string; status?: string; limit?: number }): Promise<Session[]> {
    const conditions: string[] = [];
    if (filters?.config_id) conditions.push(`fields/ConfigId eq '${this.escFilter(filters.config_id)}'`);
    if (filters?.status) conditions.push(`fields/Status eq '${this.escFilter(filters.status)}'`);

    const filter = conditions.length ? conditions.join(" and ") : undefined;
    const items = await this.queryList("SynapSessions", filter, filters?.limit);
    return items.map((i: any) => this.itemToSession(i));
  }

  // ── Messages ─────────────────────────────────────────────

  async insertMessage(msg: Omit<Message, "id" | "created_at">): Promise<string | number> {
    const result = await this.createListItem("SynapMessages", {
      fields: {
        Title: msg.session_id + "_" + msg.turn_number + "_" + msg.role,
        SessionId: msg.session_id,
        Role: msg.role,
        Content: msg.content,
        TurnNumber: msg.turn_number,
        QuestionId: msg.question_id || "",
      },
    });
    return result.id;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const items = await this.queryList(
      "SynapMessages",
      `fields/SessionId eq '${this.escFilter(sessionId)}'`
    );
    return items
      .map((i: any) => ({
        id: i.id,
        session_id: i.fields.SessionId,
        role: i.fields.Role,
        content: i.fields.Content,
        turn_number: i.fields.TurnNumber || 0,
        question_id: i.fields.QuestionId || undefined,
        created_at: i.createdDateTime,
      }))
      .sort((a: Message, b: Message) => a.turn_number - b.turn_number);
  }

  // ── Coded Themes ─────────────────────────────────────────

  async insertThemes(themes: Omit<CodedTheme, "id" | "created_at">[]): Promise<void> {
    for (const t of themes) {
      await this.createListItem("SynapThemes", {
        fields: {
          Title: t.session_id + "_" + t.theme_code,
          SessionId: t.session_id,
          MessageId: t.message_id ? String(t.message_id) : "",
          TurnNumber: t.turn_number,
          ThemeCode: t.theme_code,
          ThemeLabel: t.theme_label || "",
          Confidence: t.confidence || 0,
        },
      });
    }
  }

  async getSessionThemes(sessionId: string): Promise<CodedTheme[]> {
    const items = await this.queryList(
      "SynapThemes",
      `fields/SessionId eq '${this.escFilter(sessionId)}'`
    );
    return items.map((i: any) => ({
      id: i.id,
      session_id: i.fields.SessionId,
      message_id: i.fields.MessageId || undefined,
      turn_number: i.fields.TurnNumber || 0,
      theme_code: i.fields.ThemeCode,
      theme_label: i.fields.ThemeLabel || undefined,
      confidence: i.fields.Confidence || undefined,
      created_at: i.createdDateTime,
    }));
  }

  // ── Events ───────────────────────────────────────────────

  async insertEvent(event: Omit<SessionEvent, "id" | "created_at">): Promise<void> {
    await this.createListItem("SynapEvents", {
      fields: {
        Title: event.session_id + "_" + event.event_type,
        SessionId: event.session_id,
        EventType: event.event_type,
        Payload: event.payload ? JSON.stringify(event.payload) : "",
      },
    });
  }

  async getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    const items = await this.queryList(
      "SynapEvents",
      `fields/SessionId eq '${this.escFilter(sessionId)}'`
    );
    return items.map((i: any) => ({
      id: i.id,
      session_id: i.fields.SessionId,
      event_type: i.fields.EventType,
      payload: i.fields.Payload ? JSON.parse(i.fields.Payload) : {},
      created_at: i.createdDateTime,
    }));
  }

  // ── Graph API helpers ──────────────────────────────────────

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return;

    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("Failed to get Graph token: " + err);
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  private async graphRequest(method: string, path: string, body?: unknown): Promise<any> {
    await this.ensureToken();
    const resp = await fetch(GRAPH_BASE + path, {
      method,
      headers: {
        Authorization: "Bearer " + this.accessToken,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Graph ${method} ${path} failed ${resp.status}: ${err}`);
    }

    if (resp.status === 204) return {};
    return resp.json();
  }

  private async ensureList(name: string, columns: Array<{ name: string; [key: string]: unknown }>): Promise<string> {
    // Try to get existing list
    try {
      const existing = await this.graphRequest("GET", `/sites/${this.siteId}/lists/${name}`);
      return existing.id;
    } catch {
      // List doesn't exist, create it
    }

    const list = await this.graphRequest("POST", `/sites/${this.siteId}/lists`, {
      displayName: name,
      list: { template: "genericList" },
      columns: columns.map((c) => ({
        name: c.name,
        ...c,
      })),
    });

    return list.id;
  }

  private async createListItem(listName: string, item: Record<string, unknown>): Promise<any> {
    return this.graphRequest(
      "POST",
      `/sites/${this.siteId}/lists/${this.listIds[listName]}/items`,
      item
    );
  }

  private async updateListItem(listName: string, itemId: string, updates: Record<string, unknown>): Promise<void> {
    await this.graphRequest(
      "PATCH",
      `/sites/${this.siteId}/lists/${this.listIds[listName]}/items/${itemId}`,
      updates
    );
  }

  private async queryList(listName: string, filter?: string, top?: number): Promise<any[]> {
    let url = `/sites/${this.siteId}/lists/${this.listIds[listName]}/items?expand=fields`;
    const params: string[] = [];
    if (filter) params.push("$filter=" + encodeURIComponent(filter));
    if (top) params.push("$top=" + top);
    if (params.length) url += "&" + params.join("&");

    const result = await this.graphRequest("GET", url);
    return result.value || [];
  }

  private itemToSession(item: any): Session {
    const f = item.fields;
    return {
      id: f.SessionId,
      config_id: f.ConfigId,
      config_snapshot: f.ConfigSnapshot ? JSON.parse(f.ConfigSnapshot) : {},
      participant_profile: f.ParticipantProfile ? JSON.parse(f.ParticipantProfile) : undefined,
      status: f.Status || "active",
      started_at: f.StartedAt || item.createdDateTime,
      ended_at: f.EndedAt || undefined,
      end_reason: f.EndReason || undefined,
      turn_count: f.TurnCount || 0,
    };
  }

  private escFilter(val: string): string {
    return val.replace(/'/g, "''");
  }
}
