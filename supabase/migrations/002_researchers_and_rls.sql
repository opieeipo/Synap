-- Synap Phase 3+: Researcher authentication, study access control, and proper RLS

-- ── Researchers table ────────────────────────────────────────
-- Maps Supabase Auth users to researcher profiles
create table public.researchers (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'researcher' check (role in ('researcher', 'admin')),
  created_at timestamptz not null default now()
);

-- ── Study access table ───────────────────────────────────────
-- Controls which researchers can see which studies (config_ids)
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

-- ── Drop the old permissive policies ─────────────────────────
drop policy if exists "Service role full access" on public.sessions;
drop policy if exists "Service role full access" on public.messages;
drop policy if exists "Service role full access" on public.coded_themes;
drop policy if exists "Service role full access" on public.events;

-- ── Helper function: get accessible config_ids for current user ──
create or replace function public.accessible_config_ids()
returns setof text
language sql
security definer
stable
as $$
  select config_id from public.study_access
  where researcher_id = auth.uid()
  union
  -- Admins see everything
  select distinct config_id from public.sessions
  where exists (
    select 1 from public.researchers
    where id = auth.uid() and role = 'admin'
  )
$$;

-- ── Researchers policies ─────────────────────────────────────
-- Researchers can read their own profile
create policy "Researchers can read own profile"
  on public.researchers for select
  using (id = auth.uid());

-- Admins can read all researchers
create policy "Admins can read all researchers"
  on public.researchers for select
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

-- Admins can insert/update researchers
create policy "Admins can manage researchers"
  on public.researchers for all
  using (
    exists (select 1 from public.researchers where id = auth.uid() and role = 'admin')
  );

-- ── Study access policies ────────────────────────────────────
-- Researchers can see their own access grants
create policy "Researchers see own access"
  on public.study_access for select
  using (researcher_id = auth.uid());

-- Admins and study owners can manage access
create policy "Owners and admins manage access"
  on public.study_access for all
  using (
    exists (
      select 1 from public.researchers where id = auth.uid() and role = 'admin'
    )
    or
    exists (
      select 1 from public.study_access
      where researcher_id = auth.uid()
        and config_id = study_access.config_id
        and access_level = 'owner'
    )
  );

-- ── Sessions policies ────────────────────────────────────────
-- Edge Functions (service role) can insert sessions (from interviews)
create policy "Service role can insert sessions"
  on public.sessions for insert
  with check (true);

-- Service role can update sessions
create policy "Service role can update sessions"
  on public.sessions for update
  using (true);

-- Researchers can read sessions for their accessible studies
create policy "Researchers read accessible sessions"
  on public.sessions for select
  using (config_id in (select public.accessible_config_ids()));

-- ── Messages policies ────────────────────────────────────────
create policy "Service role can insert messages"
  on public.messages for insert
  with check (true);

create policy "Researchers read accessible messages"
  on public.messages for select
  using (
    session_id in (
      select id from public.sessions
      where config_id in (select public.accessible_config_ids())
    )
  );

-- ── Coded themes policies ────────────────────────────────────
create policy "Service role can insert themes"
  on public.coded_themes for insert
  with check (true);

create policy "Researchers read accessible themes"
  on public.coded_themes for select
  using (
    session_id in (
      select id from public.sessions
      where config_id in (select public.accessible_config_ids())
    )
  );

-- ── Events policies ──────────────────────────────────────────
create policy "Service role can insert events"
  on public.events for insert
  with check (true);

create policy "Researchers read accessible events"
  on public.events for select
  using (
    session_id in (
      select id from public.sessions
      where config_id in (select public.accessible_config_ids())
    )
  );

-- ── Auto-register researcher on first sign-in ────────────────
-- Trigger that creates a researcher row when a new user signs up
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

-- Only create trigger if it doesn't exist
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created') then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$$;
