# Synap

AI-powered qualitative research interviewing tool. Researchers define interview guides with branching logic and coding schemas; participants interact through a chat interface where an AI conducts the interview, applies thematic codes in real time, and stores structured transcripts.

## Architecture

Synap uses a three-layer design: a portable frontend shell, an environment-aware orchestration adapter, and pluggable backends.

### Frontend Shell

Pure HTML + vanilla JS — no frameworks, no build toolchain, zero external dependencies. The entire UI ships as a single `.html` file or a small `/static` folder that can be embedded in a SharePoint page, a Teams tab, an iframe, or served as a standalone URL.

On startup, the frontend loads a JSON interview config that defines the session. A consent/disclosure modal must be explicitly accepted before the chat begins. That acceptance event (timestamped, with participant token) is the first record written to storage.

The frontend operates in two modes:
- **Mock mode** — Local-only with canned responses and keyword-based theme detection. No backend required.
- **Live mode** — Connects to Supabase Edge Functions (tested) or Azure Functions (code-complete, untested) for real AI responses and persistent storage.

### Orchestration Adapter

The environment split is handled here. In corporate environments it runs as an **Azure Function** or **Power Automate flow**. In public deployments it runs as a **Supabase Edge Function** (Deno). Both expose the same contract to the frontend:

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session-start` | POST | Creates session, records consent, returns greeting |
| `/chat` | POST | Sends user message, returns AI reply + coded themes |
| `/session-end` | POST | Marks session complete |
| `/invite-user` | POST | Admin: invite a researcher via email |

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

| Provider | Config Value | Env Var(s) Required | Status |
|----------|-------------|-------------------|--------|
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` | Tested |
| OpenAI | `openai` | `OPENAI_API_KEY` | Code-complete, untested |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Code-complete, untested |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | Code-complete, untested |
| Mock (no API) | `mock` | None | Tested |

### Interview Config (JSON)

The researcher's primary artifact. Defines:

- **Guide** — Ordered question topics with probe suggestions
- **Branching rules** — `if answer_contains("theme_X") -> follow_up_id`
- **Coding schema** — Thematic codes the AI applies on the fly
- **IRB disclosure text** — Verbatim consent language
- **AI persona and constraints** — System prompt the model receives
- **Identity** — Corporate environment detection, profile enrichment, anonymization
- **Storage** — Which backend to persist data to
- **Settings** — AI provider, model, temperature, connection URLs

See `configs/sample.json` for a complete example and `configs/CONFIG_GUIDE.md` for detailed field-by-field documentation.

### Database Schema

Supabase (Postgres) with six tables:

- **sessions** — One row per interview, stores full config snapshot
- **messages** — Complete transcript with turn numbers and active question IDs
- **coded_themes** — AI-extracted thematic codes per message with confidence scores
- **events** — Consent acceptance, interview end, errors
- **researchers** — Authenticated admin/researcher users (auto-created on signup)
- **study_access** — Maps researchers to studies with access levels (viewer/editor/owner)

## Project Structure

```
Synap/
├── index.html                          # Interview chat UI
├── admin.html                          # Researcher admin dashboard
├── admin-config.json.example           # Admin dashboard config template
├── run.sh                              # macOS/Linux launcher
├── run.bat                             # Windows launcher
├── configs/
│   ├── sample.json                     # Example interview config
│   └── CONFIG_GUIDE.md                 # Field-by-field config documentation
├── static/
│   ├── css/
│   │   ├── synap.css                   # Interview UI styles
│   │   └── admin.css                   # Admin dashboard styles
│   └── js/
│       ├── synap.js                    # Frontend logic (mock + live modes)
│       ├── admin.js                    # Admin dashboard + config builder + user mgmt
│       └── identity.js                 # Corporate identity detection (MSAL)
├── supabase/                           # Public deployment backend
│   ├── config.toml
│   ├── migrations/
│   │   ├── 001_create_tables.sql       # Core data tables
│   │   └── 002_researchers_and_rls.sql # Auth, study access, RLS policies
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts
│       │   ├── prompt-builder.ts
│       │   └── db.ts
│       ├── chat/index.ts
│       ├── session-start/index.ts
│       ├── session-end/index.ts
│       └── invite-user/index.ts        # Admin user invitation
├── azure/                              # Corporate deployment backend
│   ├── package.json
│   ├── host.json
│   ├── local.settings.json.example
│   ├── shared/
│   │   ├── ai-providers.ts
│   │   └── prompt-builder.ts
│   ├── storage/
│   │   ├── interface.ts                # Pluggable storage contract
│   │   ├── factory.ts                  # Storage adapter factory
│   │   ├── json-file.ts               # Flat JSON file adapter
│   │   ├── cosmosdb.ts                # Azure Cosmos DB adapter
│   │   ├── azuresql.ts                # Azure SQL Database adapter
│   │   └── sharepoint.ts              # SharePoint Lists adapter
│   ├── identity/
│   │   └── profile-enrichment.ts       # Azure AD profile enrichment
│   └── functions/
│       ├── chat/index.ts
│       ├── session-start/index.ts
│       └── session-end/index.ts
├── power-automate/                     # Power Automate fallback
│   ├── README.md
│   └── flow-definitions.json
├── .env.example
└── .gitignore
```

