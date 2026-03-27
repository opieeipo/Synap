# Synap

AI-powered qualitative research interviewing tool. Researchers define interview guides with branching logic and coding schemas; participants interact through a chat interface where an AI conducts the interview, applies thematic codes in real time, and stores structured transcripts.

## Architecture

Synap uses a three-layer design: a portable frontend shell, an environment-aware orchestration adapter, and pluggable backends.

### Frontend Shell

Pure HTML + vanilla JS — no frameworks, no build toolchain, zero external dependencies. The entire UI ships as a single `.html` file or a small `/static` folder that can be embedded in a SharePoint page, a Teams tab, an iframe, or served as a standalone URL.

On startup, the frontend loads a JSON interview config that defines the session. A consent/disclosure modal must be explicitly accepted before the chat begins. That acceptance event (timestamped, with participant token) is the first record written to storage.

The frontend operates in two modes:
- **Mock mode** — Local-only with canned responses and keyword-based theme detection. No backend required.
- **Live mode** — Connects to Supabase Edge Functions for real AI responses and persistent storage.

### Orchestration Adapter

The environment split is handled here. In corporate environments it runs as an **Azure Function** or **Power Automate flow**. In public deployments it runs as a **Supabase Edge Function** (Deno). Both expose the same contract to the frontend:

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session-start` | POST | Creates session, records consent, returns greeting |
| `/chat` | POST | Sends user message, returns AI reply + coded themes |
| `/session-end` | POST | Marks session complete |

**Chat request/response:**

```json
// Request
{ "session_id": "...", "message": "...", "interview_config_id": "..." }

// Response
{ "reply": "...", "coded_themes": [...], "next_question_hint": "...", "turn_number": 1, "max_turns": 30 }
```

On each turn, the adapter:
1. Builds the system prompt (injecting interview guide, coding schema, and position in the question tree)
2. Routes to the configured AI provider
3. Runs a parallel AI pass to extract and tag themes from the participant's response
4. Persists messages, themes, and events to the database

### AI Providers

Synap supports four configurable AI backends. Set `ai_provider` in the interview config to switch between them:

| Provider | Config Value | Env Var(s) Required |
|----------|-------------|-------------------|
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| Mock (no API) | `mock` | None |

### Interview Config (JSON)

The researcher's primary artifact. Defines:

- **Guide** — Ordered question topics with probe suggestions
- **Branching rules** — `if answer_contains("theme_X") -> follow_up_id`
- **Coding schema** — Thematic codes the AI applies on the fly
- **IRB disclosure text** — Verbatim consent language
- **AI persona and constraints** — System prompt the model receives
- **Settings** — AI provider, model, temperature, Supabase connection

See `configs/sample.json` for a complete example and `configs/CONFIG_GUIDE.md` for detailed field-by-field documentation.

### Database Schema

Supabase (Postgres) with four tables:

- **sessions** — One row per interview, stores full config snapshot
- **messages** — Complete transcript with turn numbers and active question IDs
- **coded_themes** — AI-extracted thematic codes per message with confidence scores
- **events** — Consent acceptance, interview end, errors

## Project Structure

```
Synap/
├── index.html                          # Main frontend shell
├── run.sh                              # macOS/Linux launcher
├── run.bat                             # Windows launcher
├── configs/
│   ├── sample.json                     # Example interview config
│   └── CONFIG_GUIDE.md                 # Field-by-field config documentation
├── admin.html                          # Researcher admin dashboard
├── static/
│   ├── css/
│   │   ├── synap.css                   # Interview UI styles
│   │   └── admin.css                   # Admin dashboard styles
│   └── js/
│       ├── synap.js                    # Frontend logic (mock + live modes)
│       └── admin.js                    # Admin dashboard logic
├── supabase/
│   ├── config.toml                     # Supabase project config (created by supabase init)
│   ├── migrations/
│   │   └── 001_create_tables.sql       # Database schema
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts         # Multi-provider AI adapter
│       │   ├── prompt-builder.ts       # System prompt + coding prompts
│       │   └── db.ts                   # Supabase client + CRUD helpers
│       ├── chat/index.ts               # /chat endpoint
│       ├── session-start/index.ts      # /session-start endpoint
│       └── session-end/index.ts        # /session-end endpoint
├── .env.example                        # Environment variable template
└── .gitignore
```

## Deployment Targets

| Environment | Orchestration | Storage | Auth |
|-------------|--------------|---------|------|
| Corporate | Azure Function / Power Automate | SharePoint | Azure AD |
| Public | Supabase Edge Function | Supabase (Postgres) | Supabase Auth |

## Getting Started

### Mock Mode (no backend required)

```bash
./run.sh                            # Default config (configs/sample.json)
./run.sh configs/my-study.json      # Specific config
```

Or on Windows:
```
run.bat
run.bat configs\my-study.json
```

The launcher starts a local server and opens the browser automatically.

### Live Mode (Supabase)

**Prerequisites:**
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- A Supabase project created via the [Supabase Dashboard](https://supabase.com/dashboard)
- Your project ref (the ID from your dashboard URL, e.g., `https://supabase.com/dashboard/project/abcdefghijklmnop`)

