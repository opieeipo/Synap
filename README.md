# Synap

AI-powered qualitative research interviewing tool. Researchers define interview guides with branching logic and coding schemas; participants interact through a chat interface where an AI conducts the interview, applies thematic codes in real time, and stores structured transcripts.

## Architecture

Synap uses a three-layer design: a portable frontend shell, an environment-aware orchestration adapter, and pluggable backends.

### Frontend Shell

Pure HTML + vanilla JS — no frameworks, no build toolchain, zero external dependencies. The entire UI ships as a single `.html` file or a small `/static` folder that can be embedded in a SharePoint page, a Teams tab, an iframe, or served as a standalone URL.

On startup, the frontend loads a JSON interview config that defines the session. A consent/disclosure modal must be explicitly accepted before the chat begins. That acceptance event (timestamped, with participant token) is the first record written to storage.

### Orchestration Adapter

The environment split is handled here. In corporate environments it runs as an **Azure Function** or **Power Automate flow**. In public deployments it runs as a **Supabase Edge Function** (Deno). Both expose the same contract to the frontend:

**Endpoint:** `POST /chat`

```json
// Request
{ "session_id": "...", "message": "...", "interview_config_id": "..." }

// Response
{ "reply": "...", "coded_themes": [...], "next_question_hint": "..." }
```

On each turn, the adapter:
1. Builds the system prompt (injecting interview guide, coding schema, and position in the question tree)
2. Routes to the configured AI provider
3. Runs a second AI pass to extract and tag themes from the response
4. Persists everything to storage

### Interview Config (JSON)

The researcher's primary artifact. Defines:

- **Guide** — Ordered question topics with probe suggestions
- **Branching rules** — `if answer_contains("theme_X") -> follow_up_id`
- **Coding schema** — Thematic codes the AI applies on the fly
- **IRB disclosure text** — Verbatim consent language
- **AI persona and constraints** — System prompt the model receives

## Deployment Targets

| Environment | Orchestration | Storage | Auth |
|-------------|--------------|---------|------|
| Corporate | Azure Function / Power Automate | SharePoint | Azure AD |
| Public | Supabase Edge Function | Supabase (Postgres) | Supabase Auth |

## Build Phases

1. **Static chatbot** — HTML chat UI that loads a config and talks to a single AI provider with no persistent storage. Proves the UX.
2. **Supabase backend** — Add orchestration layer with Supabase Edge Functions and Postgres storage for public deployment.
3. **Azure/SharePoint adapter** — Add corporate deployment target sharing the same frontend.
4. **Researcher admin UI** — Dashboard for reviewing transcripts, coded themes, and managing interview configs.

## License

TBD