## Deployment Targets

| Environment | Orchestration | Storage | Identity | Status |
|-------------|--------------|---------|----------|--------|
| Public | Supabase Edge Functions | Supabase (Postgres) | None (anonymous) | Tested |
| Corporate (preferred) | Azure Functions | Cosmos DB, Azure SQL, SharePoint, or JSON files | Azure AD (silent enrichment) | Code-complete, untested |
| Corporate (fallback) | Power Automate | SharePoint Lists | Azure AD | Scaffolded (flow definitions, not importable packages) |
| Standalone | None (mock mode) | JSON files (local) | None | Tested |

### Pluggable Storage

The Azure Functions backend supports five storage backends, configured via `STORAGE_PROVIDER` env var or the config's `storage.provider` field:

| Provider | Config Value | Best For | Status |
|----------|-------------|----------|--------|
| JSON Files | `json-file` | Zero-infrastructure, local testing, offline collection | Code-complete, untested |
| Cosmos DB | `cosmosdb` | Production corporate deployments at scale | Code-complete, untested |
| Azure SQL | `azuresql` | Organizations with existing SQL infrastructure | Code-complete, untested |
| SharePoint Lists | `sharepoint` | Quick deployment using existing Microsoft 365 | Code-complete, untested |
| Supabase | `supabase` | Public deployments (uses Supabase Edge Functions directly) | Tested |

### Identity & Profile Enrichment

In corporate environments, Synap is designed to silently detect Azure AD identity and enrich session data with participant profile information (department, job title, location, employee ID). Configure via the `identity` block in the interview config:

- **Auto-detect** — Tries MSAL silent auth; falls back to public mode if unavailable
- **Corporate override** — Forces corporate mode (requires MSAL config)
- **Anonymization** — Hashes PII (names, IDs) while preserving categorical data (department, title)

> **Status:** The server-side enrichment logic and frontend MSAL detection are code-complete but have not been tested against a live Azure AD tenant. The corporate SSO login for the admin dashboard is stubbed.

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

3. Run the database migrations to create tables and RLS policies:
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
   supabase functions deploy invite-user
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

### Admin Dashboard Setup

The admin dashboard requires its own configuration file and at least one researcher account.

1. Copy the admin config template:
   ```bash
   cp admin-config.json.example admin-config.json
   ```

2. Edit `admin-config.json` with your Supabase URL and **anon key** (not service role key):
   ```json
   {
     "supabase_url": "https://your-project.supabase.co",
     "supabase_anon_key": "eyJhbGciOi..."
   }
   ```

3. Create a researcher account in Supabase Dashboard > **Authentication** > **Users** > **Add User** > **Create New User** (enter email and password).

4. The `on_auth_user_created` trigger automatically creates a row in the `researchers` table. To make yourself an admin, go to **Table Editor** > **researchers** and change `role` to `admin`.

5. Access the admin dashboard at `http://localhost:8000/admin.html` and sign in with your email and password.

**Admin features:**
- **Sessions** — View all interview sessions, filter by study or status, click to read full transcripts
- **Themes** — Aggregated theme analysis across sessions with occurrence counts and confidence scores
- **Export** — Download sessions, transcripts, coded themes, or events as CSV or JSON
- **Config Builder** — Create and edit interview configs via a form with live JSON preview
- **Users** (admin only) — Invite researchers, assign/revoke study access, manage roles

**Study access control:**
- Admins see all studies automatically
- Researchers only see studies they've been granted access to
- Grant access via the Users view: click "Access" on a researcher, enter the study ID and access level
- Access levels: `viewer` (read-only), `editor` (can modify), `owner` (full control — owner-based delegation not yet implemented in UI)

### Corporate Mode (Azure Functions)

> **Status:** Code-complete but untested. These instructions are based on the intended design and have not been validated end-to-end.

1. Navigate to the `azure/` directory and install dependencies:
   ```bash
   cd azure && npm install
   ```

2. Copy `local.settings.json.example` to `local.settings.json` and configure:
   - `STORAGE_PROVIDER` — `json-file`, `cosmosdb`, `azuresql`, or `sharepoint`
   - AI provider API keys
   - Storage-specific connection settings

3. Run locally:
   ```bash
   func start
   ```

4. Deploy to Azure:
   ```bash
   func azure functionapp publish your-app-name
   ```

5. Set `azure_functions_url` in your interview config to the deployed URL.

## Build Phases

1. **Static chatbot** — HTML chat UI with mock AI and consent flow. *(Complete, tested)*
2. **Supabase backend** — Edge Functions, multi-provider AI, persistent storage. *(Complete, tested with Claude)*
3. **Corporate backend** — Azure Functions, pluggable storage (Cosmos DB/SQL/SharePoint/JSON), identity enrichment, Power Automate fallback. *(Code-complete, untested — needs validation against live Azure environment)*
4. **Researcher admin UI** — Dashboard with sessions, transcripts, themes, export, config builder, user management, and study-scoped access control. *(Complete, tested with Supabase. Participant profile display not yet wired up. Corporate SSO login stubbed.)*

## License

TBD
