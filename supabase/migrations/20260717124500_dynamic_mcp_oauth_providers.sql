-- Persist the provider identity for dynamically certified OAuth MCPs. Without
-- this field the SDK could refresh only hard-coded providers after the
-- short-lived OAuth session had been deleted.

alter table public.connectors
  add column if not exists oauth_provider text;

update public.connectors
set oauth_provider = case
  when regexp_replace(url, '/+$', '') = 'https://app.lemlist.com/mcp' then 'lemlist'
  when regexp_replace(url, '/+$', '') = 'https://mcp.ticktick.com' then 'ticktick'
  else oauth_provider
end
where auth_type = 'mcp_oauth'
  and oauth_provider is null;

comment on column public.connectors.oauth_provider is
  'Stable callback/provider key used by official and dynamically certified remote MCP OAuth connections.';
