-- enneo OS — Account Governance + verlässliche Knowledge-/Release-Synchronisierung
-- Zwei Rollen: Member arbeitet frei im eigenen Scope; Admin verwaltet Team-Scope,
-- Rollen und Freigaben. Rollen liegen ausschließlich in profiles (nie User-Metadaten).

-- ---------------------------------------------------------------------------
-- Accounts, Einladungen und Audit
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists account_status text not null default 'active'
  check (account_status in ('active', 'disabled'));

create table public.pending_invites (
  email text primary key check (email = lower(email)),
  requested_role text not null default 'member' check (requested_role in ('member', 'admin')),
  invited_by uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_target_idx on public.audit_log (target_type, target_id);

-- Pending-Invite ist die einzige Quelle für die initiale Rolle. raw_user_meta_data
-- enthält nur Darstellungsdaten und wird nie für Autorisierung verwendet.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_role text;
begin
  if new.email !~* '@enneo\.ai$' then
    raise exception 'Nur enneo.ai-E-Mail-Adressen sind erlaubt (%).', new.email;
  end if;

  select requested_role into invite_role
  from public.pending_invites
  where email = lower(new.email) and expires_at > now();

  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    coalesce(invite_role = 'admin', false)
  )
  on conflict (id) do nothing;

  delete from public.pending_invites where email = lower(new.email);
  return new;
end;
$$;

alter table public.pending_invites enable row level security;
alter table public.audit_log enable row level security;

create policy pending_invites_admin_select on public.pending_invites for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'));
create policy audit_log_admin_select on public.audit_log for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'));

grant select on public.pending_invites, public.audit_log to authenticated;
grant all on public.pending_invites, public.audit_log to service_role;

-- Profildaten dürfen Nutzer selbst ändern, niemals Rolle oder Account-Status.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()) and account_status = 'active')
  with check (id = (select auth.uid()) and account_status = 'active');
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url, role_title, about) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Einheitlicher Scope: personal -> proposed -> team
-- ---------------------------------------------------------------------------
alter table public.routines add column if not exists visibility text not null default 'personal'
  check (visibility in ('personal', 'proposed', 'team'));
update public.routines set visibility = case when pod_id is null then 'personal' else 'team' end;

drop policy if exists routines_select on public.routines;
drop policy if exists routines_insert on public.routines;
drop policy if exists routines_update on public.routines;
drop policy if exists routines_delete on public.routines;
create policy routines_select on public.routines for select to authenticated
  using (
    visibility = 'team' or created_by = (select auth.uid())
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );
create policy routines_insert on public.routines for insert to authenticated
  with check (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );
create policy routines_update on public.routines for update to authenticated
  using (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  )
  with check (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );
create policy routines_delete on public.routines for delete to authenticated
  using (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );

alter table public.wiki_pages add column if not exists visibility text not null default 'team'
  check (visibility in ('personal', 'proposed', 'team'));

drop policy if exists wiki_select on public.wiki_pages;
drop policy if exists wiki_insert on public.wiki_pages;
drop policy if exists wiki_update on public.wiki_pages;
drop policy if exists wiki_delete on public.wiki_pages;
create policy wiki_select on public.wiki_pages for select to authenticated
  using (
    created_by = (select auth.uid())
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
    or (
      visibility = 'team' and (
        space_id is null or exists (
          select 1 from public.spaces s where s.id = wiki_pages.space_id
        )
      )
    )
  );
create policy wiki_insert on public.wiki_pages for insert to authenticated
  with check (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );
create policy wiki_update on public.wiki_pages for update to authenticated
  using (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  )
  with check (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );
create policy wiki_delete on public.wiki_pages for delete to authenticated
  using (
    (created_by = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );

drop policy if exists wc_select on public.wiki_chunks;
create policy wc_select on public.wiki_chunks for select to authenticated
  using (exists (select 1 from public.wiki_pages p where p.id = wiki_chunks.page_id));

drop policy if exists "connectors sichtbar für alle eingeloggten" on public.connectors;
drop policy if exists connectors_select_scope on public.connectors;
create policy connectors_select_scope on public.connectors for select to authenticated
  using (
    visibility = 'team' or owner = (select auth.uid())
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active')
  );

-- ---------------------------------------------------------------------------
-- Verlässliche externe Wissensquellen + Release-Feed
-- ---------------------------------------------------------------------------
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('docs_full', 'gitlab_merge_requests')),
  source_url text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  trusted boolean not null default true,
  last_synced_at timestamptz,
  last_content_hash text,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, source_url)
);
create trigger knowledge_sources_updated_at before update on public.knowledge_sources
  for each row execute function public.set_updated_at();

