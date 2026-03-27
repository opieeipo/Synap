# Interview Configuration Guide

This document explains every field in a Synap interview configuration file. Use `sample.json` as a starting point — copy it, rename it, and customize it for your study.

## Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for this interview config. Used to link sessions back to the study. Use lowercase with hyphens (e.g., `"exit-interviews-2026"`). |
| `title` | string | Yes | Human-readable name shown on the consent screen. |
| `version` | string | Yes | Version number for tracking config changes over time. Stored with each session so you know which version a participant saw. |
| `description` | string | No | Internal description of the study for researcher reference. Not shown to participants. |

## IRB Section (`irb`)

The IRB block defines the informed consent content displayed to participants before the interview begins. Participants must explicitly accept before proceeding.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `disclosure` | string | Yes | The full informed consent text shown to participants. Should include: purpose of the study, how data will be used, that participation is voluntary, and how to withdraw. Use your IRB-approved language verbatim. |
| `principal_investigator` | string | No | Name of the PI. Displayed below the disclosure. |
| `protocol_number` | string | No | IRB protocol or approval number for reference. |
| `contact_email` | string | No | Contact email for questions about the study. |
| `institution` | string | No | Affiliated institution or organization. |

## Persona Section (`persona`)

Controls how the AI interviewer presents itself and behaves during the interview.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name for the AI interviewer. |
| `system_prompt` | string | Yes | The core instructions given to the AI model. This shapes the interviewer's tone, behavior, and boundaries. See [Writing a Good System Prompt](#writing-a-good-system-prompt) below. |
| `greeting` | string | Yes | The first message shown to the participant after they accept consent. Should set the tone and invite them to begin. |

### Writing a Good System Prompt

The system prompt is the most important field for interview quality. A good prompt should:

- Define the interviewer's role and tone (e.g., warm, empathetic, curious)
- Set behavioral rules (one question at a time, no opinions or advice)
- Specify response length (2-3 sentences keeps the conversation flowing)
- Include active listening instructions (reflect back before asking the next question)
- Establish boundaries (what to do if the participant goes off-topic)

The system prompt you write here is combined with the interview guide and coding schema automatically — you don't need to repeat those details in the prompt.

## Guide Section (`guide`)

Defines the interview structure: the questions to ask, follow-up probes, branching logic, and closing message.

### Questions (`guide.questions`)

An ordered array of question objects. The AI works through these in sequence but adapts naturally to the conversation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for this question (e.g., `"q1"`, `"q2"`). Used in branching rules and session tracking. |
| `topic` | string | Yes | Short label for the topic area. Displayed in the chat header so the participant knows what area is being discussed. |
| `text` | string | Yes | The main question the AI should ask. This is guidance for the AI, not a script — it may rephrase naturally. |
| `probes` | string[] | No | Follow-up questions the AI can use to go deeper on this topic. The AI decides when to probe vs. when to move on based on the depth of the participant's response. |

**Example:**
```json
{
  "id": "q1",
  "topic": "Role Overview",
  "text": "Can you tell me about your current role and what a typical day looks like?",
  "probes": [
    "How long have you been in this role?",
    "What does a particularly good day look like?"
  ]
}
```

### Branching Rules (`guide.branching`)

Optional. Defines conditional follow-up questions that are inserted when specific themes are detected in a participant's responses.

Each branching rule has a **trigger** and a **follow-up** question:

| Field | Type | Description |
|-------|------|-------------|
| `trigger.after` | string | The question ID after which this rule is evaluated. |
| `trigger.if_themes` | string[] | Theme codes that activate this branch. If any of these themes are detected in the participant's responses, the follow-up is inserted. |
| `follow_up` | object | A question object (same structure as `guide.questions`) that gets asked before moving to the next main question. |

**Example:**
```json
{
  "trigger": { "after": "q2", "if_themes": ["conflict", "dysfunction"] },
  "follow_up": {
    "id": "q2a",
    "topic": "Conflict Resolution",
    "text": "You mentioned some friction. Can you tell me more about how those situations get resolved?",
    "probes": ["Who usually steps in?", "How do you feel afterward?"]
  }
}
```

