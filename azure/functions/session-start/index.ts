import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getStorageAdapter } from "../../storage/factory";

export async function sessionStart(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (req.method === "OPTIONS") return corsResponse();

  try {
    const body = await req.json() as any;
    const { session_id, interview_config, participant_profile } = body;

    if (!session_id || !interview_config) {
      return jsonResponse({ error: "session_id and interview_config are required" }, 400);
    }

    const storageConfig = interview_config.storage || { provider: process.env.STORAGE_PROVIDER || "json-file", base_dir: process.env.STORAGE_BASE_DIR || "./data" };
    const storage = await getStorageAdapter(storageConfig);

    await storage.createSession({
      id: session_id,
      config_id: interview_config.id,
      config_snapshot: interview_config,
      participant_profile: participant_profile || undefined,
    });

    await storage.insertEvent({
      session_id,
      event_type: "consent_accepted",
      payload: {
        config_id: interview_config.id,
        config_version: interview_config.version,
      },
    });

    const greeting = interview_config.persona?.greeting || "Hello, thanks for joining.";
    await storage.insertMessage({
      session_id,
      role: "ai",
      content: greeting,
      turn_number: 0,
      question_id: interview_config.guide?.questions?.[0]?.id || "intro",
    });

    return jsonResponse({ session_id, greeting, status: "active" });
  } catch (err: any) {
    context.error("[session-start] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
}

function jsonResponse(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function corsResponse(): HttpResponseInit {
  return {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  };
}

export default { handler: sessionStart };
