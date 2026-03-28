/**
 * Multi-provider AI adapter (Node.js version for Azure Functions)
 * Same interface as the Supabase Deno version but uses Node.js APIs.
 */

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIResponse {
  content: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ProviderConfig {
  provider: "claude" | "openai" | "azure" | "gemini";
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function callAI(messages: AIMessage[], config: ProviderConfig): Promise<AIResponse> {
  switch (config.provider) {
    case "claude": return callClaude(messages, config);
    case "openai": return callOpenAI(messages, config);
    case "azure": return callAzure(messages, config);
    case "gemini": return callGemini(messages, config);
    default: throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

async function callClaude(messages: AIMessage[], config: ProviderConfig): Promise<AIResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const system = messages.find((m) => m.role === "system")?.content || "";
  const chatMessages = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-20250514",
      max_tokens: config.max_tokens || 1024,
      temperature: config.temperature ?? 0.7,
      system,
      messages: chatMessages,
    }),
  });

  if (!resp.ok) throw new Error(`Claude API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return { content: data.content[0].text, usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 } };
}

async function callOpenAI(messages: AIMessage[], config: ProviderConfig): Promise<AIResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: config.model || "gpt-4o", max_tokens: config.max_tokens || 1024, temperature: config.temperature ?? 0.7, messages }),
  });

  if (!resp.ok) throw new Error(`OpenAI API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return { content: data.choices[0].message.content, usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
}

async function callAzure(messages: AIMessage[], config: ProviderConfig): Promise<AIResponse> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = config.model || process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";

  if (!apiKey || !endpoint || !deployment) throw new Error("Azure OpenAI requires AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and deployment name");

  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({ max_tokens: config.max_tokens || 1024, temperature: config.temperature ?? 0.7, messages }),
  });

  if (!resp.ok) throw new Error(`Azure OpenAI error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return { content: data.choices[0].message.content, usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
}

async function callGemini(messages: AIMessage[], config: ProviderConfig): Promise<AIResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const model = config.model || "gemini-2.0-flash";
  const systemMsg = messages.find((m) => m.role === "system")?.content || "";
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: config.max_tokens || 1024, temperature: config.temperature ?? 0.7 },
    }),
  });

  if (!resp.ok) throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) throw new Error("Gemini returned no content");
  return { content: candidate.content.parts[0].text, usage: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: data.usageMetadata?.candidatesTokenCount || 0 } };
}
