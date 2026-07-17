-- Restricted Space membership management. The owner can atomically replace
-- the selected member set; the owner is always retained. Account admins do
-- not receive an implicit bypass for invitation-only Spaces.

create or replace function public.replace_space_members(
  target_space_id uuid,
  member_ids uuid[] default '{}'::uuid[]
)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  is_restricted boolean;
  selected_ids uuid[] := coalesce(member_ids, '{}'::uuid[]);
begin
  if auth.uid() is null then
    raise exception 'Nicht eingeloggt';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.account_status = 'active'
  ) then
    raise exception 'Account ist nicht aktiv';
  end if;

  select s.created_by, s.restricted
  into owner_id, is_restricted
  from public.spaces s
  where s.id = target_space_id;

  if not found then
    raise exception 'Space nicht gefunden';
  end if;
  if owner_id is distinct from auth.uid() then
    raise exception 'Nur der Space-Owner kann Mitglieder verwalten';
  end if;
  if not is_restricted then
    raise exception 'Open Spaces benötigen keine Mitgliederliste';
  end if;

  delete from public.space_members sm
  where sm.space_id = target_space_id
    and sm.user_id <> owner_id
    and not (sm.user_id = any(selected_ids));

  insert into public.space_members (space_id, user_id)
  values (target_space_id, owner_id)
  on conflict (space_id, user_id) do nothing;

  insert into public.space_members (space_id, user_id)
  select target_space_id, p.id
  from public.profiles p
  where p.account_status = 'active'
    and p.id <> owner_id
    and p.id = any(selected_ids)
  on conflict (space_id, user_id) do nothing;

  return query
  select sm.user_id
  from public.space_members sm
  where sm.space_id = target_space_id
  order by sm.created_at;
end;
$$;

revoke all on function public.replace_space_members(uuid, uuid[]) from public, anon;
grant execute on function public.replace_space_members(uuid, uuid[]) to authenticated, service_role;

comment on function public.replace_space_members(uuid, uuid[]) is
  'Atomically replaces a Restricted Space member set. Only the owning active account may call it; the owner is always retained.';
