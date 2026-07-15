-- Central notification inbox + browser Web Push.
-- Notifications are written by the service role or tightly scoped internal triggers;
-- authenticated clients can only read their own rows. Mutations go through the API.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in (
    'mention', 'team_mention', 'task_assignment', 'task_comment',
    'agent_complete', 'routine_complete', 'system_update'
  )),
  actor_id uuid references auth.users (id) on delete set null,
  pod_id uuid references public.pods (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  task_id uuid references public.pod_tasks (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  body text not null default '',
  action_url text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  push_state text not null default 'pending' check (push_state in ('pending', 'sent', 'skipped', 'failed')),
  push_attempted_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_inbox_idx
  on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc) where read_at is null;
create index notifications_push_queue_idx
  on public.notifications (created_at) where push_state = 'pending';
create index notifications_pod_idx on public.notifications (pod_id, created_at desc);

create table public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  browser_push boolean not null default false,
  muted_pod_ids uuid[] not null default '{}',
  quiet_hours_enabled boolean not null default false,
  quiet_start time not null default '18:00',
  quiet_end time not null default '08:00',
  timezone text not null default 'Europe/Berlin',
  updated_at timestamptz not null default now()
);
create trigger notification_preferences_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  enabled boolean not null default true,
  failure_count integer not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id, enabled);
create trigger push_subscriptions_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

create table public.system_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 2000),
  audience text not null default 'all' check (audience in ('all', 'admins', 'members')),
  action_url text,
  created_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now()
);

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.system_announcements enable row level security;

revoke all on public.notifications from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.system_announcements from anon, authenticated;
grant select on public.notifications to authenticated;
grant select on public.notification_preferences to authenticated;
grant all on public.notifications, public.notification_preferences,
  public.push_subscriptions, public.system_announcements to service_role;

create policy notifications_select_own
on public.notifications for select to authenticated
using (user_id = (select auth.uid()));

create policy notification_preferences_select_own
on public.notification_preferences for select to authenticated
using (user_id = (select auth.uid()));

-- Internal trigger: direct task writes still generate an assignment notification.
create or replace function private.notify_task_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := coalesce((select auth.uid()), new.created_by);
  actor_name text;
begin
  if new.assignee is null or new.assignee is not distinct from actor
    or (tg_op = 'UPDATE' and new.assignee is not distinct from old.assignee) then
    return new;
  end if;
  select coalesce(nullif(display_name, ''), split_part(email, '@', 1), 'Ein Teammitglied')
    into actor_name from public.profiles where id = actor;
  insert into public.notifications (
    user_id, type, actor_id, pod_id, task_id, conversation_id,
    title, body, action_url, metadata
  ) values (
    new.assignee, 'task_assignment', actor, new.pod_id, new.id, new.conversation_id,
    coalesce(actor_name, 'Ein Teammitglied') || ' hat dir eine Aufgabe zugewiesen',
    new.title, '/pod/' || new.pod_id || '?tab=tasks&task=' || new.id,
    jsonb_build_object('task_title', new.title)
  );
  return new;
end;
$$;

create trigger pod_task_assignment_notification
after insert or update of assignee on public.pod_tasks
for each row execute function private.notify_task_assignment();

-- Internal trigger: task comments notify assignee and creator (except the author).
create or replace function private.notify_task_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  task_row public.pod_tasks%rowtype;
  actor_name text;
  recipient uuid;
begin
  select * into task_row from public.pod_tasks where id = new.task_id;
  select coalesce(nullif(display_name, ''), split_part(email, '@', 1), 'Ein Teammitglied')
    into actor_name from public.profiles where id = new.author_id;
  for recipient in
    select distinct target from (values (task_row.assignee), (task_row.created_by)) r(target)
    where target is not null and target <> new.author_id
  loop
    insert into public.notifications (
      user_id, type, actor_id, pod_id, task_id, conversation_id,
      title, body, action_url, metadata
    ) values (
      recipient, 'task_comment', new.author_id, new.pod_id, new.task_id, task_row.conversation_id,
      coalesce(actor_name, 'Ein Teammitglied') || ' hat eine Aufgabe kommentiert',
      left(new.body, 240), '/pod/' || new.pod_id || '?tab=tasks&task=' || new.task_id,
      jsonb_build_object('task_title', task_row.title)
    );
  end loop;
  return new;
end;
$$;

create trigger pod_task_comment_notification
after insert on public.pod_task_comments
for each row execute function private.notify_task_comment();

revoke all on function private.notify_task_assignment() from public, anon, authenticated;
revoke all on function private.notify_task_comment() from public, anon, authenticated;

alter table public.notifications replica identity full;
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception when duplicate_object then null;
  end;
end $$;
