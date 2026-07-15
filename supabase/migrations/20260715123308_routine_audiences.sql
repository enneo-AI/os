-- Routinen können persönlich, für alle aktiven Accounts oder für eine explizite
-- Account-Auswahl gelten. Die eigentliche Ausführung bleibt user-scoped, damit
-- persönliche Tools/Learnings und die Kosten dem richtigen Account zugeordnet sind.

alter table public.routines
  add column if not exists audience text not null default 'personal'
  check (audience in ('personal', 'all', 'restricted'));

-- Bestehende team-weite, private Routinen werden echte globale Routinen.
-- Pod-Routinen bleiben ein einzelner Lauf ihres Erstellers, damit kein Ergebnis
-- mehrfach in denselben Pod geschrieben wird.
update public.routines
set audience = case
  when visibility = 'team' and pod_id is null then 'all'
  else 'personal'
end;

alter table public.routines
  add constraint routines_audience_destination_check
  check (audience = 'personal' or pod_id is null),
  add constraint routines_audience_visibility_check
  check (audience = 'personal' or visibility = 'team');

create table public.routine_accounts (
  routine_id uuid not null references public.routines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (routine_id, user_id)
);

create index routine_accounts_user_idx on public.routine_accounts(user_id);
create index if not exists routines_created_by_idx on public.routines(created_by);
create index if not exists routines_pod_id_idx on public.routines(pod_id);

alter table public.routine_accounts enable row level security;

create policy routine_accounts_select on public.routine_accounts
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

create policy routine_accounts_insert on public.routine_accounts
  for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

create policy routine_accounts_delete on public.routine_accounts
  for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

create policy active_account_only on public.routine_accounts
  as restrictive for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.account_status = 'active'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.account_status = 'active'
    )
  );

drop policy if exists routines_select on public.routines;
drop policy if exists routines_insert on public.routines;
drop policy if exists routines_update on public.routines;
drop policy if exists routines_delete on public.routines;

create policy routines_select on public.routines
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
    or (
      visibility = 'team'
      and (
        audience = 'all'
        or (
          audience = 'restricted'
          and exists (
            select 1 from public.routine_accounts ra
            where ra.routine_id = routines.id
              and ra.user_id = (select auth.uid())
          )
        )
      )
    )
  );

create policy routines_insert on public.routines
  for insert to authenticated
  with check (
    (
      created_by = (select auth.uid())
      and audience = 'personal'
      and visibility in ('personal', 'proposed')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

create policy routines_update on public.routines
  for update to authenticated
  using (
    (
      created_by = (select auth.uid())
      and audience = 'personal'
      and visibility in ('personal', 'proposed')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  )
  with check (
    (
      created_by = (select auth.uid())
      and audience = 'personal'
      and visibility in ('personal', 'proposed')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

create policy routines_delete on public.routines
  for delete to authenticated
  using (
    (
      created_by = (select auth.uid())
      and audience = 'personal'
      and visibility in ('personal', 'proposed')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

revoke all on public.routine_accounts from anon, authenticated;
grant select on public.routine_accounts to authenticated;
grant all on public.routine_accounts to service_role;
