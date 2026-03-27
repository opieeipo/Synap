import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { callAI, type AIMessage, type ProviderConfig } from "../_shared/ai-providers.ts";
import {
  buildSystemPrompt,
  buildCodingPrompt,
  type InterviewState,
} from "../_shared/prompt-builder.ts";
import {
  getSession,
  getMessages,
  insertMessage,
  insertThemes,
  updateSession,
  getSessionThemes,
} from "../_shared/db.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { session_id, message } = await req.json();

    if (!session_id || !message) {
      return jsonResponse({ error: "session_id and message are required" }, 400);
    }

    // Load session and its config snapshot
    const session = await getSession(session_id);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);
    if (session.status !== "active") {
      return jsonResponse({ error: "Session is no longer active" }, 400);
    }

    const config = session.config_snapshot;
    const providerConfig = resolveProvider(config);

    // Get conversation history
    const history = await getMessages(session_id);
    const sessionThemes = await getSessionThemes(session_id);
    const detectedThemeCodes = [...new Set(sessionThemes.map((t: { theme_code: string }) => t.theme_code))];

    // Determine interview state
    const turnNumber = session.turn_count + 1;
    const state: InterviewState = {
      question_index: deriveQuestionIndex(history, config),
      turn_count: turnNumber,
      pending_branch_id: checkBranching(config, history, detectedThemeCodes),
      detected_themes: detectedThemeCodes,
    };

    // Store user message
    const currentQuestionId = getCurrentQuestionId(config, state);
    const userMsgId = await insertMessage({
      session_id,
      role: "user",
      content: message,
      turn_number: turnNumber,
      question_id: currentQuestionId,
    });

    // Run theme coding on user message (parallel with interview response)
    const codingPromise = codeThemes(message, config, providerConfig, session_id, userMsgId, turnNumber);

    // Build conversation for AI
    const systemPrompt = buildSystemPrompt(config, state);
    const aiMessages: AIMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history
    for (const msg of history) {
      aiMessages.push({
        role: msg.role === "ai" ? "assistant" : "user",
        content: msg.content,
      });
    }

    // Add current user message
    aiMessages.push({ role: "user", content: message });

    // Call AI for interview response
    const aiResult = await callAI(aiMessages, providerConfig);

    // Store AI response
    await insertMessage({
      session_id,
      role: "ai",
      content: aiResult.content,
      turn_number: turnNumber,
      question_id: currentQuestionId,
    });

    // Wait for coding to finish
    const codedThemes = await codingPromise;

    // Update session turn count
    await updateSession(session_id, { turn_count: turnNumber });

    // Check if interview should end
    const maxTurns = config.settings?.max_turns || 30;
    const isLastQuestion = state.question_index >= config.guide.questions.length - 1;
    const nextHint = isLastQuestion && !state.pending_branch_id ? "closing" : currentQuestionId;

    return jsonResponse({
      reply: aiResult.content,
      coded_themes: codedThemes,
      next_question_hint: nextHint,
      turn_number: turnNumber,
      max_turns: maxTurns,
    });
  } catch (err) {
    console.error("[chat] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
});

// ── Theme coding ─────────────────────────────────────────────

async function codeThemes(
  userMessage: string,
  config: Record<string, unknown>,
  providerConfig: ProviderConfig,
  sessionId: string,
  messageId: number,
  turnNumber: number
): Promise<Array<{ code: string; label: string; confidence: number }>> {
  const schema = (config as any).coding_schema;
  if (!schema?.themes?.length) return [];

  try {
    const codingPrompt = buildCodingPrompt(userMessage, schema.themes);
    const codingConfig: ProviderConfig = {
      ...providerConfig,
      temperature: 0.2, // Lower temp for structured output
      max_tokens: 512,
    };

    const result = await callAI(
      [
        { role: "system", content: "You are a qualitative research coding assistant. Respond only with valid JSON." },
        { role: "user", content: codingPrompt },
      ],
      codingConfig
    );

    // Parse the JSON response
    const cleaned = result.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const themes = JSON.parse(cleaned);

    if (Array.isArray(themes)) {
      await insertThemes(sessionId, messageId, turnNumber, themes);
      return themes;
    }
    return [];
  } catch (err) {
    console.error("[chat] Theme coding error:", err);
    return []; // Non-fatal — don't break the interview
  }
}

// ── Interview state helpers ──────────────────────────────────

function deriveQuestionIndex(
  history: Array<{ role: string; content: string }>,
  config: any
): number {
  // Count AI messages (excluding greeting) to estimate position
  const aiMessages = history.filter((m) => m.role === "ai");
  // Rough heuristic: each main question takes ~2-4 AI turns
  // The AI manages its own pacing via the prompt; this just tracks position
  const questions = config.guide.questions;
  return Math.min(
    Math.floor(aiMessages.length / 2),
    questions.length - 1
  );
}

function checkBranching(
  config: any,
  _history: Array<{ role: string }>,
  detectedThemes: string[]
): string | null {
  if (!config.guide.branching) return null;

  for (const rule of config.guide.branching) {
    const match = rule.trigger.if_themes.some((t: string) =>
      detectedThemes.includes(t)
    );
    if (match) return rule.follow_up.id;
  }
  return null;
}

function getCurrentQuestionId(config: any, state: InterviewState): string {
  if (state.pending_branch_id) return state.pending_branch_id;
  const q = config.guide.questions[state.question_index];
  return q?.id || "unknown";
}

function resolveProvider(config: any): ProviderConfig {
  const settings = config.settings || {};
  return {
    provider: settings.ai_provider || "claude",
    model: settings.ai_model || undefined,
    temperature: settings.temperature ?? 0.7,
    max_tokens: settings.max_tokens ?? 1024,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
