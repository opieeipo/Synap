import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getStorageAdapter } from "../../storage/factory";

export async function sessionEnd(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (req.method === "OPTIONS") return corsResponse();

  try {
    const body = await req.json() as any;
    const { session_id, reason } = body;

    if (!session_id) return jsonResponse({ error: "session_id is required" }, 400);

    const storageConfig = {
      provider: process.env.STORAGE_PROVIDER || "json-file",
      base_dir: process.env.STORAGE_BASE_DIR || "./data",
      cosmos_endpoint: process.env.COSMOS_ENDPOINT,
      cosmos_key: process.env.COSMOS_KEY,
      cosmos_database: process.env.COSMOS_DATABASE,
      sql_server: process.env.SQL_SERVER,
      sql_database: process.env.SQL_DATABASE,
      sql_user: process.env.SQL_USER,
      sql_password: process.env.SQL_PASSWORD,
      sharepoint_site_id: process.env.SP_SITE_ID,
      sharepoint_tenant_id: process.env.SP_TENANT_ID,
      sharepoint_client_id: process.env.SP_CLIENT_ID,
      sharepoint_client_secret: process.env.SP_CLIENT_SECRET,
    };

    const storage = await getStorageAdapter(storageConfig);
    const session = await storage.getSession(session_id);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);
    if (session.status !== "active") return jsonResponse({ error: "Session is already ended" }, 400);

    const endReason = reason || "participant_ended";

    await storage.updateSession(session_id, {
      status: "completed",
      ended_at: new Date().toISOString(),
      end_reason: endReason,
    });

    await storage.insertEvent({
      session_id,
      event_type: "interview_ended",
      payload: { reason: endReason },
    });

    return jsonResponse({ session_id, status: "completed", end_reason: endReason });
  } catch (err: any) {
    context.error("[session-end] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
}

function jsonResponse(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" },
    body: JSON.stringify(body),
  };
}

function corsResponse(): HttpResponseInit {
  return { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" } };
}

export default { handler: sessionEnd };
