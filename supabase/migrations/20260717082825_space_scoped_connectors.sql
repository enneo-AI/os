-- Marketplace connections are dormant credentials. Enni may only load a
-- connector after that concrete connector row is assigned to a Space.
-- Open Space: all active accounts. Restricted Space: creator + explicit members.

create or replace function private.can_attach_connector(connection_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  connector_id uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  if connection_key in ('wiki', 'gitlab', 'enneo') then return true; end if;
  if connection_key !~ '^connector:[0-9a-fA-F-]{36}$' then return false; end if;
  connector_id := substring(connection_key from 11)::uuid;
  return exists (
    select 1 from public.connectors c
    where c.id = connector_id
      and (
        c.visibility = 'team'
        or c.owner = (select auth.uid())
        or exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.is_admin
            and p.account_status = 'active'
        )
      )
  );
end;
$$;

revoke all on function private.can_attach_connector(text) from public, anon;
grant execute on function private.can_attach_connector(text) to authenticated, service_role;

-- Security-definer helpers break the spaces <-> space_members RLS recursion.
-- They accept only a Space id and always evaluate access for auth.uid().
create or replace function private.can_access_space(target_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.spaces s
    where s.id = target_space_id
      and (
        not s.restricted
        or s.created_by = (select auth.uid())
        or exists (
          select 1 from public.space_members sm
          where sm.space_id = s.id and sm.user_id = (select auth.uid())
        )
      )
  );
$$;

create or replace function private.owns_space(target_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.spaces s
    where s.id = target_space_id and s.created_by = (select auth.uid())
  );
$$;

create or replace function private.is_space_member(target_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.space_members sm
    where sm.space_id = target_space_id and sm.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_manage_space_connections(target_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.spaces s
    where s.id = target_space_id
      and (
        s.created_by = (select auth.uid())
        or (
          not s.restricted
          and exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'
          )
        )
      )
  );
$$;

revoke all on function private.can_access_space(uuid) from public, anon;
revoke all on function private.owns_space(uuid) from public, anon;
revoke all on function private.is_space_member(uuid) from public, anon;
revoke all on function private.can_manage_space_connections(uuid) from public, anon;
grant execute on function private.can_access_space(uuid) to authenticated, service_role;
grant execute on function private.owns_space(uuid) to authenticated, service_role;
grant execute on function private.is_space_member(uuid) to authenticated, service_role;
grant execute on function private.can_manage_space_connections(uuid) to authenticated, service_role;

drop policy if exists connectors_select_scope on public.connectors;
create policy connectors_select_scope on public.connectors for select to authenticated
  using (
    visibility = 'team'
    or owner = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.is_admin and p.account_status = 'active'
    )
    or exists (
      select 1
      from public.space_connections sc
      where sc.connection_key = 'connector:' || connectors.id::text
        and (select private.can_access_space(sc.space_id))
    )
  );

-- Restricted really means invited. Admin status alone grants no visibility.
drop policy if exists spaces_select on public.spaces;
create policy spaces_select on public.spaces for select to authenticated
  using (
    not restricted
    or created_by = (select auth.uid())
    or (select private.is_space_member(id))
  );

drop policy if exists sm_insert on public.space_members;
create policy sm_insert on public.space_members for insert to authenticated
  with check ((select private.owns_space(space_id)));

drop policy if exists sm_delete on public.space_members;
create policy sm_delete on public.space_members for delete to authenticated
  using ((select private.owns_space(space_id)));

drop policy if exists sc_select on public.space_connections;
create policy sc_select on public.space_connections for select to authenticated
  using ((select private.can_access_space(space_id)));

drop policy if exists sc_insert on public.space_connections;
create policy sc_insert on public.space_connections for insert to authenticated
  with check (
    (select private.can_manage_space_connections(space_id))
    and (select private.can_attach_connector(connection_key))
  );

drop policy if exists sc_delete on public.space_connections;
create policy sc_delete on public.space_connections for delete to authenticated
  using (
    (select private.can_manage_space_connections(space_id))
  );

-- Preserve consciously team-wide existing connections by assigning them to
-- Company Data. New connections remain dormant until a Space owner adds them.
insert into public.space_connections (space_id, connection_key, added_by)
select s.id, 'connector:' || c.id::text, c.created_by
from public.connectors c
join public.spaces s on s.name = 'Company Data'
where c.visibility = 'team'
on conflict (space_id, connection_key) do nothing;

-- Provider-name placeholders never represented a concrete credential set.
delete from public.space_connections
where connection_key in ('outlook', 'google_drive', 'notion', 'slack', 'attio');
