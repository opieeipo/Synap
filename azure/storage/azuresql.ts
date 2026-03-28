/**
 * Azure SQL Storage Adapter
 *
 * Uses tedious (the Node.js TDS driver) for Azure SQL Database.
 * Creates tables on init if they don't exist.
 *
 * Config:
 *   {
 *     provider: "azuresql",
 *     sql_server: "your-server.database.windows.net",
 *     sql_database: "synap",
 *     sql_user: "synap_admin",
 *     sql_password: "your-password"
 *   }
 *
 * Or via env vars: SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
 *
 * NOTE: Requires `npm install tedious` in the Azure Functions project.
 */

import type {
  StorageAdapter,
  StorageConfig,
  Session,
  Message,
  CodedTheme,
  SessionEvent,
} from "./interface.ts";

// Dynamic import for tedious — not available in all environments
let Connection: any;
let Request: any;
let TYPES: any;

async function loadTedious() {
  if (Connection) return;
  try {
    const tedious = await import("tedious");
    Connection = tedious.Connection;
    Request = tedious.Request;
    TYPES = tedious.TYPES;
  } catch {
    throw new Error("Azure SQL adapter requires the 'tedious' package. Run: npm install tedious");
  }
}

export class AzureSqlAdapter implements StorageAdapter {
  private config: StorageConfig;
  private connectionConfig: any;

  constructor(config: StorageConfig) {
    this.config = config;

    const server = (config.sql_server as string) || process.env.SQL_SERVER || "";
    const database = (config.sql_database as string) || process.env.SQL_DATABASE || "synap";
    const user = (config.sql_user as string) || process.env.SQL_USER || "";
    const password = (config.sql_password as string) || process.env.SQL_PASSWORD || "";

    if (!server || !user || !password) {
      throw new Error("Azure SQL requires sql_server, sql_user, and sql_password (or SQL_SERVER/SQL_USER/SQL_PASSWORD env vars)");
    }

    this.connectionConfig = {
      server,
      authentication: {
        type: "default",
        options: { userName: user, password },
      },
      options: {
        database,
        encrypt: true,
        trustServerCertificate: false,
        rowCollectionOnRequestCompletion: true,
      },
    };
  }

