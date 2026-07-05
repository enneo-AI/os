-- enneo OS — Pods nach Dust-Muster (2026-07-05)
-- Pod = geteilter Projekt-Raum: Konversationen (geteilt), Aufgaben, Dateien, Instructions for Agents.

create table pods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  instructions text not null default '',   -- "Instructions for Agents" (AGENTS.md-Konzept)
  open boolean not null default true,       -- Open = ganze Org, sonst nur Mitglieder
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger pods_updated_at before update on pods for each row execute function set_updated_at();

create table pod_members (
  pod_id uuid not null references pods (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pod_id, user_id)
);

create table pod_tasks (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references pods (id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done')),
  assignee uuid references auth.users (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,  -- Audit-Trail: Task ↔ Konversation
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger pod_tasks_updated_at before update on pod_tasks for each row execute function set_updated_at();
create index pod_tasks_pod_idx on pod_tasks (pod_id, status, created_at desc);

create table pod_files (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references pods (id) on delete cascade,
  name text not null,
  media_type text,
  size bigint,
  storage_path text not null,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index pod_files_pod_idx on pod_files (pod_id, created_at desc);

-- Konversationen können zu einem Pod gehören (dann geteilt), Messages tragen den Autor
alter table conversations add column if not exists pod_id uuid references pods (id) on delete cascade;
alter table messages add column if not exists author_id uuid references auth.users (id) on delete set null;
create index conversations_pod_idx on conversations (pod_id, updated_at desc);

-- Sichtbarkeits-Helper (security definer verhindert RLS-Rekursion)
create or replace function is_pod_visible(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pods p
    where p.id = pid and (
      p.open
      or p.created_by = auth.uid()
      or exists (select 1 from pod_members m where m.pod_id = pid and m.user_id = auth.uid())
      or exists (select 1 from profiles pr where pr.id = auth.uid() and pr.is_admin)
    )
  )
$$;

-- RLS
alter table pods enable row level security;
alter table pod_members enable row level security;
alter table pod_tasks enable row level security;
alter table pod_files enable row level security;

create policy pods_select on pods for select to authenticated using (is_pod_visible(id));
create policy pods_insert on pods for insert to authenticated with check (created_by = auth.uid());
create policy pods_update on pods for update to authenticated using (is_pod_visible(id));
create policy pods_delete on pods for delete to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create policy pm_select on pod_members for select to authenticated using (true);
create policy pm_insert on pod_members for insert to authenticated
  with check (exists (select 1 from pods p where p.id = pod_id and p.created_by = auth.uid())
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy pm_delete on pod_members for delete to authenticated
  using (exists (select 1 from pods p where p.id = pod_id and p.created_by = auth.uid())
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create policy pt_all on pod_tasks for all to authenticated
  using (is_pod_visible(pod_id)) with check (is_pod_visible(pod_id));
create policy pf_all on pod_files for all to authenticated
  using (is_pod_visible(pod_id)) with check (is_pod_visible(pod_id));

-- Konversations-RLS erweitern: eigene ODER sichtbare Pod-Konversationen
drop policy if exists conversations_all_own on conversations;
create policy conv_select on conversations for select to authenticated
  using (user_id = auth.uid() or (pod_id is not null and is_pod_visible(pod_id)));
create policy conv_insert on conversations for insert to authenticated
  with check (user_id = auth.uid() and (pod_id is null or is_pod_visible(pod_id)));
create policy conv_update on conversations for update to authenticated
  using (user_id = auth.uid() or (pod_id is not null and is_pod_visible(pod_id)));
create policy conv_delete on conversations for delete to authenticated using (user_id = auth.uid());

drop policy if exists messages_select_own on messages;
drop policy if exists messages_insert_own on messages;
create policy messages_select on messages for select to authenticated
  using (exists (select 1 from conversations c where c.id = conversation_id
    and (c.user_id = auth.uid() or (c.pod_id is not null and is_pod_visible(c.pod_id)))));
create policy messages_insert on messages for insert to authenticated
  with check (exists (select 1 from conversations c where c.id = conversation_id
    and (c.user_id = auth.uid() or (c.pod_id is not null and is_pod_visible(c.pod_id)))));

-- Storage-Bucket für Pod-Dateien
insert into storage.buckets (id, name, public) values ('pod-files', 'pod-files', false)
on conflict (id) do nothing;
create policy pod_files_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'pod-files');
create policy pod_files_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pod-files');
create policy pod_files_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'pod-files');

-- Fix (2026-07-05): pods-SELECT-Policy inline statt is_pod_visible(id) —
-- die Selbst-Requery-Funktion sieht die per INSERT..RETURNING eingefügte Zeile noch nicht.
drop policy if exists pods_select on pods;
create policy pods_select on pods for select to authenticated
  using (open or created_by = auth.uid()
    or exists (select 1 from pod_members m where m.pod_id = id and m.user_id = auth.uid())
    or exists (select 1 from profiles pr where pr.id = auth.uid() and pr.is_admin));
