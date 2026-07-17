-- Pod owners and joined admins coordinate project roles for the whole team.
-- Regular members keep control over their own role while remaining read-only
-- for the other member contexts.

drop policy if exists pod_member_contexts_insert_own on public.pod_member_contexts;
drop policy if exists pod_member_contexts_update_own on public.pod_member_contexts;
drop policy if exists pod_member_contexts_delete_own on public.pod_member_contexts;

create policy pod_member_contexts_insert_managed
on public.pod_member_contexts for insert to authenticated
with check (
  public.is_pod_visible(pod_id)
  and (
    user_id = (select auth.uid())
    or private.can_manage_pod_members(pod_id)
  )
);

create policy pod_member_contexts_update_managed
on public.pod_member_contexts for update to authenticated
using (
  user_id = (select auth.uid())
  or private.can_manage_pod_members(pod_id)
)
with check (
  public.is_pod_visible(pod_id)
  and (
    user_id = (select auth.uid())
    or private.can_manage_pod_members(pod_id)
  )
);

create policy pod_member_contexts_delete_managed
on public.pod_member_contexts for delete to authenticated
using (
  user_id = (select auth.uid())
  or private.can_manage_pod_members(pod_id)
);
