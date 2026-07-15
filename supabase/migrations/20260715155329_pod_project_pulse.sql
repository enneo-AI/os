-- Pods: Project Pulse, richer task state, and task-level collaboration.

alter table public.pods
  add column if not exists project_status text not null default 'on_track',
  add column if not exists current_focus text not null default '',
  add column if not exists target_date date;

alter table public.pods
  drop constraint if exists pods_project_status_check;
alter table public.pods
  add constraint pods_project_status_check
  check (project_status in ('on_track', 'at_risk', 'blocked', 'complete'));

alter table public.pod_tasks
  add column if not exists description text not null default '',
  add column if not exists priority text not null default 'normal';

alter table public.pod_tasks
  drop constraint if exists pod_tasks_status_check;
alter table public.pod_tasks
  add constraint pod_tasks_status_check
  check (status in ('open', 'in_progress', 'blocked', 'done'));

alter table public.pod_tasks
  drop constraint if exists pod_tasks_priority_check;
alter table public.pod_tasks
  add constraint pod_tasks_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));

create index if not exists pod_tasks_attention_idx
  on public.pod_tasks (pod_id, status, priority, due_date);

alter table public.pod_tasks
  drop constraint if exists pod_tasks_id_pod_id_key;
alter table public.pod_tasks
  add constraint pod_tasks_id_pod_id_key unique (id, pod_id);

create table if not exists public.pod_task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.pod_tasks (id) on delete cascade,
  pod_id uuid not null references public.pods (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  constraint pod_task_comments_task_pod_fk
    foreign key (task_id, pod_id) references public.pod_tasks (id, pod_id) on delete cascade
);

create index if not exists pod_task_comments_task_idx
  on public.pod_task_comments (task_id, created_at);
create index if not exists pod_task_comments_pod_idx
  on public.pod_task_comments (pod_id, created_at desc);

alter table public.pod_task_comments enable row level security;

revoke all on public.pod_task_comments from anon;
grant select, insert, update, delete on public.pod_task_comments to authenticated;
grant all on public.pod_task_comments to service_role;

drop policy if exists pod_task_comments_select on public.pod_task_comments;
create policy pod_task_comments_select
on public.pod_task_comments for select
to authenticated
using ((select auth.uid()) is not null and public.is_pod_visible(pod_id));

drop policy if exists pod_task_comments_insert on public.pod_task_comments;
create policy pod_task_comments_insert
on public.pod_task_comments for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and author_id = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

drop policy if exists pod_task_comments_update on public.pod_task_comments;
create policy pod_task_comments_update
on public.pod_task_comments for update
to authenticated
using (author_id = (select auth.uid()))
with check (author_id = (select auth.uid()) and public.is_pod_visible(pod_id));

drop policy if exists pod_task_comments_delete on public.pod_task_comments;
create policy pod_task_comments_delete
on public.pod_task_comments for delete
to authenticated
using (
  author_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_admin
  )
);

alter table public.pod_task_comments replica identity full;
alter table public.pod_tasks replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.pod_tasks;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.pod_task_comments;
  exception when duplicate_object then null;
  end;
end $$;
