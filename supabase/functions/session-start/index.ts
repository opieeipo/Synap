import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createSession, insertEvent, insertMessage } from "../_shared/db.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { session_id, interview_config } = await req.json();

    if (!session_id || !interview_config) {
      return jsonResponse(
        { error: "session_id and interview_config are required" },
        400
      );
    }

    // Create session with full config snapshot
    await createSession(session_id, interview_config.id, interview_config);

    // Record consent event
    await insertEvent(session_id, "consent_accepted", {
      config_id: interview_config.id,
      config_version: interview_config.version,
    });

    // Store the AI greeting as the first message
    const greeting = interview_config.persona?.greeting || "Hello, thanks for joining.";
    await insertMessage({
      session_id,
      role: "ai",
      content: greeting,
      turn_number: 0,
      question_id: interview_config.guide?.questions?.[0]?.id || "intro",
    });

    return jsonResponse({
      session_id,
      greeting,
      status: "active",
    });
  } catch (err) {
    console.error("[session-start] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
