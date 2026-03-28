import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    // Verify the caller is an admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Use the caller's token to check their role
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: callerData, error: callerError } = await callerClient
      .from("researchers")
      .select("role")
      .single();

    if (callerError || !callerData || callerData.role !== "admin") {
      return jsonResponse({ error: "Only admins can invite users" }, 403);
    }

    // Parse request
    const { email, display_name, role } = await req.json();
    if (!email) return jsonResponse({ error: "email is required" }, 400);

    // Use service role to create the user
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Invite user via Supabase Auth (sends magic link email)
    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { display_name: display_name || email },
    });

    if (inviteError) {
      return jsonResponse({ error: inviteError.message }, 400);
    }

    // Update the researcher's role if not default
    if (role && role !== "researcher" && inviteData.user) {
      await adminClient
        .from("researchers")
        .update({ role, display_name: display_name || email })
        .eq("id", inviteData.user.id);
    } else if (display_name && inviteData.user) {
      await adminClient
        .from("researchers")
        .update({ display_name })
        .eq("id", inviteData.user.id);
    }

    return jsonResponse({
      user_id: inviteData.user?.id,
      email: inviteData.user?.email,
      message: "Invite sent to " + email,
    });
  } catch (err) {
    console.error("[invite-user] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
