-- Remote MCPs can use their documented non-OAuth fallback. Keep the concrete
-- header type explicit so API keys are never accidentally sent as Bearer tokens.
alter table public.connectors
  drop constraint if exists connectors_auth_type_check,
  add constraint connectors_auth_type_check check (
    auth_type in ('manual', 'oauth', 'mcp_oauth', 'mcp_bearer', 'mcp_x_api_key', 'mcp_none')
  );

comment on column public.connectors.auth_type is
  'Credential transport. MCP values map to Authorization Bearer, X-API-Key or no header.';
