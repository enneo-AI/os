-- Restricted pods are invitation-only. Account admins do not receive implicit
-- visibility; they can manage a restricted pod only after being invited.

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
        p.open
        or p.created_by = (select auth.uid())
        or exists (
          select 1
          from public.pod_members m
          where m.pod_id = pid
            and m.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.is_pod_visible(uuid) from public, anon;
grant execute on function public.is_pod_visible(uuid) to authenticated, service_role;

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
          exists (
            select 1
            from public.profiles profile
            where profile.id = (select auth.uid())
              and profile.is_admin
              and coalesce(profile.account_status, 'active') = 'active'
          )
          and (
            pod.open
            or exists (
              select 1
              from public.pod_members member
              where member.pod_id = pid
                and member.user_id = (select auth.uid())
            )
          )
        )
      )
  );
$$;

revoke all on function private.can_manage_pod_members(uuid) from public, anon;
grant execute on function private.can_manage_pod_members(uuid) to authenticated, service_role;

drop policy if exists pods_select on public.pods;
create policy pods_select
on public.pods for select
to authenticated
using (
  open
  or created_by = (select auth.uid())
  or exists (
    select 1
    from public.pod_members member
    where member.pod_id = id
      and member.user_id = (select auth.uid())
  )
);

drop policy if exists pods_delete on public.pods;
create policy pods_delete
on public.pods for delete
to authenticated
using (
  created_by = (select auth.uid())
  or (
    public.is_pod_visible(id)
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.is_admin
        and coalesce(profile.account_status, 'active') = 'active'
    )
  )
);

-- Do not leak the membership directory of hidden restricted pods.
drop policy if exists pm_select on public.pod_members;
create policy pm_select
on public.pod_members for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_pod_visible(pod_id)
);

drop policy if exists pod_task_comments_delete on public.pod_task_comments;
create policy pod_task_comments_delete
on public.pod_task_comments for delete
to authenticated
using (
  author_id = (select auth.uid())
  or (
    public.is_pod_visible(pod_id)
    and exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.is_admin
        and coalesce(profile.account_status, 'active') = 'active'
    )
  )
);

-- Object paths start with the pod UUID. Storage follows the same visibility
-- boundary as pod rows instead of allowing every authenticated account.
drop policy if exists pod_files_storage_select on storage.objects;
create policy pod_files_storage_select
on storage.objects for select
to authenticated
using (
  bucket_id = 'pod-files'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.is_pod_visible(((storage.foldername(name))[1])::uuid)
);

drop policy if exists pod_files_storage_insert on storage.objects;
create policy pod_files_storage_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'pod-files'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.is_pod_visible(((storage.foldername(name))[1])::uuid)
);

drop policy if exists pod_files_storage_delete on storage.objects;
create policy pod_files_storage_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'pod-files'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.is_pod_visible(((storage.foldername(name))[1])::uuid)
);
