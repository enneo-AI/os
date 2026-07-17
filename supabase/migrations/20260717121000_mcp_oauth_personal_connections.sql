-- Personal OAuth for official remote MCP servers (first provider: Lemlist).
-- OAuth client registrations and PKCE verifiers are secrets and therefore
-- remain service-role-only. A connection always belongs to the user who
-- completed the provider consent flow.

alter table public.connectors
  add column if not exists oauth_client_information text;

create table if not exists public.mcp_oauth_sessions (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  connector_name text not null,
  server_url text not null,
  category text not null default 'tool' check (category in ('tool', 'connection')),
  code_verifier text,
  client_information text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.mcp_oauth_sessions enable row level security;
revoke all on table public.mcp_oauth_sessions from public, anon, authenticated;
grant all on table public.mcp_oauth_sessions to service_role;
create index if not exists mcp_oauth_sessions_expiry_idx
  on public.mcp_oauth_sessions (expires_at);

comment on column public.connectors.oauth_client_information is
  'AES-256-GCM encrypted OAuth dynamic-client registration metadata for remote MCP token refresh.';
comment on table public.mcp_oauth_sessions is
  'Short-lived, service-only PKCE state for personal remote MCP OAuth connections.';