  async init(): Promise<void> {
    await loadTedious();
    await this.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sessions' AND xtype='U')
      CREATE TABLE sessions (
        id NVARCHAR(255) PRIMARY KEY,
        config_id NVARCHAR(255) NOT NULL,
        config_snapshot NVARCHAR(MAX) NOT NULL,
        participant_token NVARCHAR(255),
        participant_profile NVARCHAR(MAX),
        status NVARCHAR(50) NOT NULL DEFAULT 'active',
        started_at DATETIMEOFFSET NOT NULL DEFAULT GETUTCDATE(),
        ended_at DATETIMEOFFSET,
        end_reason NVARCHAR(100),
        turn_count INT NOT NULL DEFAULT 0,
        metadata NVARCHAR(MAX)
      )
    `);
    await this.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='messages' AND xtype='U')
      CREATE TABLE messages (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        session_id NVARCHAR(255) NOT NULL,
        role NVARCHAR(10) NOT NULL,
        content NVARCHAR(MAX) NOT NULL,
        turn_number INT NOT NULL,
        question_id NVARCHAR(50),
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETUTCDATE()
      )
    `);
    await this.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='coded_themes' AND xtype='U')
      CREATE TABLE coded_themes (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        session_id NVARCHAR(255) NOT NULL,
        message_id BIGINT,
        turn_number INT NOT NULL,
        theme_code NVARCHAR(100) NOT NULL,
        theme_label NVARCHAR(255),
        confidence REAL,
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETUTCDATE()
      )
    `);
    await this.exec(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='events' AND xtype='U')
      CREATE TABLE events (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        session_id NVARCHAR(255) NOT NULL,
        event_type NVARCHAR(100) NOT NULL,
        payload NVARCHAR(MAX),
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETUTCDATE()
      )
    `);
  }

  // ── Sessions ─────────────────────────────────────────────

  async createSession(session: Partial<Session> & { id: string; config_id: string; config_snapshot: Record<string, unknown> }): Promise<void> {
    await this.exec(
      `INSERT INTO sessions (id, config_id, config_snapshot, participant_token, participant_profile, status, turn_count)
       VALUES (@id, @configId, @snapshot, @token, @profile, 'active', 0)`,
      [
        { name: "id", type: TYPES.NVarChar, value: session.id },
        { name: "configId", type: TYPES.NVarChar, value: session.config_id },
        { name: "snapshot", type: TYPES.NVarChar, value: JSON.stringify(session.config_snapshot) },
        { name: "token", type: TYPES.NVarChar, value: session.participant_token || null },
        { name: "profile", type: TYPES.NVarChar, value: session.participant_profile ? JSON.stringify(session.participant_profile) : null },
      ]
    );
  }

  async getSession(id: string): Promise<Session | null> {
    const rows = await this.query(
      "SELECT * FROM sessions WHERE id = @id",
      [{ name: "id", type: TYPES.NVarChar, value: id }]
    );
    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [{ name: "id", type: TYPES.NVarChar, value: id }];

    if (updates.status !== undefined) {
      sets.push("status = @status");
      params.push({ name: "status", type: TYPES.NVarChar, value: updates.status });
    }
    if (updates.turn_count !== undefined) {
      sets.push("turn_count = @turnCount");
      params.push({ name: "turnCount", type: TYPES.Int, value: updates.turn_count });
    }
    if (updates.ended_at !== undefined) {
      sets.push("ended_at = @endedAt");
      params.push({ name: "endedAt", type: TYPES.NVarChar, value: updates.ended_at });
    }
    if (updates.end_reason !== undefined) {
      sets.push("end_reason = @endReason");
      params.push({ name: "endReason", type: TYPES.NVarChar, value: updates.end_reason });
    }

    if (sets.length === 0) return;
    await this.exec(`UPDATE sessions SET ${sets.join(", ")} WHERE id = @id`, params);
  }

  async listSessions(filters?: { config_id?: string; status?: string; limit?: number }): Promise<Session[]> {
    let sql = "SELECT TOP " + (filters?.limit || 100) + " * FROM sessions";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.config_id) {
      conditions.push("config_id = @configId");
      params.push({ name: "configId", type: TYPES.NVarChar, value: filters.config_id });
    }
    if (filters?.status) {
      conditions.push("status = @status");
      params.push({ name: "status", type: TYPES.NVarChar, value: filters.status });
    }
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY started_at DESC";

    const rows = await this.query(sql, params);
    return rows.map((r: any) => this.rowToSession(r));
  }

  // ── Messages ─────────────────────────────────────────────

  async insertMessage(msg: Omit<Message, "id" | "created_at">): Promise<string | number> {
    const rows = await this.query(
      `INSERT INTO messages (session_id, role, content, turn_number, question_id)
       OUTPUT INSERTED.id
       VALUES (@sid, @role, @content, @turn, @qid)`,
      [
        { name: "sid", type: TYPES.NVarChar, value: msg.session_id },
        { name: "role", type: TYPES.NVarChar, value: msg.role },
        { name: "content", type: TYPES.NVarChar, value: msg.content },
        { name: "turn", type: TYPES.Int, value: msg.turn_number },
        { name: "qid", type: TYPES.NVarChar, value: msg.question_id || null },
      ]
    );
    return rows[0]?.id || 0;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.query(
      "SELECT * FROM messages WHERE session_id = @sid ORDER BY turn_number ASC, created_at ASC",
      [{ name: "sid", type: TYPES.NVarChar, value: sessionId }]
    );
  }

  // ── Coded Themes ─────────────────────────────────────────

  async insertThemes(themes: Omit<CodedTheme, "id" | "created_at">[]): Promise<void> {
    for (const t of themes) {
      await this.exec(
        `INSERT INTO coded_themes (session_id, message_id, turn_number, theme_code, theme_label, confidence)
         VALUES (@sid, @mid, @turn, @code, @label, @conf)`,
        [
          { name: "sid", type: TYPES.NVarChar, value: t.session_id },
          { name: "mid", type: TYPES.BigInt, value: t.message_id || null },
          { name: "turn", type: TYPES.Int, value: t.turn_number },
          { name: "code", type: TYPES.NVarChar, value: t.theme_code },
          { name: "label", type: TYPES.NVarChar, value: t.theme_label || null },
          { name: "conf", type: TYPES.Real, value: t.confidence || null },
        ]
      );
    }
  }

  async getSessionThemes(sessionId: string): Promise<CodedTheme[]> {
    return this.query(
      "SELECT * FROM coded_themes WHERE session_id = @sid ORDER BY turn_number ASC",
      [{ name: "sid", type: TYPES.NVarChar, value: sessionId }]
    );
  }

  // ── Events ───────────────────────────────────────────────

  async insertEvent(event: Omit<SessionEvent, "id" | "created_at">): Promise<void> {
    await this.exec(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES (@sid, @type, @payload)`,
      [
        { name: "sid", type: TYPES.NVarChar, value: event.session_id },
        { name: "type", type: TYPES.NVarChar, value: event.event_type },
        { name: "payload", type: TYPES.NVarChar, value: event.payload ? JSON.stringify(event.payload) : null },
      ]
    );
  }

  async getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    const rows = await this.query(
      "SELECT * FROM events WHERE session_id = @sid ORDER BY created_at ASC",
      [{ name: "sid", type: TYPES.NVarChar, value: sessionId }]
    );
    return rows.map((r: any) => ({
      ...r,
      payload: r.payload ? JSON.parse(r.payload) : {},
    }));
  }

  // ── SQL helpers ────────────────────────────────────────────

  private rowToSession(row: any): Session {
    return {
      ...row,
      config_snapshot: typeof row.config_snapshot === "string" ? JSON.parse(row.config_snapshot) : row.config_snapshot,
      participant_profile: row.participant_profile ? JSON.parse(row.participant_profile) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private exec(sql: string, params?: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Connection(this.connectionConfig);
      conn.on("connect", (err: any) => {
        if (err) return reject(err);
        const req = new Request(sql, (err: any) => {
          conn.close();
          if (err) reject(err);
          else resolve();
        });
        if (params) params.forEach((p) => req.addParameter(p.name, p.type, p.value));
        conn.execSql(req);
      });
      conn.connect();
    });
  }

  private query(sql: string, params?: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const conn = new Connection(this.connectionConfig);
      conn.on("connect", (err: any) => {
        if (err) return reject(err);
        const req = new Request(sql, (err: any, _rowCount: number, rows: any[]) => {
          conn.close();
          if (err) return reject(err);
          // Convert tedious row format to plain objects
          const results = (rows || []).map((row: any[]) => {
            const obj: any = {};
            row.forEach((col: any) => { obj[col.metadata.colName] = col.value; });
            return obj;
          });
          resolve(results);
        });
        if (params) params.forEach((p) => req.addParameter(p.name, p.type, p.value));
        conn.execSql(req);
      });
      conn.connect();
    });
  }
}
