-- enneo OS — BuchhaltungsButler als native Connector-Art (2026-08-19)
-- Klassische REST-API (kein MCP): HTTP Basic Auth (api_client:api_secret) + api_key
-- als Form-Feld pro Request. Die drei Credentials werden als verschlüsseltes JSON
-- in der bestehenden write-only `token`-Spalte gespeichert (kind='buchhaltungsbutler',
-- Tools in src/tools/buchhaltungsbutler.js — bewusst NUR Lese-Tools).

alter table public.connectors drop constraint if exists connectors_kind_check;
alter table public.connectors add constraint connectors_kind_check
  check (kind in ('mcp', 'attio', 'slack', 'outlook', 'google_drive', 'notion', 'buchhaltungsbutler'));
