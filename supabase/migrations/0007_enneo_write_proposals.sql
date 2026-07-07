-- Enneo-Write-Vorschläge: Enni schlägt vor, ein Mensch gibt frei (Confirm-Gate + Audit-Trail).
-- Insert/Update ausschließlich über das Backend (service_role); Frontend liest den Status.

create table public.enneo_write_proposals (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  proposed_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  instance text not null,
  method text not null check (method in ('POST', 'PUT', 'PATCH')),
  path text not null,
  body jsonb,
  summary text not null,
  status text not null default 'proposed' check (status in ('proposed', 'executed', 'failed', 'rejected')),
  result text,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

alter table public.enneo_write_proposals enable row level security;

-- Team-intern sichtbar (Pod-Konversationen teilen die Karten sowieso); Schreiben nur service_role.
create policy "proposals sichtbar für alle eingeloggten"
  on public.enneo_write_proposals for select to authenticated using (true);

grant select on public.enneo_write_proposals to authenticated;
grant all on public.enneo_write_proposals to service_role;
