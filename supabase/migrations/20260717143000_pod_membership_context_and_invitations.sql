-- Pods are discoverable spaces, not implicit organization-wide access grants.
-- Open pods can be seen by every active account, but their content is available
-- only after joining or accepting an invitation. Restricted pods remain hidden
-- until an invitation is accepted.

create or replace function public.is_pod_visible(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pods p
    where p.id = pid
      and (
        p.created_by = (select auth.uid())
        or exists (
          select 1
          from public.pod_members m
          where m.pod_id = pid
            and m.user_id = (select auth.uid())
        )
      )
  );
$$;

comment on function public.is_pod_visible(uuid) is
  'Returns content access for a pod (creator or accepted member). Open only controls discoverability.';

-- A Pod conversation must follow Pod membership even when the current user
-- originally created that conversation under the old implicit-open model.
drop policy if exists conv_select on public.conversations;
create policy conv_select on public.conversations for select to authenticated
using (
  (pod_id is null and user_id = (select auth.uid()))
  or (pod_id is not null and public.is_pod_visible(pod_id))
);

drop policy if exists conv_insert on public.conversations;
create policy conv_insert on public.conversations for insert to authenticated
with check (
  user_id = (select auth.uid())
  and (pod_id is null or public.is_pod_visible(pod_id))
);

drop policy if exists conv_update on public.conversations;
create policy conv_update on public.conversations for update to authenticated
using (
  (pod_id is null and user_id = (select auth.uid()))
  or (pod_id is not null and public.is_pod_visible(pod_id))
)
with check (
  (pod_id is null and user_id = (select auth.uid()))
  or (pod_id is not null and public.is_pod_visible(pod_id))
);

drop policy if exists conv_delete on public.conversations;
create policy conv_delete on public.conversations for delete to authenticated
using (
  user_id = (select auth.uid())
  and (pod_id is null or public.is_pod_visible(pod_id))
);

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.id = conversation_id
    and (
      (c.pod_id is null and c.user_id = (select auth.uid()))
      or (c.pod_id is not null and public.is_pod_visible(c.pod_id))
    )
));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
with check (exists (
  select 1 from public.conversations c
  where c.id = conversation_id
    and (
      (c.pod_id is null and c.user_id = (select auth.uid()))
      or (c.pod_id is not null and public.is_pod_visible(c.pod_id))
    )
));

-- Every creator is a real member. This also repairs existing open pods whose
-- creator previously relied on the implicit open-access shortcut.
insert into public.pod_members (pod_id, user_id)
select p.id, p.created_by
from public.pods p
where p.created_by is not null
on conflict (pod_id, user_id) do nothing;

