create table public.skill_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  skill_slug text not null,
  mode text not null check (mode in ('auto', 'explicit', 'tool')),
  created_at timestamptz not null default now(),
  unique (message_id, skill_slug, mode)
);

create index skill_usage_events_user_idx on public.skill_usage_events(user_id, created_at desc);
create index skill_usage_events_slug_idx on public.skill_usage_events(skill_slug, created_at desc);

alter table public.skill_usage_events enable row level security;

create policy skill_usage_events_select on public.skill_usage_events for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
  );

create policy active_account_only on public.skill_usage_events as restrictive for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = 'active'))
  with check (false);

grant select on public.skill_usage_events to authenticated;
grant all on public.skill_usage_events to service_role;

-- Bestehende modellgesteuerte skill_read-Aufrufe soweit möglich historisieren.
insert into public.skill_usage_events (user_id, conversation_id, message_id, skill_slug, mode, created_at)
select c.user_id, m.conversation_id, m.id,
  lower(trim(leading '/' from call->'input'->>'slug')), 'tool', m.created_at
from public.messages m
join public.conversations c on c.id = m.conversation_id
cross join lateral jsonb_array_elements(coalesce(m.tool_calls, '[]'::jsonb)) call
where m.role = 'assistant'
  and call->>'name' = 'skill_read'
  and nullif(trim(call->'input'->>'slug'), '') is not null
on conflict (message_id, skill_slug, mode) do nothing;
