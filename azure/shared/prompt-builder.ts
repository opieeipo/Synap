/**
 * Prompt builder (Node.js version for Azure Functions)
 * Identical logic to the Supabase version — shared contract.
 */

export interface InterviewState {
  question_index: number;
  turn_count: number;
  pending_branch_id: string | null;
  detected_themes: string[];
}

export function buildSystemPrompt(config: any, state: InterviewState): string {
  const parts: string[] = [];

  parts.push(config.persona.system_prompt);

  parts.push("\n\n## Interview Guide\n");
  parts.push("You are conducting a semi-structured interview. Here are the topics to cover in order:\n");

  for (let i = 0; i < config.guide.questions.length; i++) {
    const q = config.guide.questions[i];
    const marker = i === state.question_index ? " ← CURRENT" : i < state.question_index ? " ✓" : "";
    parts.push(`${i + 1}. [${q.id}] ${q.topic}${marker}`);
    parts.push(`   Question: "${q.text}"`);
    if (q.probes?.length) parts.push(`   Probes: ${q.probes.join(" / ")}`);
  }

  if (state.pending_branch_id && config.guide.branching) {
    const branch = config.guide.branching.find((b: any) => b.follow_up.id === state.pending_branch_id);
    if (branch) {
      parts.push(`\n**IMPORTANT: Before moving to the next main question, ask this follow-up:**`);
      parts.push(`"${branch.follow_up.text}"`);
      if (branch.follow_up.probes?.length) parts.push(`Probes: ${branch.follow_up.probes.join(" / ")}`);
    }
  }

  parts.push(`\nWhen all topics are covered, use this closing: "${config.guide.closing}"`);

  parts.push("\n\n## Rules");
  parts.push("- Ask ONE question at a time.");
  parts.push("- Use the participant's own words when reflecting back.");
  parts.push("- Probe deeper when answers are surface-level before advancing.");
  parts.push("- Do not offer opinions, advice, or judgments.");
  parts.push("- Keep your responses to 2-3 sentences before your next question.");
  parts.push("- Follow the question order but adapt naturally to the conversation flow.");
  parts.push(`- You are on turn ${state.turn_count} of the interview.`);

  if (config.coding_schema?.themes?.length) {
    parts.push("\n\n## Thematic Awareness");
    parts.push("Be aware of these themes in participant responses (for your context, not to mention aloud):");
    for (const t of config.coding_schema.themes) {
      parts.push(`- ${t.code}: ${t.description}`);
    }
  }

  return parts.join("\n");
}

export function buildCodingPrompt(
  userMessage: string,
  themes: Array<{ code: string; label: string; description: string }>
): string {
  return `You are a qualitative research coder. Analyze the following participant response and identify which thematic codes apply.

## Available Codes
${themes.map((t) => `- "${t.code}" (${t.label}): ${t.description}`).join("\n")}

## Participant Response
"${userMessage}"

## Instructions
Return a JSON array of objects with "code", "label", and "confidence" (0.0-1.0) for each theme detected. Only include themes that are clearly present. Return an empty array if none apply.

Respond with ONLY the JSON array, no other text.`;
}
