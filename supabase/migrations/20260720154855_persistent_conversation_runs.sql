-- Durable live state for Enni turns. Realtime Broadcast alone cannot replay a
-- snapshot to clients that return after navigating away or refreshing.
create table if not exists public.conversation_runs (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  pod_id uuid references public.pods(id) on delete cascade,
  thread_root_id uuid references public.messages(id) on delete cascade,
  user_message_id uuid references public.messages(id) on delete cascade,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phase text not null default 'thinking'
    check (phase in ('thinking', 'tool', 'text', 'finalizing')),
  status text not null default 'Enni denkt nach …',
  thinking text not null default '',
  response_text text not null default '',
  tools jsonb not null default '[]'::jsonb
);

create index if not exists conversation_runs_pod_idx
  on public.conversation_runs (pod_id, updated_at desc)
  where pod_id is not null;

alter table public.conversation_runs enable row level security;

drop policy if exists conversation_runs_select_visible on public.conversation_runs;
create policy conversation_runs_select_visible
on public.conversation_runs for select to authenticated
using (
  (select auth.uid()) is not null
  and exists (
    select 1
    from public.conversations c
    where c.id = conversation_runs.conversation_id
      and (
        (c.pod_id is null and c.user_id = (select auth.uid()))
        or (c.pod_id is not null and public.is_pod_visible(c.pod_id))
      )
  )
);

revoke all on public.conversation_runs from anon, authenticated;
grant select on public.conversation_runs to authenticated;
grant all on public.conversation_runs to service_role;

do $$
begin
  alter publication supabase_realtime add table public.conversation_runs;
exception
  when duplicate_object then null;
end $$;

comment on table public.conversation_runs is
  'One durable, backend-owned live progress snapshot per working conversation; deleted when the turn completes.';