create table public.knowledge_source_documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  source_key text not null,
  source_url text not null,
  content_hash text not null,
  wiki_page_id uuid references public.wiki_pages(id) on delete set null,
  synced_at timestamptz not null default now(),
  unique (source_id, source_key)
);

create table public.release_entries (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  external_id text not null,
  title text not null,
  summary text not null default '',
  source_url text,
  author text,
  published_at timestamptz not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_id, external_id)
);
create index release_entries_recent_idx on public.release_entries (published_at desc);

create table public.knowledge_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  status text not null check (status in ('running', 'success', 'failed')),
  documents_seen integer not null default 0,
  documents_changed integer not null default 0,
  entries_added integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.knowledge_sources enable row level security;
alter table public.knowledge_source_documents enable row level security;
alter table public.release_entries enable row level security;
alter table public.knowledge_sync_runs enable row level security;

create policy knowledge_sources_read on public.knowledge_sources for select to authenticated using (enabled = true);
create policy release_entries_read on public.release_entries for select to authenticated using (true);
create policy knowledge_source_documents_admin on public.knowledge_source_documents for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'));
create policy knowledge_sync_runs_admin on public.knowledge_sync_runs for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'));

grant select on public.knowledge_sources, public.release_entries to authenticated;
grant select on public.knowledge_source_documents, public.knowledge_sync_runs to authenticated;
grant all on public.knowledge_sources, public.knowledge_source_documents, public.release_entries, public.knowledge_sync_runs to service_role;

-- Deaktivierte Accounts verlieren auch mit einem noch nicht abgelaufenen JWT sofort
-- jeden direkten Data-API-Zugriff. Restrictive Policies ergänzen alle Fach-Policies.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'conversations','messages','llm_usage','wiki_pages','knowledge_updates','wiki_chunks',
    'spaces','space_members','space_connections','pods','pod_members','pod_tasks','pod_files',
    'enneo_write_proposals','connectors','skills','routines','learnings','oauth_states',
    'pending_invites','audit_log','knowledge_sources','knowledge_source_documents',
    'release_entries','knowledge_sync_runs'
  ] loop
    execute format('drop policy if exists active_account_only on public.%I', table_name);
    execute format(
      'create policy active_account_only on public.%I as restrictive for all to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = ''active'')) with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = ''active''))',
      table_name
    );
  end loop;
end $$;

-- Offizielle Quellen: aktuelle Produktdokumentation + wöchentliche Änderungen im
-- zentralen GitLab-Projekt. Der Backend-Sync liest Zugangsdaten ausschließlich aus Env.
insert into public.knowledge_sources (name, kind, source_url, config)
values
  ('Enneo Produktdokumentation', 'docs_full', 'https://docs.enneo.ai/llms-full.txt', '{"language":"de","new_pages_per_run":20}'::jsonb),
  ('Enneo Produkt-Releases', 'gitlab_merge_requests', 'https://gitlab.com/enneo/enneo', '{"project_path":"enneo/enneo","lookback_days":90}'::jsonb)
on conflict (kind, source_url) do nothing;

-- Wöchentlicher Digest für den ersten aktiven Admin. Ziel-Pod kann danach in der
-- Routinen-UI gewählt werden; ohne Pod bleibt das Ergebnis zunächst privat beim Admin.
insert into public.routines (name, prompt, cron, schedule_label, model, created_by, visibility)
select
  'Wöchentliche Enneo Release Notes',
  'Erstelle einen kompakten Wochen-Digest der Enneo-Produktänderungen der letzten sieben Tage. Nutze ausschließlich den aktuellen Release-Notes-Kontext. Gruppiere nach Neue Funktionen, Verbesserungen und Fixes. Wenn es keine Einträge gab, sage das klar. Verlinke die Quellen.',
  '0 9 * * 1',
  'Montags 09:00',
  'claude-sonnet-5',
  p.id,
  'team'
from public.profiles p
where p.is_admin and p.account_status = 'active'
  and not exists (select 1 from public.routines r where r.name = 'Wöchentliche Enneo Release Notes')
order by p.created_at
limit 1;
