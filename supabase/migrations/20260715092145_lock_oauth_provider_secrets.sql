-- OAuth-App-Secrets sind nie Teil der Data API. RLS bleibt Defense-in-depth;
-- die Tabellenberechtigung wird zusätzlich explizit entzogen.
revoke all on table public.oauth_provider_configs from public, anon, authenticated;
grant all on table public.oauth_provider_configs to service_role;