**Setup:**

1. Copy `.env.example` to `.env` and fill in your Supabase and AI provider credentials:
   ```bash
   cp .env.example .env
   ```

2. Initialize and link Supabase to your project:
   ```bash
   supabase init        # Creates config.toml (detects existing supabase/ directory)
   supabase link --project-ref your-project-ref
   ```

3. Run the database migration to create tables:
   ```bash
   supabase db push
   ```

4. Set secrets so Edge Functions can access your API keys:
   ```bash
   supabase secrets set --env-file .env
   ```
   > **Note:** You'll see warnings that `SUPABASE_` prefixed vars are skipped — this is expected. Supabase injects those automatically. Your AI provider keys (e.g., `ANTHROPIC_API_KEY`) are what get pushed.

5. Deploy the Edge Functions:
   ```bash
   supabase functions deploy session-start
   supabase functions deploy chat
   supabase functions deploy session-end
   ```

6. Copy `configs/sample.json` to a new config and update it:
   ```bash
   cp configs/sample.json configs/my-study.json
   ```
   Set the following in the `settings` block:
   - `supabase_url` — your project URL (e.g., `"https://abcdefghijklmnop.supabase.co"`)
   - `supabase_anon_key` — your project's **anon / public** key. This is a long JWT starting with `eyJhbGciOi...`, found in Dashboard > Settings > API > Project API keys.
   - `ai_provider` — set to `"claude"`, `"openai"`, `"azure"`, or `"gemini"`

7. Launch with your config:
   ```bash
   ./run.sh configs/my-study.json
   ```

## Build Phases

1. **Static chatbot** — HTML chat UI with mock AI and consent flow. *(Complete)*
2. **Supabase backend** — Edge Functions, multi-provider AI, persistent storage. *(Complete)*
3. **Azure/SharePoint adapter** — Corporate deployment target sharing the same frontend.
4. **Researcher admin UI** — Dashboard for reviewing transcripts, coded themes, and exporting data. *(Complete)*

### Admin Dashboard

Access the admin UI at `admin.html` (e.g., `http://localhost:8000/admin.html`). Connect using your Supabase URL and **service role key** (not the anon key — the admin needs full read access).

Features:
- **Sessions** — View all interview sessions with status, turn count, and duration. Filter by study or status.
- **Transcripts** — Click any session to read the full transcript with role labels, turn numbers, and detected themes.
- **Themes** — Aggregated view of all detected themes across sessions with occurrence counts, session counts, and average confidence scores.
- **Export** — Download sessions, transcripts, coded themes, or events as CSV or JSON. Filter exports by study.

## License

TBD
