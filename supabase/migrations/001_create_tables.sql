-- Synap Phase 2: Core schema for interview sessions and transcripts

-- Sessions table: one row per interview
create table public.sessions (
  id text primary key,
  config_id text not null,
  config_snapshot jsonb not null,       -- full config at time of session start
  participant_token text,                -- optional de-identified token
  status text not null default 'active', -- active | completed | abandoned
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,                       -- guide_complete | participant_ended | max_turns | abandoned
  turn_count integer not null default 0,
  metadata jsonb default '{}'::jsonb
);

-- Messages table: full transcript
create table public.messages (
  id bigint generated always as identity primary key,
  session_id text not null references public.sessions(id) on delete cascade,
  role text not null check (role in ('ai', 'user')),
  content text not null,
  turn_number integer not null,
  question_id text,                      -- which guide question was active
  created_at timestamptz not null default now()
);

-- Coded themes: AI-extracted thematic codes per turn
create table public.coded_themes (
  id bigint generated always as identity primary key,
  session_id text not null references public.sessions(id) on delete cascade,
  message_id bigint references public.messages(id) on delete cascade,
  turn_number integer not null,
  theme_code text not null,
  theme_label text,
  confidence real,                       -- 0.0–1.0 if the model provides it
  created_at timestamptz not null default now()
);

-- Events: consent, end, errors, etc.
create table public.events (
  id bigint generated always as identity primary key,
  session_id text not null references public.sessions(id) on delete cascade,
  event_type text not null,              -- consent_accepted | interview_ended | error
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Indexes for common query patterns
create index idx_messages_session on public.messages(session_id, turn_number);
create index idx_coded_themes_session on public.coded_themes(session_id);
create index idx_coded_themes_code on public.coded_themes(theme_code);
create index idx_events_session on public.events(session_id);
create index idx_sessions_config on public.sessions(config_id);
create index idx_sessions_status on public.sessions(status);

-- Row Level Security (enabled but permissive for now — tighten in Phase 3)
alter table public.sessions enable row level security;
alter table public.messages enable row level security;
alter table public.coded_themes enable row level security;
alter table public.events enable row level security;

-- Allow edge functions (service role) full access
create policy "Service role full access" on public.sessions
  for all using (true) with check (true);
create policy "Service role full access" on public.messages
  for all using (true) with check (true);
create policy "Service role full access" on public.coded_themes
  for all using (true) with check (true);
create policy "Service role full access" on public.events
  for all using (true) with check (true);
