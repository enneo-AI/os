-- Selbst verknüpfte Integrationen: jeder MCP-Server per URL (+ optionalem Bearer-Token).
-- Kategorie steuert nur die Anzeige (Tools-Seite vs. Connections-Seite).
-- Token ist write-only für Clients: Spalten-Grant schließt ihn aus, nur service_role liest ihn.

create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  token text,
  category text not null default 'tool' check (category in ('tool', 'connection')),
  tool_count int,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.connectors enable row level security;

create policy "connectors sichtbar für alle eingeloggten"
  on public.connectors for select to authenticated using (true);

-- Spalten-Grant OHNE token — ein select auf token schlägt für authenticated fehl
grant select (id, name, url, category, tool_count, created_by, created_at) on public.connectors to authenticated;
grant all on public.connectors to service_role;
