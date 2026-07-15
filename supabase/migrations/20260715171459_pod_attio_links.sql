-- A Pod stores only stable Attio references plus a compact identity snapshot.
-- CRM history stays in Attio and is fetched lazily by Enni's read-only tools.
create table public.pod_attio_links (
  pod_id uuid primary key references public.pods(id) on delete cascade,
  attio_object text not null default 'companies' check (attio_object = 'companies'),
  attio_record_id text not null,
  record_name text not null,
  record_domain text,
  record_url text,
  snapshot jsonb not null default '{}'::jsonb,
  linked_by uuid references auth.users(id) on delete set null,
  linked_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pod_attio_related_records (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references public.pod_attio_links(pod_id) on delete cascade,
  attio_object text not null check (attio_object in ('people', 'deals')),
  attio_record_id text not null,
  record_name text not null,
  record_detail text,
  record_url text,
  snapshot jsonb not null default '{}'::jsonb,
  linked_by uuid references auth.users(id) on delete set null,
  linked_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  unique (pod_id, attio_object, attio_record_id)
);

create index pod_attio_links_record_idx
  on public.pod_attio_links (attio_object, attio_record_id);
create index pod_attio_related_pod_idx
  on public.pod_attio_related_records (pod_id);

create trigger pod_attio_links_set_updated_at
  before update on public.pod_attio_links
  for each row execute function public.set_updated_at();

alter table public.pod_attio_links enable row level security;
alter table public.pod_attio_related_records enable row level security;

create policy "Visible pod members can read the Attio customer"
  on public.pod_attio_links for select to authenticated
  using (public.is_pod_visible(pod_id));

create policy "Visible pod members can read related Attio records"
  on public.pod_attio_related_records for select to authenticated
  using (public.is_pod_visible(pod_id));

revoke all on table public.pod_attio_links from anon, authenticated;
revoke all on table public.pod_attio_related_records from anon, authenticated;
grant select on table public.pod_attio_links to authenticated;
grant select on table public.pod_attio_related_records to authenticated;
grant all on table public.pod_attio_links to service_role;
grant all on table public.pod_attio_related_records to service_role;
