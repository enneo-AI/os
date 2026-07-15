-- Enni Research Lab: Nutzer schlagen fehlende Tools vor, Enni erstellt einen
-- quellenbasierten Integrations-Blueprint, Admins veröffentlichen ihn.
create table public.tool_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete cascade,
  name text,
  source_url text,
  request_note text,
  status text not null default 'queued'
    check (status in ('queued', 'researching', 'review', 'approved', 'rejected', 'failed')),
  research jsonb not null default '{}'::jsonb,
  research_error text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (nullif(btrim(coalesce(name, '')), '') is not null or nullif(btrim(coalesce(source_url, '')), '') is not null)
);

create index tool_requests_status_created_idx on public.tool_requests(status, created_at desc);
create index tool_requests_requested_by_idx on public.tool_requests(requested_by, created_at desc);
create index tool_requests_reviewed_by_idx on public.tool_requests(reviewed_by) where reviewed_by is not null;

create trigger tool_requests_updated_at
  before update on public.tool_requests
  for each row execute function public.set_updated_at();

alter table public.tool_requests enable row level security;

create policy tool_requests_select_scope on public.tool_requests
  for select to authenticated
  using (
    status = 'approved'
    or requested_by = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

-- Erstellung, Recherche-Ergebnis und Review laufen ausschließlich über das
-- authentifizierte Backend. Der Browser erhält nur die sicheren Blueprint-Daten.
grant select on public.tool_requests to authenticated;
grant all on public.tool_requests to service_role;
