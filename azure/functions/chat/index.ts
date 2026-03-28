import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { callAI, type AIMessage, type ProviderConfig } from "../../shared/ai-providers";
import { buildSystemPrompt, buildCodingPrompt, type InterviewState } from "../../shared/prompt-builder";
import { getStorageAdapter } from "../../storage/factory";

export async function chat(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (req.method === "OPTIONS") return corsResponse();

  try {
    const body = await req.json() as any;
    const { session_id, message } = body;

    if (!session_id || !message) {
      return jsonResponse({ error: "session_id and message are required" }, 400);
    }

    // Get storage adapter from session's config
    const storageConfig = resolveStorageConfig();
    const storage = await getStorageAdapter(storageConfig);

    const session = await storage.getSession(session_id);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);
    if (session.status !== "active") return jsonResponse({ error: "Session is no longer active" }, 400);

    const config = session.config_snapshot as any;
    const providerConfig = resolveProvider(config);

    // Get conversation history and themes
    const history = await storage.getMessages(session_id);
    const sessionThemes = await storage.getSessionThemes(session_id);
    const detectedThemeCodes = [...new Set(sessionThemes.map((t) => t.theme_code))];

    const turnNumber = session.turn_count + 1;
    const state: InterviewState = {
      question_index: deriveQuestionIndex(history, config),
      turn_count: turnNumber,
      pending_branch_id: checkBranching(config, detectedThemeCodes),
      detected_themes: detectedThemeCodes,
    };

    const currentQuestionId = getCurrentQuestionId(config, state);

    // Store user message
    const userMsgId = await storage.insertMessage({
      session_id,
      role: "user",
      content: message,
      turn_number: turnNumber,
      question_id: currentQuestionId,
    });

    // Theme coding (parallel with interview response)
    const codingPromise = codeThemes(message, config, providerConfig, storage, session_id, userMsgId, turnNumber);

    // Build conversation for AI
    const systemPrompt = buildSystemPrompt(config, state);
    const aiMessages: AIMessage[] = [{ role: "system", content: systemPrompt }];
    for (const msg of history) {
      aiMessages.push({ role: msg.role === "ai" ? "assistant" : "user", content: msg.content });
    }
    aiMessages.push({ role: "user", content: message });

    // Call AI
    const aiResult = await callAI(aiMessages, providerConfig);

    // Store AI response
    await storage.insertMessage({
      session_id,
      role: "ai",
      content: aiResult.content,
      turn_number: turnNumber,
      question_id: currentQuestionId,
    });

    const codedThemes = await codingPromise;

    await storage.updateSession(session_id, { turn_count: turnNumber });

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
  } catch (err: any) {
    context.error("[chat] Error:", err);
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
}

async function codeThemes(
  userMessage: string,
  config: any,
  providerConfig: ProviderConfig,
  storage: any,
  sessionId: string,
  messageId: string | number,
  turnNumber: number
): Promise<Array<{ code: string; label: string; confidence: number }>> {
  const schema = config.coding_schema;
  if (!schema?.themes?.length) return [];

  try {
    const codingPrompt = buildCodingPrompt(userMessage, schema.themes);
    const result = await callAI(
      [
        { role: "system", content: "You are a qualitative research coding assistant. Respond only with valid JSON." },
        { role: "user", content: codingPrompt },
      ],
      { ...providerConfig, temperature: 0.2, max_tokens: 512 }
    );

    const cleaned = result.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const themes = JSON.parse(cleaned);

    if (Array.isArray(themes)) {
      await storage.insertThemes(
        themes.map((t: any) => ({
          session_id: sessionId,
          message_id: messageId,
          turn_number: turnNumber,
          theme_code: t.code,
          theme_label: t.label,
          confidence: t.confidence,
        }))
      );
      return themes;
    }
    return [];
  } catch (err) {
    console.error("[chat] Theme coding error:", err);
    return [];
  }
}

function deriveQuestionIndex(history: any[], config: any): number {
  const aiMessages = history.filter((m) => m.role === "ai");
  return Math.min(Math.floor(aiMessages.length / 2), config.guide.questions.length - 1);
}

function checkBranching(config: any, detectedThemes: string[]): string | null {
  if (!config.guide.branching) return null;
  for (const rule of config.guide.branching) {
    if (rule.trigger.if_themes.some((t: string) => detectedThemes.includes(t))) return rule.follow_up.id;
  }
  return null;
}

function getCurrentQuestionId(config: any, state: InterviewState): string {
  if (state.pending_branch_id) return state.pending_branch_id;
  return config.guide.questions[state.question_index]?.id || "unknown";
}

function resolveProvider(config: any): ProviderConfig {
  const s = config.settings || {};
  return { provider: s.ai_provider || "claude", model: s.ai_model, temperature: s.temperature ?? 0.7, max_tokens: s.max_tokens ?? 1024 };
}

function resolveStorageConfig(): any {
  return {
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
  return { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" } };
}

export default { handler: chat };
