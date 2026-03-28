/**
 * Azure Cosmos DB Storage Adapter (SQL API)
 *
 * Uses the Cosmos DB REST API directly — no SDK dependency.
 * Stores data in four containers: sessions, messages, coded_themes, events.
 * Partition key for all containers is session_id (or id for sessions).
 *
 * Config:
 *   {
 *     provider: "cosmosdb",
 *     cosmos_endpoint: "https://your-account.documents.azure.com",
 *     cosmos_key: "your-primary-key",
 *     cosmos_database: "synap"
 *   }
 *
 * Or via env vars: COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE
 */

import * as crypto from "node:crypto";
import type {
  StorageAdapter,
  StorageConfig,
  Session,
  Message,
  CodedTheme,
  SessionEvent,
} from "./interface.ts";

const CONTAINERS = ["sessions", "messages", "coded_themes", "events"];

export class CosmosDbAdapter implements StorageAdapter {
  private endpoint: string;
  private key: string;
  private database: string;

  constructor(config: StorageConfig) {
    this.endpoint = (config.cosmos_endpoint as string) || process.env.COSMOS_ENDPOINT || "";
    this.key = (config.cosmos_key as string) || process.env.COSMOS_KEY || "";
    this.database = (config.cosmos_database as string) || process.env.COSMOS_DATABASE || "synap";

    if (!this.endpoint || !this.key) {
      throw new Error("Cosmos DB requires cosmos_endpoint and cosmos_key (or COSMOS_ENDPOINT/COSMOS_KEY env vars)");
    }
  }

  async init(): Promise<void> {
    // Ensure database exists
    await this.createDatabaseIfNotExists();
    // Ensure containers exist
    for (const name of CONTAINERS) {
      const partitionKey = name === "sessions" ? "/id" : "/session_id";
      await this.createContainerIfNotExists(name, partitionKey);
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
    await this.createDocument("sessions", full, full.id);
  }

  async getSession(id: string): Promise<Session | null> {
    try {
      return await this.readDocument("sessions", id, id);
    } catch {
      return null;
    }
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    const session = await this.getSession(id);
    if (!session) throw new Error("Session not found: " + id);
    const updated = { ...session, ...updates };
    await this.replaceDocument("sessions", id, id, updated);
  }

  async listSessions(filters?: { config_id?: string; status?: string; limit?: number }): Promise<Session[]> {
    let query = "SELECT * FROM c";
    const conditions: string[] = [];
    const params: Array<{ name: string; value: string }> = [];

    if (filters?.config_id) {
      conditions.push("c.config_id = @configId");
      params.push({ name: "@configId", value: filters.config_id });
    }
    if (filters?.status) {
      conditions.push("c.status = @status");
      params.push({ name: "@status", value: filters.status });
    }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY c.started_at DESC";

    const results = await this.queryDocuments("sessions", query, params);
    return filters?.limit ? results.slice(0, filters.limit) : results;
  }

  // ── Messages ─────────────────────────────────────────────

  async insertMessage(msg: Omit<Message, "id" | "created_at">): Promise<string | number> {
    const id = this.generateId();
    const full: Message = {
      ...msg,
      id,
      created_at: new Date().toISOString(),
    };
    await this.createDocument("messages", full, msg.session_id);
    return id;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.queryDocuments(
      "messages",
      "SELECT * FROM c WHERE c.session_id = @sid ORDER BY c.turn_number ASC, c.created_at ASC",
      [{ name: "@sid", value: sessionId }]
    );
  }

  // ── Coded Themes ─────────────────────────────────────────

  async insertThemes(themes: Omit<CodedTheme, "id" | "created_at">[]): Promise<void> {
    const now = new Date().toISOString();
    for (const t of themes) {
      const full: CodedTheme = {
        ...t,
        id: this.generateId(),
        created_at: now,
      };
      await this.createDocument("coded_themes", full, t.session_id);
    }
  }

  async getSessionThemes(sessionId: string): Promise<CodedTheme[]> {
    return this.queryDocuments(
      "coded_themes",
      "SELECT * FROM c WHERE c.session_id = @sid ORDER BY c.turn_number ASC",
      [{ name: "@sid", value: sessionId }]
    );
  }

  // ── Events ───────────────────────────────────────────────

  async insertEvent(event: Omit<SessionEvent, "id" | "created_at">): Promise<void> {
    const full: SessionEvent = {
      ...event,
      id: this.generateId(),
      created_at: new Date().toISOString(),
    };
    await this.createDocument("events", full, event.session_id);
  }

  async getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.queryDocuments(
      "events",
      "SELECT * FROM c WHERE c.session_id = @sid ORDER BY c.created_at ASC",
      [{ name: "@sid", value: sessionId }]
    );
  }

