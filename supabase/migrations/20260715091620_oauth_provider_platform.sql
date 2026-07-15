-- enneo OS — provider-unabhängige OAuth-Plattform.
-- Admins konfigurieren die OAuth-App einmalig in enneo OS; Nutzer verbinden
-- anschließend Accounts ausschließlich über den Anbieter-Login.

alter table public.connectors drop constraint if exists connectors_kind_check;
alter table public.connectors add constraint connectors_kind_check
  check (kind in ('mcp', 'attio', 'slack', 'outlook', 'google_drive', 'notion'));

alter table public.oauth_states drop constraint if exists oauth_states_provider_check;
alter table public.oauth_states add constraint oauth_states_provider_check
  check (provider in ('slack', 'outlook', 'google_drive', 'notion', 'attio'));

create table public.oauth_provider_configs (
  provider text primary key check (provider in ('slack', 'outlook', 'google_drive', 'notion', 'attio')),
  client_id text not null,
  client_secret text not null,
  tenant_id text,
  enabled boolean not null default true,
  configured_by uuid references public.profiles(id) on delete set null,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger oauth_provider_configs_updated_at before update on public.oauth_provider_configs
  for each row execute function public.set_updated_at();

alter table public.oauth_provider_configs enable row level security;
grant all on public.oauth_provider_configs to service_role;

-- Absichtlich KEIN Grant an authenticated: selbst Admins erhalten Provider-Secrets
-- ausschließlich indirekt über die serverseitigen Admin-Endpunkte.

drop policy if exists active_account_only on public.oauth_provider_configs;
create policy active_account_only on public.oauth_provider_configs as restrictive for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ));
