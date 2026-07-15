-- enneo OS — wiederverwendbare OAuth-Grundlage für den Integrations-Marktplatz.
-- Provider-Credentials bleiben server-only; der Browser sieht nur Status/Metadaten.

alter table connectors add column if not exists auth_type text not null default 'manual'
  check (auth_type in ('manual', 'oauth', 'mcp_oauth'));
alter table connectors add column if not exists external_account_id text;
alter table connectors add column if not exists external_account_name text;
alter table connectors add column if not exists scopes text[] not null default '{}';
alter table connectors add column if not exists refresh_token text;
alter table connectors add column if not exists token_expires_at timestamptz;

grant select (auth_type, external_account_id, external_account_name, scopes, token_expires_at)
  on connectors to authenticated;

create table if not exists oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('slack')),
  visibility text not null check (visibility in ('personal', 'team')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table oauth_states enable row level security;
grant all on oauth_states to service_role;
create index if not exists oauth_states_expiry_idx on oauth_states (expires_at);