  // ── Cosmos DB REST API helpers ─────────────────────────────

  private async createDatabaseIfNotExists(): Promise<void> {
    try {
      await this.cosmosRequest("POST", "/dbs", { id: this.database });
    } catch (e: any) {
      if (!e.message?.includes("409")) throw e;
    }
  }

  private async createContainerIfNotExists(name: string, partitionKeyPath: string): Promise<void> {
    try {
      await this.cosmosRequest("POST", `/dbs/${this.database}/colls`, {
        id: name,
        partitionKey: { paths: [partitionKeyPath], kind: "Hash" },
      });
    } catch (e: any) {
      if (!e.message?.includes("409")) throw e;
    }
  }

  private async createDocument(container: string, doc: Record<string, unknown>, partitionKey: string): Promise<void> {
    await this.cosmosRequest(
      "POST",
      `/dbs/${this.database}/colls/${container}/docs`,
      doc,
      { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) }
    );
  }

  private async readDocument(container: string, docId: string, partitionKey: string): Promise<any> {
    return this.cosmosRequest(
      "GET",
      `/dbs/${this.database}/colls/${container}/docs/${docId}`,
      undefined,
      { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) }
    );
  }

  private async replaceDocument(container: string, docId: string, partitionKey: string, doc: Record<string, unknown>): Promise<void> {
    await this.cosmosRequest(
      "PUT",
      `/dbs/${this.database}/colls/${container}/docs/${docId}`,
      doc,
      { "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]) }
    );
  }

  private async queryDocuments(
    container: string,
    query: string,
    parameters?: Array<{ name: string; value: string }>
  ): Promise<any[]> {
    const body = { query, parameters: parameters || [] };
    const result = await this.cosmosRequest(
      "POST",
      `/dbs/${this.database}/colls/${container}/docs`,
      body,
      {
        "Content-Type": "application/query+json",
        "x-ms-documentdb-isquery": "true",
        "x-ms-documentdb-query-enablecrosspartition": "true",
      }
    );
    return result.Documents || [];
  }

  private async cosmosRequest(
    method: string,
    resourcePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<any> {
    const date = new Date().toUTCString();
    const resourceType = this.getResourceType(resourcePath);
    const resourceId = this.getResourceId(resourcePath);

    const authToken = this.generateAuthToken(method, resourceType, resourceId, date);

    const headers: Record<string, string> = {
      Authorization: authToken,
      "x-ms-date": date,
      "x-ms-version": "2018-12-31",
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    const url = this.endpoint + resourcePath;
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Cosmos DB ${method} ${resourcePath} failed ${resp.status}: ${err}`);
    }

    if (resp.status === 204) return {};
    return resp.json();
  }

  private generateAuthToken(method: string, resourceType: string, resourceId: string, date: string): string {
    const payload = `${method.toLowerCase()}\n${resourceType}\n${resourceId}\n${date.toLowerCase()}\n\n`;
    const key = Buffer.from(this.key, "base64");
    const hmac = crypto.createHmac("sha256", key).update(payload).digest("base64");
    return encodeURIComponent(`type=master&ver=1.0&sig=${hmac}`);
  }

  private getResourceType(path: string): string {
    const segments = path.split("/").filter(Boolean);
    return segments[segments.length - 1] === "docs"
      ? "docs"
      : segments.length % 2 === 0
        ? segments[segments.length - 1]
        : segments[segments.length - 2] || "";
  }

  private getResourceId(path: string): string {
    const segments = path.split("/").filter(Boolean);
    if (segments.length % 2 === 0) {
      return segments.join("/");
    }
    return segments.slice(0, -1).join("/");
  }

  private generateId(): string {
    return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }
}
