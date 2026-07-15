-- Avoid pods -> pod_members -> pods policy recursion when a creator adds members.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.can_manage_pod_members(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.pods p
      where p.id = pid and p.created_by = (select auth.uid())
    )
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.is_admin
    );
$$;

revoke all on function private.can_manage_pod_members(uuid) from public, anon;
grant execute on function private.can_manage_pod_members(uuid) to authenticated, service_role;

drop policy if exists pm_insert on public.pod_members;
create policy pm_insert
on public.pod_members for insert
to authenticated
with check (private.can_manage_pod_members(pod_id));

drop policy if exists pm_delete on public.pod_members;
create policy pm_delete
on public.pod_members for delete
to authenticated
using (
  user_id = (select auth.uid())
  or private.can_manage_pod_members(pod_id)
);
