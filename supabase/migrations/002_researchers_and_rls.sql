-- Synap: Researcher authentication, study access control, and RLS
-- This migration replaces the permissive Phase 1 policies with proper
-- role-based access control for researchers.

-- ── Researchers table ────────────────────────────────────────
create table public.researchers (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'researcher' check (role in ('researcher', 'admin')),
  created_at timestamptz not null default now()
);

-- ── Study access table ───────────────────────────────────────
create table public.study_access (
  id bigint generated always as identity primary key,
  researcher_id uuid not null references public.researchers(id) on delete cascade,
  config_id text not null,
  access_level text not null default 'viewer' check (access_level in ('viewer', 'editor', 'owner')),
  granted_at timestamptz not null default now(),
  unique(researcher_id, config_id)
);

create index idx_study_access_researcher on public.study_access(researcher_id);
create index idx_study_access_config on public.study_access(config_id);

-- ── Enable RLS on new tables ─────────────────────────────────
alter table public.researchers enable row level security;
alter table public.study_access enable row level security;

-- ── Drop the old permissive policies from Phase 1 ────────────
drop policy if exists "Service role full access" on public.sessions;
drop policy if exists "Service role full access" on public.messages;
drop policy if exists "Service role full access" on public.coded_themes;
drop policy if exists "Service role full access" on public.events;

-- ══════════════════════════════════════════════════════════════
-- RESEARCHERS table policies
-- Note: Cannot query researchers from within its own RLS policy
-- (causes infinite recursion). Use auth.uid() checks only.
-- ══════════════════════════════════════════════════════════════

create policy "Authenticated can read researchers"
  on public.researchers for select
  using (auth.uid() is not null);

create policy "Service role manages researchers"
  on public.researchers for all
  using ((auth.jwt() ->> 'role') = 'service_role');

-- ══════════════════════════════════════════════════════════════
-- STUDY_ACCESS table policies
-- Researchers see their own grants. Admins see and manage all.
-- Admin check queries researchers table (safe, no self-reference).
-- ══════════════════════════════════════════════════════════════

create policy "Read own access"
  on public.study_access for select
  using (researcher_id = auth.uid());

create policy "Admins read all access"
  on public.study_access for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

create policy "Service role manages access"
  on public.study_access for all
  using ((auth.jwt() ->> 'role') = 'service_role');

create policy "Admins manage access"
  on public.study_access for all
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

-- ══════════════════════════════════════════════════════════════
-- SESSIONS table policies
-- Service role: insert + update (from Edge Functions during interviews)
-- Admins: read all. Researchers: read only their granted studies.
-- ══════════════════════════════════════════════════════════════

create policy "Service role can insert sessions"
  on public.sessions for insert
  with check (true);

create policy "Service role can update sessions"
  on public.sessions for update
  using (true);

create policy "Admins read all sessions"
  on public.sessions for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

create policy "Researchers read granted sessions"
  on public.sessions for select
  using (
    config_id in (select config_id from public.study_access where researcher_id = auth.uid())
  );

-- ══════════════════════════════════════════════════════════════
-- MESSAGES table policies
-- ══════════════════════════════════════════════════════════════

create policy "Service role can insert messages"
  on public.messages for insert
  with check (true);

create policy "Admins read all messages"
  on public.messages for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

create policy "Researchers read granted messages"
  on public.messages for select
  using (
    session_id in (
      select s.id from public.sessions s
      inner join public.study_access sa on sa.config_id = s.config_id
      where sa.researcher_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════
-- CODED_THEMES table policies
-- ══════════════════════════════════════════════════════════════

create policy "Service role can insert themes"
  on public.coded_themes for insert
  with check (true);

create policy "Admins read all themes"
  on public.coded_themes for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

create policy "Researchers read granted themes"
  on public.coded_themes for select
  using (
    session_id in (
      select s.id from public.sessions s
      inner join public.study_access sa on sa.config_id = s.config_id
      where sa.researcher_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════
-- EVENTS table policies
-- ══════════════════════════════════════════════════════════════

create policy "Service role can insert events"
  on public.events for insert
  with check (true);

create policy "Admins read all events"
  on public.events for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

create policy "Researchers read granted events"
  on public.events for select
  using (
    session_id in (
      select s.id from public.sessions s
      inner join public.study_access sa on sa.config_id = s.config_id
      where sa.researcher_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════
-- Auto-register researcher on first sign-in
-- ══════════════════════════════════════════════════════════════

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.researchers (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  );
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created') then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$$;