create or replace function private.ensure_pod_creator_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.pod_members (pod_id, user_id)
    values (new.id, new.created_by)
    on conflict (pod_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_pod_creator_membership on public.pods;
create trigger ensure_pod_creator_membership
after insert on public.pods
for each row execute function private.ensure_pod_creator_membership();

create or replace function private.can_manage_pod_members(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pods pod
    where pod.id = pid
      and (
        pod.created_by = (select auth.uid())
        or (
          public.is_pod_visible(pid)
          and exists (
            select 1
            from public.profiles profile
            where profile.id = (select auth.uid())
              and profile.is_admin
              and coalesce(profile.account_status, 'active') = 'active'
          )
        )
      )
  );
$$;

-- Per-member context is intentionally separate from the global profile role:
-- one person can have different responsibilities in different pods.
create table public.pod_member_contexts (
  pod_id uuid not null,
  user_id uuid not null,
  role_title text not null default '' check (char_length(role_title) <= 160),
  responsibilities text not null default '' check (char_length(responsibilities) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (pod_id, user_id),
  foreign key (pod_id, user_id)
    references public.pod_members (pod_id, user_id) on delete cascade
);

create trigger pod_member_contexts_updated_at
before update on public.pod_member_contexts
for each row execute function public.set_updated_at();

alter table public.pod_member_contexts enable row level security;
revoke all on public.pod_member_contexts from anon, authenticated;
grant select, insert, update, delete on public.pod_member_contexts to authenticated;
grant all on public.pod_member_contexts to service_role;

create policy pod_member_contexts_select
on public.pod_member_contexts for select to authenticated
using (public.is_pod_visible(pod_id));

create policy pod_member_contexts_insert_own
on public.pod_member_contexts for insert to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

create policy pod_member_contexts_update_own
on public.pod_member_contexts for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

create policy pod_member_contexts_delete_own
on public.pod_member_contexts for delete to authenticated
using (user_id = (select auth.uid()));

create table public.pod_invitations (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references public.pods (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (pod_id, invitee_id)
);

create index pod_invitations_invitee_pending_idx
  on public.pod_invitations (invitee_id, created_at desc)
  where status = 'pending';

alter table public.pod_invitations enable row level security;
revoke all on public.pod_invitations from anon, authenticated;
grant select on public.pod_invitations to authenticated;
grant all on public.pod_invitations to service_role;

create policy pod_invitations_select_participants
on public.pod_invitations for select to authenticated
using (
  invitee_id = (select auth.uid())
  or invited_by = (select auth.uid())
  or private.can_manage_pod_members(pod_id)
);

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'mention', 'team_mention', 'task_assignment', 'task_comment',
  'agent_complete', 'routine_complete', 'system_update', 'pod_invitation'
));

create or replace function public.join_open_pod(target_pod_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Nicht eingeloggt'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and coalesce(p.account_status, 'active') = 'active'
  ) then raise exception 'Account ist nicht aktiv'; end if;
  if not exists (select 1 from public.pods p where p.id = target_pod_id and p.open) then
    raise exception 'Dieser Pod ist nicht offen';
  end if;

  insert into public.pod_members (pod_id, user_id)
  values (target_pod_id, auth.uid())
  on conflict (pod_id, user_id) do nothing;

  update public.pod_invitations
  set status = 'accepted', responded_at = now()
  where pod_id = target_pod_id and invitee_id = auth.uid() and status = 'pending';

  update public.notifications n
  set read_at = coalesce(n.read_at, now()),
      push_state = case when n.push_state = 'pending' then 'skipped' else n.push_state end,
      metadata = n.metadata || jsonb_build_object('status', 'accepted')
  where n.user_id = auth.uid() and n.type = 'pod_invitation' and n.pod_id = target_pod_id;
  return true;
end;
$$;

revoke all on function public.join_open_pod(uuid) from public, anon;
grant execute on function public.join_open_pod(uuid) to authenticated, service_role;

create or replace function public.invite_to_pod(target_pod_id uuid, target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_id uuid;
  pod_name text;
  inviter_name text;
begin
  if auth.uid() is null then raise exception 'Nicht eingeloggt'; end if;
  if not private.can_manage_pod_members(target_pod_id) then
    raise exception 'Du darfst für diesen Pod keine Einladungen versenden';
  end if;
  if target_user_id = auth.uid() then raise exception 'Du bist bereits in diesem Pod'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = target_user_id and coalesce(p.account_status, 'active') = 'active'
  ) then raise exception 'Dieser Account ist nicht aktiv'; end if;
  if exists (
    select 1 from public.pod_members m
    where m.pod_id = target_pod_id and m.user_id = target_user_id
  ) then raise exception 'Diese Person ist bereits Mitglied'; end if;

  insert into public.pod_invitations (pod_id, invitee_id, invited_by, status, created_at, responded_at)
  values (target_pod_id, target_user_id, auth.uid(), 'pending', now(), null)
  on conflict (pod_id, invitee_id) do update
    set invited_by = excluded.invited_by,
        status = 'pending',
        created_at = now(),
        responded_at = null
  returning id into invitation_id;

  select p.name into pod_name from public.pods p where p.id = target_pod_id;
  select coalesce(nullif(p.display_name, ''), split_part(p.email, '@', 1), 'Ein Teammitglied')
    into inviter_name from public.profiles p where p.id = auth.uid();

  delete from public.notifications n
  where n.user_id = target_user_id
    and n.type = 'pod_invitation'
    and n.pod_id = target_pod_id;

  insert into public.notifications (
    user_id, type, actor_id, pod_id, title, body, action_url, metadata
  ) values (
    target_user_id, 'pod_invitation', auth.uid(), target_pod_id,
    coalesce(inviter_name, 'Ein Teammitglied') || ' lädt dich in einen Pod ein',
    coalesce(pod_name, 'Pod'), '/notifications',
    jsonb_build_object('invitation_id', invitation_id, 'pod_name', pod_name)
  );

  return invitation_id;
end;
$$;

revoke all on function public.invite_to_pod(uuid, uuid) from public, anon;
grant execute on function public.invite_to_pod(uuid, uuid) to authenticated, service_role;

create or replace function public.respond_to_pod_invitation(target_invitation_id uuid, accept_invitation boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.pod_invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'Nicht eingeloggt'; end if;
  select * into invitation
  from public.pod_invitations i
  where i.id = target_invitation_id
    and i.invitee_id = auth.uid()
    and i.status = 'pending'
  for update;
  if not found then raise exception 'Einladung nicht gefunden oder bereits beantwortet'; end if;

  if accept_invitation then
    insert into public.pod_members (pod_id, user_id)
    values (invitation.pod_id, auth.uid())
    on conflict (pod_id, user_id) do nothing;
  end if;

  update public.pod_invitations
  set status = case when accept_invitation then 'accepted' else 'declined' end,
      responded_at = now()
  where id = target_invitation_id;

  update public.notifications n
  set read_at = coalesce(n.read_at, now()),
      push_state = case when n.push_state = 'pending' then 'skipped' else n.push_state end,
      metadata = n.metadata || jsonb_build_object('status', case when accept_invitation then 'accepted' else 'declined' end)
  where n.user_id = auth.uid()
    and n.type = 'pod_invitation'
    and n.metadata ->> 'invitation_id' = target_invitation_id::text;

  return accept_invitation;
end;
$$;

revoke all on function public.respond_to_pod_invitation(uuid, boolean) from public, anon;
grant execute on function public.respond_to_pod_invitation(uuid, boolean) to authenticated, service_role;
