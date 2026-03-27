import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSession, updateSession, insertEvent } from "../_shared/db.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    const { session_id, reason } = await req.json();

    if (!session_id) {
      return jsonResponse({ error: "session_id is required" }, 400);
    }

    const session = await getSession(session_id);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);

    if (session.status !== "active") {
      return jsonResponse({ error: "Session is already ended" }, 400);
    }

    const endReason = reason || "participant_ended";

    await updateSession(session_id, {
      status: "completed",
      ended_at: new Date().toISOString(),
      end_reason: endReason,
    });

    await insertEvent(session_id, "interview_ended", { reason: endReason });

    return jsonResponse({
      session_id,
      status: "completed",
      end_reason: endReason,
    });
  } catch (err) {
    console.error("[session-end] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
