-- enneo OS — MVP Phase 1 Schema (2026-07-03)
-- Tabellen: profiles, conversations, messages, llm_usage, wiki_pages, knowledge_updates
-- Prinzipien: RLS überall, Audit-Attribution, Kosten pro Antwort (llm_usage),
-- Wissens-Änderungen nur als Diff mit menschlicher Freigabe (knowledge_updates).

-- =========================================================================
-- Enums
-- =========================================================================
create type message_role as enum ('user', 'assistant', 'tool');
create type knowledge_update_status as enum ('proposed', 'approved', 'rejected');
create type usage_source as enum ('chat', 'routine');

-- =========================================================================
-- updated_at Helper
-- =========================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =========================================================================
-- profiles — 1:1 zu auth.users (Google-SSO), Anzeige-Name + Admin-Flag
-- =========================================================================
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- Auto-Anlage bei Google-SSO-Signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- =========================================================================
-- conversations — Chat-Verläufe pro Nutzer
-- =========================================================================
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_idx on conversations (user_id, updated_at desc);

create trigger conversations_updated_at before update on conversations
  for each row execute function set_updated_at();

-- =========================================================================
-- messages — einzelne Turns inkl. Gedankenkette + Tool-Calls (jsonb)
-- =========================================================================
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  role message_role not null,
  content text not null default '',
  thinking text,                -- Gedankenkette fürs Detail-Panel (mockup-v5)
  tool_calls jsonb,             -- [{name, input, output, duration_ms}]
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

-- =========================================================================
-- llm_usage — Kosten-Transparenz pro Antwort (Konzept: Euro an jeder Antwort)
-- =========================================================================
create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,
  message_id uuid references messages (id) on delete set null,
  source usage_source not null default 'chat',
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_eur numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);

create index llm_usage_user_month_idx on llm_usage (user_id, created_at desc);
create index llm_usage_source_idx on llm_usage (source, created_at desc);

-- =========================================================================
-- wiki_pages — Markdown-Wiki (Notion-Ersatz), org-weit lesbar
-- =========================================================================
create table wiki_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  content text not null default '',   -- Markdown
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index wiki_pages_slug_idx on wiki_pages (slug);

create trigger wiki_pages_updated_at before update on wiki_pages
  for each row execute function set_updated_at();

-- =========================================================================
-- knowledge_updates — Ennis Diff-Vorschläge, nie Auto-Apply
-- =========================================================================
create table knowledge_updates (
  id uuid primary key default gen_random_uuid(),
  wiki_page_id uuid not null references wiki_pages (id) on delete cascade,
  triggered_by uuid references auth.users (id) on delete set null,  -- wessen Chat hat den Vorschlag ausgelöst
  source_conversation_id uuid references conversations (id) on delete set null,
  summary text not null,              -- 1-Satz-Begründung von Enni
  diff text not null,                 -- unified diff auf wiki_pages.content
  status knowledge_update_status not null default 'proposed',
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create index knowledge_updates_status_idx on knowledge_updates (status, created_at desc);

-- =========================================================================
-- RLS — Backend (Claude Agent SDK) nutzt service_role und umgeht RLS.
-- Diese Policies gelten für direkten Frontend-Zugriff mit User-JWT.
-- =========================================================================
alter table profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table llm_usage enable row level security;
alter table wiki_pages enable row level security;
alter table knowledge_updates enable row level security;

-- profiles: jeder Authentifizierte sieht alle Profile (Team-Anzeige), ändert nur sich selbst
create policy profiles_select on profiles for select to authenticated using (true);
create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select p.is_admin from profiles p where p.id = auth.uid()));

-- conversations: nur der Owner
create policy conversations_all_own on conversations for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- messages: über die eigene Conversation
create policy messages_select_own on messages for select to authenticated
  using (exists (select 1 from conversations c where c.id = conversation_id and c.user_id = auth.uid()));
create policy messages_insert_own on messages for insert to authenticated
  with check (exists (select 1 from conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- llm_usage: Nutzer liest eigene Kosten; Inserts macht nur das Backend (service_role)
create policy llm_usage_select_own on llm_usage for select to authenticated
  using (user_id = auth.uid());

-- wiki_pages: org-weit lesen, Authentifizierte dürfen anlegen/ändern (Audit via updated_by)
create policy wiki_select on wiki_pages for select to authenticated using (true);
create policy wiki_insert on wiki_pages for insert to authenticated with check (created_by = auth.uid());
create policy wiki_update on wiki_pages for update to authenticated using (true) with check (updated_by = auth.uid());

-- knowledge_updates: org-weit lesen; Review (approve/reject) durch Authentifizierte;
-- Anlage macht nur das Backend (Enni via service_role)
create policy ku_select on knowledge_updates for select to authenticated using (true);
create policy ku_review on knowledge_updates for update to authenticated
  using (status = 'proposed') with check (reviewed_by = auth.uid());
