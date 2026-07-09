-- enneo OS — Connector-Arten (2026-07-09)
-- 'mcp'   = selbst verknüpfter MCP-Server (bisheriges Verhalten)
-- 'attio' = nativer Attio-CRM-Connector (API-Key, read-only Tools in src/tools/attio.js)
-- Der Spalten-Grant muss explizit erweitert werden — die 0010-Grant-Liste ist abschließend.

alter table connectors add column if not exists kind text not null default 'mcp'
  check (kind in ('mcp', 'attio'));

grant select (kind) on connectors to authenticated;