This rule says: after question `q2`, if the themes `conflict` or `dysfunction` were detected, ask the follow-up before moving to `q3`.

### Closing (`guide.closing`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `closing` | string | Yes | The final message delivered when the interview ends. Should thank the participant and offer a chance to add anything. |

## Coding Schema (`coding_schema`)

Defines the thematic codes the AI uses to tag participant responses in real time. These codes are the foundation of your qualitative analysis.

### Themes (`coding_schema.themes`)

An array of theme objects:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Short machine-readable identifier (e.g., `"autonomy"`, `"conflict"`). Used in branching rules and stored in the database. Use lowercase with no spaces. |
| `label` | string | Yes | Human-readable name (e.g., `"Autonomy & Ownership"`). Shown in the admin UI and exports. |
| `description` | string | Yes | Brief description of what this theme captures. This is given to the AI so it knows what to look for — be specific. |

**Tips for designing your coding schema:**
- Start with 5-15 themes. Too many dilutes accuracy; too few misses nuance.
- Write descriptions from the AI's perspective: "Participant expresses..." or "References to..."
- Include both positive and negative themes for balanced analysis.
- Theme codes are used in branching rules — plan them together.
- You can refine themes between study rounds; each session stores the config snapshot it used.

**Example:**
```json
{ "code": "autonomy", "label": "Autonomy & Ownership", "description": "Sense of control over one's work" }
```

## Settings Section (`settings`)

Controls the AI provider, model configuration, and backend connection.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ai_provider` | string | Yes | `"mock"` | Which AI backend to use. Options: `"mock"`, `"claude"`, `"openai"`, `"azure"`, `"gemini"`. |
| `ai_model` | string | No | Provider default | Specific model to use. Examples: `"claude-sonnet-4-20250514"`, `"gpt-4o"`, `"gemini-2.0-flash"`. If omitted, each provider uses its default. |
| `temperature` | number | No | `0.7` | Controls response randomness (0.0 = deterministic, 1.0 = creative). 0.7 works well for interviews. |
| `max_tokens` | number | No | `1024` | Maximum length of each AI response in tokens. 1024 is sufficient for interview-style responses. |
| `max_turns` | number | No | `30` | Maximum number of participant messages before the interview auto-ends. Prevents runaway sessions. |
| `supabase_url` | string | No | `null` | Your Supabase project URL (e.g., `"https://abcdefg.supabase.co"`). Required for live mode. |
| `supabase_anon_key` | string | No | `null` | Your Supabase anon/public key. Found in Dashboard > Settings > API. Required for live mode. |
| `endpoint` | string | No | `null` | Override for a custom backend URL. If set, used instead of constructing the URL from `supabase_url`. |

### Provider Details

| Provider | `ai_provider` | `ai_model` Default | Required Env Var(s) |
|----------|--------------|-------------------|-------------------|
| Mock (no API) | `"mock"` | N/A | None |
| Anthropic Claude | `"claude"` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| OpenAI | `"openai"` | `gpt-4o` | `OPENAI_API_KEY` |
| Azure OpenAI | `"azure"` | Uses `AZURE_OPENAI_DEPLOYMENT` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| Google Gemini | `"gemini"` | `gemini-2.0-flash` | `GEMINI_API_KEY` |

## Creating a New Config

1. Copy `sample.json` to a new file in the `configs/` folder:
   ```bash
   cp configs/sample.json configs/my-study.json
   ```

2. Update the `id`, `title`, `version`, and `description` for your study.

3. Replace the `irb` section with your approved consent language.

4. Write your `persona.system_prompt` and `persona.greeting`.

5. Define your `guide.questions` in the order you want them asked. Add `probes` for each.

6. Add `guide.branching` rules if you want conditional follow-ups based on detected themes.

7. Write your `guide.closing` message.

8. Define your `coding_schema.themes` — these should align with your research questions.

9. Set `settings.ai_provider` and connection details for your deployment.

10. Launch with your config:
    ```bash
    ./run.sh configs/my-study.json
    ```
