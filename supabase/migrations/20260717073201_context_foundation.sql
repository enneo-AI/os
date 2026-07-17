-- Context foundation: multi-department profiles, private personal context and
-- deterministic context dependencies for skills.

alter table public.profiles
  add column if not exists departments text[] not null default '{}';

alter table public.profiles
  drop constraint if exists profiles_department_check,
  add constraint profiles_department_check check (
    department is null or department in (
      'partnerships', 'it_development', 'sales', 'finance', 'operations', 'custom'
    )
  );

update public.profiles
set departments = case
  when department is null then '{}'
  when not (department = any(departments)) then array_prepend(department, departments)
  else departments
end;

alter table public.profiles
  drop constraint if exists profiles_departments_check,
  add constraint profiles_departments_check check (
    departments <@ array['partnerships', 'it_development', 'sales', 'finance', 'operations', 'custom']::text[]
    and cardinality(departments) <= 6
    and (department is null or department = any(departments))
  );

comment on column public.profiles.department is 'Primary department used for grouping and the leading profile label.';
comment on column public.profiles.departments is 'All departments the person works across; the primary department must be included.';

grant update (departments) on public.profiles to authenticated;

create table public.contexts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  description text not null default '',
  content text not null default '',
  context_type text not null default 'knowledge'
    check (context_type in ('knowledge', 'brand', 'persona', 'customer', 'personal_profile')),
  visibility text not null default 'personal'
    check (visibility in ('personal', 'proposed', 'team')),
  owner_id uuid references auth.users(id) on delete cascade,
  is_locked boolean not null default false,
  structured_data jsonb not null default '{}'::jsonb,
  source text not null default 'manual'
    check (source in ('manual', 'import', 'onboarding')),
  created_by uuid not null references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contexts_owner_scope_check check (
    (visibility in ('personal', 'proposed') and owner_id is not null)
    or (visibility = 'team' and owner_id is null)
  )
);

create unique index contexts_personal_profile_owner_idx
  on public.contexts(owner_id)
  where context_type = 'personal_profile';
create index contexts_visible_idx on public.contexts(visibility, updated_at desc);
create index contexts_owner_idx on public.contexts(owner_id, updated_at desc);
create index contexts_created_by_idx on public.contexts(created_by);
create index contexts_updated_by_idx on public.contexts(updated_by) where updated_by is not null;

create trigger contexts_updated_at before update on public.contexts
  for each row execute function set_updated_at();

alter table public.contexts enable row level security;

-- Privacy boundary: admins do not receive implicit access to another person's
-- contexts. The server may load the current user's own context for Enni.
create policy contexts_select on public.contexts for select to authenticated
  using (visibility = 'team' or owner_id = (select auth.uid()));

create policy contexts_insert on public.contexts for insert to authenticated
  with check (
    (owner_id = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or (
      visibility = 'team' and owner_id is null
      and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
    )
  );

create policy contexts_update on public.contexts for update to authenticated
  using (
    owner_id = (select auth.uid())
    or (visibility = 'team' and exists (
      select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin
    ))
  )
  with check (
    (owner_id = (select auth.uid()) and visibility in ('personal', 'proposed'))
    or (
      visibility = 'team' and owner_id is null
      and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
    )
  );

create policy contexts_delete on public.contexts for delete to authenticated
  using (
    owner_id = (select auth.uid())
    or (visibility = 'team' and exists (
      select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin
    ))
  );

grant select, insert, update, delete on public.contexts to authenticated;

create table public.skill_contexts (
  skill_id uuid not null references public.skills(id) on delete cascade,
  context_id uuid not null references public.contexts(id) on delete cascade,
  requirement text not null default 'required' check (requirement in ('required', 'optional')),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  primary key (skill_id, context_id)
);

create index skill_contexts_context_idx on public.skill_contexts(context_id);
alter table public.skill_contexts enable row level security;

create policy skill_contexts_select on public.skill_contexts for select to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (s.visibility = 'team' or s.created_by = (select auth.uid()))
    )
    and exists (
      select 1 from public.contexts c
      where c.id = context_id and (c.visibility = 'team' or c.owner_id = (select auth.uid()))
    )
  );

create policy skill_contexts_insert on public.skill_contexts for insert to authenticated
  with check (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (
        (s.created_by = (select auth.uid()) and s.visibility in ('personal', 'proposed'))
        or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
      )
    )
    and exists (
      select 1 from public.contexts c
      where c.id = context_id and (c.visibility = 'team' or c.owner_id = (select auth.uid()))
    )
  );

create policy skill_contexts_update on public.skill_contexts for update to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (
        (s.created_by = (select auth.uid()) and s.visibility in ('personal', 'proposed'))
        or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
      )
    )
  )
  with check (
    exists (
      select 1 from public.contexts c
      where c.id = context_id and (c.visibility = 'team' or c.owner_id = (select auth.uid()))
    )
  );

create policy skill_contexts_delete on public.skill_contexts for delete to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (
        (s.created_by = (select auth.uid()) and s.visibility in ('personal', 'proposed'))
        or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
      )
    )
  );

grant select, insert, update, delete on public.skill_contexts to authenticated;

create policy active_account_only on public.contexts as restrictive for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ));

create policy active_account_only on public.skill_contexts as restrictive for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ));
